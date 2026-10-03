# Foundry necromancer abomination

Foundry VTT 13 / D&D 5e 5.2.4.

Install via Setup > Add-on Modules > Install Module > Manifest URL:

https://raw.githubusercontent.com/Prepad/foundry-necromancer-abomination/main/module.json

Enable boundary-flesh in Manage Modules. Import the feature and Script macros from imports/.
The GM selects the necromancer token and runs the summon macro.
The free summon recovers after a completed long rest.

Module version: 1.0.2. Local checks passed; live Foundry testing pending.

Artwork: the aberration uses a custom portrait and a separate square token image
from boundary-flesh/assets/. After a GM reloads the updated module, its existing
summons still using the original built-in image receive the new artwork.
Custom images selected manually are preserved. Existing manually imported NPC
templates can be reimported from imports/02-aberration-actor.json.

The feature and summon/dismiss macros use assets/summon-feature.png: a warm sepia
oil-painting icon matching the supplied reference. Existing features and matching
macros with the old built-in image also receive the new icon when the GM reloads.
This local update has not been committed or pushed to GitHub yet.
