// Validates and versions architectural floor models from any source in the city building registry.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { attachBuildingFloorPlans } from '../proposals/building-floor-plans.js';
import { saveFloorModel, buildingSourceId } from '../buildings/floor-models.js';

export function parseArgs(args) {
    const options = { target: 'local', apply: false, initSchema: false, confirmProduction: false };
    for (let i = 0; i < args.length; i++) {
        const flag = args[i];
        if (flag === '--apply') options.apply = true;
        else if (flag === '--init-schema') options.initSchema = true;
        else if (flag === '--confirm-production') options.confirmProduction = true;
        else if (['--archive', '--models', '--target'].includes(flag)) {
            const value = args[++i];
            if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
            options[flag.slice(2)] = value;
        } else throw new Error(`Unknown argument: ${flag}`);
    }
    if (Boolean(options.archive) === Boolean(options.models) && !(!options.archive && !options.models && options.initSchema)) {
        throw new Error('Choose --archive <proposal.geojson> or --models <registry.json>.');
    }
    if (!['local', 'production'].includes(options.target)) throw new Error('Target must be local or production.');
    if (options.apply && options.target === 'production' && !options.confirmProduction) {
        throw new Error('Production apply requires --confirm-production.');
    }
    return options;
}

function assertTarget(options, env) {
    if (!['localhost', '127.0.0.1', '::1'].includes(env.PGHOST) || env.PGDATABASE !== 'geodata') {
        throw new Error('Connect to geodata over localhost, directly or through the configured production tunnel.');
    }
    if (options.target === 'local' && (Number(env.PGPORT || 5432) !== 5432 || env.NODE_ENV === 'production')) {
        throw new Error('Local imports require local geodata on port 5432 outside NODE_ENV=production.');
    }
    if (options.target === 'production' && env.NODE_ENV !== 'production') {
        throw new Error('Production imports require NODE_ENV=production.');
    }
}

export async function importFloorModels(client, options, input) {
    let models = [], proposalRow, cleanedBuildings;
    if (options.archive) {
        if (input.reconstruction?.schema !== 'consensus-builder.reconstruction.v1') throw new Error('Expected a canonical reconstruction archive.');
        const ownerId = input.reconstruction.proposal?.proposalId;
        const city = input.reconstruction.proposal?.city;
        if (!ownerId || !city) throw new Error('Archive needs a stable proposal id and city.');
        const sources = input.features.filter(feature => feature.properties?.['consensus:role'] === 'building');
        const result = await client.query('SELECT id, city, proposal_data FROM proposal WHERE proposal_id = $1 FOR UPDATE', [ownerId]);
        if (result.rows.length !== 1 || result.rows[0].city !== city) throw new Error(`Expected one ${city} proposal ${ownerId}.`);
        proposalRow = result.rows[0];
        // Validate identity and exact registered footprint before writing any model.
        const patch = attachBuildingFloorPlans(proposalRow.proposal_data?.geometry?.buildings, sources);
        models = sources.filter(source => source.properties.floorPlans).map(source => ({ city, source: 'proposal', ownerId,
            buildingId: buildingSourceId(source), footprint: source.geometry, floorPlans: source.properties.floorPlans }));
        const modeledIds = new Set(models.map(model => model.buildingId));
        cleanedBuildings = patch.buildings.map(building => {
            if (modeledIds.has(buildingSourceId(building))) {
                delete building.properties.floorPlans;
                delete building.properties.floorModel;
            }
            return building;
        });
    } else if (options.models) {
        if (input.schema !== 'consensus-builder.building-floor-model-registry.v1' || !Array.isArray(input.models)) {
            throw new Error('Expected a consensus-builder.building-floor-model-registry.v1 manifest.');
        }
        models = input.models;
        if (models.some(model => model.source === 'proposal')) throw new Error('Import proposal models with --archive so their footprints can be verified.');
    }
    let changed = 0, floors = 0;
    for (const [index, model] of models.entries()) {
        const saved = await saveFloorModel(client, model, { apply: options.apply });
        if (saved.changed) changed++;
        floors += model.floorPlans.floors.length;
        console.log(JSON.stringify({ progress: `${index + 1}/${models.length}`, city: model.city, source: model.source,
            buildingId: model.buildingId, version: saved.version, changed: saved.changed, apply: options.apply }));
    }
    // Keep the proposal's authored state small; APIs join the registry on read. Only the old
    // inline model copies are removed, after every new registry record has been read back.
    const embedded = proposalRow && JSON.stringify(cleanedBuildings) !== JSON.stringify(proposalRow.proposal_data.geometry.buildings);
    if (options.apply && embedded) {
        await client.query(`UPDATE proposal SET proposal_data = jsonb_set(proposal_data, '{geometry,buildings}', $2::jsonb),
            updated_at = now() WHERE id = $1`, [proposalRow.id, JSON.stringify(cleanedBuildings)]);
    }
    return { changedBuildings: changed, buildings: models.length, floors, removedInlineCopies: Boolean(embedded), apply: options.apply };
}

async function main() {
    const args = process.argv.slice(2);
    if (!args.length || args.includes('--help')) {
        console.log('Usage: node --env-file=<backend.env> backend/scripts/import-building-floor-plans.mjs\n'
            + '  --archive <proposal.geojson> | --models <registry.json>\n'
            + '  [--target local|production] [--init-schema] [--apply] [--confirm-production]\n'
            + 'Dry run by default. --init-schema can also run alone. Production requires NODE_ENV=production.');
        return;
    }
    const options = parseArgs(args);
    assertTarget(options, process.env);
    const input = options.archive || options.models ? JSON.parse(await readFile(resolve(options.archive || options.models), 'utf8')) : null;
    const pool = new pg.Pool();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("SET LOCAL statement_timeout = '30s'");
        await client.query("SET LOCAL lock_timeout = '5s'");
        if (options.initSchema) await client.query(await readFile(new URL('../db/building-floor-model.sql', import.meta.url), 'utf8'));
        console.log(JSON.stringify(await importFloorModels(client, options, input)));
        await client.query(options.apply ? 'COMMIT' : 'ROLLBACK');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
