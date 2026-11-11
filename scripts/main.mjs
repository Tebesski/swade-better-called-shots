import {MODULE_ID, actorShots, addDamageRules, addTargetFlags, generatedGearFlags, isGear} from "./shots.mjs";
import {loadDisarmRule} from "./disarm.mjs";
import {openCalledShots, refreshCalledShots, renderActorButton, renderGearFields} from "./sheets.mjs";
import {installRolls} from "./rolls.mjs";
import {installDamage} from "./damage.mjs";

Hooks.once("setup", () => {
  installRolls();
  installDamage();
  game.modules.get(MODULE_ID).api = Object.freeze({actorShots, openCalledShots});
});
Hooks.once("ready", () => { void loadDisarmRule(); });
Hooks.on("swadeBetterEffectsAutomaticFlags", (item, flags) => { flags.push(...generatedGearFlags(item)); });
Hooks.on("swadeBetterEffectsTargetFlags", addTargetFlags);
Hooks.on("swadeBetterEffectsDamageRules", addDamageRules);
Hooks.on("updateActor", refreshCalledShots);
for (const event of ["createItem", "updateItem", "deleteItem"]) {
  Hooks.on(event, item => { if (isGear(item) && item.actor) refreshCalledShots(item.actor); });
}
Hooks.on("renderApplicationV2", (app, root) => {
  renderActorButton(app, root);
  renderGearFields(app, root);
});
