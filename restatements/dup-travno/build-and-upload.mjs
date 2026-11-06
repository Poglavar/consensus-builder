#!/usr/bin/env node
// Publishes the DUP Travno (1971) restatement (README.md): one freeform building design per building the
// plan draws (travno-designs.mjs, from the committed data) and one agreement over them, through
// backend/scripts/lib/restatement-publish.mjs.
//
//   node build-and-upload.mjs --dry-run
//   node build-and-upload.mjs --designs --api <api> [--origin <app>] --apply
//   node build-and-upload.mjs --capture --app <app> --api <api>
//   node build-and-upload.mjs --agreement --api <api> [--origin <app>] [--app <app>] --apply

import { runRestatementCli } from '../../backend/scripts/lib/restatement-publish.mjs';
import { PLAN_KEY, travnoPlan } from './travno-designs.mjs';

await runRestatementCli({
    script: 'restatements/dup-travno/build-and-upload.mjs',
    describe: 'the DUP Travno (1971) plan',
    planKeys: [PLAN_KEY],
    plans: async () => [travnoPlan()]
});
