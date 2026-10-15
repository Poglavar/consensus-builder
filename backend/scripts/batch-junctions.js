#!/usr/bin/env node
// Targeted, budgeted Anthropic Batch API recognition; raw paid responses survive rejected patches.
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { buildRoadRoutes } from '../../../cadastre-data/api/src/domains/roads/routes.js';
import { buildDeterministicSolution, storeTopologySolution, withRestrictionProblems } from '../routes/lane-topology.js';
import { buildRecognitionPrompt, TOPOLOGY_OUTPUT_SCHEMA, TOPOLOGY_PROMPT_VERSION, applyRecognitionPatch } from '../lane-topology/cli-providers.js';
import { fetchImageryCrop, resolveImagerySource, coversImageryBbox } from '../lane-topology/imagery.js';
import { TIERS, initialTier, openTargets, safeTransition, budgetedPrefix, pilotMadeProgress, bboxAroundPoints } from './lib/junction-batch.js';

const require = createRequire(import.meta.url);
const { createLlm, parseResponse } = require('../../../agents/lib/llm-cost/llm.cjs');
const { readBatchResults, awaitBatch } = require('../../../agents/lib/llm-cost/batch.cjs');
const { computeCost, record } = require('../../../agents/lib/llm-cost/index.cjs');
const { values: args } = parseArgs({ options: {
    execute: { type: 'boolean' }, 'prepare-only': { type: 'boolean' }, help: { type: 'boolean' }, run: { type: 'string' },
    worklist: { type: 'string' }, 'max-usd': { type: 'string' },
    'standard-model': { type: 'string' }, 'advanced-model': { type: 'string' }, 'hardest-model': { type: 'string' },
    'pilot-size': { type: 'string', default: '5' }, limit: { type: 'string' }, 'max-tokens': { type: 'string', default: '16000' }
} });
if ((!args.execute && !args['prepare-only']) || args.help) {
    console.log('Usage: node --env-file=.env scripts/batch-junctions.js --execute|--prepare-only --run LABEL --worklist FILE --max-usd N --standard-model MODEL --advanced-model MODEL --hardest-model MODEL [--pilot-size 5]');
    process.exit(0);
}
for (const key of ['run', 'worklist', 'max-usd', ...TIERS.map(t => `${t}-model`)]) if (!args[key]) throw new Error(`--${key} is required`);
if (!/^[a-z0-9][a-z0-9_-]{0,80}$/i.test(args.run)) throw new Error('Invalid run label');
const cap = Number(args['max-usd']);
const pilotSize = Number(args['pilot-size']);
if (!Number.isFinite(cap) || !(cap > 0) || !Number.isInteger(pilotSize) || pilotSize < 1) throw new Error('Invalid cap or pilot size');
if (args.limit && (!Number.isInteger(Number(args.limit)) || Number(args.limit) < 1)) throw new Error('Invalid limit');
const models = Object.fromEntries(TIERS.map(t => [t, args[`${t}-model`]]));
const efforts = { standard: 'medium', advanced: 'high', hardest: 'high' };
const maxTokens = Number(args['max-tokens']);
if (!Number.isInteger(maxTokens) || maxTokens < 1000 || maxTokens > 64_000) throw new Error('Invalid output token cap');
const dir = path.resolve('..', 'tmp/junction-batch', args.run);
fs.mkdirSync(dir, { recursive: true });
const statePath = path.join(dir, 'state.json');
const worklistBytes = fs.readFileSync(args.worklist);
const worklistHash = createHash('sha256').update(worklistBytes).digest('hex');
const inventoryLimit = args.limit ? Number(args.limit) : null;
let inventory = JSON.parse(worklistBytes).junctions;
if (!Array.isArray(inventory)) throw new Error('Worklist must contain junctions[]');
if (args.limit) inventory = inventory.slice(0, Number(args.limit));
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath))
    : { run: args.run, models, efforts, cap, maxTokens, worklistHash, inventoryLimit, costUsd: 0, items: [], batches: [], pilotPassed: false, startedAt: new Date().toISOString() };
if (state.worklistHash !== worklistHash || JSON.stringify(state.models) !== JSON.stringify(models) || state.cap !== cap || state.inventoryLimit !== inventoryLimit || state.maxTokens !== maxTokens) throw new Error('Run identity or budget changed; use another run label');
const log = m => console.log(`[${new Date().toISOString()}] ${m}`);
function writeJson(file, value) { fs.writeFileSync(file + '.tmp', JSON.stringify(value) + '\n', { mode: 0o600 }); fs.renameSync(file + '.tmp', file); }
const save = () => writeJson(statePath, { ...state, updatedAt: new Date().toISOString() });
const readJson = file => JSON.parse(fs.readFileSync(file));
const pool = new pg.Pool({ host: process.env.PGHOST === 'db' ? 'localhost' : process.env.PGHOST,
    port: Number(process.env.PGPORT) || 5432, user: process.env.PGUSER, password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE, max: 4, statement_timeout: 120_000 });
const lock = await pool.connect();
const client = new Anthropic({ timeout: 10 * 60_000 });
const layer = createLlm({ provider: 'anthropic', client, repo: 'consensus-builder', script: 'batch-junctions' });
const roads = buildRoadRoutes({ runQuery: (sql, values) => pool.query(sql, values) });
const roadsFetchImpl = url => {
    const u = new URL(url);
    return roads.request(u.pathname.replace(/^\/api\/roads/, '') + u.search);
};
const schema = fs.readFileSync(new URL('../routes/lane-topology-ddl.sql', import.meta.url), 'utf8');
const areaKey = bbox => createHash('sha256').update(`zagreb:${bbox.map(n => Number(n).toFixed(7)).join(',')}`).digest('hex');
const bboxFor = junction => bboxAroundPoints([junction.point]);
async function prepare() {
    const database = (await pool.query('SELECT current_database() AS name')).rows[0].name;
    if (database !== 'geodata') throw new Error('Junction work must use geodata');
    await pool.query('BEGIN; SET LOCAL ROLE geo_user;\n' + schema + '\nCOMMIT;');
    for (const [index, junction] of inventory.entries()) {
        const key = `j${index}`;
        const previous = state.items.find(item => item.key === key);
        if (previous && previous.status !== 'preparation_failed') continue;
        const item = previous || { key, name: junction.name, targetNodeIds: junction.nodeIds, tier: initialTier(junction), attempts: [] };
        item.bbox = bboxFor(junction);
        delete item.error;
        try {
            let base = await buildDeterministicSolution(pool, item.bbox, 'zagreb', null, { roadsFetchImpl });
            // Never send an absent target: tight crops can miss the connecting OSM ways.
            let present = new Set(base.solution.graph.nodes.map(n => n.id));
            if (item.targetNodeIds.some(id => !present.has(id))) {
                const nodeIds = item.targetNodeIds.map(id => /^osm-node:(\d+)$/.exec(id)?.[1]);
                if (nodeIds.some(id => !id) || base.evidence.snapshot?.id == null) throw new Error('Missing target coordinates or snapshot');
                const points = await pool.query(`SELECT osm_id,ST_X(geom) AS lng,ST_Y(geom) AS lat
                    FROM public.osm_topology_node WHERE snapshot_id=$1 AND osm_id=ANY($2::bigint[])`, [base.evidence.snapshot.id,nodeIds]);
                if (points.rows.length !== nodeIds.length) throw new Error('Target coordinates absent from source snapshot');
                item.bbox = bboxAroundPoints(points.rows.map(p => [p.lng,p.lat]));
                const expanded = await buildDeterministicSolution(pool,item.bbox,'zagreb',null,{ roadsFetchImpl });
                if (expanded.evidence.snapshot?.id !== base.evidence.snapshot.id) throw new Error('Source snapshot changed during preparation');
                base = expanded;
                present = new Set(base.solution.graph.nodes.map(n => n.id));
            }
            if (item.targetNodeIds.some(id => !present.has(id))) throw new Error('Target missing from verified crop');
            item.remaining = openTargets(base.solution.graph, item.targetNodeIds);
            item.workingSolutionId = base.solution.id;
            item.inputPath = path.join(dir, key + '-input.json');
            item.imagePath = path.join(dir, key + '-orthophoto.jpg');
            item.snapshotAt = base.evidence.snapshotAt;
            item.snapshotId = base.evidence.snapshot?.id ?? null;
            let imagery = null;
            if (item.remaining.length) {
                const city = resolveImagerySource('zagreb_cdof_2022');
                const source = coversImageryBbox(city, item.bbox) ? city : resolveImagerySource('dgu_dof_lidar_2022_2023');
                const crop = await fetchImageryCrop(source, item.bbox);
                if (crop.metadata.effectiveGsdM > 0.35) throw new Error('Imagery too coarse for lane recognition');
                fs.writeFileSync(item.imagePath, crop.buffer, { mode: 0o600 });
                imagery = crop.metadata;
            }
            writeJson(item.inputPath, { selection: { city: 'zagreb', bbox: item.bbox },
                deterministicGraph: base.solution.graph, restrictions: base.evidence.restrictions,
                imagery, targetNodeIds: item.remaining });
            item.status = item.remaining.length ? 'ready' : 'already_settled';
        } catch (error) { item.status = 'preparation_failed'; item.error = error.message; }
        if (!previous) state.items.push(item);
        save();
        log(`prepared ${index + 1}/${inventory.length}: ${item.tier}, ${item.status}${item.error ? ': ' + item.error : ''}`);
    }
}
async function requestFor(item, tier) {
    const input = readJson(item.inputPath);
    input.targetNodeIds = item.remaining;
    const customId = `${item.key}-${tier}`;
    const request = layer.batchRequest(customId, { model: models[tier], effort: efforts[tier], maxTokens,
        content: [{ type: 'image', path: item.imagePath }, buildRecognitionPrompt(input)],
        schema: TOPOLOGY_OUTPUT_SCHEMA, extra: { thinking: { type: 'adaptive' } } });
    writeJson(path.join(dir,customId + '-request.json'),request);
    const { input_tokens: tokens } = await client.messages.countTokens({ model: request.params.model,
        messages: request.params.messages, ...(request.params.system ? { system: request.params.system } : {}) });
    // Token counting excludes output-grammar overhead; reserve additional input headroom.
    const ceilingUsd = computeCost(models[tier], { input_tokens: tokens + 2048, output_tokens: maxTokens }, { batch: true });
    return { item, tier, customId, request, ceilingUsd };
}
async function applySavedResult(item, attempt, batch) {
    if (attempt.applied) return;
    const result = readJson(path.join(dir, attempt.customId + '-result.json'));
    try {
        attempt.remainingBefore = item.remaining.length;
        if (result.error) throw new Error(result.error);
        const parsed = parseResponse('anthropic', result.message, { schema: TOPOLOGY_OUTPUT_SCHEMA });
        if (parsed.error) throw new Error(parsed.error);
        const input = readJson(attempt.inputPath);
        const graph = withRestrictionProblems(applyRecognitionPatch(JSON.parse(parsed.data.patch_json),
            input.deterministicGraph, 'anthropic', { imagery: input.imagery, restrictions: input.restrictions, targetNodeIds: input.targetNodeIds }), input.restrictions);
        graph.source = { ...(graph.source || {}), imagery: input.imagery,
            recognition: { run: args.run, batchId: batch.id, customId: attempt.customId, model: models[attempt.tier], effort: efforts[attempt.tier] } };
        const safe = safeTransition(input.deterministicGraph, graph);
        // A crash after storing but before saving state must not create a second solution.
        const existing = await pool.query(`SELECT id FROM public.lane_topology_solution WHERE provider='anthropic'
            AND graph->'source'->'recognition'->>'run'=$1 AND graph->'source'->'recognition'->>'customId'=$2 LIMIT 1`, [args.run, attempt.customId]);
        const solution = existing.rows[0] || await storeTopologySolution(pool, { parentId: attempt.parentId,
            city: 'zagreb', bbox: item.bbox, sourceKind: 'anthropic', provider: 'anthropic',
            model: result.message.model, promptVersion: TOPOLOGY_PROMPT_VERSION,
            snapshotAt: item.snapshotAt, snapshotId: item.snapshotId, graph, status: safe ? 'candidate' : 'rejected' });
        attempt.solutionId = Number(solution.id); attempt.safe = safe;
        if (safe) {
            item.remaining = openTargets(graph, item.targetNodeIds);
            item.workingSolutionId = attempt.solutionId;
            writeJson(item.inputPath, { ...input, deterministicGraph: graph, targetNodeIds: item.remaining });
        }
        item.status = item.remaining.length ? 'unsettled' : 'settled';
        attempt.remainingAfter = item.remaining.length;
        await pool.query(`UPDATE public.lane_topology_job SET status='completed',result_solution_id=$2,
            usage=$3,output_tail=$4,finished_at=now(),updated_at=now() WHERE id=$1`,
        [attempt.jobId, attempt.solutionId, { resolvedModel: result.message.model, costUsd: result.costUsd,
            inputTokens: result.usage?.input_tokens, outputTokens: result.usage?.output_tokens }, JSON.stringify(parsed.data).slice(-8000)]);
        const check = await pool.query('SELECT result_solution_id,status FROM public.lane_topology_job WHERE id=$1', [attempt.jobId]);
        if (Number(check.rows[0]?.result_solution_id) !== attempt.solutionId) throw new Error('Stored result readback disagrees');
    } catch (error) {
        attempt.error = error.message; item.status = 'unsettled';
        await pool.query(`UPDATE public.lane_topology_job SET status='failed',error=$2,finished_at=now(),updated_at=now() WHERE id=$1`, [attempt.jobId, error.message]);
    }
    attempt.applied = true; save();
    log(`${attempt.customId}: ${item.status}, ${item.remaining.length} targets remain${attempt.error ? ': ' + attempt.error : ''}`);
}
async function collect(batch) {
    await awaitBatch({ client, provider: 'anthropic', batchId: batch.id, pollMs: 30_000,
        onProgress: progress => log(`${batch.id}: ${JSON.stringify(progress)}`) });
    for await (const raw of readBatchResults({ client, provider: 'anthropic', batchId: batch.id })) {
        const item = state.items.find(i => i.attempts.some(a => a.customId === raw.customId));
        if (!item) throw new Error(`Unknown paid result ${raw.customId}`);
        const attempt = item.attempts.find(a => a.customId === raw.customId);
        const file = path.join(dir, raw.customId + '-result.json');
        if (!fs.existsSync(file)) {
            const costUsd = raw.error ? 0 : computeCost(raw.message.model, raw.usage, { batch: true });
            writeJson(file, { ...raw, costUsd });
            if (!raw.error) record({ repo: 'consensus-builder', script: 'batch-junctions',
                model: raw.message.model, usage: raw.usage, cost_usd: costUsd, batch: true,
                meta: { run: args.run, batchId: batch.id, customId: raw.customId, tier: attempt.tier } });
        }
        // The saved raw results, including invalid answers, are the spend authority on resume.
        await applySavedResult(item, attempt, batch);
    }
    for (const customId of batch.customIds) {
        if (!fs.existsSync(path.join(dir, customId + '-result.json'))) throw new Error(`Batch lacks paid result ${customId}; refusing to advance`);
    }
    batch.collected = true;
    state.costUsd = state.items.flatMap(i => i.attempts).reduce((sum, a) => {
        const file = path.join(dir, a.customId + '-result.json');
        return sum + (fs.existsSync(file) ? readJson(file).costUsd : 0);
    }, 0);
    save();
}
async function submit(group, tier, pilot) {
    const planned = [];
    for (const item of group) planned.push(await requestFor(item, tier));
    const { selected, reserved } = budgetedPrefix(planned, cap - state.costUsd);
    if (!selected.length) { state.budgetLimited = true; save(); return; }
    if (selected.length !== planned.length) state.budgetLimited = true;
    log(`${pilot ? 'pilot' : 'batch'} ${tier}: ${selected.length} requests, $${reserved.toFixed(3)} ceiling, $${state.costUsd.toFixed(3)} spent of $${cap}`);
    const batch = { tier, pilot, ceilingUsd: reserved, customIds: selected.map(p => p.customId), status: 'submitting' };
    for (const p of selected) {
        const inputPath = path.join(dir, p.customId + '-input.json');
        writeJson(inputPath, { ...readJson(p.item.inputPath), targetNodeIds: p.item.remaining });
        const { rows } = await pool.query(`INSERT INTO public.lane_topology_job
            (provider,status,city,area_key,selected_bbox,base_solution_id,model,prompt_version,input_summary)
            VALUES ('anthropic','queued','zagreb',$1,$2,$3,$4,$5,$6) RETURNING id`,
        [areaKey(p.item.bbox), p.item.bbox, p.item.workingSolutionId, models[tier], TOPOLOGY_PROMPT_VERSION,
            { run: args.run, customId: p.customId, tier, effort: efforts[tier], targetNodeIds: p.item.remaining }]);
        p.item.attempts.push({ customId: p.customId, tier, jobId: Number(rows[0].id), parentId: p.item.workingSolutionId, inputPath });
    }
    state.batches.push(batch); save();
    // Unknown submission outcome is stopped on resume, never blindly resubmitted.
    batch.id = await layer.submitBatch(selected.map(p => p.request));
    batch.status = 'submitted'; save();
    await pool.query(`UPDATE public.lane_topology_job SET status='running',started_at=now(),updated_at=now()
        WHERE id=ANY($1::bigint[])`, [selected.map(p => p.item.attempts.at(-1).jobId)]);
    await collect(batch);
}
try {
    const locked = await lock.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [`junction-batch:${args.run}`]);
    if (!locked.rows[0].locked) throw new Error('This run is already active');
    for (const batch of state.batches.filter(b => !b.collected)) {
        if (!batch.id) throw new Error('Submission outcome unknown; reconcile Anthropic batch list before resuming');
        await collect(batch);
    }
    await prepare();
    log(`Inventory: ${state.items.length} groups; models ${JSON.stringify(models)}`);
    if (args['prepare-only']) {
        log('Preparation complete; no paid requests submitted.');
    } else {
    if (!state.pilotPassed) {
        const pilot = [];
        for (const tier of TIERS) {
            const example = state.items.find(i => i.remaining?.length && i.tier === tier && !i.attempts.length && i.status !== 'preparation_failed');
            if (example) pilot.push(example);
        }
        for (const item of state.items.filter(i => i.remaining?.length && !i.attempts.length && i.status !== 'preparation_failed')) {
            if (pilot.length >= pilotSize) break;
            if (!pilot.includes(item)) pilot.push(item);
        }
        for (const tier of TIERS) { const group = pilot.filter(i => i.tier === tier); if (group.length) await submit(group, tier, true); }
        const results = state.items.flatMap(i => i.attempts);
        if (!pilotMadeProgress(results)) throw new Error('Pilot did not safely reduce unresolved targets; inspect raw results before spending more');
        state.pilotPassed = true; save();
    }
    for (const tier of TIERS) {
        const eligible = state.items.filter(i => i.remaining?.length && i.status !== 'preparation_failed'
            && TIERS.indexOf(i.tier) <= TIERS.indexOf(tier) && !i.attempts.some(a => a.tier === tier));
        if (eligible.length) await submit(eligible, tier, false);
    }
    state.status = state.items.some(i => i.remaining?.length || i.status === 'preparation_failed') ? 'partial' : 'complete';
    save();
    log(`${state.status}: ${state.items.filter(i => i.status === 'settled' || i.status === 'already_settled').length}/${state.items.length} settled, $${state.costUsd.toFixed(4)} actual spend`);
    if (state.status !== 'complete') process.exitCode = 2;
    }
} finally { await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [`junction-batch:${args.run}`]); lock.release(); await pool.end(); }
