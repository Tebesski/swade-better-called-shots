import {catalogFlags} from "../../swade-better-effects/scripts/flags.mjs";
import {normalizeFlags, normalizePattern} from "../../swade-better-effects/scripts/rules.mjs";
import {cleanRollNote} from "../../swade-better-effects/scripts/roll-notes.mjs";
import {ChoicePicker} from "../../swade-better-setting/scripts/picker.mjs";
import {MODULE_ID, MODES, SCALES, actorLocations, actorShots, attackModifier, damageRuleSettings, gearSettings, isCreature, isGear, rollNotes,
  scaleLabel, shotFlags, signed} from "./shots.mjs";
import {disarmRuleLink, loadDisarmRule} from "./disarm.mjs";

const {ApplicationV2, DialogV2, HandlebarsApplicationMixin} = foundry.applications.api;
const editors = new WeakMap();
const STAGES = {attack: "Attack", damage: "Damage"};
const OUTCOMES = {any: "Any", success: "Success or raise", failure: "Failure", critical: "Critical failure",
  raise: "Any raise", exact: "Exact raises"};

const report = error => ui.notifications.error(error.message, {console: true});
const field = (row, key) => row.querySelector(`[data-field="${key}"]`);
const noteField = (row, key) => row.querySelector(`[data-note-field="${key}"]`);
const readNumber = input => Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : 0;
const getRoute = file => foundry.utils.getRoute(`modules/${MODULE_ID}/${file}`);

function node(doc, tag, content) {
  const element = doc.createElement(tag);
  if (content !== undefined) element.textContent = content;
  return element;
}

async function pickScale(current, onSelect) {
  const doc = current.ownerDocument;
  const section = node(doc, "div");
  section.className = "sbs-size-picker-content bcs-scale-picker";
  const scroll = node(doc, "div");
  scroll.className = "sbs-size-table-scroll";
  const table = node(doc, "table");
  table.setAttribute("aria-label", "Scale table");
  const header = table.createTHead().insertRow();
  for (const title of ["Scale", "Modifier", "Example items"]) {
    const th = node(doc, "th", title);
    th.scope = "col";
    header.append(th);
  }
  const body = table.createTBody();
  const buttons = new Map();
  for (const {value, label, examples} of SCALES) {
    const row = body.insertRow();
    row.dataset.size = String(value);
    const name = node(doc, "th");
    name.scope = "row";
    const button = node(doc, "button", label);
    button.type = "button";
    if (value === (current.value === "" ? Number(current.placeholder) : current.valueAsNumber)) button.setAttribute("aria-current", "true");
    name.append(button);
    row.append(name, node(doc, "td", signed(value)), node(doc, "td", examples));
    buttons.set(button, value);
  }
  scroll.append(table);
  section.append(scroll);
  const app = new DialogV2({
    classes: ["sbs-setting-dialog", "sbs-npc-size-picker"],
    window: {title: "Scale Table", resizable: true},
    position: {width: 490, height: "auto"},
    content: "<div></div>",
    buttons: [{action: "close", label: "Close"}]
  });
  await app.render({force: true});
  app.element.querySelector(".dialog-content").replaceChildren(section);
  for (const [button, value] of buttons) button.addEventListener("click", () => {
    current.value = String(value);
    onSelect();
    void app.close();
  });
}

function pickFlag(input, shot) {
  const used = new Set([...normalizeFlags(input.value), ...shotFlags({...shot, flags: []})]);
  const choices = catalogFlags().filter(flag => !used.has(flag)).map(flag => ({key: flag, name: flag}));
  return new ChoicePicker({
    choices,
    window: {title: "Pick a Flag"},
    onSelect: flag => {
      if (!input.isConnected) return;
      input.value = normalizeFlags([...normalizeFlags(input.value), flag]).join(", ");
      input.dispatchEvent(new Event("change", {bubbles: true}));
    }
  }).render({force: true});
}

class CalledShotsEditor extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    tag: "form", classes: ["sbs-setting-dialog", "bcs-editor"], position: {width: 650, height: 635},
    window: {title: "Called Shots", icon: "fa-solid fa-crosshairs", resizable: true},
    form: {handler: async function () { await this.save(); }, closeOnSubmit: false}
  };
  static PARTS = {body: {template: `modules/${MODULE_ID}/templates/editor.hbs`, scrollable: [".bcs-editor-scroll"]}};

  constructor(actor) {
    super();
    this.actor = actor;
  }

  get title() {
    return `Called Shots · ${this.actor.name}`;
  }

  async _prepareContext(options) {
    await loadDisarmRule();
    const {locations, items} = actorShots(this.actor);
    this.shots = new Map([...locations, ...items].map(shot => [shot.id, shot]));
    const present = shot => ({
      ...shot, armourInput: shot.deriveArmour ? shot.armour : shot.armourOverride,
      scaleInput: shot.item ? shot.scaleOverride : shot.scale, customFlags: shot.flags.join(", "), baseFlags: shotFlags({...shot, flags: []}),
      summary: [shot.item ? `Hardness ${shot.hardness}` : `Armour ${shot.armour}`,
        `Attack ${signed(attackModifier(shot, 0))}`, `Damage ${signed(shot.damage)}`].join(" · "),
      modes: shot.item ? MODES.map(mode => ({...mode, value: shot.adjustments[mode.key]})) : [],
      notes: rollNotes(shot, disarmRuleLink()).map(note => ({...note, exact: note.outcome === "exact"}))
    });
    return {...await super._prepareContext(options), appId: this.id, editable: this.actor.isOwner,
      stages: STAGES, outcomes: OUTCOMES, helmets: {opened: "Opened helmet", closed: "Closed helmet"},
      groups: [
        {label: "Body locations", shots: locations.map(present)},
        {label: "Items", shots: items.map(present)}
      ]};
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element.querySelector(".bcs-editor-content");
    const open = root.querySelector(`[data-shot-id="${CSS.escape(this.openId ?? "")}"]`);
    if (open) open.open = true;
    if (!this.actor.isOwner) return;
    root.addEventListener("click", event => {
      const button = event.target.closest("button");
      if (!button) return;
      const row = button.closest(".bcs-shot");
      if (button.hasAttribute("data-bcs-pick-scale")) {
        const scale = field(row, "scale");
        void pickScale(scale, () => scale.dispatchEvent(new Event("change", {bubbles: true}))).catch(report);
      } else if (button.hasAttribute("data-bcs-pick-flag")) {
        void pickFlag(field(row, "flags"), this.shots.get(row.dataset.shotId)).catch(report);
      } else if (button.hasAttribute("data-bcs-add-note")) {
        this.dirty = true;
        const notes = row.querySelector(".bcs-notes");
        notes.append(root.querySelector("template").content.cloneNode(true));
        notes.lastElementChild.querySelector("textarea").focus();
      } else if (button.hasAttribute("data-bcs-remove-note")) {
        this.dirty = true;
        button.closest(".bcs-note").remove();
      }
    });
    root.addEventListener("input", () => { this.dirty = true; });
    root.addEventListener("change", event => {
      const input = event.target;
      const row = input.closest(".bcs-shot");
      if (!row) return;
      this.dirty = true;
      const shot = this.shots.get(row.dataset.shotId);
      const helmet = field(row, "helmet");
      const preview = helmet ? actorLocations(this.actor, {headHelmet: helmet.value}).find(location => location.id === shot.id) : shot;
      switch (input.dataset.field) {
        case "helmet": {
          if (field(row, "deriveArmour").checked) field(row, "armour").value = preview.derivedArmour;
          const attack = field(row, "attack");
          if (shot.attackOverride == null && attack.value === attack.dataset.defaultAttack) {
            attack.value = preview.defaultAttack;
          }
          attack.dataset.defaultAttack = preview.defaultAttack;
          break;
        }
        case "deriveArmour": this.toggleDerived(field(row, "armour"), input.checked, preview.derivedArmour, shot.armourOverride); break;
        case "deriveScale": this.toggleDerived(field(row, "scale"), input.checked, shot.derivedScale, shot.scaleOverride);
          row.querySelector("[data-bcs-pick-scale]").disabled = input.checked; break;
        case "deriveAttack": field(row, "attack").disabled = input.checked; break;
        case "equipAffects": row.querySelector(".bcs-adjustments").hidden = !input.checked; break;
      }
      if (input.dataset.noteField === "outcome") input.closest(".bcs-note").querySelector("[data-note-raises]").hidden = input.value !== "exact";
      if (input.dataset.field || input.dataset.adjustment) this.updateSummary(row, preview);
    });
  }

  updateSummary(row, shot) {
    const attackInput = field(row, "attack");
    const scaleInput = field(row, "scale");
    const preview = {...shot, scale: scaleInput.value === "" ? shot.derivedScale : readNumber(scaleInput),
      attack: attackInput.value === "" ? shot.defaultAttack ?? 0 : readNumber(attackInput)};
    let defence;
    if (shot.item) {
      preview.deriveAttack = field(row, "deriveAttack").checked;
      preview.equipAffects = field(row, "equipAffects").checked;
      preview.adjustments = Object.fromEntries([...row.querySelectorAll("[data-adjustment]")].map(input => [input.dataset.adjustment, readNumber(input)]));
      defence = `Hardness ${readNumber(field(row, "hardness"))}`;
    } else defence = `Armour ${readNumber(field(row, "armour"))}`;
    const attack = signed(attackModifier(preview, 0));
    const damage = signed(readNumber(field(row, "damage")));
    row.querySelector(".bcs-shot-summary").textContent = `${defence} · Attack ${attack} · Damage ${damage}`;
  }

  toggleDerived(input, checked, derived, saved) {
    if (checked) input.dataset.override = input.value;
    input.value = checked ? derived : input.dataset.override ?? saved;
    input.disabled = checked;
  }

  async save() {
    if (!this.actor.isOwner || this.saving) return;
    this.saving = true;
    try {
      const locations = {};
      const itemUpdates = [];
      for (const row of this.element.querySelectorAll(".bcs-shot")) {
        const shot = this.shots.get(row.dataset.shotId);
        const notes = [];
        const defaults = new Map(rollNotes(shot, disarmRuleLink()).filter(note => note.defaultId)
          .map(({defaultId, ...note}) => [defaultId, note]));
        const defaultNoteOverrides = {};
        for (const element of row.querySelectorAll(".bcs-note")) {
          const note = {stage: noteField(element, "stage").value, outcome: noteField(element, "outcome").value,
            raises: Math.max(1, readNumber(noteField(element, "raises"))), text: cleanRollNote(noteField(element, "text").value.trim())};
          const id = element.dataset.defaultNoteId;
          if (!id) {
            if (note.text) notes.push(note);
            continue;
          }
          const baseline = defaults.get(id);
          defaults.delete(id);
          if (Object.keys(note).some(key => note[key] !== baseline?.[key])) defaultNoteOverrides[id] = note.text ? note : false;
        }
        for (const id of defaults.keys()) defaultNoteOverrides[id] = false;
        const settings = {damage: readNumber(field(row, "damage")), flags: normalizeFlags(field(row, "flags").value), notes};
        if (shot.item) {
          Object.assign(settings, {
            hardness: Math.max(0, readNumber(field(row, "hardness"))),
            deriveAttack: field(row, "deriveAttack").checked,
            attack: readNumber(field(row, "attack")), equipAffects: field(row, "equipAffects").checked,
            adjustments: Object.fromEntries([...row.querySelectorAll("[data-adjustment]")].map(input => [input.dataset.adjustment, readNumber(input)]))
          });
          const changed = Object.fromEntries(Object.entries(settings).filter(([key, value]) => JSON.stringify(shot[key]) !== JSON.stringify(value)));
          const scale = field(row, "scale");
          const scaleOverride = scale.value === "" ? null : readNumber(scale);
          if (scaleOverride !== shot.scaleOverride) changed.scale = scaleOverride;
          if (Object.keys(changed).length && this.actor.items.has(shot.item.id)) {
            itemUpdates.push({_id: shot.item.id, [`flags.${MODULE_ID}.shot`]: changed});
          }
        } else {
          const attack = field(row, "attack");
          const useDefaultAttack = attack.value === "" ||
            (shot.attackOverride == null && attack.value === attack.dataset.defaultAttack);
          Object.assign(settings, {
            deriveArmour: field(row, "deriveArmour").checked, deriveScale: field(row, "deriveScale").checked,
            attack: useDefaultAttack ? null : readNumber(attack)
          });
          if (!settings.deriveArmour) settings.armour = Math.max(0, readNumber(field(row, "armour")));
          if (!settings.deriveScale) settings.scale = readNumber(field(row, "scale"));
          if (shot.hasHelmet) settings.helmet = field(row, "helmet").value;
          const baseline = {...shot, attack: shot.attackOverride ?? null, armour: shot.armourOverride, scale: shot.scaleOverride};
          if (shot.deriveArmour && !settings.deriveArmour) delete baseline.armour;
          if (shot.deriveScale && !settings.deriveScale) delete baseline.scale;
          const changed = Object.fromEntries(Object.entries(settings).filter(([key, value]) => JSON.stringify(baseline[key]) !== JSON.stringify(value)));
          if (Object.keys(defaultNoteOverrides).length) changed.defaultNoteOverrides = defaultNoteOverrides;
          if (Object.keys(changed).length) locations[shot.id] = changed;
        }
      }
      if (Object.keys(locations).length) await this.actor.setFlag(MODULE_ID, "locations", locations);
      if (itemUpdates.length) await this.actor.updateEmbeddedDocuments("Item", itemUpdates);
      this.dirty = false;
      await this.close();
    } catch (error) { report(error); }
    finally { this.saving = false; }
  }
}

export async function openCalledShots(actor) {
  if (!isCreature(actor)) return;
  const existing = editors.get(actor);
  if (existing?.rendered) {
    existing.bringToFront();
    return existing;
  }
  const editor = new CalledShotsEditor(actor);
  editors.set(actor, editor);
  return editor.render({force: true});
}

export function refreshCalledShots(actor) {
  const editor = editors.get(actor);
  if (!editor?.rendered || editor.dirty || editor.saving) return;
  editor.openId = editor.element.querySelector(".bcs-shot[open]")?.dataset.shotId;
  void editor.render().catch(report);
}

export function renderActorButton(app, root) {
  if (!root.matches(".sheet") || !isCreature(app.document) || root.querySelector(".bcs-sheet-button")) return;
  const header = root.querySelector(".main-grid > .header:has(.branding), .sheet-header .charline");
  if (!header) return;
  const button = node(root.ownerDocument, "button");
  button.type = "button";
  button.className = "bcs-sheet-button";
  button.setAttribute("aria-label", "Called Shots");
  button.dataset.tooltip = "Called Shots";
  const icon = node(root.ownerDocument, "img");
  icon.src = getRoute("target.png");
  icon.alt = "";
  const hover = node(root.ownerDocument, "img");
  hover.src = getRoute("target-hover.png");
  hover.alt = "";
  hover.className = "bcs-hover-image";
  button.append(icon, hover);
  button.addEventListener("click", () => { void openCalledShots(app.document).catch(report); });
  header.append(button);
}

export function renderGearFields(app, root) {
  const item = app.document;
  if (item?.documentName !== "Item" || !isGear(item)) return;
  const properties = root.querySelector('.sheet-body [data-tab="properties"]');
  const sidebar = root.querySelector(".sheet-sidebar");
  if (!properties || !sidebar || sidebar.querySelector(".bcs-gear-stats")) return;
  const doc = root.ownerDocument;
  const values = gearSettings(item);
  const gear = node(doc, "div");
  gear.className = "bcs-gear-stats";
  const prefix = `flags.${MODULE_ID}`;
  const update = (path, value) => { void item.update({[`${prefix}.${path}`]: value}).catch(report); };
  function control(label, key, type, value, read) {
    const row = node(doc, "div");
    row.className = "form-group";
    const title = node(doc, "label", label);
    const fields = node(doc, "div");
    fields.className = "form-fields";
    const input = node(doc, "input");
    input.type = type;
    input.id = `${app.id}-bcs-${key}`;
    title.htmlFor = input.id;
    input.disabled = !app.isEditable;
    if (type === "checkbox") input.checked = value;
    else input.value = value ?? "";
    if (type === "number") input.min = "0";
    fields.append(input);
    input.addEventListener("change", event => {
      event.stopPropagation();
      if (!app.isEditable || !input.reportValidity()) return;
      update(key, read(input));
    });
    row.append(title, fields);
    return {row, fields, input};
  }
  const hardness = control("Hardness", "shot.hardness", "number", values.hardness, readNumber);
  const scale = control("Scale", "shot.scale", "number", values.scaleOverride,
    input => input.value === "" ? null : readNumber(input));
  Object.assign(scale.input, {min: "-6", max: "6", step: "2", placeholder: String(values.derivedScale)});
  scale.input.dataset.tooltip = values.scaleOverride == null && item.type === "armor" ? `${scaleLabel(values.scale)} · Derived from creature scale` : scaleLabel(values.scale);
  const pick = node(doc, "button");
  pick.type = "button";
  pick.disabled = scale.input.disabled;
  pick.setAttribute("aria-label", "Pick scale");
  pick.dataset.tooltip = "Pick scale";
  const icon = node(doc, "i");
  icon.className = "fa-solid fa-ruler";
  pick.append(icon);
  pick.addEventListener("click", () => {
    void pickScale(scale.input, () => scale.input.dispatchEvent(new Event("change", {bubbles: true}))).catch(report);
  });
  scale.fields.append(pick);
  const allow = control("Allow Called Shots", "shot.allowCalledShots", "checkbox", values.allowCalledShots, input => input.checked);
  allow.row.classList.add("inline");
  allow.fields.replaceWith(allow.input);
  gear.append(hardness.row, scale.row, allow.row);
  const toughness = sidebar.querySelector('[name="system.toughness"]')?.closest(".form-group");
  const separator = sidebar.querySelector("hr");
  if (toughness) toughness.after(gear);
  else if (separator) separator.before(gear);
  else sidebar.append(gear);

  const group = node(doc, "fieldset");
  group.className = "bcs-gear-fields";
  group.append(node(doc, "legend", "Called Shots"));
  const types = item.type === "armor" ? [["resistance", "Provides Resistance"]]
    : [["resistance", "Resistance"], ["weakness", "Weakness"]];
  for (const [key, label] of types) {
    const {value, flags} = damageRuleSettings(item, key);
    const amount = control(label, `${key}.value`, "number", value, readNumber);
    const condition = control(`${label} flags`, `${key}.flags`, "text", flags.join(", "),
      input => [...new Set(input.value.split(",").map(normalizePattern).filter(Boolean))]);
    condition.input.placeholder = "e.g. firearm";
    condition.input.dataset.tooltip = "Comma-separated damage flags. All must match. Use * to match any damage.";
    group.append(amount.row, condition.row);
  }
  properties.prepend(group);
}
