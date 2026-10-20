#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REVIEW_SCHEMA, validateBatch, validateReview } from './public/model.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const jsonHash = value => sha256(Buffer.from(JSON.stringify(value), 'utf8'));
const copy = value => JSON.parse(JSON.stringify(value));
const inside = (parent, child) => {
    const rel = relative(parent, child);
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};

async function loadBundle(bundleDir) {
    const root = resolve(bundleDir);
    const batch = JSON.parse(await readFile(join(root, 'batch.json'), 'utf8'));
    validateBatch(batch);
    const { batch_hash: _omitted, ...payload } = batch;
    if (jsonHash(payload) !== batch.batch_hash) throw new Error('Bundle batch hash does not match its contents');
    for (const sample of batch.samples) {
        const image = resolve(root, sample.image);
        if (!inside(root, image) || relative(root, image).startsWith('..')) throw new Error(`Image path escapes bundle: ${sample.id}`);
        if (sha256(await readFile(image)) !== sample.image_sha256) throw new Error(`Bundle image hash mismatch: ${sample.id}`);
    }
    return batch;
}

function recordsFrom(input) {
    if (!input || input.schema !== REVIEW_SCHEMA || !Array.isArray(input.reviews)) throw new Error('Unsupported review export schema');
    if (input.origin !== undefined && input.origin !== 'phone-backup') throw new Error('Unsupported review export origin');
    const kind = input.origin === 'phone-backup' ? 'phone-backup' : 'server-snapshot';
    return { kind, records: input.reviews };
}

function normalizeRecord(record, batch, sourceKind, seen) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid review record');
    if (typeof record.id !== 'string' || seen.has(record.id)) throw new Error(`Missing or duplicate review id: ${record?.id || '(empty)'}`);
    seen.add(record.id);
    if (!Number.isInteger(record.revision) || record.revision < 0) throw new Error(`Invalid review revision: ${record.id}`);
    if (record.conflict !== undefined && record.conflict !== null) throw new Error(`Unresolved review conflict: ${record.id}`);
    if (sourceKind === 'phone-backup' && typeof record.pending_sync !== 'boolean') throw new Error(`Missing phone backup sync status: ${record.id}`);
    if (record.pending_sync !== undefined && typeof record.pending_sync !== 'boolean') throw new Error(`Invalid phone backup sync status: ${record.id}`);
    let value;
    try { value = validateReview(record.value, batch); }
    catch (error) { throw new Error(`Invalid review ${record.id}: ${error.message}`); }
    if (value.id !== record.id) throw new Error(`Review id does not match value: ${record.id}`);
    if (sourceKind === 'server-snapshot' && (!Number.isInteger(record.revision) || record.revision < 1
        || typeof record.mutation_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.mutation_id)
        || typeof record.updated_at !== 'string')) throw new Error(`Invalid server review receipt: ${record.id}`);
    return {
        id: value.id,
        sample_id: value.sample_id,
        relation: value.relation,
        a: value.a,
        b: value.b,
        trace: value.trace,
        note: value.note,
        review_revision: record.revision,
        ...(record.mutation_id ? { mutation_id: record.mutation_id } : {}),
        ...(record.updated_at ? { updated_at: record.updated_at } : {}),
        sync_status: sourceKind === 'phone-backup' && record.pending_sync ? 'pending-sync-backup' : 'saved-to-server',
    };
}

export async function buildHumanReviewExport({ input, bundleDir }) {
    const batch = await loadBundle(bundleDir);
    if (!input || input.batch_hash !== batch.batch_hash || !input.batch) throw new Error('Review export is not bound to this batch');
    validateBatch(input.batch);
    const { batch_hash: _omitted, ...sourcePayload } = input.batch;
    if (jsonHash(sourcePayload) !== input.batch_hash || JSON.stringify(input.batch) !== JSON.stringify(batch)) throw new Error('Review export batch content does not match bundle');
    const { kind, records } = recordsFrom(input);
    const seen = new Set(), reviewed = records.map(record => normalizeRecord(record, batch, kind, seen));
    if (!reviewed.length) throw new Error('No human reviews to export');
    const tasksBySample = new Map(batch.samples.map(sample => [sample.id, new Set(batch.tasks.filter(task => task.sample_id === sample.id).map(task => task.id))]));
    const reviewsBySample = new Map(batch.samples.map(sample => [sample.id, []]));
    for (const record of reviewed) reviewsBySample.get(record.sample_id).push(record);
    const samples = batch.samples.map(sample => {
        const reviews = reviewsBySample.get(sample.id).sort((a, b) => a.id.localeCompare(b.id));
        const scored = reviews.filter(review => review.relation === 'separate' || review.relation === 'same_surface');
        const uncertain = reviews.filter(review => review.relation === 'unclear');
        const requiredTasks = tasksBySample.get(sample.id);
        const completedTasks = new Set(reviews.map(review => review.id));
        const allTasksReviewed = [...requiredTasks].every(id => completedTasks.has(id));
        return {
            id: sample.id,
            title: sample.title,
            width: sample.width,
            height: sample.height,
            bbox: copy(sample.bbox),
            crs: sample.crs,
            image: sample.image,
            image_sha256: sample.image_sha256,
            source_id: sample.source_id ?? null,
            source_url: sample.source_url ?? null,
            attribution: sample.attribution,
            license: sample.license,
            producer: sample.producer ?? null,
            acquisition_start: sample.acquisition_start ?? null,
            review_status: reviews.length === 0 ? 'not-reviewed' : 'has-human-observations',
            starting_task_status: allTasksReviewed ? 'all-reviewed' : 'incomplete',
            starting_tasks_reviewed: [...requiredTasks].filter(id => completedTasks.has(id)).length,
            starting_tasks_total: requiredTasks.size,
            probes: scored.map(review => ({
                id: review.id,
                relation: review.relation,
                a: review.a,
                b: review.b,
                evidence: { note: review.note, trace: review.trace.map(point => [...point]), coordinate_space: 'image-edge-pixels' },
                review_revision: review.review_revision,
                sync_status: review.sync_status,
                ...(review.mutation_id ? { mutation_id: review.mutation_id } : {}),
                ...(review.updated_at ? { updated_at: review.updated_at } : {}),
            })),
            uncertain_reviews: uncertain.map(review => ({
                id: review.id,
                relation: 'unclear',
                a: review.a,
                b: review.b,
                evidence: { note: review.note, trace: review.trace.map(point => [...point]), coordinate_space: 'image-edge-pixels' },
                review_revision: review.review_revision,
                sync_status: review.sync_status,
                ...(review.mutation_id ? { mutation_id: review.mutation_id } : {}),
                ...(review.updated_at ? { updated_at: review.updated_at } : {}),
            })),
        };
    });
    return {
        schema: 'human-visible-divisions-v1',
        review_status: 'human-reviewed',
        coordinate_convention: batch.coordinate_convention,
        evaluation_role: 'unassigned',
        provenance: {
            source_kind: kind,
            source_origin: input.origin ?? 'authenticated-server-snapshot',
            source_exported_at: input.exported_at ?? null,
            bundle_id: batch.id,
            batch_hash: batch.batch_hash,
            verified_image_count: batch.samples.length,
            verified_image_hashes: true,
            pending_sync_review_ids: reviewed.filter(review => review.sync_status === 'pending-sync-backup').map(review => review.id).sort(),
        },
        limitations: [
            'Human pair observations are not complete parcel boundaries or exhaustive ground truth.',
            'Unclear judgments are retained separately and excluded from scored probes.',
            'Image traces and notes are evidence coordinates, not additional labels.',
            'This export is not assigned to training, validation, or final evaluation.',
        ],
        samples,
    };
}

async function atomicWrite(path, value) {
    const target = resolve(path), dirName = dirname(target);
    await mkdir(dirName, { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    let handle;
    try {
        handle = await open(temporary, 'wx', 0o600);
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
        await handle.sync();
        await handle.close(); handle = null;
        await rename(temporary, target);
        const dir = await open(dirName, 'r');
        try { await dir.sync(); } finally { await dir.close(); }
    } finally {
        if (handle) await handle.close().catch(() => {});
        await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
}

export async function exportReviews({ inputPath, outputPath, bundleDir }) {
    const input = JSON.parse(await readFile(resolve(inputPath), 'utf8'));
    const bundle = resolve(bundleDir), output = resolve(outputPath);
    if (inside(bundle, output)) throw new Error('Output must be outside the immutable bundle');
    const document = await buildHumanReviewExport({ input, bundleDir: bundle });
    await atomicWrite(output, document);
    return { output, samples: document.samples.length,
        probes: document.samples.reduce((sum, sample) => sum + sample.probes.length, 0),
        uncertain: document.samples.reduce((sum, sample) => sum + sample.uncertain_reviews.length, 0) };
}

function parseArgs(args) {
    const values = {};
    for (let i = 0; i < args.length; i += 2) {
        if (!['--input', '--output', '--bundle'].includes(args[i]) || !args[i + 1] || values[args[i]]) throw new Error('Usage: node export_reviews.mjs --input export.json --output human-reviews.json --bundle prepared-bundle');
        values[args[i]] = args[i + 1];
    }
    if (!values['--input'] || !values['--output'] || !values['--bundle']) throw new Error('Usage: node export_reviews.mjs --input export.json --output human-reviews.json --bundle prepared-bundle');
    return { inputPath: values['--input'], outputPath: values['--output'], bundleDir: values['--bundle'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const result = await exportReviews(parseArgs(process.argv.slice(2)));
    console.log(`Wrote ${result.output}: ${result.samples} samples, ${result.probes} scored observations, ${result.uncertain} uncertain records.`);
}
