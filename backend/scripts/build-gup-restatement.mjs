// Resumable GUP-to-native-proposal export; reads the current cache, never runs the city solver.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import dotenv from 'dotenv';
import { createPool, isLocalDatabase } from '../db/connection.cjs';
import { translateParcel, summarizeAudits, retainSourceQuantities, TRANSLATOR_VERSION, digest, REASONS } from '../gup-restatement/translate.js';
import { serializeProposalRow } from '../proposals/serializer.js';
import { createPlanStore } from '../plans/plan-store.js';
import { memberHash, planHash, stableStringify } from '../plans/plan-hash.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const log = message => console.log(`[gup-restatement ${new Date().toISOString()}] ${message}`);
const sqlScope = `SELECT ST_UnaryUnion(ST_Collect(ST_MakeValid(geom))) AS geom
    FROM consensus.urban_rule WHERE gup = '2025' AND current AND geom IS NOT NULL`;

export function parseArgs(args) {
    const options = { out: resolve(root, 'tmp/gup-2025-restatement'), batchSize: 1000, strictScalars: false };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--build') options.build = true;
        else if (arg === '--apply') options.apply = true;
        else if (arg === '--strict-scalars') options.strictScalars = true;
        else if (arg === '--out') options.out = resolve(args[++i] || '');
        else if (arg === '--env-file') options.envFile = resolve(args[++i] || '');
        else if (arg === '--gup-text') options.gupText = resolve(args[++i] || '');
        else if (arg === '--batch-size') options.batchSize = Number(args[++i]);
        else if (arg === '--help') options.help = true;
        else throw new Error(`Unknown option ${arg}`);
    }
    if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 2000) throw new Error('batch-size must be 1–2000');
    if (options.build && options.apply) throw new Error('Build and apply are separate commands; review the completed export first.');
    return options;
}

async function jsonFile(path, value) {
    await writeFile(`${path}.partial`, `${JSON.stringify(value, null, 2)}\n`);
    await rename(`${path}.partial`, path);
}
async function maybeJson(path) {
    try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function verifyProposalReadBack(row, proposal) {
    const readBack = serializeProposalRow(row);
    if (stableStringify(row.proposal_data) !== stableStringify(proposal) || !readBack.geometry?.buildings?.length) {
        throw new Error(`Read-back differs for ${proposal.proposalId}`);
    }
    return readBack;
}

async function fingerprint(pool) {
    const queries = {
        parcels: `WITH scope AS MATERIALIZED (${sqlScope}) SELECT count(*)::int AS count,
            md5(string_agg(p.cestica_id::text || ':' || coalesce(p.geom_hash, '') || ':' || p.maticni_broj_ko || ':' || p.broj_cestice, ',' ORDER BY p.cestica_id)) AS hash
            FROM public.parcel p,scope s WHERE p.current AND p.geom && s.geom AND ST_Intersects(p.geom,s.geom)`,
        cache: `SELECT count(*)::int AS count, md5(string_agg(cestica_id::text || ':' || md5(to_jsonb(e)::text), ',' ORDER BY cestica_id)) AS hash FROM public.parcel_build_envelope e WHERE current AND gup_id=2025`,
        rules: `SELECT count(*)::int AS count, md5(string_agg(md5(to_jsonb(u)::text), ',' ORDER BY md5(to_jsonb(u)::text))) AS hash FROM consensus.urban_rule u WHERE current AND gup='2025'`,
        variables: `SELECT count(*)::int AS count, md5(string_agg(md5(to_jsonb(v)::text), ',' ORDER BY rule_id)) AS hash FROM consensus.urban_rule_variable v WHERE gup_id=2025`
    };
    const result = {};
    for (const [key, sql] of Object.entries(queries)) result[key] = (await pool.query(sql)).rows[0];
    return result;
}

export const PAGE_SQL = `WITH scope AS MATERIALIZED (SELECT geom FROM gup_restatement_scope), selected AS MATERIALIZED (
    SELECT p.*, 'HR-' || p.maticni_broj_ko || '-' || p.broj_cestice AS stable_id
    FROM public.parcel p, scope s
    WHERE p.current AND p.cestica_id > $1 AND p.geom && s.geom AND ST_Intersects(p.geom, s.geom)
    ORDER BY p.cestica_id LIMIT $2
)
SELECT p.cestica_id, p.stable_id AS parcel_id,
    e.cestica_id IS NOT NULL AS cache_present, e.parcel_id = p.stable_id AS identity_matches,
    CASE WHEN e.geom IS NULL THEN false ELSE ST_Equals(e.geom, p.geom) END AS geometry_matches,
    e.zone, e.rule_id, e.planned_use_mark, e.solver_version, e.computed_at,
    e.result_status, e.geometry_status, e.build_regime, e.buildable, e.source, e.reason,
    e.applicability_status, e.proxy_applicability, e.zero_capacity_bound, e.in_exception_area,
    e.gbp_m2, e.footprint_area_m2, e.total_height_m, e.floors_count, e.max_units, e.floors,
    e.existing_gbp, e.existing_gbp_status, e.existing_gbp_source,
    v.variables, ST_Area(ST_Intersection(p.geom, s.geom)) AS scope_area_m2,
    ST_AsGeoJSON(ST_Transform(p.geom, 4326),9)::json AS parcel_geometry,
    CASE WHEN e.footprint_geom IS NULL THEN false ELSE ST_IsValid(e.footprint_geom) AND NOT ST_IsEmpty(e.footprint_geom) END AS footprint_valid,
    CASE WHEN e.footprint_geom IS NOT NULL AND ST_IsValid(e.footprint_geom) AND ST_IsValid(p.geom)
        THEN ST_Area(ST_Difference(e.footprint_geom, p.geom)) END AS outside_m2,
    ST_AsGeoJSON(ST_Transform(e.footprint_geom,4326),9)::json AS footprint_geometry
FROM selected p CROSS JOIN scope s
LEFT JOIN public.parcel_build_envelope e ON e.cestica_id=p.cestica_id AND e.gup_id=2025 AND e.current
LEFT JOIN consensus.urban_rule_variable v ON v.gup_id=2025 AND v.rule_id=e.rule_id
ORDER BY p.cestica_id`;

async function build(pool, options) {
    await mkdir(resolve(options.out, 'pages'), { recursive: true });
    log('Pinning current parcel, cache, rule and variable inputs.');
    const inputs = await fingerprint(pool);
    const textBytes = options.gupText ? await readFile(options.gupText) : null;
    const textHash = textBytes ? createHash('sha256').update(textBytes).digest('hex') : null;
    const config = { version: TRANSLATOR_VERSION, strictScalars: options.strictScalars, inputs, textHash };
    const key = digest(config);
    const checkpointPath = resolve(options.out, 'checkpoint.json');
    let checkpoint = await maybeJson(checkpointPath);
    if (checkpoint && checkpoint.key !== key) throw new Error('Source/configuration changed. Use a new output directory; old pages must not mix with new inputs.');
    if (!checkpoint) checkpoint = { key, config, lastId: 0, pages: [], startedAt: new Date().toISOString() };
    await pool.query(`CREATE TEMP TABLE gup_restatement_scope AS ${sqlScope}`);
    const scope = (await pool.query('SELECT ST_Area(geom) AS area_m2, ST_AsGeoJSON(ST_Transform(geom,4326),8)::json AS geometry FROM gup_restatement_scope')).rows[0];
    if (!scope?.geometry || !(scope.area_m2 > 0)) throw new Error('No positive-area 2025 GUP scope.');
    await jsonFile(resolve(options.out, 'scope.geojson'), { type: 'FeatureCollection', features: [
        { type: 'Feature', properties: { role: 'gup-scope', status: 'unrepresented-until-parcel-audited', source: 'consensus.urban_rule:gup=2025:current' }, geometry: scope.geometry }
    ] });
    const total = Number((await pool.query('SELECT count(*)::int total FROM public.parcel p,gup_restatement_scope s WHERE p.current AND p.geom && s.geom AND ST_Intersects(p.geom,s.geom)')).rows[0].total);
    let completed = checkpoint.pages.reduce((sum, page) => sum + page.count, 0);
    log(`Cohort ${total} current intersecting parcels; resumed ${completed} from verified pages.`);
    for (const page of checkpoint.pages) {
        const bytes = await readFile(resolve(options.out, 'pages', page.file));
        if (createHash('sha256').update(bytes).digest('hex') !== page.sha256) throw new Error(`Corrupt checkpoint page ${page.file}`);
    }
    while (true) {
        const rows = (await pool.query(PAGE_SQL, [checkpoint.lastId, options.batchSize])).rows;
        if (!rows.length) break;
        const entries = rows.map(row => translateParcel(row, options));
        const bytes = gzipSync(entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
        const file = `${String(rows[0].cestica_id).padStart(10, '0')}-${rows.at(-1).cestica_id}.ndjson.gz`;
        const pagePath = resolve(options.out, 'pages', file);
        await writeFile(`${pagePath}.partial`, bytes); await rename(`${pagePath}.partial`, pagePath);
        checkpoint.pages.push({ file, count: rows.length, sha256: createHash('sha256').update(bytes).digest('hex') });
        checkpoint.lastId = rows.at(-1).cestica_id;
        await jsonFile(checkpointPath, checkpoint);
        completed += rows.length;
        log(`${completed}/${total} parcels · ${Math.round(100 * completed / total)}% · page represented ${entries.filter(entry => entry.proposal).length}`);
    }
    if (completed !== total) throw new Error(`Cohort count changed: processed ${completed}, expected ${total}`);
    if (digest(await fingerprint(pool)) !== digest(inputs)) throw new Error('Source changed during export. No completed manifest published; rebuild in a fresh directory.');
    const summary = summarizeAudits([]), proposals = [];
    for (const page of checkpoint.pages) {
        const bytes = await readFile(resolve(options.out, 'pages', page.file));
        const entries = [];
        for (const line of gunzipSync(bytes).toString('utf8').trim().split('\n')) {
            const entry = retainSourceQuantities(JSON.parse(line)); entries.push(entry);
            summarizeAudits([entry.audit], summary);
            if (entry.proposal) proposals.push(entry.proposal);
        }
        // This projection also upgrades completed local pages without re-reading or re-solving
        // parcels. Only audit quantities change; native geometry and its content identity do not.
        const projected = gzipSync(entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
        if (!projected.equals(bytes)) {
            const path = resolve(options.out, 'pages', page.file);
            await writeFile(`${path}.partial`, projected); await rename(`${path}.partial`, path);
            page.sha256 = createHash('sha256').update(projected).digest('hex');
            await jsonFile(checkpointPath, checkpoint);
        }
    }
    // A compact native bundle is separate from the larger per-parcel flag pages.
    const bundle = { version: TRANSLATOR_VERSION, proposals };
    await jsonFile(resolve(options.out, 'proposals.json'), bundle);
    const manifest = { completed: true, ...config, key, startedAt: checkpoint.startedAt, completedAt: new Date().toISOString(),
        codeCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        scope: { areaM2: scope.area_m2, definition: '2025 Zagreb GUP urban-rule union; excludes separate Sesvete GUP',
            parcelUniverse: 'all current cadastral parcels intersecting the mapped scope, including uncached parcels',
            limitation: 'Parcel area totals are not a non-overlapping ground tessellation; scope.geojson retains uncadastrated ground as unresolved.' },
        summary, reasons: REASONS, pages: checkpoint.pages, proposalBundleHash: digest(bundle),
        notes: ['A represented mass is one cached option, not a legal permission or global maximum.',
            'Source uncertainty flags stay visible; skipped parcels never become zero capacity.',
            'This is an above-ground spatial translation. Existing stock and underground capacity remain separate.',
            'Scalar source limits are notes unless strictScalars is true. No new proposal primitive is introduced.'] };
    await jsonFile(resolve(options.out, 'manifest.json'), manifest);
    log(`Completed: ${summary.represented} represented, ${summary.skipped} skipped, ${summary.proven_zero} evidenced zeros.`);
    return manifest;
}

async function apply(pool, options) {
    if (!isLocalDatabase()) throw new Error('Apply is restricted to the local database.');
    const manifest = await maybeJson(resolve(options.out, 'manifest.json'));
    if (!manifest?.completed || manifest.version !== TRANSLATOR_VERSION) throw new Error('A complete compatible export is required.');
    if (digest(await fingerprint(pool)) !== digest(manifest.inputs)) throw new Error('Current source no longer matches the export.');
    const bundle = JSON.parse(await readFile(resolve(options.out, 'proposals.json'), 'utf8'));
    if (!manifest.proposalBundleHash || digest(bundle) !== manifest.proposalBundleHash) throw new Error('Proposal bundle does not match the completed manifest.');
    const { proposals } = bundle;
    if (!proposals.length) { log('No representable proposals; flags remain in the export. Nothing written.'); return; }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const ids = [];
        for (const proposal of proposals) {
            const { rows } = await client.query(`INSERT INTO public.proposal
                (proposal_id,city,name,title,description,author,type,lifecycle_status,cadastre_parcel_ids,building_proposal,bounds,proposal_data)
                VALUES ($1,'zagreb',$2,$2,$3,$4,'building','draft',$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb)
                ON CONFLICT (proposal_id) DO NOTHING RETURNING *`,
            [proposal.proposalId, proposal.name, proposal.description, proposal.author, JSON.stringify(proposal.cadastreParcelIds),
                JSON.stringify(proposal.buildingProposal), JSON.stringify(proposal.bounds), JSON.stringify(proposal)]);
            const row = rows[0] || (await client.query('SELECT * FROM public.proposal WHERE proposal_id=$1', [proposal.proposalId])).rows[0];
            verifyProposalReadBack(row, proposal);
            ids.push(String(row.id));
        }
        const store = createPlanStore(client);
        const members = await store.members(ids);
        const memberHashes = Object.fromEntries(members.map(row => [String(row.id), memberHash(row)]));
        // Keep each native plan link under the existing route's 1800-character budget.
        const chunks = [];
        for (const id of ids) {
            let chunk = chunks.at(-1);
            if (!chunk || chunk.concat(id).join(',').length > 1600 || chunk.length >= 150) { chunk = []; chunks.push(chunk); }
            chunk.push(id);
        }
        const plans = [];
        for (let index = 0; index < chunks.length; index++) {
            const proposalIds = chunks[index], slug = `gup25-${manifest.key.slice(0, 12)}-${index + 1}`;
            const existing = await store.plan(slug);
            if (existing && JSON.stringify(existing.proposal_ids) !== JSON.stringify(proposalIds)) throw new Error(`Plan collision ${slug}`);
            if (!existing) await store.insert({ slug, proposalIds, title: `GUP 2025 · prostorni prijepis ${index + 1}/${chunks.length}`,
                description: `${manifest.summary.represented} čestica prikazano; ${manifest.summary.skipped} preskočeno. Približne nadzemne omotnice; uvjeti nisu u cijelosti kodirani. Pregled zastavica: manifest.json i pages/*.ndjson.gz.`,
                author: 'GUP 2025 · prostorni prijepis', place: 'Zagreb', city: 'zagreb', memberHashes: Object.fromEntries(proposalIds.map(id => [id, memberHashes[id]])),
                planHash: planHash(proposalIds.map(id => ({ proposalId: members.find(row => String(row.id) === id).proposal_id, hash: memberHashes[id] }))),
                supersedes: null, creatorIp: null, creatorFingerprint: null });
            plans.push({ slug, path: `/proposals/${slug}`, proposals: proposalIds.length });
        }
        await client.query('COMMIT');
        await jsonFile(resolve(options.out, 'local-plans.json'), { key: manifest.key, plans });
        log(`Read back ${ids.length} native proposals in ${plans.length} local plans; repeat apply is a no-op.`);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
}

export async function main(args = process.argv.slice(2)) {
    const options = parseArgs(args);
    if (options.help || (!options.build && !options.apply)) {
        console.log('Usage: node backend/scripts/build-gup-restatement.mjs --build|--apply [--env-file path] [--gup-text path] [--out directory] [--batch-size 1000] [--strict-scalars]\nBuild exports every GUP parcel as represented, skipped or evidenced zero. Apply imports a reviewed completed export into the LOCAL native proposal/plan tables. No solver runs.'); return;
    }
    dotenv.config({ path: options.envFile || resolve(root, 'backend/.env'), quiet: true });
    const pool = createPool({ max: 1, statement_timeout: 60000, connectionTimeoutMillis: 5000 });
    try {
        await pool.query('SET jit = off');
        if (options.build) await build(pool, options);
        else await apply(pool, options);
    } finally { await pool.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(error => { console.error(`[gup-restatement] ${error.message}`); process.exitCode = 1; });
}
