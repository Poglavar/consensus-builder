#!/usr/bin/env node
// Publishes the official UPU Borovje – zona jug restatement (README.md) at its current version: the
// designs borovje-designs.mjs builds from the committed data (two streets, three parcel layouts, eleven
// buildings, six parks) and one agreement over them, through backend/scripts/lib/restatement-publish.mjs.
//
//   node build-and-upload.mjs --dry-run
//   node build-and-upload.mjs --designs --api <api> [--origin <app>] --apply
//   node build-and-upload.mjs --capture --app <app> --api <api>
//   node build-and-upload.mjs --agreement --api <api> [--origin <app>] [--app <app>] --apply

import { runRestatementCli } from '../../backend/scripts/lib/restatement-publish.mjs';
import { officialPlan, PLAN_KEYS } from './borovje-designs.mjs';

await runRestatementCli({
    script: 'restatements/upu-borovje/build-and-upload.mjs',
    describe: 'the official UPU Borovje – zona jug plan',
    planKeys: [PLAN_KEYS.official],
    plans: async () => [await officialPlan()]
});
