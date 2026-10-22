#!/usr/bin/env node
// Publishes "Borovje – urbani blokovi", an alternative to UPU Borovje – zona jug on the same eleven
// building plots (kazete M1-1…M1-11): the official streets, parcel layouts and parks (the same design
// objects, so the same CIDs) with an open urban block on each plot instead of the plan's free-standing
// slab, and one agreement over them, through backend/scripts/lib/restatement-publish.mjs. The blocks
// are computed from the plots of the current version (borovje-designs.mjs).
//
//   node build-urban-blocks.mjs --dry-run
//   node build-urban-blocks.mjs --designs --api <api> [--origin <app>] --apply
//   node build-urban-blocks.mjs --capture --app <app> --api <api>
//   node build-urban-blocks.mjs --agreement --api <api> [--origin <app>] [--app <app>] --apply

import { log, runRestatementCli } from '../../backend/scripts/lib/restatement-publish.mjs';
import { PLAN_KEYS, urbanBlocksPlan } from './borovje-designs.mjs';

await runRestatementCli({
    script: 'restatements/upu-borovje/build-urban-blocks.mjs',
    describe: 'the "Borovje – urbani blokovi" alternative',
    planKeys: [PLAN_KEYS.urbanBlocks],
    plans: async () => {
        const plan = await urbanBlocksPlan();
        log(`urban blocks: ${plan.blocks.buildings} buildings, footprint ${plan.blocks.footprintM2} m², floor area ${plan.blocks.floorAreaM2} m²`);
        return [plan];
    }
});
