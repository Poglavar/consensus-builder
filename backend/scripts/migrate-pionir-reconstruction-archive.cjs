// Builds and transactionally imports the canonical Pionir/Paron reconstruction archive.
// Production imports require both NODE_ENV=production and an explicit confirmation flag.

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const BUNDLE_SCHEMA = 'consensus-builder.pionir-reconstruction-bundle.v1';
const ARCHIVE_ROOT = path.resolve(__dirname, '../../rekonstrukcije/pionir-paron');
const EXPECTED_PROJECT_KEYS = Object.freeze([
    'borongajska-caviceva',
    'folnegoviceva-rapska',
    'lovinciceva-4090-1',
    'lovinciceva-f1-f5',
    'pergosiceva-a1-a4',
    'savica-f1-f3',
    'selska-bastijanova-viteziceva',
    'selska-drniska',
    'spansko-c-d',
    'spansko-sjever-a-f',
    'spansko-stenjevecki-odvojak',
    'zagrebacka-avenija-rudes'
]);

function usage() {
    console.log(`Usage:
  node backend/scripts/migrate-pionir-reconstruction-archive.cjs --build-bundle <path>
  node backend/scripts/migrate-pionir-reconstruction-archive.cjs --dry-run-bundle <path> --target local|production
  node backend/scripts/migrate-pionir-reconstruction-archive.cjs --apply-bundle <path> --target local|production [--confirm-production]

The bundle is built from canonical GeoJSON and contains stable proposal ids, never database ids.
Production apply additionally requires NODE_ENV=production and --confirm-production.`);
}

function parseArgs(argv) {
    const args = {
        action: null,
        bundlePath: null,
        target: null,
        confirmProduction: false,
        help: false
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--help' || arg === '-h') args.help = true;
        else if (['--build-bundle', '--dry-run-bundle', '--apply-bundle'].includes(arg)) {
            if (args.action) throw new Error('Choose exactly one bundle action.');
            args.action = arg.slice(2);
            args.bundlePath = argv[++index] || null;
            if (!args.bundlePath) throw new Error(`${arg} requires a path.`);
        } else if (arg === '--target') {
            args.target = argv[++index] || null;
        } else if (arg === '--confirm-production') {
            args.confirmProduction = true;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    if (args.help) return args;
    if (!args.action) throw new Error('Choose one bundle action.');
    if (args.action !== 'build-bundle' && !['local', 'production'].includes(args.target)) {
        throw new Error('Bundle inspection/import requires --target local or --target production.');
    }
    if (args.action === 'apply-bundle' && args.target === 'production' && !args.confirmProduction) {
        throw new Error('Production import requires --confirm-production.');
    }
    return args;
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function payloadChecksum(payload) {
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function assertExactProjectSet(keys) {
    const actual = [...keys].sort();
    const expected = [...EXPECTED_PROJECT_KEYS].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Archive project set differs: expected ${expected.join(', ')}; found ${actual.join(', ')}.`);
    }
}

function validateBundle(bundle) {
    if (!bundle || bundle.schema !== BUNDLE_SCHEMA || !Array.isArray(bundle.projects)) {
        throw new Error(`Expected ${BUNDLE_SCHEMA}.`);
    }
    const { checksum, ...payload } = bundle;
    const expectedChecksum = payloadChecksum(payload);
    if (checksum !== expectedChecksum) throw new Error('Bundle checksum does not match its payload.');
    assertExactProjectSet(bundle.projects.map(project => project.key));

    const seenProposalIds = new Set();
    for (const project of bundle.projects) {
        if (!project.plan || project.plan.slug !== `pionir-${project.key}`) {
            throw new Error(`${project.key}: missing canonical named-plan slug.`);
        }
        if (project.plan.city !== 'zagreb') throw new Error(`${project.key}: expected Zagreb plan city.`);
        if (!Array.isArray(project.proposals) || !project.proposals.length) {
            throw new Error(`${project.key}: no proposals in bundle.`);
        }
        const proposalIds = project.proposals.map(proposal => proposal.proposalId);
        if (JSON.stringify(proposalIds) !== JSON.stringify(project.plan.proposalIds)) {
            throw new Error(`${project.key}: named-plan order differs from bundled proposal order.`);
        }
        const buildingCount = project.proposals.filter(proposal => proposal.buildingProposal).length;
        if (buildingCount !== 1) throw new Error(`${project.key}: expected exactly one building proposal.`);
        for (const proposal of project.proposals) {
            if (!proposal.proposalId || seenProposalIds.has(proposal.proposalId)) {
                throw new Error(`${project.key}: missing or duplicate proposal id ${proposal.proposalId || '(empty)'}.`);
            }
            if (proposal.city !== 'zagreb') throw new Error(`${proposal.proposalId}: expected Zagreb city.`);
            if (proposal.applied !== false) throw new Error(`${proposal.proposalId}: archive proposal must be unapplied.`);
            if (Boolean(proposal.buildingProposal) === Boolean(proposal.roadProposal)) {
                throw new Error(`${proposal.proposalId}: expected exactly one formation payload.`);
            }
            seenProposalIds.add(proposal.proposalId);
        }
    }
    return {
        projectCount: bundle.projects.length,
        proposalCount: seenProposalIds.size,
        planCount: bundle.projects.length,
        checksum
    };
}

async function buildArchiveBundle(archiveRoot = ARCHIVE_ROOT) {
    const [buildingCodec, corridorCodec] = await Promise.all([
        import(pathToFileURL(path.resolve(__dirname, '../proposals/reconstruction-geojson.js')).href),
        import(pathToFileURL(path.resolve(__dirname, '../proposals/corridor-reconstruction-geojson.js')).href)
    ]);
    const entries = await fs.readdir(archiveRoot, { withFileTypes: true });
    const projects = [];
    for (const entry of entries.filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        const directory = path.join(archiveRoot, entry.name);
        let manifest;
        let buildingCollection;
        try {
            [manifest, buildingCollection] = await Promise.all([
                fs.readFile(path.join(directory, 'plan.json'), 'utf8').then(JSON.parse),
                fs.readFile(path.join(directory, 'proposal.geojson'), 'utf8').then(JSON.parse)
            ]);
        } catch (error) {
            if (error?.code === 'ENOENT') continue;
            throw error;
        }
        if (manifest.schema !== 'consensus-builder.reconstruction-plan.v1' || manifest.project !== entry.name) {
            throw new Error(`${entry.name}: invalid reconstruction plan manifest.`);
        }
        const building = buildingCodec.reconstructionGeoJSONToProposal(buildingCollection);
        buildingCodec.assertReconstructionGeoJSONRoundTrip(building);
        if (manifest.building?.proposalId !== building.proposalId || manifest.building?.file !== 'proposal.geojson') {
            throw new Error(`${entry.name}: building manifest does not match proposal.geojson.`);
        }

        const circulationFiles = (await fs.readdir(directory))
            .filter(filename => /^circulation-(?:access|parking)-.+\.geojson$/.test(filename))
            .sort();
        const declaredFiles = (manifest.circulation || []).map(item => item.file).sort();
        if (JSON.stringify(circulationFiles) !== JSON.stringify(declaredFiles)) {
            throw new Error(`${entry.name}: circulation files differ from plan.json.`);
        }
        const circulation = [];
        for (const item of manifest.circulation || []) {
            const collection = JSON.parse(await fs.readFile(path.join(directory, item.file), 'utf8'));
            const imported = corridorCodec.corridorReconstructionGeoJSONToProposal(collection);
            corridorCodec.assertCorridorReconstructionGeoJSONRoundTrip(imported.proposal, imported.site);
            if (item.proposalId !== imported.proposal.proposalId) {
                throw new Error(`${entry.name}: ${item.file} proposal id differs from plan.json.`);
            }
            circulation.push(imported.proposal);
        }
        projects.push({
            key: entry.name,
            plan: {
                slug: manifest.planSlug,
                title: manifest.planTitle,
                city: 'zagreb',
                proposalIds: [...circulation.map(proposal => proposal.proposalId), building.proposalId]
            },
            proposals: [...circulation, building]
        });
    }
    assertExactProjectSet(projects.map(project => project.key));
    const payload = {
        schema: BUNDLE_SCHEMA,
        generatedAt: '2026-08-13T00:00:00.000Z',
        projects
    };
    const bundle = { ...payload, checksum: payloadChecksum(payload) };
    validateBundle(bundle);
    return bundle;
}

function assertRuntimeTarget(args) {
    const productionEnv = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
    if (args.target === 'production' && !productionEnv) {
        throw new Error('Production target requires NODE_ENV=production from the production environment.');
    }
    if (args.target === 'local' && productionEnv) {
        throw new Error('Refusing local target while NODE_ENV=production.');
    }
}

async function resolveProposalTable(pool) {
    const { rows } = await pool.query(`
        SELECT to_regclass('consensus.proposal')::text AS consensus_table,
               to_regclass('public.proposal')::text AS public_table
    `);
    if (rows[0]?.consensus_table) return 'consensus.proposal';
    if (rows[0]?.public_table) return 'public.proposal';
    throw new Error('No proposal table found in consensus or public schema.');
}

async function inspectBundle(pool, proposalTable, bundle) {
    const proposalIds = bundle.projects.flatMap(project => project.plan.proposalIds);
    const slugs = bundle.projects.map(project => project.plan.slug);
    const [proposalResult, planResult, targetResult] = await Promise.all([
        pool.query(`SELECT proposal_id, id FROM ${proposalTable} WHERE proposal_id = ANY($1::text[])`, [proposalIds]),
        pool.query('SELECT slug, proposal_ids FROM public.ens_plan WHERE slug = ANY($1::text[])', [slugs]),
        pool.query(`SELECT current_database() AS database, current_user AS role,
                           COALESCE(inet_server_addr()::text, 'local-socket') AS server_address`)
    ]);
    return {
        target: targetResult.rows[0],
        proposalTable,
        proposals: {
            total: proposalIds.length,
            existing: proposalResult.rowCount,
            toInsert: proposalIds.length - proposalResult.rowCount
        },
        plans: {
            total: slugs.length,
            existing: planResult.rowCount,
            toInsert: slugs.length - planResult.rowCount
        }
    };
}

async function upsertProposal(client, proposalTable, proposal) {
    const { rows } = await client.query(`
        INSERT INTO ${proposalTable} (
            proposal_id, city, name, title, description, author, type,
            lifecycle_status, created_at, updated_at,
            ancestor_parcel_ids, cadastre_parcel_ids,
            building_proposal, road_proposal, bounds, proposal_data, applied
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $9,
            $10::jsonb, $11::jsonb,
            $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, false
        )
        ON CONFLICT (proposal_id) DO UPDATE SET
            city = EXCLUDED.city,
            name = EXCLUDED.name,
            title = EXCLUDED.title,
            description = EXCLUDED.description,
            author = EXCLUDED.author,
            type = EXCLUDED.type,
            lifecycle_status = EXCLUDED.lifecycle_status,
            updated_at = NOW(),
            ancestor_parcel_ids = EXCLUDED.ancestor_parcel_ids,
            cadastre_parcel_ids = EXCLUDED.cadastre_parcel_ids,
            building_proposal = EXCLUDED.building_proposal,
            road_proposal = EXCLUDED.road_proposal,
            bounds = EXCLUDED.bounds,
            proposal_data = EXCLUDED.proposal_data,
            applied = false
        RETURNING id, proposal_id
    `, [
        proposal.proposalId,
        proposal.city,
        proposal.name,
        proposal.title,
        proposal.description,
        proposal.author,
        proposal.type,
        proposal.lifecycleStatus,
        proposal.createdAt,
        JSON.stringify(proposal.parentParcelIds || []),
        JSON.stringify(proposal.cadastreParcelIds || proposal.parentParcelIds || []),
        proposal.buildingProposal ? JSON.stringify(proposal.buildingProposal) : null,
        proposal.roadProposal ? JSON.stringify(proposal.roadProposal) : null,
        JSON.stringify(proposal.bounds || null),
        JSON.stringify({ ...clone(proposal), applied: false })
    ]);
    return rows[0];
}

async function upsertPlan(client, project, numericIds) {
    const tokenHash = crypto.createHash('sha256')
        .update(`reconstruction-archive:${project.plan.slug}`)
        .digest('hex');
    await client.query(`
        INSERT INTO public.ens_plan (slug, proposal_ids, title, city, edit_token_hash)
        VALUES ($1, $2::jsonb, $3, $4, $5)
        ON CONFLICT (slug) DO UPDATE SET
            proposal_ids = EXCLUDED.proposal_ids,
            title = EXCLUDED.title,
            city = EXCLUDED.city,
            updated_at = NOW()
    `, [
        project.plan.slug,
        JSON.stringify(numericIds.map(String)),
        project.plan.title,
        project.plan.city,
        tokenHash
    ]);
}

async function applyBundle(pool, proposalTable, bundle) {
    const client = await pool.connect();
    const projects = [];
    try {
        await client.query('BEGIN');
        for (const project of bundle.projects) {
            const numericIds = [];
            for (const proposal of project.proposals) {
                const row = await upsertProposal(client, proposalTable, proposal);
                numericIds.push(Number(row.id));
            }
            await upsertPlan(client, project, numericIds);
            projects.push({
                key: project.key,
                slug: project.plan.slug,
                proposalIds: numericIds.map(String)
            });
        }
        await client.query('COMMIT');
        return projects;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function readBundle(bundlePath) {
    const bundle = JSON.parse(await fs.readFile(path.resolve(bundlePath), 'utf8'));
    validateBundle(bundle);
    return bundle;
}

async function runDatabaseAction(args) {
    assertRuntimeTarget(args);
    const bundle = await readBundle(args.bundlePath);
    const { Pool } = require('pg');
    const pool = new Pool();
    try {
        const proposalTable = await resolveProposalTable(pool);
        const before = await inspectBundle(pool, proposalTable, bundle);
        console.log(JSON.stringify({ phase: 'preflight', ...before }));
        if (args.action === 'dry-run-bundle') return;
        const projects = await applyBundle(pool, proposalTable, bundle);
        const after = await inspectBundle(pool, proposalTable, bundle);
        if (after.proposals.existing !== after.proposals.total || after.plans.existing !== after.plans.total) {
            throw new Error('Post-import verification found missing proposals or plans.');
        }
        console.log(JSON.stringify({ phase: 'applied', ...after, projects }));
    } finally {
        await pool.end();
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) { usage(); return; }
    if (args.action === 'build-bundle') {
        const bundle = await buildArchiveBundle();
        await fs.writeFile(path.resolve(args.bundlePath), `${JSON.stringify(bundle)}\n`, 'utf8');
        console.log(JSON.stringify({ phase: 'built', path: path.resolve(args.bundlePath), ...validateBundle(bundle) }));
        return;
    }
    await runDatabaseAction(args);
}

if (require.main === module) {
    main().catch(error => {
        console.error(error?.stack || error?.message || error);
        process.exitCode = 1;
    });
}

module.exports = {
    ARCHIVE_ROOT,
    BUNDLE_SCHEMA,
    EXPECTED_PROJECT_KEYS,
    buildArchiveBundle,
    parseArgs,
    payloadChecksum,
    validateBundle
};
