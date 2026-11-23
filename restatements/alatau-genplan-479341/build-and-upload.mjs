#!/usr/bin/env node
// Publishing steps for the Alatau general plan district restatement (README.md): the designs
// district-designs.mjs builds from the committed data (one block layout, one road in its street ground,
// eight parks) through backend/scripts/lib/restatement-publish.mjs. Every step but --dry-run writes to
// an index (--apply); the restatement is kept local (README.md).
//
//   node build-and-upload.mjs --dry-run
//   node build-and-upload.mjs --designs --api <api> [--origin <app>] --apply
//   node build-and-upload.mjs --capture --app <app> --api <api>
//   node build-and-upload.mjs --agreement --api <api> [--origin <app>] [--app <app>] --apply

import { runRestatementCli } from '../../backend/scripts/lib/restatement-publish.mjs';
import { PLAN_KEY, districtPlan } from './district-designs.mjs';

await runRestatementCli({
    script: 'restatements/alatau-genplan-479341/build-and-upload.mjs',
    describe: 'the Alatau general plan (2025) district around block 479341',
    planKeys: [PLAN_KEY],
    plans: async () => [districtPlan()]
});
