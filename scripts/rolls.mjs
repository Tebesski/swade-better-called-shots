import {applyDamageFormula, sharedDamageRules} from "../../swade-better-effects/scripts/damage-formulas.mjs";
import {documentFlags} from "../../swade-better-effects/scripts/flags.mjs";
import {criticalFailure} from "../../swade-better-effects/scripts/roll-outcomes.mjs";
import {setRollContext} from "../../swade-better-effects/scripts/roll-context.mjs";
import {cleanRollNote} from "../../swade-better-effects/scripts/roll-notes.mjs";
import {normalizeFlags} from "../../swade-better-effects/scripts/rules.mjs";
import {MODULE_ID, EFFECTS, actorShots, allShots, attackModifier, rollNotes, rollOutcome, scaleOf, shotFlags, signed} from "./shots.mjs";
import {disarmRuleLink} from "./disarm.mjs";

const dialogStates = new WeakMap();
const pendingRolls = new WeakMap();
const traitSources = new WeakMap();
const linkedRolls = new WeakMap();

const effects = () => game.modules.get(EFFECTS).api;
const resolve = uuid => uuid ? foundry.utils.fromUuidSync(uuid) : null;
const bonusDamage = () => game.i18n.localize("SWADE.BonusDamage");
const conditionalBreakdown = `${MODULE_ID}.modifiers`;

function wrap(object, method, handler) {
  const original = object[method];
  object[method] = function (...args) { return handler.call(this, original.bind(this), ...args); };
}

function captureTrait(actor, _trait, roll, modifiers, options) {
  if (options.item?.type !== "weapon") return;
  const context = roll.options[EFFECTS];
  const target = game.user.targets.first()?.document;
  const result = effects().traitAdjustment(context, target);
  const conditional = [];
  // The effect hook appends its applicable modifiers before this hook runs.
  const available = [...modifiers].reverse();
  for (const adjustment of [...result.applied].reverse()) {
    const index = available.findIndex(mod => mod.label === adjustment.label && mod.value === adjustment.value);
    if (index >= 0) conditional.push(available.splice(index, 1)[0]);
  }
  traitSources.set(roll, {actor, item: options.item, target, conditional, context});
}

function initialState(app) {
  const source = traitSources.get(app.ctx.roll);
  if (!app.isDamageRoll && !app.isAttack && !source) return;
  const linked = linkedRolls.get(app.ctx.roll);
  const target = linked ? resolve(linked.tokenUuid) : source?.target ?? game.user.targets.first()?.document;
  if (!target?.actor) return;
  const weapon = source?.item ?? app.ctx.item;
  const actor = weapon?.actor?.type === "vehicle" ? weapon.actor : app.ctx.actor ?? weapon?.actor;
  const scaleMod = app.isDamageRoll ? null : app.ctx.mods.find(mod =>
    ["SWADE.ScaleDifference", game.i18n.localize("SWADE.ScaleDifference")].includes(mod.label));
  return {
    target, linked, source, actor, weapon, scaleMod, selected: linked?.id ?? "",
    context: source?.context ?? app.ctx.roll.options[EFFECTS] ?? effects().makeRollContext(actor, weapon),
    noAcing: false, replaced: new Map(), added: []
  };
}

function targetNumber(state) {
  const flags = state.context.roll;
  const melee = state.weapon?.system.isMelee && (!state.weapon.system.isRanged
    || state.context.skill?.name?.toLowerCase() === "fighting"
    || state.actor?.items.get(state.context.skill?.id)?.system.swid === "fighting");
  if (!melee && !(flags.includes("melee") && !flags.includes("ranged"))) return 4;
  return Math.max(2, Number(state.target.actor.system.stats?.parry?.value ?? 4));
}

function changeModifiers(app, state, shot) {
  const base = app.ctx.roll;
  const mods = app.ctx.mods;
  for (const mod of state.added) {
    const index = mods.indexOf(mod);
    if (index >= 0) mods.splice(index, 1);
  }
  state.added = [];
  for (const [mod, ignore] of state.replaced) mod.ignore = ignore;
  state.replaced.clear();
  if (!shot) {
    if (state.shot) setRollContext(base, state.context);
    state.shot = null;
    pendingRolls.delete(base.terms[0]);
    return;
  }
  const flags = normalizeFlags([...shotFlags(shot), ...documentFlags(shot.item)]);
  const shotContext = {...state.context, roll: normalizeFlags([...state.context.roll, ...flags]), targetUuids: [state.target.uuid],
    calledShotId: shot.id, targetItemId: shot.item?.id};
  if (app.isTraitRoll) {
    for (const mod of [state.scaleMod, ...state.source?.conditional ?? []]) {
      if (!mod) continue;
      state.replaced.set(mod, mod.ignore);
      mod.ignore = true;
    }
    const adjustment = effects().traitAdjustment(shotContext, state.target);
    shotContext.traitApplied = adjustment.value;
    shotContext.traitTargetUuid = state.target.uuid;
    state.added.push(...adjustment.applied);
  }
  const value = app.isDamageRoll ? shot.damage : attackModifier(shot, scaleOf(state.actor));
  if (value) state.added.push({label: `Called Shot · ${shot.name.replace(/[\[\]]/g, "")}`, value});
  if (app.isDamageRoll && state.linked?.raisedAttack && shot.kind === "location") {
    const die = state.weapon?.system.bonusDamageDie ?? 6;
    const count = state.weapon?.system.bonusDamageDice ?? 1;
    state.added.push({label: bonusDamage(), value: `+${count}d${die}x`});
  }
  mods.push(...state.added);
  state.shot = shot;
  state.rollContext = shotContext;
  state.snapshot = {
    id: shot.id, kind: shot.kind, name: shot.name, tokenUuid: state.target.uuid, tokenName: state.target.name,
    weaponUuid: state.weapon?.uuid ?? null,
    hardness: shot.hardness, heavy: shot.heavy, armour: shot.armour,
    heavyWeapon: state.weapon?.type === "weapon" && state.weapon.system.isHeavyWeapon === true,
    targetNumber: app.isTraitRoll ? targetNumber(state) : undefined,
    notes: rollNotes(shot, disarmRuleLink()).map(note => ({...note, text: cleanRollNote(note.text, {publicContent: true})}))
  };
  setRollContext(base, shotContext);
  pendingRolls.set(base.terms[0], state);
}

function prepareDialog(app) {
  const state = dialogStates.get(app) ?? initialState(app);
  if (!state) return;
  dialogStates.set(app, state);
  state.groups = actorShots(state.target.actor);
  const shot = [...state.groups.locations, ...state.groups.items].find(entry => entry.id === state.selected);
  if (state.current !== state.selected || (!!state.shot && !shot)) {
    state.current = state.selected;
    changeModifiers(app, state, shot);
  }
  return state;
}

function buildShotRoll(original, terms, options, damage) {
  const state = pendingRolls.get(terms[0]);
  if (!state?.shot) {
    if (!damage || !options?.[conditionalBreakdown]?.length) return original(terms, options);
    const {[conditionalBreakdown]: modifiers, ...finalOptions} = options;
    return original(terms, {...finalOptions, modifiers: [...finalOptions.modifiers ?? [], ...modifiers]});
  }
  // The native dialog builds a preview and then a final roll. Only the
  // original first term is registered, so conditional damage is added once.
  const copies = terms.map(term => foundry.dice.terms.RollTerm.fromData(foundry.utils.deepClone(term.toJSON())));
  const roll = original(copies, {...options, [MODULE_ID]: state.snapshot});
  let context = state.rollContext;
  if (damage) {
    const acing = state.shot.kind !== "item" && !state.noAcing;
    const rules = sharedDamageRules(context);
    context = applyDamageFormula(roll, context, rules, acing);
    roll.options[conditionalBreakdown] = rules.filter(rule => ["add", "subtract"].includes(rule.type ?? "add"))
      .map(rule => ({label: rule.label, value: rule.type === "subtract" ? `-${rule.formula ?? rule.value}` : rule.formula ?? rule.value}));
  } else {
    roll.targetNumber = state.snapshot.targetNumber;
  }
  return setRollContext(roll, context);
}

function renderRollPicker(app, root) {
  const state = dialogStates.get(app);
  const presets = root.querySelector(".presets");
  if (!state || !presets || root.querySelector(".bcs-roll-picker")) return;
  if (!state.linked && !state.groups.locations.length && !state.groups.items.length) return;
  const doc = root.ownerDocument;
  const row = doc.createElement("div");
  row.className = "presets bcs-roll-picker";
  const toggle = doc.createElement("button");
  toggle.type = "button";
  toggle.className = "toggle-list";
  toggle.setAttribute("aria-label", "Called Shot");
  toggle.setAttribute("aria-expanded", "false");
  toggle.dataset.tooltip = state.target.name;
  toggle.disabled = !!state.linked;
  const caret = doc.createElement("i");
  caret.className = "fa-solid fa-caret-right";
  toggle.append(caret, state.shot ? `Called Shot · ${state.shot.name}` : "Called Shot");
  const dropdown = doc.createElement("div");
  dropdown.className = "dropdown";
  dropdown.id = `${app.id}-called-shot`;
  dropdown.hidden = true;
  toggle.setAttribute("aria-controls", dropdown.id);
  const choices = doc.createElement("ol");
  choices.className = "selections unmarked-list";
  dropdown.append(choices);
  row.append(toggle, dropdown);
  presets.after(row);
  const messageMode = root.querySelector("#messageMode");
  if (state.messageMode) messageMode.value = state.messageMode;
  messageMode.addEventListener("change", () => { state.messageMode = messageMode.value; });
  for (const input of root.querySelectorAll(".modifiers input[data-index]")) {
    if (state.replaced.has(app.ctx.mods[Number(input.dataset.index)])) input.closest("li").hidden = true;
  }

  const addChoice = (id, label) => {
    const entry = doc.createElement("li");
    entry.className = "modifier";
    const button = doc.createElement("button");
    button.type = "button";
    button.dataset.shotId = id;
    button.textContent = label;
    if ((state.shot?.id ?? "") === id) button.setAttribute("aria-current", "true");
    button.addEventListener("click", () => {
      state.selected = id;
      state.messageMode = messageMode.value;
      void app.render({force: true});
    });
    entry.append(button);
    choices.append(entry);
  };
  addChoice("", "None");
  for (const [label, shots] of [["Body locations", state.groups.locations], ["Items", state.groups.items]]) {
    if (!shots.length) continue;
    const heading = doc.createElement("li");
    heading.className = "group-header";
    heading.textContent = label;
    choices.append(heading);
    for (const shot of shots) {
      const modifier = app.isDamageRoll ? shot.damage : attackModifier(shot, scaleOf(state.actor));
      addChoice(shot.id, `${shot.name} (${signed(modifier)})`);
    }
  }
  const show = visible => {
    if (visible) dropdown.style.width = doc.defaultView.getComputedStyle(toggle).width;
    dropdown.hidden = !visible;
    toggle.setAttribute("aria-expanded", String(visible));
    caret.classList.toggle("rotate", visible);
  };
  toggle.addEventListener("click", () => show(dropdown.hidden));
  row.addEventListener("focusout", event => { if (!row.contains(event.relatedTarget)) show(false); });
  row.addEventListener("keydown", event => {
    if (event.key !== "Escape" || dropdown.hidden) return;
    event.stopPropagation();
    show(false);
    toggle.focus();
  });
  if (!app.isDamageRoll) return;
  const objectShot = state.shot?.kind === "item";
  const noAcing = root.querySelector('[name="noAcing"]');
  noAcing.checked = objectShot || state.noAcing;
  noAcing.disabled = objectShot;
  noAcing.addEventListener("change", () => { state.noAcing = noAcing.checked; });
  const raise = root.querySelector('button[name="extra"]');
  if (raise) raise.disabled = raise.hidden = objectShot || !!state.linked;
  const submit = root.querySelector("button.submit-roll");
  if (state.linked && !state.shot && submit) submit.disabled = true;
}

export function getCalledShot(message) {
  return message.getFlag(MODULE_ID, "shot") ?? message.significantRoll?.options?.[MODULE_ID];
}

export function attackOutcomes(message, shot) {
  const roll = message.significantRoll;
  const adjustment = Number(message.flags?.["swade-tools"]?.gmmod) || 0;
  const critical = criticalFailure(roll);
  const pool = roll.terms[0];
  if (!Array.isArray(pool?.rolls)) return [rollOutcome(roll.total + adjustment, shot.targetNumber, critical)];
  const modifier = roll.total - pool.total + adjustment;
  return pool.rolls.filter((_die, index) => pool.results[index]?.active && !pool.results[index].discarded)
    .map(die => rollOutcome(die.total + modifier, shot.targetNumber, critical));
}

export async function rollShotDamage(message, raisedAttack, actionId) {
  const shot = getCalledShot(message);
  if (!shot) return;
  const target = resolve(shot?.tokenUuid);
  if (!allShots(target?.actor).some(entry => entry.id === shot.id)) {
    return ui.notifications.warn("That called shot is no longer available on the original target.");
  }
  const weapon = resolve(shot.weaponUuid);
  const action = weapon?.system.actions?.additional?.[actionId];
  const damageAction = action?.type === "damage" ? action : null;
  if (!weapon?.isOwner || !(damageAction?.override || weapon.system.damage)) return ui.notifications.warn("The weapon for this attack is no longer available.");
  const damageMod = game.swade.itemChatCardHelper.getDamageMod(weapon);
  const additionalMods = damageMod ? [damageMod] : [];
  if (damageAction?.modifier) additionalMods.push({label: damageAction.name, value: damageAction.modifier});
  return weapon.rollDamage({additionalMods, dmgOverride: damageAction?.override, ap: damageAction?.ap,
    isHeavyWeapon: damageAction?.isHeavyWeapon, flavour: damageAction?.name,
    [MODULE_ID]: {...shot, raisedAttack: shot.kind === "location" && raisedAttack}});
}

export function installRolls() {
  const {RollDialog} = game.swade;
  const {TraitRoll, DamageRoll} = CONFIG.Dice;
  Hooks.on("swadePreRollSkill", captureTrait);
  Hooks.on("swadePreRollAttribute", captureTrait);
  Hooks.on("swadeRollDamage", (_actor, _item, roll, mods, options) => {
    const linked = options?.[MODULE_ID];
    if (!linked) return;
    linkedRolls.set(roll, linked);
    const current = game.user.targets.first()?.document;
    if (current?.uuid === linked.tokenUuid) return;
    const original = new Set(current?.actor?.system.stats?.globalMods.targetDamage ?? []);
    for (let index = mods.length - 1; index >= 0; index--) {
      if (original.has(mods[index])) mods.splice(index, 1);
    }
    const target = resolve(linked.tokenUuid);
    mods.push(...target?.actor?.system.stats?.globalMods.targetDamage ?? []);
  });
  wrap(RollDialog.prototype, "_prepareContext", async function (original, ...args) {
    const state = prepareDialog(this);
    const context = await original(...args);
    if (state?.shot?.kind === "item" && this.isDamageRoll) context.noAcing = true;
    return context;
  });
  wrap(RollDialog.prototype, "_onRender", async function (original, ...args) {
    await original(...args);
    renderRollPicker(this, this.element);
  });
  wrap(TraitRoll, "fromTerms", function (original, terms, options) { return buildShotRoll(original, terms, options, false); });
  wrap(DamageRoll, "fromTerms", function (original, terms, options) { return buildShotRoll(original, terms, options, true); });

  const acing = Object.getOwnPropertyDescriptor(DamageRoll.prototype, "acing");
  Object.defineProperty(DamageRoll.prototype, "acing", {...acing, set(value) {
    acing.set.call(this, this.options[MODULE_ID]?.kind === "item" ? false : value);
  }});
  Hooks.on("preCreateChatMessage", message => {
    const shot = getCalledShot(message);
    if (!shot) return;
    message.updateSource({
      [`flags.${MODULE_ID}.shot`]: shot,
      "flags.swade.targets": [{uuid: shot.tokenUuid, name: shot.tokenName}]
    });
  });
}
