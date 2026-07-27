// Rewrites legacy demolition records from the DGU cadastre key space to the GDI one:
// `record.id` goes from a zgrada_id (dgu_building) to an object_id (gdi_building_*), resolved
// through dgu_gdi_building_match.
//
// WHY: cut/tunnel/demolish detection used to scan the DGU cadastre footprints while the 3D view and
// the walk sim rendered GDI meshes — two different surveys of the same city, in two different key
// spaces. Records written then name a cadastre building. Detection now scans the GDI objects, and
// every consumer matches a record to a mesh EXACTLY by object_id, so a record still carrying a
// zgrada_id names nothing and its building silently comes back from the dead.
//
// IDEMPOTENT + RESTARTABLE. A rewritten record keeps its old id under `zgradaId`, which is also the
// marker that says "already migrated" — those records are skipped on a re-run, so the script can be
// killed and restarted at will and can never double-map (both key spaces are plain integers, so a
// second blind pass would happily treat an object_id as a zgrada_id). Each proposal is committed on
// its own, so progress survives a crash.
//
// Records that are NOT cadastre ids are left alone by design:
//   proposal:<id>:<n>  a PROPOSED building demolished by a later proposal — no cadastre identity
//   geom:...           a geometry-derived fallback key — no cadastre identity
// Records whose zgrada_id has no row in dgu_gdi_building_match are left alone too, and REPORTED:
// there is no object_id to point them at, and inventing one would be worse than leaving them.
//
// DRY RUN BY DEFAULT. Nothing is written unless --apply is passed.
//
// Usage:
//   node scripts/migrate-demolition-ids-to-object-id.js --help
//   node scripts/migrate-demolition-ids-to-object-id.js                      # dry run, all proposals
//   node scripts/migrate-demolition-ids-to-object-id.js --proposals 55,62    # dry run, by id
//   node scripts/migrate-demolition-ids-to-object-id.js --proposals 55,62 --apply

import pkg from 'pg';
import 'dotenv/config';

const { Pool } = pkg;

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);
const warn = (...args) => console.warn(`[${new Date().toISOString()}]`, ...args);

function usage() {
    console.log(`
Migrate demolition record ids from the DGU cadastre (zgrada_id) to GDI objects (object_id).

  --proposals <a,b,c>   Only these proposal ids (numeric id or proposal_id). Default: every
                        proposal that carries demolition records.
  --apply               Actually write. WITHOUT THIS NOTHING IS WRITTEN (dry run is the default).
  --drop-unresolved     Remove records naming a cadastre building GDI has never surveyed. They
                        cannot be migrated (no object_id exists) and nothing reads them any more.
  --help                Print this and exit.

Reads the database from the usual PG* env vars (backend/.env).
Every rewritten record keeps its old cadastre id as \`zgradaId\`, which makes the script safe to
re-run: already-migrated records are skipped, never re-mapped.
`);
}

function parseArgs(argv) {
    const args = { proposals: null, apply: false, dropUnresolved: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') args.help = true;
        else if (arg === '--apply') args.apply = true;
        else if (arg === '--drop-unresolved') args.dropUnresolved = true;
        else if (arg === '--proposals') args.proposals = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
        else if (arg.startsWith('--proposals=')) args.proposals = arg.slice(12).split(',').map(s => s.trim()).filter(Boolean);
        else {
            console.error(`Unknown argument: ${arg}`);
            usage();
            process.exit(1);
        }
    }
    return args;
}

// The three places a demolition record can live on a proposal. Each is a (column, path) pair,
// where the path is where the array sits inside that column's JSON.
const RECORD_SITES = [
    { column: 'road_proposal', path: ['definition', 'demolishedBuildings'], label: 'roadProposal.definition' },
    { column: 'structure_proposal', path: ['demolishedBuildings'], label: 'structureProposal' },
    { column: 'building_proposal', path: ['demolishedBuildings'], label: 'buildingProposal' }
];

function readPath(root, path) {
    let node = root;
    for (const key of path) {
        if (!node || typeof node !== 'object') return null;
        node = node[key];
    }
    return Array.isArray(node) ? node : null;
}

// Only a bare integer can be a zgrada_id. `proposal:…` and `geom:…` ids have no cadastre identity.
const isCadastreId = (id) => /^\d+$/.test(String(id));

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        usage();
        return;
    }

    const pool = new Pool({
        host: process.env.PGHOST,
        port: Number(process.env.PGPORT) || 5432,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE
    });

    log(`Connecting to ${process.env.PGDATABASE}@${process.env.PGHOST}:${process.env.PGPORT || 5432} as ${process.env.PGUSER}`);
    log(args.apply ? 'MODE: APPLY — changes WILL be written.' : 'MODE: DRY RUN — nothing will be written. Pass --apply to write.');

    const totals = {
        proposals: 0, proposalsChanged: 0,
        records: 0, cadastre: 0, alreadyMigrated: 0, nonCadastre: 0,
        resolved: 0, unresolved: 0, dropped: 0
    };
    const unresolvedList = [];

    try {
        const where = args.proposals
            ? 'WHERE proposal_id = ANY($1::text[]) OR id::text = ANY($1::text[])'
            : '';
        const params = args.proposals ? [args.proposals] : [];
        const { rows } = await pool.query(
            `SELECT id, proposal_id, status, road_proposal, structure_proposal, building_proposal
             FROM proposal ${where} ORDER BY id`,
            params
        );
        log(`Scanning ${rows.length} proposal(s).`);

        for (const row of rows) {
            // Collect every cadastre id this proposal still uses, so the whole proposal needs only
            // one lookup no matter how many sites its records are spread across.
            const pending = new Set();
            for (const site of RECORD_SITES) {
                for (const record of readPath(row[site.column], site.path) || []) {
                    if (!record || record.id === undefined || record.id === null) continue;
                    if (record.zgradaId !== undefined) continue;          // already migrated
                    if (!isCadastreId(record.id)) continue;               // proposal:…/geom:… id
                    pending.add(Number(record.id));
                }
            }

            let matches = new Map();
            if (pending.size) {
                const { rows: matchRows } = await pool.query(
                    'SELECT zgrada_id, object_id FROM dgu_gdi_building_match WHERE zgrada_id = ANY($1::int[])',
                    [[...pending]]
                );
                matches = new Map(matchRows.map(m => [String(m.zgrada_id), m.object_id]));
            }

            const updates = [];
            let proposalRecords = 0;
            let proposalResolved = 0;
            let proposalUnresolved = 0;
            let proposalDropped = 0;

            for (const site of RECORD_SITES) {
                const records = readPath(row[site.column], site.path);
                if (!records || !records.length) continue;

                let siteChanged = false;
                // Records naming a cadastre building GDI has never surveyed. They cannot be migrated
                // (there is no object_id to migrate TO) and nothing reads them any more, so
                // --drop-unresolved removes them rather than leaving a stale key space behind.
                const unmigratable = [];
                for (const record of records) {
                    if (!record || record.id === undefined || record.id === null) continue;
                    proposalRecords++;
                    totals.records++;

                    if (record.zgradaId !== undefined) {
                        totals.alreadyMigrated++;
                        continue;
                    }
                    if (!isCadastreId(record.id)) {
                        totals.nonCadastre++;
                        continue;
                    }

                    totals.cadastre++;
                    const objectId = matches.get(String(record.id));
                    if (objectId === undefined) {
                        totals.unresolved++;
                        proposalUnresolved++;
                        unresolvedList.push({
                            proposal: row.proposal_id || row.id,
                            proposalDbId: row.id,
                            site: site.label,
                            zgradaId: String(record.id)
                        });
                        if (args.dropUnresolved) unmigratable.push(record);
                        continue;
                    }

                    // Rewrite in place. `zgradaId` preserves the old identity AND marks the record
                    // migrated, which is what makes a re-run a no-op instead of a corruption.
                    record.zgradaId = String(record.id);
                    record.id = String(objectId);
                    siteChanged = true;
                    totals.resolved++;
                    proposalResolved++;
                }

                // Splice the unmigratable ones out of the live array (it is the one inside the JSONB
                // that gets written back). Reverse order so the indices stay valid.
                if (unmigratable.length) {
                    for (let i = records.length - 1; i >= 0; i--) {
                        if (unmigratable.includes(records[i])) records.splice(i, 1);
                    }
                    totals.dropped += unmigratable.length;
                    proposalDropped += unmigratable.length;
                    siteChanged = true;
                }

                if (siteChanged) updates.push(site);
            }

            totals.proposals++;
            if (!updates.length) {
                if (proposalRecords) {
                    log(`  proposal ${row.proposal_id || row.id}: ${proposalRecords} record(s), nothing to rewrite`
                        + `${proposalUnresolved ? ` (${proposalUnresolved} UNRESOLVED)` : ''}`);
                }
                continue;
            }

            totals.proposalsChanged++;
            log(`  proposal ${row.proposal_id || row.id} [${row.status}]: ${proposalRecords} record(s) — `
                + `${proposalResolved} rewritten, ${proposalUnresolved} unresolved`
                + `${proposalDropped ? `, ${proposalDropped} DROPPED` : ''}`
                + ` [${updates.map(u => u.label).join(', ')}]`);

            if (!args.apply) continue;

            // One statement per proposal, so a crash leaves every other proposal untouched and the
            // re-run picks up exactly where it left off.
            const sets = updates.map((site, i) => `${site.column} = $${i + 2}::jsonb`).join(', ');
            const values = updates.map(site => JSON.stringify(row[site.column]));
            await pool.query(
                `UPDATE proposal SET ${sets}, updated_at = now() WHERE id = $1`,
                [row.id, ...values]
            );
            log(`  proposal ${row.proposal_id || row.id}: WRITTEN`);
        }

        log('---------------------------------------------------------------');
        log(`Proposals scanned      : ${totals.proposals}`);
        log(`Proposals to change    : ${totals.proposalsChanged}`);
        log(`Demolition records     : ${totals.records}`);
        log(`  cadastre-keyed       : ${totals.cadastre}`);
        log(`    → resolved         : ${totals.resolved}`);
        log(`    → UNRESOLVED       : ${totals.unresolved}`);
        if (args.dropUnresolved) log(`    → DROPPED          : ${totals.dropped}  (--drop-unresolved)`);
        log(`  already migrated     : ${totals.alreadyMigrated}`);
        log(`  not cadastre ids     : ${totals.nonCadastre}  (proposal:…/geom:… — nothing to do)`);

        if (unresolvedList.length) {
            warn('---------------------------------------------------------------');
            warn(`${unresolvedList.length} record(s) have NO row in dgu_gdi_building_match — `
                + `${args.dropUnresolved ? 'DROPPED (GDI has no such building)' : 'left as they are (pass --drop-unresolved to remove them)'}:`);
            for (const item of unresolvedList) {
                warn(`  proposal ${item.proposal} (db id ${item.proposalDbId}) ${item.site}: zgrada_id ${item.zgradaId}`);
            }
        }

        if (!args.apply) {
            log('---------------------------------------------------------------');
            log('DRY RUN — nothing was written. Re-run with --apply to commit.');
        }
    } finally {
        await pool.end();
    }
}

main().catch(err => {
    console.error(`[${new Date().toISOString()}] FAILED:`, err);
    process.exit(1);
});
