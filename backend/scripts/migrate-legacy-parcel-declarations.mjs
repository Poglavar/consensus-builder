// Make stored proposals that still carry RETIRED parcel declarations readable again, re-declaring
// their land as the parcels their own geometry actually lies on.
//
// The strict serializer (commit 7815c9d) rejects any row that still holds a retired alias such as
// proposal_data.parentParcelIds, so GET /proposals/:id answers 422 for it. The 2026-09-04
// migration (migrate-tessellation.js) left 80 Zagreb rows in that state. Analysis (2026-09-24)
// showed neither of their two declarations can be trusted as written:
//   - the legacy "selection" is the id PREFIX of the readjustment pieces the author built on (the
//     first input parcel of that readjustment), and in 43 rows it has 0 m² under the geometry;
//   - the cadastre_parcel_ids column came from the July geometric backfill (>= 2 m², plus the
//     selection prefixes), and the 2026-08-07 road split copied the whole road's column onto every
//     sibling stretch.
// The user approved (2026-09-24) one rule for all of them, the same rule the API now enforces on
// every new proposal:
//
//   GEOMETRY-SUPPORTED DECLARATION: cadastre_parcel_ids := every current cadastral parcel the
//   proposal's own geometry covers by >= 1 m² (EPSG:3765, ST_MakeValid both sides).
//
// The footprint comes from the shared builder (frontend/js/proposals/footprint-parts.js via
// backend/proposals/footprint.js). A road stored without its corridor polygon is buffered from its
// centreline by width/2 (flat ends); such rows are marked `approximateFootprint: true`.
//
// A row is REFUSED (never written) when its footprint cannot be rebuilt, when the geometry covers no
// parcel by >= 1 m², when an ownership snapshot entry outside the new declaration records real
// consent, or when an accepted-parcel / ownership-flow entry lies outside it.
//
// Records are immutable by design, and this migration does change the declared land of most rows.
// Provenance is kept on the row itself: everything removed or replaced — the previous
// cadastre_parcel_ids, each retired field and snapshot entry with its exact column and path — goes
// into proposal_data.legacy["<MIGRATION_ID>"], together with the rule, per-parcel overlap m², the
// source checksum and migratedAt. restoreLegacyParcelDeclarations() rebuilds the original columns
// exactly from that block. The serializer never serves `legacy`.
//
//   node scripts/migrate-legacy-parcel-declarations.mjs --help
//   node scripts/migrate-legacy-parcel-declarations.mjs --dry-run            # read-only report
//   node scripts/migrate-legacy-parcel-declarations.mjs --dry-run --ids 8,20
//   node scripts/migrate-legacy-parcel-declarations.mjs --apply              # writes migratable rows

import pkg from 'pg';
import dotenv from 'dotenv';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { assertCanonicalProposalRow } from '../proposals/serializer.js';
import {
    MIN_PARCEL_OVERLAP_M2,
    footprintParts,
    hasFootprint,
    parcelOverlaps,
    proposalGeometryView
} from '../proposals/footprint.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

const { Pool } = pkg;

export const MIGRATION_ID = 'legacy-parcel-declarations-v1';
export const MIGRATION_RULE = 'geometry-supported-declaration';
export const MIGRATION_RULE_TEXT = 'cadastre_parcel_ids := current cadastral parcels the proposal geometry covers by '
    + `>= ${MIN_PARCEL_OVERLAP_M2} m² (EPSG:3765). Retired declarations and unconsented ownership snapshot entries `
    + 'outside the new declaration are moved here verbatim.';

// Sub-proposal columns and the proposal_data key each mirrors.
const SUB_COLUMNS = Object.freeze([
    ['road_proposal', 'roadProposal'],
    ['building_proposal', 'buildingProposal'],
    ['structure_proposal', 'structureProposal'],
    ['reparcellization', 'reparcellization']
]);
const SUB_KEYS = Object.freeze(['roadProposal', 'buildingProposal', 'structureProposal', 'reparcellization', 'decideLaterProposal']);
const INELIGIBLE_ID_KEYS = Object.freeze(['parcelId', 'parcel_id', 'parentParcelId', 'parentParcelIds']);
// Columns the migration may write. Everything else is read-only here.
export const WRITABLE_COLUMNS = Object.freeze([
    'cadastre_parcel_ids', 'proposal_data', 'road_proposal', 'building_proposal', 'structure_proposal',
    'reparcellization', 'owner_acceptances', 'ancestor_parcel_ids'
]);

const own = (value, key) => !!value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key);
const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const round1 = value => Math.round(Number(value) * 10) / 10;

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value instanceof Date) return value.toISOString();
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

export function recordChecksum(row) {
    const subset = Object.fromEntries(WRITABLE_COLUMNS.map(column => [column, row?.[column] ?? null]));
    return createHash('sha256').update(JSON.stringify(stableValue(subset))).digest('hex');
}

function pathLabel(container, path) {
    return path.reduce((label, key) => (typeof key === 'number' ? `${label}[${key}]` : `${label}.${key}`), container);
}

// Every retired field present on the row, with the exact place it lives. All of them are archived;
// under the geometry rule none of them decides the declaration any more.
export function retiredParcelFields(row) {
    const found = [];
    const add = (container, root, path, kind) => {
        let owner = root;
        for (const key of path.slice(0, -1)) owner = owner?.[key];
        const last = path[path.length - 1];
        if (own(owner, last)) found.push({ container, path, kind, value: clone(owner[last]) });
    };
    const scanSub = (container, root, prefix, subKey) => {
        const sub = prefix.length ? root?.[prefix[0]] : root;
        if (!isPlainObject(sub)) return;
        add(container, root, [...prefix, 'parentParcelIds'], 'land');
        if (subKey === 'reparcellization') {
            add(container, root, [...prefix, 'parcelIds'], 'land');
            (Array.isArray(sub.ownerShares) ? sub.ownerShares : []).forEach((_, index) => {
                add(container, root, [...prefix, 'ownerShares', index, 'parcelIds'], 'metadata');
            });
        }
        if (subKey === 'buildingProposal') {
            add(container, root, [...prefix, 'blockParcelIds'], 'land');
            add(container, root, [...prefix, 'parentParcelNumbers'], 'metadata');
            add(container, root, [...prefix, 'ancestorKey'], 'metadata');
            (Array.isArray(sub.ineligibleParcels) ? sub.ineligibleParcels : []).forEach((entry, index) => {
                INELIGIBLE_ID_KEYS.forEach(key => {
                    if (own(entry, key)) add(container, root, [...prefix, 'ineligibleParcels', index, key], 'metadata');
                });
            });
        }
    };

    const data = row?.proposal_data;
    if (isPlainObject(data)) {
        add('proposal_data', data, ['parentParcelIds'], 'land');
        add('proposal_data', data, ['parcelIds'], 'land');
        SUB_KEYS.forEach(key => scanSub('proposal_data', data, [key], key));
    }
    SUB_COLUMNS.forEach(([column, key]) => scanSub(column, row?.[column], [], key));
    if (row?.ancestor_parcel_ids !== null && row?.ancestor_parcel_ids !== undefined) {
        found.push({ container: 'ancestor_parcel_ids', path: [], kind: 'land', value: clone(row.ancestor_parcel_ids) });
    }
    return found;
}

// An ownerAcceptances entry is consent only when someone accepted. Anything that is not the known
// snapshot shape is treated as possible consent — the safe direction is "refuse".
export function hasRecordedConsent(entry) {
    if (!isPlainObject(entry)) return true;
    if (isPlainObject(entry.acceptedBy) && Object.keys(entry.acceptedBy).length) return true;
    if (entry.acceptedBy !== undefined && !isPlainObject(entry.acceptedBy)) return true;
    if (Array.isArray(entry.acceptedOwnerKeys) && entry.acceptedOwnerKeys.length) return true;
    if (entry.acceptedOwnerKeys !== undefined && !Array.isArray(entry.acceptedOwnerKeys)) return true;
    if (entry.accepted === true || entry.acceptedAt) return true;
    return false;
}

function removeAt(row, container, path) {
    if (!path.length) {
        row[container] = null;
        return;
    }
    let owner = row[container];
    for (const key of path.slice(0, -1)) owner = owner?.[key];
    if (owner && typeof owner === 'object') delete owner[path[path.length - 1]];
}

function setAt(row, container, path, value) {
    if (!path.length) {
        row[container] = clone(value);
        return;
    }
    if (!row[container] || typeof row[container] !== 'object') row[container] = {};
    let owner = row[container];
    for (const [index, key] of path.slice(0, -1).entries()) {
        if (owner[key] === undefined || owner[key] === null) owner[key] = typeof path[index + 1] === 'number' ? [] : {};
        owner = owner[key];
    }
    owner[path[path.length - 1]] = clone(value);
}

function acceptanceContainers(row) {
    const out = [];
    if (isPlainObject(row?.owner_acceptances)) out.push(['owner_acceptances', [], row.owner_acceptances]);
    if (isPlainObject(row?.proposal_data?.ownerAcceptances)) {
        out.push(['proposal_data', ['ownerAcceptances'], row.proposal_data.ownerAcceptances]);
    }
    return out;
}

function referenceLists(row) {
    const accepted = [];
    const flows = [];
    const addAccepted = (label, value) => (Array.isArray(value) ? value : [])
        .forEach((id, index) => accepted.push({ path: `${label}[${index}]`, id: String(id) }));
    addAccepted('accepted_parcel_ids', row?.accepted_parcel_ids);
    addAccepted('proposal_data.acceptedParcelIds', row?.proposal_data?.acceptedParcelIds);
    const addFlow = (label, value) => (Array.isArray(value) ? value : [])
        .forEach((entry, index) => {
            if (entry?.parcelId) flows.push({ path: `${label}[${index}].parcelId`, id: String(entry.parcelId) });
        });
    addFlow('ownership_flow', row?.ownership_flow);
    addFlow('proposal_data.ownershipFlow', row?.proposal_data?.ownershipFlow);
    return { accepted, flows };
}

// The new declaration: parcels with >= 1 m² under the geometry. Parcels already declared keep their
// authored order; added ones follow, largest overlap first.
export function geometrySupportedDeclaration(previousIds, overlaps) {
    const supported = (overlaps || []).filter(hit => Number(hit.overlapM2) >= MIN_PARCEL_OVERLAP_M2);
    const supportedIds = new Set(supported.map(hit => String(hit.id)));
    const previous = (Array.isArray(previousIds) ? previousIds : []).map(String);
    const kept = previous.filter(id => supportedIds.has(id));
    const keptSet = new Set(kept);
    const added = supported
        .slice()
        .sort((left, right) => Number(right.overlapM2) - Number(left.overlapM2) || String(left.id).localeCompare(String(right.id)))
        .map(hit => String(hit.id))
        .filter(id => !keptSet.has(id));
    const dropped = previous.filter(id => !supportedIds.has(id));
    return { ids: [...kept, ...added], kept, added, dropped };
}

/**
 * Classify one stored row and, when it is migratable, compute the exact column updates.
 *
 * @param {object} row  proposal row (id, type, the WRITABLE_COLUMNS, accepted_parcel_ids, ownership_flow)
 * @param {object} options
 * @param {Array<{id:string, parcelAreaM2:number, overlapM2:number}>} options.overlaps  every current
 *        parcel the row's footprint intersects (any area); required for a row the API cannot read
 * @param {object} [options.parts]  footprintParts() of the row (computed when omitted)
 * @param {string} [options.now]    ISO time recorded as migratedAt
 * @returns {{ class: 'canonical'|'migratable'|'refused', reasons: object[], declaration?: object,
 *             approximate?: boolean, updates?: object, migrated?: object, removed?: object[] }}
 */
export function classifyLegacyRow(row, options = {}) {
    const reasons = [];
    let alreadyReadable = true;
    try {
        assertCanonicalProposalRow(row);
    } catch (error) {
        alreadyReadable = false;
        if (error?.code !== 'proposal-record-invalid') throw error;
    }
    if (alreadyReadable) return { class: 'canonical', reasons };

    const parts = options.parts || footprintParts(proposalGeometryView(row));
    if (parts.invalid || !hasFootprint(parts)) {
        reasons.push({ code: 'footprint-unavailable', detail: parts.invalid || 'the row carries no footprint geometry' });
        return { class: 'refused', reasons, approximate: parts.approximate };
    }
    if (!Array.isArray(options.overlaps)) throw new TypeError('classifyLegacyRow needs the measured parcel overlaps');
    const declaration = geometrySupportedDeclaration(row.cadastre_parcel_ids, options.overlaps);
    if (!declaration.ids.length) {
        reasons.push({ code: 'geometry-covers-no-parcel', detail: `no current parcel has >= ${MIN_PARCEL_OVERLAP_M2} m² under the geometry` });
        return { class: 'refused', reasons, declaration, approximate: parts.approximate };
    }
    const declaredSet = new Set(declaration.ids);

    const snapshotRemovals = [];
    for (const [container, prefix, map] of acceptanceContainers(row)) {
        for (const [parcelId, entry] of Object.entries(map)) {
            if (declaredSet.has(parcelId)) continue;
            if (hasRecordedConsent(entry)) {
                reasons.push({ code: 'consent-outside-declaration', path: pathLabel(container, [...prefix, parcelId]) });
            } else {
                snapshotRemovals.push({ container, path: [...prefix, parcelId], kind: 'ownership-snapshot', value: clone(entry) });
            }
        }
    }
    const { accepted, flows } = referenceLists(row);
    accepted.filter(ref => !declaredSet.has(ref.id))
        .forEach(ref => reasons.push({ code: 'acceptance-outside-declaration', path: ref.path, id: ref.id }));
    flows.filter(ref => !declaredSet.has(ref.id))
        .forEach(ref => reasons.push({ code: 'ownership-flow-outside-declaration', path: ref.path, id: ref.id }));
    if (reasons.length) return { class: 'refused', reasons, declaration, approximate: parts.approximate };

    const migrated = {};
    WRITABLE_COLUMNS.forEach(column => { migrated[column] = clone(row[column] ?? null); });
    migrated.id = row.id;
    migrated.accepted_parcel_ids = clone(row.accepted_parcel_ids ?? null);
    migrated.ownership_flow = clone(row.ownership_flow ?? null);
    if (!isPlainObject(migrated.proposal_data)) migrated.proposal_data = {};

    const removed = [...retiredParcelFields(row), ...snapshotRemovals]
        .map(field => ({ container: field.container, path: field.path, kind: field.kind, value: field.value }));
    if (own(row.proposal_data, 'cadastreParcelIds')) {
        removed.push({ container: 'proposal_data', path: ['cadastreParcelIds'], kind: 'declaration', value: clone(row.proposal_data.cadastreParcelIds) });
    }
    removed.forEach(field => removeAt(migrated, field.container, field.path));
    const added = [{ container: 'proposal_data', path: ['cadastreParcelIds'] }];
    migrated.proposal_data.cadastreParcelIds = declaration.ids.slice();
    migrated.cadastre_parcel_ids = declaration.ids.slice();

    const overlapById = new Map(options.overlaps.map(hit => [String(hit.id), hit]));
    const overlapM2 = {};
    [...declaration.ids, ...declaration.dropped].forEach(id => {
        overlapM2[id] = overlapById.has(id) ? round1(overlapById.get(id).overlapM2) : 0;
    });
    const previousLegacy = isPlainObject(migrated.proposal_data.legacy) ? migrated.proposal_data.legacy : {};
    migrated.proposal_data.legacy = {
        ...previousLegacy,
        [MIGRATION_ID]: {
            rule: MIGRATION_RULE,
            ruleText: MIGRATION_RULE_TEXT,
            migratedAt: options.now || new Date().toISOString(),
            sourceChecksum: recordChecksum(row),
            approximateFootprint: parts.approximate === true,
            footprintSources: parts.sources.slice(),
            previousCadastreParcelIds: clone(row.cadastre_parcel_ids ?? null),
            addedParcelIds: declaration.added.slice(),
            droppedParcelIds: declaration.dropped.slice(),
            overlapM2,
            hadLegacyKey: isPlainObject(row?.proposal_data?.legacy),
            removed,
            added
        }
    };

    try {
        assertCanonicalProposalRow(migrated);
    } catch (error) {
        if (error?.code !== 'proposal-record-invalid') throw error;
        reasons.push({ code: 'still-unreadable-after-migration', detail: error.detail || error.message });
        return { class: 'refused', reasons, declaration, approximate: parts.approximate };
    }

    const updates = {};
    WRITABLE_COLUMNS.forEach(column => {
        if (JSON.stringify(stableValue(migrated[column] ?? null)) !== JSON.stringify(stableValue(row[column] ?? null))) {
            updates[column] = migrated[column] ?? null;
        }
    });
    return { class: 'migratable', reasons, declaration, approximate: parts.approximate === true, updates, migrated, removed };
}

// Exact inverse of the transform, from the provenance block alone: restores the previous
// cadastre_parcel_ids, puts every removed value back at its path, drops what was added, and removes
// the block. Used by tests to prove the migration is reversible; also the recipe for a manual
// rollback of one row.
export function restoreLegacyParcelDeclarations(row) {
    const out = {};
    WRITABLE_COLUMNS.forEach(column => { out[column] = clone(row[column] ?? null); });
    const entry = out.proposal_data?.legacy?.[MIGRATION_ID];
    if (!entry) return out;
    delete out.proposal_data.legacy[MIGRATION_ID];
    if (!entry.hadLegacyKey && !Object.keys(out.proposal_data.legacy).length) delete out.proposal_data.legacy;
    (entry.added || []).forEach(field => removeAt(out, field.container, field.path));
    (entry.removed || []).forEach(field => setAt(out, field.container, field.path, field.value));
    out.cadastre_parcel_ids = clone(entry.previousCadastreParcelIds ?? null);
    return out;
}

export function parseArgs(argv) {
    const args = { apply: false, dryRun: false, ids: null, json: false, help: false };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--apply') args.apply = true;
        else if (arg === '--dry-run') args.dryRun = true;
        else if (arg === '--json') args.json = true;
        else if (arg === '--help' || arg === '-h') args.help = true;
        else if (arg === '--ids') {
            const list = String(argv[++index] || '').split(',').map(value => value.trim()).filter(Boolean);
            if (!list.length || list.some(value => !/^\d+$/.test(value))) throw new Error('--ids needs comma-separated numeric row ids');
            args.ids = list.map(Number);
        } else throw new Error(`Unknown argument: ${arg}`);
    }
    if (args.apply && args.dryRun) throw new Error('Pass either --dry-run or --apply, not both.');
    if (!args.apply && !args.dryRun) args.help = true;
    return args;
}

function usage() {
    console.log([
        'Re-declare the land of proposal rows the API cannot read (retired parcel declarations) as the',
        `current cadastral parcels their own geometry covers by >= ${MIN_PARCEL_OVERLAP_M2} m², archiving everything`,
        'replaced under proposal_data.legacy. Rows with no usable footprint, no covered parcel or recorded',
        'consent outside the new declaration are refused.',
        '',
        '  --dry-run   Classify and report. Opens a READ ONLY session; writes nothing.',
        '  --apply     Write migratable rows, one UPDATE per row, each in its own transaction',
        '              that locks, re-measures, re-classifies and re-verifies the row.',
        '  --ids LIST  Limit to comma-separated numeric row ids.',
        '  --json      Also print the full per-row report as JSON.',
        '  --help      Show this message.',
        '',
        'Idempotent: a migrated row passes the serializer and is reported as canonical next time.',
        'Connection: PG* variables (backend/.env, or exported to point at another database).'
    ].join('\n'));
}

const ts = () => new Date().toISOString();
const log = message => console.log(`[${ts()}] ${message}`);

const ROW_COLUMNS = `id, proposal_id, city, type, title, accepted_parcel_ids, ownership_flow, ${WRITABLE_COLUMNS.join(', ')}`;

async function measure(db, row) {
    const parts = footprintParts(proposalGeometryView(row));
    const overlaps = hasFootprint(parts) ? await parcelOverlaps(db, parts, { minAreaM2: 0 }) : [];
    return { parts, overlaps };
}

function examples(ids, limit = 3) {
    return ids.length ? `${ids.slice(0, limit).join(', ')}${ids.length > limit ? `, … (+${ids.length - limit})` : ''}` : '—';
}

function describe(result) {
    if (result.class === 'refused') {
        return result.reasons.map(reason => reason.code).filter((code, index, all) => all.indexOf(code) === index).join(', ');
    }
    const d = result.declaration;
    return `${d.kept.length + d.dropped.length} → ${d.ids.length} parcels · +${d.added.length} [${examples(d.added)}] · `
        + `−${d.dropped.length} [${examples(d.dropped)}]${result.approximate ? ' · APPROXIMATE footprint' : ''}`;
}

async function applyRow(pool, id) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(`SELECT ${ROW_COLUMNS} FROM proposal WHERE id = $1 FOR UPDATE`, [id]);
        if (!rows.length) { await client.query('ROLLBACK'); return { status: 'gone' }; }
        const { parts, overlaps } = await measure(client, rows[0]);
        const result = classifyLegacyRow(rows[0], { parts, overlaps });
        if (result.class !== 'migratable') { await client.query('ROLLBACK'); return { status: `now-${result.class}` }; }
        const columns = Object.keys(result.updates);
        const values = columns.map(column => JSON.stringify(result.updates[column]));
        const assignments = columns.map((column, index) => `${column} = $${index + 1}::jsonb`);
        await client.query(
            `UPDATE proposal SET ${assignments.join(', ')}, updated_at = now() WHERE id = $${columns.length + 1}`,
            [...values, id]
        );
        // Verify from the row as stored, not from the absence of an error.
        const { rows: after } = await client.query(`SELECT ${ROW_COLUMNS} FROM proposal WHERE id = $1`, [id]);
        assertCanonicalProposalRow(after[0]);
        await client.query('COMMIT');
        return { status: 'written', columns };
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        return { status: 'failed', error: error.detail || error.message };
    } finally {
        client.release();
    }
}

export async function run(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (args.help) { usage(); return 0; }
    if (!process.env.PGDATABASE) {
        console.error('PGDATABASE is not set — refusing to guess a database.');
        return 1;
    }
    const pool = new Pool();
    const reader = await pool.connect();
    try {
        // A dry run cannot write even by mistake: the session itself is read-only.
        if (!args.apply) await reader.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
        const { rows: [target] } = await reader.query(
            "SELECT current_database() AS db, current_user AS usr, coalesce(inet_server_addr()::text, 'socket') AS host, inet_server_port() AS port, current_setting('transaction_read_only') AS ro"
        );
        log(`${MIGRATION_ID} (${MIGRATION_RULE}) · mode ${args.apply ? 'APPLY' : 'DRY RUN'} · db ${target.db} as ${target.usr} @ ${target.host}:${target.port} · read_only=${target.ro}`);

        const filter = args.ids ? 'WHERE id = ANY($1::int[])' : '';
        const { rows } = await reader.query(`SELECT ${ROW_COLUMNS} FROM proposal ${filter} ORDER BY id`, args.ids ? [args.ids] : []);
        const now = ts();
        const pending = [];
        let canonical = 0;
        for (const row of rows) {
            const quick = classifyLegacyRow(row, { overlaps: [] }).class;
            if (quick === 'canonical') { canonical += 1; continue; }
            pending.push(row);
        }
        log(`${rows.length} row(s) read, ${canonical} already canonical (skipped), ${pending.length} to classify`);

        const results = [];
        for (const [index, row] of pending.entries()) {
            const { parts, overlaps } = await measure(reader, row);
            const result = classifyLegacyRow(row, { parts, overlaps, now });
            results.push({ row, result });
            log(`${index + 1}/${pending.length} #${row.id} ${row.type || '?'} ${result.class.toUpperCase()} · ${describe(result)} · ${String(row.title || '').slice(0, 50)}`);
        }
        const migratable = results.filter(item => item.result.class === 'migratable').map(item => item.row.id);
        const refused = results.filter(item => item.result.class === 'refused').map(item => item.row.id);

        const stats = { written: 0, skipped: 0, failed: 0 };
        if (args.apply) {
            log(`applying ${migratable.length} migratable row(s); ${refused.length} refused`);
            for (const [index, id] of migratable.entries()) {
                const outcome = await applyRow(pool, id);
                if (outcome.status === 'written') stats.written += 1;
                else if (outcome.status === 'failed') stats.failed += 1;
                else stats.skipped += 1;
                log(`apply ${index + 1}/${migratable.length} #${id} ${outcome.status}${outcome.columns ? ` (${outcome.columns.join(',')})` : ''}${outcome.error ? ` · ${outcome.error}` : ''}`);
            }
        }

        const approximate = results.filter(item => item.result.approximate).map(item => item.row.id);
        console.log(JSON.stringify({
            migrationId: MIGRATION_ID,
            rule: MIGRATION_RULE,
            mode: args.apply ? 'apply' : 'dry-run',
            total: rows.length,
            canonical,
            migratable,
            refused,
            approximateFootprint: approximate,
            ...(args.apply ? { stats } : {})
        }, null, 2));
        if (args.json) {
            console.log(JSON.stringify(results.map(({ row, result }) => ({
                id: row.id,
                type: row.type,
                class: result.class,
                reasons: result.reasons,
                approximateFootprint: result.approximate === true,
                ...(result.declaration ? {
                    previousCount: (row.cadastre_parcel_ids || []).length,
                    newCount: result.declaration.ids.length,
                    added: result.declaration.added,
                    dropped: result.declaration.dropped
                } : {}),
                ...(result.updates ? { columns: Object.keys(result.updates) } : {})
            })), null, 2));
        }
        return stats.failed ? 1 : 0;
    } finally {
        reader.release();
        await pool.end();
    }
}

const invokedDirectly = process.argv[1]
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
    run().then(code => { process.exitCode = code; }).catch(error => {
        console.error(`[${ts()}] FAILED: ${error.stack || error.message}`);
        process.exitCode = 1;
    });
}
