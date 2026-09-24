// Make stored proposals that still carry RETIRED parcel declarations readable again, without
// changing what they declare.
//
// The strict serializer (commit 7815c9d) rejects any row that still holds a retired alias such as
// proposal_data.parentParcelIds, so GET /proposals/:id answers 422 for it. The 2026-09-04
// migration (migrate-tessellation.js) promoted a legacy declaration only when EVERY declaration
// named the same set and no linked record used a generated piece id; 80 Zagreb rows failed that
// and were left unusable on purpose ("ambiguous records remain unusable, no plan-specific fixers").
//
// This script is deliberately narrower than a fixer. The row's cadastre_parcel_ids column is the
// authority and is NEVER changed. A row is migrated only when:
//   - every retired LAND declaration (parentParcelIds, parcelIds, <sub>.parentParcelIds,
//     reparcellization.parcelIds, buildingProposal.blockParcelIds, ancestor_parcel_ids) names
//     exactly the cadastre_parcel_ids set, with no generated ids;
//   - every ownerAcceptances entry outside that set is an owner ROSTER with no recorded consent
//     (acceptedBy / acceptedOwnerKeys empty) — a roster is re-derivable, consent is not;
//   - no acceptedParcelIds / ownershipFlow entry lies outside the set;
//   - the resulting row passes the API serializer.
// Anything else is AMBIGUOUS (two defensible answers — a person must choose) or UNRECOVERABLE
// (no valid authority at all), and is never written.
//
// Records are immutable by design. Migrating here changes the row's representation, not its
// instruction: the land it declares (cadastre_parcel_ids) is untouched, and every removed value is
// kept byte-for-byte under proposal_data.legacy["<MIGRATION_ID>"] with its exact container and
// path, so restoreLegacyParcelDeclarations() reverses it exactly. The serializer never serves
// `legacy`.
//
//   node scripts/migrate-legacy-parcel-declarations.mjs --help
//   node scripts/migrate-legacy-parcel-declarations.mjs --dry-run            # read-only report
//   node scripts/migrate-legacy-parcel-declarations.mjs --dry-run --ids 8,20
//   node scripts/migrate-legacy-parcel-declarations.mjs --apply              # writes migratable rows

import pkg from 'pg';
import dotenv from 'dotenv';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { assertCanonicalProposalRow } from '../proposals/serializer.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

const requireCjs = createRequire(import.meta.url);
const authoredRecord = requireCjs('../../frontend/js/proposals/authored-record.js');
const { Pool } = pkg;

export const MIGRATION_ID = 'legacy-parcel-declarations-v1';
export const MIGRATION_RULE = 'Retired declarations equal to cadastre_parcel_ids, and unconsented owner '
    + 'rosters keyed outside it, are moved here verbatim; cadastre_parcel_ids is unchanged.';

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
    'proposal_data', 'road_proposal', 'building_proposal', 'structure_proposal', 'reparcellization',
    'owner_acceptances', 'ancestor_parcel_ids'
]);

const own = (value, key) => !!value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key);
const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value instanceof Date) return value.toISOString();
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

export function recordChecksum(row) {
    const subset = Object.fromEntries(WRITABLE_COLUMNS.map(column => [column, row?.[column] ?? null]));
    subset.cadastre_parcel_ids = row?.cadastre_parcel_ids ?? null;
    return createHash('sha256').update(JSON.stringify(stableValue(subset))).digest('hex');
}

function pathLabel(container, path) {
    return path.reduce((label, key) => (typeof key === 'number' ? `${label}[${key}]` : `${label}.${key}`), container);
}

// Every retired field present on the row, with the exact place it lives. `kind: 'land'` fields are
// parcel-set declarations and must agree with cadastre_parcel_ids; `kind: 'metadata'` fields are
// retired per-piece bookkeeping that the API projection already drops (authored-record.js).
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
// roster shape is treated as possible consent — the safe direction is "ambiguous".
export function hasRecordedConsent(entry) {
    if (!isPlainObject(entry)) return true;
    if (isPlainObject(entry.acceptedBy) && Object.keys(entry.acceptedBy).length) return true;
    if (entry.acceptedBy !== undefined && !isPlainObject(entry.acceptedBy)) return true;
    if (Array.isArray(entry.acceptedOwnerKeys) && entry.acceptedOwnerKeys.length) return true;
    if (entry.acceptedOwnerKeys !== undefined && !Array.isArray(entry.acceptedOwnerKeys)) return true;
    if (entry.accepted === true || entry.acceptedAt) return true;
    return false;
}

function setRelation(declared, legacy) {
    const declaredSet = new Set(declared);
    const legacySet = new Set(legacy);
    const inBoth = legacy.filter(id => declaredSet.has(id)).length;
    if (inBoth === legacySet.size && inBoth === declaredSet.size) return 'equal';
    if (inBoth === legacySet.size) return 'subset';
    if (inBoth === declaredSet.size) return 'superset';
    return inBoth ? 'overlap' : 'disjoint';
}

function validDeclaration(ids) {
    return Array.isArray(ids) && ids.length > 0
        && ids.every(id => typeof id === 'string' && id && id === id.trim())
        && new Set(ids).size === ids.length
        && !ids.some(id => authoredRecord.isDerivedParcelId(id));
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

/**
 * Classify one stored row and, when it is migratable, compute the exact column updates.
 *
 * @param {object} row  proposal row (the columns in WRITABLE_COLUMNS plus id, cadastre_parcel_ids,
 *                      accepted_parcel_ids, ownership_flow)
 * @param {object} [options]
 * @param {(id: string) => boolean|null} [options.parcelExists]  false = id is not a cadastral parcel
 *                      at all (e.g. a synthetic fantasy id); null = cannot be checked
 * @param {string} [options.now]  ISO time recorded as migratedAt
 * @returns {{ class: 'canonical'|'migratable'|'ambiguous'|'unrecoverable', reasons: object[],
 *             warnings: object[], updates?: object, migrated?: object }}
 */
export function classifyLegacyRow(row, options = {}) {
    const reasons = [];
    const warnings = [];
    let alreadyReadable = true;
    try {
        assertCanonicalProposalRow(row);
    } catch (error) {
        alreadyReadable = false;
        if (error?.code !== 'proposal-record-invalid') throw error;
    }
    if (alreadyReadable) return { class: 'canonical', reasons, warnings };

    const declared = row?.cadastre_parcel_ids;
    if (!validDeclaration(declared)) {
        reasons.push({ code: 'no-canonical-declaration', message: 'cadastre_parcel_ids is missing, malformed or contains generated ids.' });
        return { class: 'unrecoverable', reasons, warnings };
    }
    const declaredSet = new Set(declared);
    if (typeof options.parcelExists === 'function') {
        const unknown = declared.filter(id => options.parcelExists(id) === false);
        if (unknown.length) {
            reasons.push({ code: 'declared-parcel-unknown', message: 'Declared ids are not cadastral parcels.', ids: unknown });
        }
    }

    const retired = retiredParcelFields(row);
    for (const field of retired) {
        if (field.kind !== 'land') continue;
        const label = pathLabel(field.container, field.path);
        if (field.value === null || (Array.isArray(field.value) && !field.value.length)) continue;
        if (!Array.isArray(field.value) || !field.value.every(id => typeof id === 'string' || typeof id === 'number')) {
            reasons.push({ code: 'legacy-declaration-malformed', path: label });
            continue;
        }
        const ids = field.value.map(String);
        const generated = ids.filter(id => authoredRecord.isDerivedParcelId(id));
        if (generated.length) {
            reasons.push({ code: 'legacy-declaration-generated-ids', path: label, ids: generated });
            continue;
        }
        const relation = setRelation(declared, ids);
        if (relation !== 'equal') {
            reasons.push({
                code: 'legacy-declaration-disagrees',
                path: label,
                relation,
                declaredCount: declared.length,
                legacyCount: new Set(ids).size,
                onlyInLegacy: ids.filter(id => !declaredSet.has(id)),
                onlyDeclared: declared.filter(id => !ids.includes(id)).length
            });
        }
    }

    const rosterRemovals = [];
    for (const [container, prefix, map] of acceptanceContainers(row)) {
        for (const [parcelId, entry] of Object.entries(map)) {
            if (declaredSet.has(parcelId)) continue;
            if (hasRecordedConsent(entry)) {
                reasons.push({ code: 'consent-outside-declaration', path: pathLabel(container, [...prefix, parcelId]) });
            } else {
                rosterRemovals.push({ container, path: [...prefix, parcelId], kind: 'roster', value: clone(entry) });
            }
        }
    }
    const { accepted, flows } = referenceLists(row);
    accepted.filter(ref => !declaredSet.has(ref.id))
        .forEach(ref => reasons.push({ code: 'acceptance-outside-declaration', path: ref.path, id: ref.id }));
    flows.filter(ref => !declaredSet.has(ref.id))
        .forEach(ref => reasons.push({ code: 'ownership-flow-outside-declaration', path: ref.path, id: ref.id }));

    const dataDeclaration = row?.proposal_data?.cadastreParcelIds;
    if (dataDeclaration !== undefined
        && !(Array.isArray(dataDeclaration) && setRelation(declared, dataDeclaration.map(String)) === 'equal')) {
        reasons.push({ code: 'proposal-data-declaration-conflicts', path: 'proposal_data.cadastreParcelIds' });
    }

    if (reasons.length) return { class: 'ambiguous', reasons, warnings };

    // Transform: move every retired field and unconsented out-of-set roster verbatim into the
    // provenance block, and write the declaration into proposal_data like every canonical row.
    const migrated = {};
    WRITABLE_COLUMNS.forEach(column => { migrated[column] = clone(row[column] ?? null); });
    migrated.id = row.id;
    migrated.cadastre_parcel_ids = declared.slice();
    migrated.accepted_parcel_ids = clone(row.accepted_parcel_ids ?? null);
    migrated.ownership_flow = clone(row.ownership_flow ?? null);
    if (!isPlainObject(migrated.proposal_data)) migrated.proposal_data = {};

    const removed = [...retired, ...rosterRemovals]
        .map(field => ({ container: field.container, path: field.path, kind: field.kind, value: field.value }));
    removed.forEach(field => removeAt(migrated, field.container, field.path));
    const added = [];
    if (!own(migrated.proposal_data, 'cadastreParcelIds')) {
        migrated.proposal_data.cadastreParcelIds = declared.slice();
        added.push({ container: 'proposal_data', path: ['cadastreParcelIds'] });
    }
    const previousLegacy = isPlainObject(migrated.proposal_data.legacy) ? migrated.proposal_data.legacy : {};
    migrated.proposal_data.legacy = {
        ...previousLegacy,
        [MIGRATION_ID]: {
            migratedAt: options.now || new Date().toISOString(),
            rule: MIGRATION_RULE,
            sourceChecksum: recordChecksum(row),
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
        return { class: 'unrecoverable', reasons, warnings };
    }

    const updates = {};
    WRITABLE_COLUMNS.forEach(column => {
        if (JSON.stringify(stableValue(migrated[column] ?? null)) !== JSON.stringify(stableValue(row[column] ?? null))) {
            updates[column] = migrated[column] ?? null;
        }
    });
    return { class: 'migratable', reasons, warnings, updates, migrated, removed, added };
}

// Exact inverse of the transform, from the provenance block alone: puts every removed value back
// at its path, drops what was added, and removes the block. Used by tests to prove the migration
// is reversible; also the recipe for a manual rollback of one row.
export function restoreLegacyParcelDeclarations(row) {
    const out = {};
    WRITABLE_COLUMNS.forEach(column => { out[column] = clone(row[column] ?? null); });
    const entry = out.proposal_data?.legacy?.[MIGRATION_ID];
    if (!entry) return out;
    delete out.proposal_data.legacy[MIGRATION_ID];
    if (!entry.hadLegacyKey && !Object.keys(out.proposal_data.legacy).length) delete out.proposal_data.legacy;
    (entry.added || []).forEach(field => removeAt(out, field.container, field.path));
    (entry.removed || []).forEach(field => setAt(out, field.container, field.path, field.value));
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
        'Move retired parcel declarations of unreadable proposal rows into proposal_data.legacy,',
        'when they provably say the same thing as cadastre_parcel_ids. Ambiguous rows are refused.',
        '',
        '  --dry-run   Classify and report. Opens a READ ONLY session; writes nothing.',
        '  --apply     Write migratable rows, one UPDATE per row, each in its own transaction',
        '              that re-reads, re-classifies and re-verifies the row.',
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

const ROW_COLUMNS = `id, proposal_id, city, title, cadastre_parcel_ids, accepted_parcel_ids, ownership_flow,
    ${WRITABLE_COLUMNS.join(', ')}`;

async function loadParcelExistence(db, rows) {
    const pairs = new Map();
    rows.forEach(row => (Array.isArray(row.cadastre_parcel_ids) ? row.cadastre_parcel_ids : []).forEach(id => {
        const match = /^HR-(\d+)-(.+)$/.exec(String(id));
        if (match) pairs.set(String(id), [Number(match[1]), match[2]]);
    }));
    if (!pairs.size) return () => null;
    const kos = []; const numbers = [];
    pairs.forEach(([ko, number]) => { kos.push(ko); numbers.push(number); });
    const { rows: found } = await db.query(`
        SELECT DISTINCT 'HR-' || p.maticni_broj_ko || '-' || p.broj_cestice AS id
        FROM unnest($1::int[], $2::text[]) AS u(ko, nr)
        JOIN parcel p ON p.maticni_broj_ko = u.ko AND p.broj_cestice = u.nr`, [kos, numbers]);
    const known = new Set(found.map(row => row.id));
    return id => (pairs.has(String(id)) ? known.has(String(id)) : null);
}

function describe(result) {
    if (result.class === 'migratable') {
        const land = result.removed.filter(field => field.kind === 'land').length;
        const meta = result.removed.filter(field => field.kind === 'metadata').length;
        const roster = result.removed.filter(field => field.kind === 'roster').length;
        return `archive ${land} land decl, ${meta} metadata, ${roster} roster entr${roster === 1 ? 'y' : 'ies'}; columns ${Object.keys(result.updates).join(',')}`;
    }
    const codes = {};
    result.reasons.forEach(reason => {
        const key = reason.relation ? `${reason.code}(${reason.relation})` : reason.code;
        codes[key] = (codes[key] || 0) + 1;
    });
    return Object.entries(codes).map(([code, count]) => (count > 1 ? `${code}×${count}` : code)).join(', ');
}

async function applyRow(pool, id, parcelExists) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(`SELECT ${ROW_COLUMNS} FROM proposal WHERE id = $1 FOR UPDATE`, [id]);
        if (!rows.length) { await client.query('ROLLBACK'); return { status: 'gone' }; }
        const result = classifyLegacyRow(rows[0], { parcelExists });
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
        log(`${MIGRATION_ID} · mode ${args.apply ? 'APPLY' : 'DRY RUN'} · db ${target.db} as ${target.usr} @ ${target.host}:${target.port} · read_only=${target.ro}`);

        const filter = args.ids ? 'WHERE id = ANY($1::int[])' : '';
        const { rows } = await reader.query(`SELECT ${ROW_COLUMNS} FROM proposal ${filter} ORDER BY id`, args.ids ? [args.ids] : []);
        const parcelExists = await loadParcelExistence(reader, rows);
        const now = ts();
        const results = rows.map(row => ({ row, result: classifyLegacyRow(row, { parcelExists, now }) }));
        const pending = results.filter(item => item.result.class !== 'canonical');
        log(`${rows.length} row(s) read, ${rows.length - pending.length} already canonical (skipped), ${pending.length} to classify`);

        const byClass = { migratable: [], ambiguous: [], unrecoverable: [] };
        pending.forEach(({ row, result }, index) => {
            byClass[result.class].push(row.id);
            log(`${index + 1}/${pending.length} #${row.id} ${result.class.toUpperCase()} · ${describe(result)} · ${String(row.title || '').slice(0, 60)}`);
        });

        const stats = { written: 0, skipped: 0, failed: 0 };
        if (args.apply) {
            log(`applying ${byClass.migratable.length} migratable row(s); ${byClass.ambiguous.length + byClass.unrecoverable.length} refused`);
            for (const [index, id] of byClass.migratable.entries()) {
                const outcome = await applyRow(pool, id, parcelExists);
                if (outcome.status === 'written') stats.written += 1;
                else if (outcome.status === 'failed') stats.failed += 1;
                else stats.skipped += 1;
                log(`apply ${index + 1}/${byClass.migratable.length} #${id} ${outcome.status}${outcome.columns ? ` (${outcome.columns.join(',')})` : ''}${outcome.error ? ` · ${outcome.error}` : ''}`);
            }
        }

        const summary = {
            migrationId: MIGRATION_ID,
            mode: args.apply ? 'apply' : 'dry-run',
            total: rows.length,
            canonical: rows.length - pending.length,
            migratable: byClass.migratable,
            ambiguous: byClass.ambiguous,
            unrecoverable: byClass.unrecoverable,
            ...(args.apply ? { stats } : {})
        };
        console.log(JSON.stringify(summary, null, 2));
        if (args.json) {
            console.log(JSON.stringify(pending.map(({ row, result }) => ({
                id: row.id,
                class: result.class,
                reasons: result.reasons,
                ...(result.removed ? { removed: result.removed.map(field => pathLabel(field.container, field.path)) } : {}),
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
