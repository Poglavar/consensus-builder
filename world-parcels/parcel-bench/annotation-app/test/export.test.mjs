import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { buildHumanReviewExport, exportReviews } from '../export_reviews.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cleanup = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'annotation-export-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const bundleDir = join(root, 'bundle');
    await mkdir(join(bundleDir, 'images'), { recursive: true });
    const image = Buffer.from('verified test jpeg');
    await writeFile(join(bundleDir, 'images', 'ortho-1.jpg'), image);
    const payload = {
        schema: 'plot-review-batch-v1', id: 'commute-review-v1', title: 'Visible ground divisions',
        coordinate_convention: 'image-edge pixels; origin top-left; x right; y down', evaluation_role: 'unassigned',
        samples: [{ id: 'ortho-1', title: 'Test ortho', image: 'images/ortho-1.jpg', image_sha256: hash(image), width: 100, height: 80,
            bbox: [500000.25, 5000000.5, 500010.25, 5000008.5], crs: 'EPSG:3765', source_id: 'source-1', source_url: 'https://example.invalid/item/1',
            attribution: 'Imagery provider', license: 'Research use', producer: 'Provider', acquisition_start: '2025-01-01T00:00:00Z' }],
        tasks: [
            { id: 'task-separate', sample_id: 'ortho-1', a: [20, 20], b: [70, 60] },
            { id: 'task-same', sample_id: 'ortho-1', a: [22, 22], b: [73, 62] },
            { id: 'task-unclear', sample_id: 'ortho-1', a: [25, 20], b: [75, 60] },
        ],
    };
    const batch = { ...payload, batch_hash: hash(Buffer.from(JSON.stringify(payload))) };
    await writeFile(join(bundleDir, 'batch.json'), JSON.stringify(batch));
    const record = (id, relation, patch = {}) => ({ id, revision: 1, mutation_id: randomUUID(), updated_at: '2026-10-19T12:00:00.000Z', value: {
        id, sample_id: 'ortho-1', a: [20, 20], b: [70, 60], relation, trace: [[30, 30], [40, 35], [60, 50]], note: `Human note for ${id}`, ...patch,
    } });
    const input = { schema: 'plot-review-export-v1', batch_hash: batch.batch_hash, batch, reviews: [
        record('task-separate', 'separate'), record('task-same', 'same_surface'), record('task-unclear', 'unclear'),
    ] };
    return { root, bundleDir, batch, input, record };
}

describe('human review export', () => {
    it('emits only scored relations as probes and retains uncertainty, trace and provenance separately', async () => {
        const { bundleDir, input, batch } = await fixture();
        const result = await buildHumanReviewExport({ input, bundleDir });
        assert.equal(result.schema, 'human-visible-divisions-v1');
        assert.equal(result.review_status, 'human-reviewed');
        assert.equal(result.evaluation_role, 'unassigned');
        assert.equal(result.provenance.batch_hash, batch.batch_hash);
        assert.equal(result.provenance.verified_image_hashes, true);
        const sample = result.samples[0];
        assert.equal(sample.review_status, 'has-human-observations');
        assert.equal(sample.starting_task_status, 'all-reviewed');
        assert.equal(sample.starting_tasks_reviewed, 3);
        assert.equal(sample.probes.length, 2);
        assert.deepEqual(sample.probes.map(probe => probe.relation), ['same_surface', 'separate']);
        assert.deepEqual(sample.probes[1].evidence.trace, [[30, 30], [40, 35], [60, 50]]);
        assert.equal(sample.probes[1].evidence.coordinate_space, 'image-edge-pixels');
        assert.equal(sample.uncertain_reviews.length, 1);
        assert.equal(sample.uncertain_reviews[0].relation, 'unclear');
        assert.equal('confidence' in sample.probes[0], false);
        assert.match(result.limitations.join(' '), /not complete parcel boundaries/);
    });

    it('preserves phone backup pending-sync status and refuses unresolved conflicts', async () => {
        const { bundleDir, input } = await fixture();
        input.origin = 'phone-backup';
        input.exported_at = '2026-10-19T12:30:00.000Z';
        input.reviews = input.reviews.map((record, index) => ({ ...record, mutation_id: undefined,
            updated_at: undefined, pending_sync: index !== 1, conflict: null }));
        const result = await buildHumanReviewExport({ input, bundleDir });
        assert.equal(result.provenance.source_kind, 'phone-backup');
        assert.deepEqual(result.provenance.pending_sync_review_ids, ['task-separate', 'task-unclear']);
        assert.equal(result.samples[0].probes.find(probe => probe.id === 'task-separate').sync_status, 'pending-sync-backup');
        input.reviews[0].conflict = { revision: 4 };
        await assert.rejects(buildHumanReviewExport({ input, bundleDir }), /Unresolved review conflict/);
    });

    it('rejects mismatched batch contents, duplicate reviews, invalid relation data, and image drift', async () => {
        const { bundleDir, input, record } = await fixture();
        await assert.rejects(buildHumanReviewExport({ input: { ...input, batch_hash: 'f'.repeat(64) }, bundleDir }), /not bound to this batch/);
        await assert.rejects(buildHumanReviewExport({ input: { ...input, reviews: [...input.reviews, input.reviews[0]] }, bundleDir }), /duplicate review id/);
        await assert.rejects(buildHumanReviewExport({ input: { ...input, reviews: [record('task-separate', 'maybe')] }, bundleDir }), /Invalid review/);
        await writeFile(join(bundleDir, 'images/ortho-1.jpg'), 'changed image');
        await assert.rejects(buildHumanReviewExport({ input, bundleDir }), /image hash mismatch/);
    });

    it('writes a standalone export and marks unreviewed imagery without inventing labels', async () => {
        const { root, bundleDir, input } = await fixture();
        input.reviews = input.reviews.slice(0, 1);
        const inputPath = join(root, 'server-snapshot.json'), outputPath = join(root, 'human-visible-divisions.json');
        await writeFile(inputPath, JSON.stringify(input));
        const summary = await exportReviews({ inputPath, outputPath, bundleDir });
        const saved = JSON.parse(await readFile(outputPath, 'utf8'));
        assert.equal(summary.probes, 1);
        assert.equal(saved.samples[0].review_status, 'has-human-observations');
        assert.equal(saved.samples[0].starting_task_status, 'incomplete');
        assert.equal(saved.samples[0].starting_tasks_reviewed, 1);
        assert.equal(saved.samples[0].uncertain_reviews.length, 0);
        await assert.rejects(exportReviews({ inputPath, outputPath: join(bundleDir, 'export.json'), bundleDir }), /outside the immutable bundle/);
    });
});
