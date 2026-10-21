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
//
// Usage:
//   node backend/scripts/migrate-corridor-osm-form.mjs --dry-run              # against DATABASE_URL
//   node backend/scripts/migrate-corridor-osm-form.mjs --apply                # writes, idempotent
//   node backend/scripts/migrate-corridor-osm-form.mjs --from-json roads.json  # offline dry run on a dump
// Resumable: a row already in record shape is skipped, so a rerun after a kill only finishes.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const osmForm = require('../../frontend/js/corridor-osm-form.js');

// JSON with object keys sorted at every depth (undefined keys dropped), so equal content compares equal.
function stableStringify(value) {
    if (value === undefined) return 'null';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = name => { const index = args.indexOf(name); return index === -1 ? null : args[index + 1]; };

const usage = () => fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(line => line.startsWith('//')).map(line => line.slice(3)).join('\n');
const apply = flag('--apply');
const fromJson = option('--from-json');
const stamp = () => new Date().toISOString();

const VIEW_FIELDS = osmForm.VIEW_FIELDS;
const hasViewFields = definition => VIEW_FIELDS.some(field => definition && Object.prototype.hasOwnProperty.call(definition, field));
const roadContent = definition => stableStringify({
    segments: definition.segments ?? definition.points ?? null,
    segmentIds: definition.segmentIds ?? null,
    segmentProfiles: definition.segmentProfiles ?? null,
    width: definition.width ?? null
});

// What one row becomes: { status, record?, reason? }.
export function migrateRow(row) {
    const definition = row.road_proposal && row.road_proposal.definition;
    if (!definition || typeof definition !== 'object') return { status: 'not-a-road' };
    if (definition.osm && !hasViewFields(definition)) return { status: 'done' };
    let record;
    try { record = osmForm.toRecord(definition); } catch (error) { return { status: 'unencodable', reason: error.message }; }
    if (!record.osm) return { status: 'unencodable', reason: 'no stretches with a cross-section (a designation or a polygon alone)' };
    const view = osmForm.toView(record);
    const exact = roadContent(definition) === roadContent(view);
    return { status: exact ? 'exact' : 'canonicalised', record };
}

function report(outcomes) {
    const counts = {};
    outcomes.forEach(({ result }) => { counts[result.status] = (counts[result.status] || 0) + 1; });
    console.log(`[${stamp()}] ${outcomes.length} corridor rows: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    outcomes.filter(({ result }) => result.status === 'unencodable').slice(0, 20).forEach(({ row, result }) => {
        console.log(`  unencodable ${row.id} (${row.city || '?'}): ${result.reason}`);
    });
}

async function main() {
    if (!args.length || flag('--help') || flag('-h')) { console.log(usage()); return; }
    if (fromJson) {
        const rows = JSON.parse(fs.readFileSync(path.resolve(fromJson), 'utf8')) || [];
        const outcomes = rows.map(row => ({ row, result: migrateRow(row) }));
        report(outcomes);
        return;
    }
    const { createPool } = await import('../db/connection.cjs');
    const pool = createPool();
    try {
        const { rows } = await pool.query(`SELECT id, proposal_id, city, type, proposal_data->>'goal' AS goal, cadastre_parcel_ids,
            road_proposal, building_proposal, structure_proposal, reparcellization, proposal_data->'geometry' AS geometry, proposal_data
            FROM proposal WHERE road_proposal->'definition' IS NOT NULL ORDER BY id`);
        const outcomes = rows.map(row => ({ row, result: migrateRow(row) }));
        report(outcomes);
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
