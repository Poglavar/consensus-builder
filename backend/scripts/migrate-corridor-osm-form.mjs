// One-off migration: store every corridor record as its OSM document (roads.md §11, step two).
// A row's road_proposal.definition loses its stretch and cross-section fields (points, segments,
// segmentIds, profile, segmentProfiles, width, sidewalkWidth) and gains `osm`, encoded from them;
// everything else on the definition (land, construction frame, tunnels, junctions, metadata) stays.
// Readers decode the form at load (corridor-osm-form.js toView), so a migrated row renders as before.
//
// Dry run by default: reports, per row, whether the form reads back as the very same stretches
// (exact), as the same road in canonical form (canonicalised: a flat point list nested, a missing
// stretch-id list, an override equal to the default dropped, a legacy width replaced by the
// cross-section's), or cannot be carried (unencodable: a designation, or a form that disagrees).
// It also names every plan (ens_plan) whose member hash would change, because GET /plans/:slug
// recomputes member hashes from the rows and flags drift.
//
// Usage:
//   node backend/scripts/migrate-corridor-osm-form.mjs --dry-run              # against DATABASE_URL
//   node backend/scripts/migrate-corridor-osm-form.mjs --apply                # writes, idempotent
//   node backend/scripts/migrate-corridor-osm-form.mjs --from-json roads.json --plans-json plans.json
//                                                                             # offline dry run on a dump
// Resumable: a row already in record shape is skipped, so a rerun after a kill only finishes.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const osmForm = require('../../frontend/js/corridor-osm-form.js');
const { memberHash, planHash, stableStringify } = await import('../plans/plan-hash.js');

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = name => { const index = args.indexOf(name); return index === -1 ? null : args[index + 1]; };

const usage = () => fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(line => line.startsWith('//')).map(line => line.slice(3)).join('\n');
const apply = flag('--apply');
const fromJson = option('--from-json');
const plansJson = option('--plans-json');
const stamp = () => new Date().toISOString();

const VIEW_FIELDS = osmForm.VIEW_FIELDS;
const hasViewFields = definition => VIEW_FIELDS.some(field => definition && Object.prototype.hasOwnProperty.call(definition, field));
const roadContent = definition => stableStringify({
    segments: definition.segments ?? definition.points ?? null,
    segmentIds: definition.segmentIds ?? null,
    segmentProfiles: definition.segmentProfiles ?? null,
    width: definition.width ?? null
});

// What one row becomes: { status, record?, reason?, hashBefore, hashAfter }.
export function migrateRow(row) {
    const definition = row.road_proposal && row.road_proposal.definition;
    if (!definition || typeof definition !== 'object') return { status: 'not-a-road' };
    if (definition.osm && !hasViewFields(definition)) return { status: 'done' };
    let record;
    try { record = osmForm.toRecord(definition); } catch (error) { return { status: 'unencodable', reason: error.message }; }
    if (!record.osm) return { status: 'unencodable', reason: 'no stretches with a cross-section (a designation or a polygon alone)' };
    const view = osmForm.toView(record);
    const before = { ...row };
    const after = { ...row, road_proposal: { ...row.road_proposal, definition: view } };
    let hashBefore = null;
    let hashAfter = null;
    try { hashBefore = memberHash(before); hashAfter = memberHash(after); } catch (_) { /* a row plan-hash cannot read is reported below */ }
    const exact = roadContent(definition) === roadContent(view);
    return { status: exact ? 'exact' : 'canonicalised', record, hashBefore, hashAfter, hashChanged: hashBefore !== hashAfter };
}

// What a plan's stored member hashes become. plan-hash.js now hashes a road by its stretches and
// cross-sections, whichever shape the row spells them in, so every road member's hash moves once
// (the function changed, the road did not) and GET /plans/:slug would flag every road member as
// changed. The stored hashes are re-stamped to the new function. A minted plan keeps the plan hash
// its chain record carries and records the member hashes that hash was computed from
// (`onchain_data.memberHashesAtMint`), so the chain commitment stays recomputable.
export function planRestamp(plan, rowsById) {
    const ids = Array.isArray(plan.proposal_ids) ? plan.proposal_ids.map(String) : [];
    const stored = plan.member_hashes || {};
    const memberHashes = {};
    let moved = 0;
    let missing = 0;
    ids.forEach(id => {
        const row = rowsById.get(id);
        if (!row) { missing += 1; if (stored[id]) memberHashes[id] = stored[id]; return; }
        memberHashes[id] = memberHash(row);
        if (memberHashes[id] !== stored[id]) moved += 1;
    });
    if (!moved) return null;
    const restamped = { slug: plan.slug, minted: !!plan.minted, moved, missing, memberHashes, planHash: plan.plan_hash, onchainData: plan.onchain_data || null };
    if (!plan.minted) {
        restamped.planHash = planHash(ids.map(id => ({ proposalId: rowsById.get(id) ? rowsById.get(id).proposal_id : id, hash: memberHashes[id] })));
    } else if (plan.onchain_data && !plan.onchain_data.memberHashesAtMint) {
        restamped.onchainData = { ...plan.onchain_data, memberHashesAtMint: stored };
    }
    return restamped;
}

function planImpact(plans, outcomes) {
    const rowsById = new Map(outcomes.map(outcome => [String(outcome.row.id), outcome.result.record
        ? { ...outcome.row, road_proposal: { ...outcome.row.road_proposal, definition: outcome.result.record } }
        : outcome.row]));
    return plans.map(plan => planRestamp(plan, rowsById)).filter(Boolean);
}

function report(outcomes, plans) {
    const counts = {};
    outcomes.forEach(({ result }) => { counts[result.status] = (counts[result.status] || 0) + 1; });
    console.log(`[${stamp()}] ${outcomes.length} corridor rows: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    outcomes.filter(({ result }) => result.status === 'unencodable').slice(0, 20).forEach(({ row, result }) => {
        console.log(`  unencodable ${row.id} (${row.city || '?'}): ${result.reason}`);
    });
    const hashChanges = outcomes.filter(({ result }) => result.hashChanged);
    console.log(`[${stamp()}] rows whose road reads back with a different member hash: ${hashChanges.length} of ${outcomes.length}`);
    if (!plans) return [];
    const restamps = planImpact(plans, outcomes);
    console.log(`[${stamp()}] plans whose stored member hashes move to the new hash function: ${restamps.length} of ${plans.length}`);
    restamps.forEach(entry => {
        console.log(`  plan ${entry.slug}${entry.minted ? ' (MINTED: plan hash kept, member hashes at mint recorded)' : ' (plan hash recomputed)'}: ${entry.moved} member hash(es) re-stamped${entry.missing ? `, ${entry.missing} member row(s) not in this set` : ''}`);
    });
    return restamps;
}

async function main() {
    if (!args.length || flag('--help') || flag('-h')) { console.log(usage()); return; }
    if (fromJson) {
        const rows = JSON.parse(fs.readFileSync(path.resolve(fromJson), 'utf8')) || [];
        const plans = plansJson ? (JSON.parse(fs.readFileSync(path.resolve(plansJson), 'utf8')) || []) : null;
        const outcomes = rows.map(row => ({ row, result: migrateRow(row) }));
        report(outcomes, plans);
        return;
    }
    const { createPool } = await import('../db/connection.cjs');
    const pool = createPool();
    try {
        const { rows } = await pool.query(`SELECT id, proposal_id, city, type, proposal_data->>'goal' AS goal, cadastre_parcel_ids,
            road_proposal, building_proposal, structure_proposal, reparcellization, proposal_data->'geometry' AS geometry, proposal_data
            FROM proposal WHERE road_proposal->'definition' IS NOT NULL ORDER BY id`);
        const plans = (await pool.query(`SELECT slug, proposal_ids, member_hashes, plan_hash, onchain_data, onchain_data IS NOT NULL AS minted FROM ens_plan`)).rows;
        const outcomes = rows.map(row => ({ row, result: migrateRow(row) }));
        // Every member row of every plan, with the road rows as they will be stored, so a plan's
        // hashes are re-stamped from complete members (a building member hashes as before).
        const memberIds = [...new Set(plans.flatMap(plan => (Array.isArray(plan.proposal_ids) ? plan.proposal_ids : []).map(Number)).filter(Number.isFinite))];
        const members = memberIds.length ? (await pool.query(`SELECT id, proposal_id, city, type, proposal_data->>'goal' AS goal, cadastre_parcel_ids,
            road_proposal, building_proposal, structure_proposal, reparcellization, proposal_data->'geometry' AS geometry, proposal_data
            FROM proposal WHERE id = ANY($1::int[])`, [memberIds])).rows : [];
        const migrated = new Map(outcomes.filter(({ result }) => result.record).map(({ row, result }) => [String(row.id), result.record]));
        const rowsById = new Map(members.map(row => [String(row.id), migrated.has(String(row.id))
            ? { ...row, road_proposal: { ...row.road_proposal, definition: migrated.get(String(row.id)) } }
            : row]));
        const restamps = report(outcomes, null);
        plans.map(plan => planRestamp(plan, rowsById)).filter(Boolean).forEach(entry => restamps.push(entry));
        console.log(`[${stamp()}] plans whose stored member hashes move to the new hash function: ${restamps.length} of ${plans.length}`);
        restamps.forEach(entry => {
            console.log(`  plan ${entry.slug}${entry.minted ? ' (MINTED: plan hash kept, member hashes at mint recorded)' : ' (plan hash recomputed)'}: ${entry.moved} member hash(es) re-stamped${entry.missing ? `, ${entry.missing} member row(s) missing from the table` : ''}`);
        });
        if (!apply) { console.log(`[${stamp()}] dry run; pass --apply to write`); return; }
        const todo = outcomes.filter(({ result }) => result.record);
        let done = 0;
        for (const { row, result } of todo) {
            const roadProposal = { ...row.road_proposal, definition: result.record };
            const data = row.proposal_data && typeof row.proposal_data === 'object' && row.proposal_data.roadProposal
                ? { ...row.proposal_data, roadProposal: { ...row.proposal_data.roadProposal, definition: result.record } }
                : row.proposal_data;
            await pool.query(`UPDATE proposal SET road_proposal = $1::jsonb, proposal_data = $2::jsonb, updated_at = now() WHERE id = $3`,
                [JSON.stringify(roadProposal), JSON.stringify(data), row.id]);
            done += 1;
            if (done % 25 === 0 || done === todo.length) console.log(`[${stamp()}] ${done}/${todo.length} rows written`);
        }
        for (const entry of restamps) {
            await pool.query(`UPDATE ens_plan SET member_hashes = $1::jsonb, plan_hash = $2, onchain_data = $3::jsonb, updated_at = now() WHERE slug = $4`,
                [JSON.stringify(entry.memberHashes), entry.planHash, entry.onchainData ? JSON.stringify(entry.onchainData) : null, entry.slug]);
        }
        if (restamps.length) console.log(`[${stamp()}] ${restamps.length} plan(s) re-stamped`);
        const check = await pool.query(`SELECT count(*) FILTER (WHERE road_proposal->'definition' ? 'osm') AS records,
            count(*) FILTER (WHERE road_proposal->'definition' ? 'points' OR road_proposal->'definition' ? 'segments') AS views
            FROM proposal WHERE road_proposal->'definition' IS NOT NULL`);
        console.log(`[${stamp()}] after: ${check.rows[0].records} rows carry a form, ${check.rows[0].views} still carry stretch fields`);
    } finally {
        await pool.end();
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    main().catch(error => { console.error(`[${stamp()}]`, error); process.exit(1); });
}
