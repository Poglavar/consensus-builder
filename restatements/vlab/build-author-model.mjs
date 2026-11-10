#!/usr/bin/env node
// Publishes the local vLAB variant whose building is the author's own model with its interiors
// (prepare-model.mjs: cache/model-placement.json and cache/model-upload.json), through
// backend/scripts/lib/restatement-publish.mjs. Local only: the uploaded model is the author's work, and
// both its upload and this plan's ground file stay in the gitignored cache/.
//
//   node build-author-model.mjs --dry-run
//   node build-author-model.mjs --designs --api <api> [--origin <app>] --apply
//   node build-author-model.mjs --capture --app <app> --api <api>
//   node build-author-model.mjs --agreement --api <api> [--origin <app>] [--app <app>] --apply

import { readFile } from 'node:fs/promises';
import { runRestatementCli } from '../../backend/scripts/lib/restatement-publish.mjs';
import { PLAN_KEY, vlabModelPlan } from './vlab-designs.mjs';

const cached = async name => JSON.parse(await readFile(new URL(`./cache/${name}`, import.meta.url), 'utf8'));

await runRestatementCli({
    script: 'restatements/vlab/build-author-model.mjs',
    describe: 'the vLAB plan with the author\'s building model',
    planKeys: [`${PLAN_KEY}-autorov-model`],
    plans: async () => {
        const [placement, upload] = await Promise.all([cached('model-placement.json'), cached('model-upload.json')]);
        if (upload.sha256 !== placement.sha256) throw new Error('cache/model-upload.json is not the upload of the built model (run prepare-model.mjs --upload)');
        return [vlabModelPlan({ modelUrl: upload.modelUrl, modelOrigin: placement.modelOrigin, rotation: placement.rotation })];
    }
});
