import {normalizeFlags, normalizePattern} from "../../swade-better-effects/scripts/rules.mjs";

export const MODULE_ID = "swade-better-called-shots";
export const EFFECTS = "swade-better-effects";
export const QUERY = `${MODULE_ID}.resolveDamage`;

export const SCALES = [
  {value: -6, label: "Tiny", examples: "Pistol, key, watch"},
  {value: -4, label: "Very Small", examples: "Dagger, holster, canteen"},
  {value: -2, label: "Small", examples: "Sword, shield, backpack"},
  {value: 0, label: "Normal", examples: "Rifle case, trunk, longbow"},
  {value: 2, label: "Large", examples: "Crate, large chest"},
  {value: 4, label: "Huge", examples: "Field cannon, wagon"},
  {value: 6, label: "Gargantuan", examples: "Siege tower, ship’s mast"}
];

export const MODES = [
  {key: "carried", label: "Carried"}, {key: "offHand", label: "Off-Hand"},
  {key: "mainHand", label: "Main Hand"}, {key: "twoHands", label: "Two Hands"}
];

const LOCATIONS = [
  {id: "hand", name: "Hand", location: "arms", attack: -4, damage: 0},
  {id: "head", name: "Head", location: "head", attack: -4, damage: 4},
  {id: "vitals", name: "Vitals", location: "torso", attack: -4, damage: 4},
  {id: "limbs", name: "Limbs", attack: -2, damage: 0},
  {id: "unarmoured-area", name: "Unarmoured Area", attack: -6, damage: 0}
];

export const isCreature = actor => ["character", "npc"].includes(actor?.type);
export const isGear = item => ["gear", "weapon", "armor", "shield", "consumable"].includes(item?.type);
export const scaleOf = actor => Number(actor?.system.stats?.scale ?? actor?.system.scale ?? 0);
export const signed = value => value > 0 ? `+${value}` : String(value);
export const scaleLabel = value => SCALES.find(scale => scale.value === value)?.label ?? signed(value);

function number(value, fallback = 0) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function equipMode(item) {
  const {OFF_HAND, EQUIPPED, MAIN_HAND, TWO_HANDS} = CONFIG.SWADE.CONST.EQUIP_STATE;
  switch (item.system.equipStatus) {
    case OFF_HAND: return MODES[1];
    case EQUIPPED: return item.type === "shield" ? MODES[1] : MODES[0];
    case MAIN_HAND: return MODES[2];
    case TWO_HANDS: return MODES[3];
    default: return MODES[0];
  }
}

export function gearSettings(item) {
  const saved = item.getFlag(MODULE_ID, "shot") ?? {};
  const derivedScale = item.type === "armor" ? scaleOf(item.actor) : -2;
  return {
    hardness: Math.max(0, number(saved.hardness, 5)),
    heavy: item.system.isHeavyArmor ?? (item.type !== "armor" && saved.heavy === true),
    allowCalledShots: saved.allowCalledShots ?? (item.type !== "armor"),
    scale: number(saved.scale, derivedScale),
    derivedScale,
    scaleOverride: saved.scale ?? null,
    deriveAttack: saved.deriveAttack !== false,
    attack: number(saved.attack),
    damage: number(saved.damage),
    equipAffects: saved.equipAffects === true,
    adjustments: Object.fromEntries(MODES.map(({key}) => [key, number(saved.adjustments?.[key])])),
    flags: Array.isArray(saved.flags) ? saved.flags : [],
    notes: Array.isArray(saved.notes) ? saved.notes : []
  };
}

export function generatedGearFlags(item) {
  if (item?.type !== "armor") return [];
  const flags = ["armor", ...Object.keys(item.system.locations).filter(key => item.system.locations[key]).map(key => `armor-${key}`)];
  if (gearSettings(item).allowCalledShots) flags.push("called-shot");
  return flags;
}

export function damageRuleSettings(item, key) {
  const saved = item.getFlag(MODULE_ID, key) ?? {};
  const flags = [...new Set((Array.isArray(saved.flags) ? saved.flags : String(saved.flags ?? "").split(","))
    .map(normalizePattern).filter(Boolean))];
  return {value: Math.max(0, number(saved.value, 4)), flags};
}

function equippedArmour(actor) {
  const {EQUIPPED} = CONFIG.SWADE.CONST.EQUIP_STATE;
  return actor.itemTypes.armor.filter(item => item.system.equipStatus === EQUIPPED && (item.system.quantity ?? 1) > 0);
}

function actorWithEquippedArmour(actor) {
  const equipped = {...actor.itemTypes, armor: equippedArmour(actor)};
  // Use SWADE's stacking and armour effects with the stricter equipment filter.
  return new Proxy(actor, {get(target, key) {
    return key === "itemTypes" ? equipped : Reflect.get(target, key, target);
  }});
}

function armourFor(actor, location, {exposedFace = false} = {}) {
  if (!location) return {armour: 0, heavy: false, worn: []};
  const worn = actor.itemTypes.armor.filter(item => item.system.locations[location]
    && (!exposedFace || item.system.isNaturalArmor));
  const armour = exposedFace
    ? worn.reduce((total, item) => total + item.system.armor, 0)
    : Math.max(0, number(actor.calcArmor(location)));
  const heavy = armour > 0 && worn.some(item => item.system.isHeavyArmor && item.system.armor > 0);
  return {armour, heavy, worn};
}

function hasVitals(actor) {
  const traits = [...actor.items].filter(item => ["ancestry", "ability", "edge"].includes(item.type));
  return !traits.some(item => ["construct", "undead"].includes(item.system.swid)
    || ["construct", "undead"].includes(item.name.trim().toLowerCase()))
    && !actor.getFlag(EFFECTS, "tags")?.includes("no-vitals");
}

export function actorLocations(actor, {headHelmet} = {}) {
  if (!isCreature(actor)) return [];
  const equipped = actorWithEquippedArmour(actor);
  const savedLocations = actor.getFlag(MODULE_ID, "locations") ?? {};
  const helmet = equipped.itemTypes.armor.some(item => item.system.locations.head && !item.system.isNaturalArmor);
  const helmetMode = (headHelmet ?? savedLocations.head?.helmet) === "opened" ? "opened" : "closed";
  const living = hasVitals(actor);
  const derivedScale = scaleOf(actor);
  return LOCATIONS.map(definition => {
    const {id, name} = definition;
    const saved = savedLocations[id] ?? {};
    // A general limb shot is aimed at the less protected of the arms and legs.
    let location = definition.location;
    if (id === "limbs") {
      const arms = armourFor(equipped, "arms"), legs = armourFor(equipped, "legs");
      location = arms.armour < legs.armour || (arms.armour === legs.armour && !arms.heavy) ? "arms" : "legs";
    }
    const hasHelmet = id === "head" && helmet;
    const exposedFace = hasHelmet && helmetMode === "opened";
    const defence = armourFor(equipped, location, {exposedFace});
    const deriveArmour = saved.deriveArmour !== false;
    const deriveScale = saved.deriveScale !== false;
    const defaultAttack = definition.attack - (exposedFace ? 1 : 0);
    return {
      id, name, kind: "location", deriveArmour, deriveScale, hasHelmet, helmet: helmetMode, exposedFace, worn: defence.worn,
      armour: deriveArmour ? defence.armour : Math.max(0, number(saved.armour, defence.armour)),
      derivedArmour: defence.armour,
      armourOverride: Math.max(0, number(saved.armour, defence.armour)),
      heavy: defence.heavy && (deriveArmour || number(saved.armour) > 0),
      scale: deriveScale ? derivedScale : number(saved.scale, derivedScale),
      derivedScale,
      scaleOverride: number(saved.scale, derivedScale),
      attack: number(saved.attack, defaultAttack),
      attackOverride: saved.attack,
      defaultAttack,
      damage: number(saved.damage, living ? definition.damage : 0),
      flags: Array.isArray(saved.flags) ? saved.flags : [],
      notes: Array.isArray(saved.notes) ? saved.notes : [],
      defaultNoteOverrides: saved.defaultNoteOverrides ?? {}
    };
  });
}

export function actorShots(actor, options) {
  if (!isCreature(actor)) return {locations: [], items: []};
  const locations = actorLocations(actor, options);
  const {CARRIED} = CONFIG.SWADE.CONST.EQUIP_STATE;
  const items = actor.items.filter(item => isGear(item) && item.system.equipStatus >= CARRIED && (item.system.quantity ?? 1) > 0)
    .map(item => ({...gearSettings(item), id: `item:${item.id}`, name: item.name, kind: "item", item, mode: equipMode(item)}))
    .filter(shot => shot.allowCalledShots)
    .sort((first, second) => first.name.localeCompare(second.name));
  return {locations, items};
}

export function allShots(actor) {
  const {locations, items} = actorShots(actor);
  return [...locations, ...items];
}

export function attackModifier(shot, attackerScale) {
  const scaleDifference = shot.scale - attackerScale;
  if (shot.kind === "location") return shot.attack + scaleDifference;
  const equip = shot.equipAffects ? shot.adjustments[shot.mode.key] : 0;
  return (shot.deriveAttack ? scaleDifference : shot.attack) + equip;
}

export function shotFlags(shot) {
  return normalizeFlags([shot.name, "called-shot", ...generatedGearFlags(shot.item), ...shot.flags]);
}

export function addTargetFlags(context, token, actor, item, flags) {
  if (!context.calledShotId || !context.targetUuids?.includes(token?.uuid)) return;
  const shot = item ? {...gearSettings(item), item, name: item.name}
    : actorLocations(actor).find(location => location.id === context.calledShotId);
  if (shot) flags.push(...shotFlags(shot));
}

export function addDamageRules(context, actor, token, item, rules) {
  if (!actor) return;
  const add = (source, key, label, type, resolutionOnly = false) => {
    const {value, flags} = damageRuleSettings(source, key);
    if (!value || !flags.length) return;
    rules.push({label: `${source.name} · ${label}`, selector: "incoming-damage", type, value, resolutionOnly,
      priority: resolutionOnly ? Number.MAX_SAFE_INTEGER : undefined,
      predicate: {op: "all", children: flags.map(flag => ({op: "flag", source: "roll", flag}))}});
  };
  if (context.targetItemId) {
    if (item && item.type !== "armor") {
      add(item, "resistance", "Resistance", "subtract");
      add(item, "weakness", "Weakness", "add");
    }
    return;
  }
  if (!isCreature(actor)) return;
  const location = context.calledShotId && context.targetUuids?.includes(token?.uuid)
    ? actorLocations(actor).find(shot => shot.id === context.calledShotId) : undefined;
  const worn = location?.worn ?? equippedArmour(actor).filter(armour => armour.system.locations.torso);
  for (const armour of worn) add(armour, "resistance", "Resistance", "subtract", true);
}

export function referenceNotes(shot, disarmLink) {
  const disarm = disarmLink || "Disarmed";
  const notes = {
    hand: [{defaultId: "hit", stage: "attack", outcome: "success", text: `The target may be ${disarm}.`},
      {defaultId: "disarm", stage: "damage", outcome: "success", text: `The target rolls Strength at −4, including Wound penalties, or is ${disarm}.`}],
    head: [{defaultId: "hit", stage: "attack", outcome: "success", text: "A hit to the head adds +4 damage against living targets."}],
    vitals: [{defaultId: "hit", stage: "attack", outcome: "success", text: "A hit to the vitals adds +4 damage against living targets."}],
    limbs: [{defaultId: "disarm", stage: "damage", outcome: "success", text: `If the shot hit an arm, the target rolls Strength at −2, including Wound penalties, or is ${disarm}.`}],
    "unarmoured-area": [{defaultId: "opening", stage: "attack", outcome: "any", text: "Choose an exposed spot. The GM sets the penalty based on the size of the opening."}]
  };
  if (shot.exposedFace) notes.head.push({defaultId: "face", stage: "attack", outcome: "any", text: "A shot to the exposed face bypasses helmet armour and applies a further −1."});
  return notes[shot.id] ?? [];
}

export function rollNotes(shot, disarmLink) {
  const defaults = referenceNotes(shot, disarmLink).flatMap(note => {
    const override = shot.defaultNoteOverrides?.[note.defaultId];
    return override === false ? [] : [{raises: 1, ...note, ...override}];
  });
  return [...defaults, ...shot.notes];
}

export function matchesNote(note, stage, outcome) {
  if (note.stage !== stage) return false;
  switch (note.outcome) {
    case "any": return true;
    case "success": return outcome.success;
    case "failure": return !outcome.success;
    case "critical": return outcome.critical;
    case "raise": return outcome.raises > 0;
    case "exact": return outcome.raises === note.raises && outcome.raises > 0;
    default: return false;
  }
}

export function rollOutcome(total, target, critical = false) {
  const success = !critical && total >= target;
  return {success, critical, raises: success ? Math.floor((total - target) / 4) : 0};
}

export function locationDefence(actor, shot) {
  const current = actor.system.stats.toughness;
  return {armor: shot.armour, toughness: Number(current.value) - Number(current.armor) + shot.armour};
}
