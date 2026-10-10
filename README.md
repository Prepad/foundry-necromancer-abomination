# Foundry necromancer abomination

Foundry VTT 13 / D&D 5e 5.2.4.

Install via Setup > Add-on Modules > Install Module > Manifest URL:

https://raw.githubusercontent.com/Prepad/foundry-necromancer-abomination/main/module.json

Enable boundary-flesh in Manage Modules. Import the feature and Script macros from imports/.
The GM selects the necromancer token and runs the summon macro.
The free summon recovers after a completed long rest.

Summoning has two steps:

1. Choose the spell slots to sacrifice. Each gives upgrade points equal to its
   level: a 1st-level slot gives 1 point, a 2nd-level slot gives 2, and so on.
   Pact slots use their current level. The separate slot paying for a repeat
   summon gives no upgrade points.
2. Allocate all points. Each point gives +1d6 necrotic damage, +2 AC, or +15 HP.
   The dialog shows the remaining points and resulting statistics. Use Back to
   change the sacrificed slots, or Cancel to abandon the summon without spending
   resources. Slots are charged only on final confirmation and successful creation.

Reimport imports/01-summon-feature.json to update the feature's rules text.
An existing feature with the original identifier still works with the updated module.

Module version: 1.0.3. Local checks passed; live Foundry testing pending.

Run the rules and simulated Foundry/dialog checks with Node.js:

```powershell
node --experimental-vm-modules --test tests/rules.test.mjs tests/summon.test.mjs
```

Artwork: the aberration uses a custom portrait and a separate square token image
from boundary-flesh/assets/. After a GM reloads the updated module, its existing
summons still using the original built-in image receive the new artwork.
Custom images selected manually are preserved. Existing manually imported NPC
templates can be reimported from imports/02-aberration-actor.json.

The feature and summon/dismiss macros use assets/summon-feature.png: a warm sepia
oil-painting icon matching the supplied reference. Existing features and matching
macros with the old built-in image also receive the new icon when the GM reloads.
