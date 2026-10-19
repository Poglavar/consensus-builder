#!/usr/bin/env node
import { readFile, mkdir, writeFile, copyFile, access } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { SCHEMA, validateBatch } from './public/model.mjs';

const bench = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function prepare(destination, root = bench) {
  // New immutable bundles only: changing a batch underneath saved reviews is an error.
  try { await access(join(destination, 'batch.json')); throw new Error('Bundle already exists; choose a new destination'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const targets = JSON.parse(await readFile(join(root, 'annotations/target-review-v1.json')));
  const drafts = JSON.parse(await readFile(join(root, 'annotations/visible-divisions-v1.json')));
  const samples = [], tasks = [], files = [];
  for (const [document, target] of [[targets, true], [drafts, false]]) {
    for (const sample of document.samples) {
      const source = join(root, 'output', target ? 'target-review-v1' : 'pool/nearby-donor-v1/dataset', sample.image);
      const bytes = await readFile(source);
      if (hash(bytes) !== sample.image_sha256) throw new Error(`Image changed: ${sample.id}`);
      samples.push({ id: sample.id, title: target ? sample.id.replaceAll('-', ' ') : `Croatia · ${sample.id.replaceAll('_', ' ')}`,
        image: `images/${sample.id}.jpg`, image_sha256: sample.image_sha256, width: sample.width, height: sample.height,
        bbox: sample.bbox, crs: sample.crs || document.crs, source_id: sample.source_id || sample.region,
        source_url: sample.item_url || null, license: sample.license || 'Project research permission (2026-10-12)',
        attribution: sample.attribution || 'Croatian orthophoto providers; project research imagery',
        producer: sample.producer || null, acquisition_start: sample.acquisition_start || null,
        cohort: target ? 'target-candidate' : 'croatian-development' });
      files.push({ source, destination: join(destination, `images/${sample.id}.jpg`) });
      if (target) tasks.push({ id: `${sample.id}_pair1`, sample_id: sample.id, a: null, b: null, origin: 'human-placement' });
      else for (const probe of sample.probes) tasks.push({ id: `${sample.id}_${probe.id}`, sample_id: sample.id,
        a: probe.a, b: probe.b, origin: 'agent-suggested-pair' });
      // Deliberately omit the agent's answers, confidence, and evidence from the phone batch.
    }
  }
  const payload = { schema: SCHEMA, id: 'commute-review-v1', title: 'Visible ground divisions',
    coordinate_convention: 'image-edge pixels: origin top-left, x right, y down; bbox is outer image extent',
    evaluation_role: 'unassigned', limitations: targets.limitations, samples, tasks };
  const batch = validateBatch({ ...payload, batch_hash: hash(JSON.stringify(payload)) });
  await mkdir(join(destination, 'images'), { recursive: true });
  for (const file of files) await copyFile(file.source, file.destination);
  await writeFile(join(destination, 'batch.json'), `${JSON.stringify(batch, null, 2)}\n`);
  return batch;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = resolve(process.argv[2] || join(bench, 'output/annotation-bundle-v1'));
  const batch = await prepare(output);
  console.log(`Prepared ${batch.samples.length} images and ${batch.tasks.length} tasks; batch ${batch.batch_hash.slice(0, 12)}.`);
}
