#!/usr/bin/env node
// Publishes the vLAB restatement (README.md): the designs vlab-designs.mjs builds from the committed data
// and one agreement over them, through backend/scripts/lib/restatement-publish.mjs.
//
//   node build-and-upload.mjs --dry-run
//   node build-and-upload.mjs --designs --api <api> [--origin <app>] --apply
//   node build-and-upload.mjs --capture --app <app> --api <api>
//   node build-and-upload.mjs --agreement --api <api> [--origin <app>] [--app <app>] --apply

import { runRestatementCli } from '../../backend/scripts/lib/restatement-publish.mjs';
import { PLAN_KEY, vlabPlan } from './vlab-designs.mjs';

await runRestatementCli({
    script: 'restatements/vlab/build-and-upload.mjs',
    describe: 'the vLAB plan (Cibona – Westin)',
    planKeys: [PLAN_KEY],
    plans: async () => [vlabPlan()]
});
