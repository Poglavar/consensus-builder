#!/usr/bin/env node
// Publishes the UPU Podbrežje restatement (README.md) as two plans over shared designs
// (podbrezje-designs.mjs, from the committed data): the whole plan on an empty site ('upu-podbrezje') and
// the part still to be built ('upu-podbrezje-preostalo'), each with one agreement, through
// backend/scripts/lib/restatement-publish.mjs.
//
//   node build-and-upload.mjs --dry-run
//   node build-and-upload.mjs --designs --api <api> [--origin <app>] --apply
//   node build-and-upload.mjs --capture --app <app> --api <api> [--only upu-podbrezje-preostalo]
//   node build-and-upload.mjs --agreement --api <api> [--origin <app>] [--app <app>] --apply

import { runRestatementCli } from '../../backend/scripts/lib/restatement-publish.mjs';
import { fullPlan, PLAN_KEYS, remainderPlan } from './podbrezje-designs.mjs';

await runRestatementCli({
    script: 'restatements/upu-podbrezje/build-and-upload.mjs',
    describe: 'the UPU Podbrežje plan (whole, and the part still to be built)',
    planKeys: [PLAN_KEYS.full, PLAN_KEYS.remainder],
    plans: async () => [fullPlan(), remainderPlan()]
});
