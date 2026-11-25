import {MODULE_ID} from "./shots.mjs";
import {t} from "./i18n.mjs";

const attacks = new WeakMap();
const maneuvers = {
  wildAttack: {get label() {
    const translated = game.i18n.localize("SWADE.WildAttack");
    return translated !== "SWADE.WildAttack" ? translated : t(`${MODULE_ID}.UI.WildAttack`);
  }, attack: 2, damage: 2},
  theDrop: {get label() { return t(`${MODULE_ID}.UI.TheDrop`); }, attack: 4, damage: 4},
  desperate2: {label: "SWADE.DesperateAttack.2", attack: 2, damage: -2},
  desperate4: {label: "SWADE.DesperateAttack.4", attack: 4, damage: -4}
};

export function maneuverDamageModifiers(message) {
  return (message.getFlag(MODULE_ID, "maneuvers")?.selected ?? [])
    .filter(id => Object.hasOwn(maneuvers, id))
    .map(id => ({label: maneuvers[id].label, value: maneuvers[id].damage}));
}

export function prepareManeuvers(app) {
  if (app.isAttack) attacks.set(app.ctx.roll.terms[0], {actor: app.ctx.actor ?? app.ctx.item?.actor, item: app.ctx.item});
}

export function copyManeuverSource(sourceTerm, roll) {
  const source = attacks.get(sourceTerm);
  if (source) attacks.set(roll.terms[0], source);
}

export function installManeuvers() {
  const groups = CONFIG.SWADE.rollModifiers;
  for (const id of ["calledHand", "calledHeadVitals", "calledLimbs"]) delete groups.attack.modifiers[id];
  for (const id of ["wildAttack", "theDrop"]) {
    const maneuver = maneuvers[id];
    groups.attack.modifiers[id] = {label: maneuver.label, value: maneuver.attack};
    groups.damage.modifiers[id] = {label: maneuver.label, value: maneuver.damage};
  }

  const original = CONFIG.Dice.TraitRoll.prototype.toMessage;
  CONFIG.Dice.TraitRoll.prototype.toMessage = async function (data = {}, options = {}) {
    const source = attacks.get(this.terms[0]);
    if (!source) return original.call(this, data, options);
    const selected = Object.entries(maneuvers).filter(([, maneuver]) => this.modifiers.some(mod =>
      !mod.ignore && Number(mod.value) === maneuver.attack &&
      [maneuver.label, game.i18n.localize(maneuver.label),
        ...(maneuver === maneuvers.wildAttack ? ["SWADE.WildAttack"] : [])].includes(mod.label))).map(([id]) => id);
    const messageData = foundry.utils.mergeObject(data, {flags: {[MODULE_ID]: {
      maneuvers: {selected, weaponUuid: source.item?.uuid}
    }}}, {inplace: false});
    const message = await original.call(this, messageData, options);
    if (message && options.create !== false && selected.includes("wildAttack") && source.actor?.isOwner) {
      await source.actor.toggleStatusEffect("vulnerable", {active: true});
    }
    return message;
  };

  Hooks.on("swadeBetterEffectsInlineDamageOptions", (message, projection) => {
    projection.options.additionalMods.push(...maneuverDamageModifiers(message));
  });
  Hooks.on("renderChatMessageHTML", (message, root) => {
    const saved = message.getFlag(MODULE_ID, "maneuvers");
    if (!saved?.selected?.length) return;
    root.addEventListener("click", event => {
      const button = event.target.closest(".swadetools-rolldamage");
      if (!button || message.getFlag(MODULE_ID, "shot")) return;
      const item = foundry.utils.fromUuidSync(saved.weaponUuid);
      if (!item?.isOwner) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const action = item.system.actions?.additional?.[message.flags?.["swade-tools"]?.damageaction];
      const variant = action?.type === "damage" ? action : null;
      const additionalMods = maneuverDamageModifiers(message);
      const damageMod = game.swade.itemChatCardHelper.getDamageMod(item);
      if (damageMod) additionalMods.push(damageMod);
      if (variant?.modifier) additionalMods.push({label: variant.name, value: variant.modifier});
      if (Number(button.dataset.swadetoolsRaise) > 0) additionalMods.push({label: "SWADE.BonusDamage",
        value: `+${item.system.bonusDamageDice ?? 1}d${item.system.bonusDamageDie ?? 6}x`});
      void item.rollDamage({additionalMods, dmgOverride: variant?.override, ap: variant?.ap,
        isHeavyWeapon: variant?.isHeavyWeapon, flavour: variant?.name}).catch(error => {
        console.error(error);
        ui.notifications.error(error.message);
      });
    }, {capture: true});
  });
}
