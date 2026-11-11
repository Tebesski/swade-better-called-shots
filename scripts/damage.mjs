import {TargetedDamageApplicator} from "../../swade-targeted-damage/modules/TargetedDamageApplicator.mjs";
import {actorWithDefense, prepareDamage} from "../../swade-better-effects/scripts/damage.mjs";
import {calculateWounds} from "../../swade-better-effects/scripts/rules.mjs";
import {damageAP, messageContext} from "../../swade-better-effects/scripts/roll-context.mjs";
import {MODULE_ID, EFFECTS, QUERY, actorLocations, locationDefence, matchesNote, rollOutcome} from "./shots.mjs";
import {attackOutcomes, getCalledShot, rollShotDamage} from "./rolls.mjs";

const open = new Map();
const posting = new Set();
const adjustment = message => Number(message.flags?.["swade-tools"]?.gmmod) || 0;
const damageTotal = message => message.significantRoll.total + adjustment(message);
const isDamage = message => message.significantRoll?.options?.rollType === "damage";
const report = error => ui.notifications.error(error.message, {console: true});
const getToken = shot => foundry.utils.fromUuidSync(shot.tokenUuid);

function locationValues(token, shot, message, damage = damageTotal(message), ap = damageAP(message)) {
  const actor = token.actor;
  const location = actorLocations(actor).find(entry => entry.id === shot.id) ?? shot;
  const defender = new Proxy(actor, {get(target, key) {
    if (key === "hasHeavyArmor") return location.heavy;
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  }});
  const context = {...messageContext(message), calledShotId: shot.id, targetUuids: [token.uuid]};
  return prepareDamage(defender, token, message, {...locationDefence(actor, location), damage, ap, context});
}

function itemOutcome(message, shot) {
  const total = damageTotal(message);
  if (shot.heavy && !shot.heavyWeapon) return {success: false, raises: 0, heavyBlocked: true};
  // Hardness must be exceeded. Item damage has no mechanical raises.
  return {success: total > shot.hardness, raises: total > shot.hardness ? Math.floor((total - shot.hardness) / 4) : 0};
}

function damageOutcome(message, shot) {
  if (shot.kind === "item") return itemOutcome(message, shot);
  const token = getToken(shot);
  if (!token?.actor) return {success: false, raises: 0};
  const values = locationValues(token, shot, message);
  return values.immune ? {success: false, raises: 0} : rollOutcome(values.damage, values.effectiveToughness);
}

class CalledShotDamage extends TargetedDamageApplicator {
  static DEFAULT_OPTIONS = {classes: ["sbe-targeted-adapter", "bcs-damage-app"]};
  static PARTS = {...TargetedDamageApplicator.PARTS, calledShot: {template: `modules/${MODULE_ID}/templates/damage.hbs`}};

  constructor(token, shot, message, key) {
    super({token, damage: damageTotal(message), ap: damageAP(message)});
    Object.assign(this, {shot, message, key});
  }

  get title() {
    return `${super.title} · ${this.shot.name}`;
  }

  get actor() {
    return this.defence ? actorWithDefense(super.actor, this.defence) : super.actor;
  }

  async calcWounds() {
    const actor = super.actor;
    this.values = locationValues(this.options.token, this.shot, this.message, this.object.damage, this.object.ap);
    const result = calculateWounds({...this.values, shaken: actor.system.status?.isShaken, hardy: actor.getFlag("swade", "hardy"),
      woundCap: game.settings.get("swade", "woundCap")});
    this.object.statusToApply = result.status;
    this.object.wounds = Math.max(0, result.wounds - (this.object.bestSoakAttempt || 0));
  }

  async _prepareContext(...args) {
    const context = await super._prepareContext(...args);
    return {...context, shot: this.shot, values: this.values, showDefence: !game.settings.get("swade-targeted-damage", "hide-defense-values")};
  }

  render(options, ...args) {
    if (options?.parts) options = {...options, parts: [...new Set([...options.parts, "calledShot"])]};
    return super.render(options, ...args);
  }

  async outputChat(message) {
    const original = {damage: this.object.damage, ap: this.object.ap};
    this.defence = this.values;
    try {
      this.object.damage = this.values.damage;
      this.object.ap = this.values.ap;
      await super.outputChat(message);
    } finally {
      Object.assign(this.object, original);
      this.defence = null;
    }
  }

  async _onClose(options) {
    if (open.get(this.key) === this) open.delete(this.key);
    return super._onClose(options);
  }
}

async function openRequest({messageUuid, tokenUuid, shot: sentShot, rollData}, {user}) {
  let message = await foundry.utils.fromUuid(messageUuid).catch(() => null);
  if (!message?.visible || message.isContentVisible === false) {
    // A GM can send a private damage roll to a defender without revealing its chat card.
    if (!user.isGM || !rollData || !Number.isFinite(rollData.total) || !Number.isFinite(rollData.ap)) {
      throw new Error("This damage roll is not accessible.");
    }
    message = {uuid: messageUuid, significantRoll: {...rollData, options: {rollType: "damage"}},
      getFlag: (scope, key) => scope === EFFECTS && key === "context" ? rollData.context
        : scope === MODULE_ID && key === "shot" ? sentShot : undefined};
  } else {
    if (!user.isGM && message.author?.id !== user.id) throw new Error("Only the roll author or a GM can send damage.");
  }
  const shot = getCalledShot(message);
  const token = shot?.tokenUuid === tokenUuid ? getToken(shot) : null;
  if (!token?.actor?.isOwner || shot?.kind !== "location" || !isDamage(message)) throw new Error("This called shot cannot be resolved.");
  const key = `${messageUuid}:${tokenUuid}`;
  const existing = open.get(key);
  if (existing?.state >= CalledShotDamage.RENDER_STATES.NONE) {
    existing.bringToFront();
    return {opened: true};
  }
  const app = new CalledShotDamage(token, shot, message, key);
  open.set(key, app);
  try { await app.render({force: true}); }
  catch (error) {
    if (open.get(key) === app) open.delete(key);
    throw error;
  }
  return {opened: true};
}

async function resolveLocationDamage(message, shot) {
  const actor = getToken(shot)?.actor;
  if (!actor) return ui.notifications.warn("The original target is no longer available.");
  const players = game.users.filter(user => user.active && !user.isGM && actor.testUserPermission(user, "OWNER"));
  const owner = players.find(user => user.character?.id === actor.id) ?? players[0] ?? (actor.isOwner ? game.user : game.users.activeGM);
  if (!owner) return ui.notifications.warn(`No connected owner can resolve damage for ${actor.name}.`);
  const roll = message.significantRoll;
  const request = {messageUuid: message.uuid, tokenUuid: shot.tokenUuid, shot, rollData: {total: damageTotal(message), ap: damageAP(message),
    isHeavyWeapon: roll.isHeavyWeapon, context: game.modules.get(EFFECTS).api.getRollContext(message)}};
  if (owner.id === game.user.id) await openRequest(request, {user: game.user});
  else {
    await owner.query(QUERY, request);
    ui.notifications.info(`Sent damage for ${actor.name} to ${owner.name}.`);
  }
}

async function renderNotes(message, root, shot, outcome) {
  const stage = isDamage(message) ? "damage" : "attack";
  const notes = shot.notes.filter(note => matchesNote(note, stage, outcome));
  if (!notes.length) return;
  const doc = root.ownerDocument;
  const section = doc.createElement("section");
  section.className = "sbe-roll-notes bcs-roll-notes";
  section.setAttribute("aria-label", "Called shot notes");
  const enrich = foundry.applications.ux.TextEditor.implementation.enrichHTML;
  for (const note of notes) {
    const entry = doc.createElement("div");
    entry.className = "sbe-roll-note";
    const label = doc.createElement("strong");
    label.className = "sbe-roll-note-label";
    label.textContent = shot.name;
    const body = doc.createElement("div");
    body.className = "sbe-roll-note-body";
    body.innerHTML = await enrich(note.text, {secrets: false, relativeTo: message.speakerActor, embeds: false});
    entry.append(label, body);
    section.append(entry);
  }
  root.append(section);
}

function renderShotCard(message, root) {
  const shot = getCalledShot(message);
  if (!shot || message.isContentVisible === false) return;
  const card = root.querySelector(".swade-roll-message");
  if (!card || root.querySelector(".bcs-shot-result")) return;
  const doc = root.ownerDocument;
  const result = doc.createElement("section");
  result.className = "bcs-shot-result";
  const caption = doc.createElement("strong");
  const canUse = message.isAuthor || game.user.isGM;
  const damage = isDamage(message);
  const attacks = damage ? [] : attackOutcomes(message, shot);
  const hits = attacks.filter(attack => attack.success);
  const outcome = damage ? damageOutcome(message, shot)
    : hits.reduce((best, attack) => attack.raises > best.raises ? attack : best, hits[0] ?? attacks[0] ?? {success: false, raises: 0});
  caption.textContent = `${shot.tokenName} · ${shot.name}`;
  result.append(caption);

  if (damage) {
    const controls = card.querySelector(".wounds-calc");
    if (shot.kind === "item") {
      controls?.remove();
      const status = doc.createElement("span");
      status.textContent = outcome.heavyBlocked ? "A Heavy Weapon is required." : outcome.success ? "Destroyed" : "Hardness held";
      result.append(status);
    } else if (canUse) {
      const original = controls?.querySelector("button");
      const button = original?.cloneNode(false) ?? doc.createElement("button");
      button.type = "button";
      button.removeAttribute("disabled");
      button.className = "bcs-resolve-damage";
      const icon = doc.createElement("i");
      icon.className = "fa-solid fa-meter-droplet";
      button.append(icon, game.i18n.localize("SWADETargetedDamage.ResolveDamage"));
      button.addEventListener("click", () => { void resolveLocationDamage(message, shot).catch(report); });
      if (controls) controls.replaceChildren(button);
      else result.append(button);
    } else {
      controls?.remove();
    }
    // Companion modules can attach their own damage actions during this render.
    // Capture them at the message root so they cannot apply item damage to an actor.
    root.addEventListener("click", event => {
      if (!event.target.closest(".calculate-wounds, .swadetools-applydamage, .swadetools-soakdamage")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (canUse && shot.kind === "location") void resolveLocationDamage(message, shot).catch(report);
    }, {capture: true});
    root.classList.add("bcs-called-damage");
  } else {
    const status = outcome.critical ? "Critical failure" : !outcome.success ? "Miss" : outcome.raises ? "Raise" : "Hit";
    const tokenId = shot.tokenUuid.split(".").at(-1);
    const existing = [...root.querySelectorAll(".swadetools-rolldamage")].some(button => button.dataset.swadetoolsTargetid === tokenId);
    if (canUse && outcome.success && shot.weaponUuid && !existing) {
      for (const [index, hit] of hits.entries()) {
        const button = doc.createElement("button");
        button.type = "button";
        button.className = "bcs-hit";
        const hitLabel = hit.raises ? "Raise" : "Hit";
        button.textContent = `${shot.tokenName}: ${hitLabel}${hits.length > 1 ? ` ${index + 1}` : ""}`;
        button.dataset.tooltip = `Roll damage against ${shot.name}`;
        button.addEventListener("click", () => {
          void rollShotDamage(message, hit.raises > 0, message.flags?.["swade-tools"]?.damageaction).catch(report);
        });
        result.append(button);
      }
    } else {
      const label = doc.createElement("span");
      label.textContent = status;
      result.append(label);
    }
    root.addEventListener("click", event => {
      const button = event.target.closest(".swadetools-rolldamage");
      if (!button) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (canUse && button.dataset.swadetoolsTargetid === tokenId) {
        void rollShotDamage(message, Number(button.dataset.swadetoolsRaise) > 0, message.flags?.["swade-tools"]?.damageaction).catch(report);
      }
    }, {capture: true});
  }
  const anchor = card.querySelector(damage ? ".wounds-calc, footer.roll-interaction" : "footer.roll-interaction");
  if (anchor) anchor.before(result);
  else card.append(result);
  void renderNotes(message, root, shot, outcome).catch(report);
}

async function announceDestruction(message, userId) {
  if (game.user.id !== userId || !isDamage(message)) return;
  const shot = getCalledShot(message);
  if (shot?.kind !== "item" || !itemOutcome(message, shot).success || posting.has(message.uuid)) return;
  posting.add(message.uuid);
  try {
    const name = foundry.utils.escapeHTML(shot.name);
    await ChatMessage.create({content: `The ${name} was destroyed`, speaker: message.speaker,
      whisper: [...message.whisper], blind: message.blind});
  } finally { posting.delete(message.uuid); }
}

export function installDamage() {
  CONFIG.queries[QUERY] = openRequest;
  Hooks.on("renderChatMessageHTML", renderShotCard);
  Hooks.on("createChatMessage", (message, _options, userId) => { void announceDestruction(message, userId).catch(report); });
}
