// Joins floor models onto buildings. Native city buildings read the shared floor-plan publication
// (cadastre-data buildings.floor_plan via /api/floor-plans); proposal buildings still read the frozen
// consensus.building_floor_model registry until the published documents carry what they need
// (docs/building-floor-models.md, "Proposal buildings"). Nothing here writes floor models.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createFloorPlanPublicationReader, validatePublicationConfig } from './floor-plan-publication.js';

const require = createRequire(import.meta.url);
const SourceRuntime = require('../../frontend/js/source-runtime.js');
const CityLightConfig = require('../../frontend/js/city-light-config.js');
const { buildingSourceId } = require('../../frontend/js/building-floor-plans.js');

// JSONB changes object-key order; identities and footprint fingerprints must not depend on that order.
export function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort()
        .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
export const fingerprint = value => createHash('sha256').update(canonicalJson(value)).digest('hex');

// Two custom feeds may both call a building "123". Bind to the selected feed's portable
// descriptor, not its generic adapter label, and expose this key in /buildings/near.
export function nativeFloorModelSource(requestSource, providerSource) {
    return requestSource?.startsWith('building.') ? `custom:${fingerprint(requestSource)}` : providerSource;
}

export function validateModelIdentity({ city, source, ownerId = '', buildingId }) {
    for (const [name, value, max] of [['city', city, 100], ['source', source, 100], ['buildingId', buildingId, 255]]) {
        if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max) {
            throw new Error(`${name} must be a non-empty string of at most ${max} characters.`);
        }
    }
    if (typeof ownerId !== 'string' || ownerId !== ownerId.trim() || ownerId.length > 255
        || (source === 'proposal' ? !ownerId : ownerId !== '')) {
        throw new Error('ownerId is required only for proposal buildings.');
    }
    return { city, source, ownerId, buildingId };
}

const identityValues = model => [model.city, model.source, model.ownerId, model.buildingId];

// One indexed join for a whole response, including chains of proposals from different cities.
async function readStoredFloorModels(pool, identities) {
    if (!identities.length) return new Map();
    const queryKeys = identities.map(identity => {
        const valid = validateModelIdentity(identity);
        return { city: valid.city, source: valid.source, owner_id: valid.ownerId, building_id: valid.buildingId };
    });
    const result = await pool.query(`SELECT m.city, m.source, m.owner_id, m.building_id,
            m.version, m.updated_at, m.geom_hash, m.floor_plans, m.footprint
        FROM consensus.building_floor_model m
        JOIN jsonb_to_recordset($1::jsonb) AS q(city text, source text, owner_id text, building_id text)
            USING (city, source, owner_id, building_id)
        WHERE m.current`, [JSON.stringify(queryKeys)]);
    return new Map(result.rows.map(row => [canonicalJson([row.city, row.source, row.owner_id, row.building_id]), row]));
}

const queryKeysOf = identities => JSON.stringify(identities.map(identity => {
    const valid = validateModelIdentity(identity);
    return { city: valid.city, source: valid.source, owner_id: valid.ownerId, building_id: valid.buildingId };
}));
// What a map cell needs to know about a stored model: its storeys and apartments, never the model.
async function readStoredFloorModelMarkers(pool, identities) {
    if (!identities.length) return new Map();
    const result = await pool.query(`SELECT m.city, m.source, m.owner_id, m.building_id, m.version,
            (SELECT COALESCE(jsonb_agg((s->>'level')::int ORDER BY (s->>'level')::int), '[]'::jsonb)
               FROM jsonb_array_elements(m.floor_plans->'storeys') s) AS levels,
            (SELECT count(*) FROM jsonb_array_elements(m.floor_plans->'storeys') s,
                    jsonb_array_elements(COALESCE(s->'units', '[]'::jsonb)) u WHERE u->>'kind' = 'apartment')::int AS units
        FROM consensus.building_floor_model m
        JOIN jsonb_to_recordset($1::jsonb) AS q(city text, source text, owner_id text, building_id text)
            USING (city, source, owner_id, building_id)
        WHERE m.current`, [queryKeysOf(identities)]);
    return new Map(result.rows.map(row => [canonicalJson([row.city, row.source, row.owner_id, row.building_id]), row]));
}

// `floor-plan-publication` reads plans a city's configuration declares (floorModels.published): the only
// source of native buildings' models. `floor-model-storage` is the frozen registry, read only for proposal
// buildings (attachProposalFloorModels) until their published documents can be drawn; it has no writer
// and goes, with its table, once proposals read the publication (db/migrations/2026-11-20-drop-building-floor-model.sql).
export const buildingDetailSourceRegistry = SourceRuntime.createRegistry({
    abstraction: 'building-details',
    adapters: { 'floor-model-storage': { custom: false, create: (_config, { pool }) => ({
        fetchFloorModels: identities => readStoredFloorModels(pool, identities),
        fetchFloorModelMarkers: identities => readStoredFloorModelMarkers(pool, identities)
    }) },
    'floor-plan-publication': { custom: false, validateConfig: validatePublicationConfig,
        create: (config, context) => createFloorPlanPublicationReader(config, context) } },
    sources: [SourceRuntime.source('building-details', 'floor-model-storage', {
        id: 'building-floor-models', storage: 'consensus.building_floor_model'
    })],
    required: ['fetchFloorModels', 'fetchFloorModelMarkers']
});
export async function fetchFloorModels(pool, identities) {
    return buildingDetailSourceRegistry.open('building-floor-models', { pool }).fetchFloorModels(identities);
}

function attachModel(target, row) {
    target.floorPlans = row.floor_plans;
    target.floorModel = { city: row.city, source: row.source, ownerId: row.owner_id,
        buildingId: row.building_id, version: row.version, updatedAt: row.updated_at, footprint: row.footprint };
}

// A proposal building's model, shown only while the building keeps the footprint it was drawn for.
// Still the frozen registry: the published documents bound to these buildings (zagreb-novogradnje
// bind-proposal-floor-plans.mjs) carry no registration and no unit lists yet, so the converter
// (published-floor-model.js) cannot draw them.
export async function attachProposalFloorModels(pool, proposals) {
    const entries = [];
    for (const proposal of proposals) {
        if (!proposal?.city || !proposal.proposalId) continue;
        for (const building of proposal.geometry?.buildings || []) {
            const buildingId = buildingSourceId(building);
            if (!buildingId || !building.geometry) continue;
            entries.push({ building, identity: { city: proposal.city, source: 'proposal',
                ownerId: String(proposal.proposalId), buildingId } });
        }
    }
    const models = await fetchFloorModels(pool, entries.map(entry => entry.identity));
    for (const { building, identity } of entries) {
        const row = models.get(canonicalJson(identityValues(identity)));
        if (row && row.geom_hash === fingerprint(building.geometry)) attachModel(building.properties, row);
    }
    return proposals;
}

// The publication API every `floor-plan-publication` source reads. Server configuration only: a city
// configuration (shipped to browsers) names the namespace inside it, never a URL.
export const DEFAULT_FLOOR_PLAN_PUBLICATION_API = 'https://zagreb.lol/api';

// Every city's light configuration, read the way the browser reads it (data/city-index.js expanded by
// js/city-light-config.js), which carries floorModels.
export function readCityConfigs() {
    const context = vm.createContext({});
    vm.runInContext(readFileSync(new URL('../../frontend/data/city-index.js', import.meta.url), 'utf8'), context);
    const index = context.__cityIndex;
    return index.rows.map(row => CityLightConfig.expand(index, row));
}

// floorModels.published of each city, as registered building-details sources per namespace. Order is
// priority: for one building the first source with a model wins.
function declarePublishedSources(cityConfigs, baseUrl) {
    const byNamespace = new Map();
    for (const config of cityConfigs) {
        const { namespace, published } = config?.floorModels || {};
        if (published === undefined) continue;
        if (typeof namespace !== 'string' || !namespace || !Array.isArray(published)) {
            throw new Error(`city ${config.id}: floorModels.published needs a namespace and an array of sources.`);
        }
        const sources = published.map(({ adapter, ...settings }, index) => {
            if (Object.hasOwn(settings, 'baseUrl')) throw new Error(`city ${config.id}: a floor-plan source's baseUrl is server configuration.`);
            const id = `floor-plans.${namespace}.${index}`;
            return buildingDetailSourceRegistry.register(SourceRuntime.source('building-details', adapter, { ...settings, baseUrl, id }, { id }), { replace: true });
        });
        if (byNamespace.has(namespace)) throw new Error(`floorModels namespace ${namespace} is declared by two cities.`);
        byNamespace.set(namespace, sources);
    }
    return byNamespace;
}

// The published floor plans of native buildings, per city namespace. `fetch`, `cache` and `cityConfigs`
// are injected in tests; FLOOR_PLAN_PUBLICATION_API_URL points the server at another publication API.
export function createPublishedFloorModels({ env = process.env, fetch = globalThis.fetch, cityConfigs, cache, log } = {}) {
    const baseUrl = env.FLOOR_PLAN_PUBLICATION_API_URL || DEFAULT_FLOOR_PLAN_PUBLICATION_API;
    let byNamespace = null;
    const context = { fetch, ...(cache ? { cache } : {}), ...(log ? { log } : {}) };
    return {
        sources(namespace) {
            byNamespace ??= declarePublishedSources(cityConfigs ?? readCityConfigs(), baseUrl);
            return byNamespace.get(namespace) || [];
        },
        // identities: native { city: namespace, source: floorModelSource, ownerId: '', buildingId } → Map(buildingId → answer)
        fetchFloorModelMarkers(namespace, identities, report = {}) { return this.read('fetchFloorModelMarkers', namespace, identities, report); },
        fetchFloorModels(namespace, identities, report = {}) { return this.read('fetchFloorModels', namespace, identities, report); },
        async read(method, namespace, identities, report) {
            const rows = new Map();
            for (const source of this.sources(namespace)) {
                const remaining = identities.filter(identity => !rows.has(String(identity.buildingId)));
                if (!remaining.length) break;
                const found = await buildingDetailSourceRegistry.open(source.id, context)[method](remaining, report);
                for (const [id, row] of found) if (!rows.has(id)) rows.set(id, row);
            }
            return rows;
        }
    };
}
let defaultPublished = null;
const publishedFloorModels = () => (defaultPublished ??= createPublishedFloorModels());

const logPublishedFailure = (city, source, error) =>
    console.error(`[${new Date().toISOString()}] [floor-models] published floor plans for ${city}/${source} failed:`, error);

// Floor plans are never bulk-loaded with buildings. A map cell's buildings carry only a marker,
// `floorPlansAvailable: { origin: 'publication', city, source, storeys, units }`, from the publication's
// compact summaries. The browser asks for one building's model (readNativeFloorModel, GET
// /buildings/floor-model) when X-ray is on and the building is near. `report.publishedUnavailable` says
// the publication did not answer (the caller should not cache).
export async function attachNearbyFloorModelMarkers(city, source, buildings, { published = publishedFloorModels(), report = {} } = {}) {
    if (!buildings.length || !city || !published) return buildings;
    const identities = buildings.map(building => ({ city, source, ownerId: '', buildingId: String(building.object_id) }));
    let markers;
    try { markers = await published.fetchFloorModelMarkers(city, identities, report); } catch (error) {
        report.publishedUnavailable = true;
        logPublishedFailure(city, source, error);
        return buildings;
    }
    return buildings.map((building, index) => {
        const marker = markers.get(identities[index].buildingId);
        if (!marker) return building;
        return { ...building, floorPlansAvailable: { origin: 'publication', city, source, storeys: marker.storeys, units: marker.units } };
    });
}

// One native building's model on demand, from the plans its city publishes. A proposal building's model
// comes with its proposal (attachProposalFloorModels), so a proposal identity answers null here.
// → { city, source, ownerId, buildingId, version: null, updatedAt, origin: 'publication', footprint, floorPlans, publication } | null
export async function readNativeFloorModel(identity, { published = publishedFloorModels(), report = {} } = {}) {
    const valid = validateModelIdentity(identity);
    if (!published || valid.ownerId) return null;
    let found;
    try { found = (await published.fetchFloorModels(valid.city, [valid], report)).get(valid.buildingId); } catch (error) {
        report.publishedUnavailable = true;
        logPublishedFailure(valid.city, valid.source, error);
        return null;
    }
    return found ? { ...valid, version: null, updatedAt: found.updatedAt, origin: 'publication', footprint: found.footprint,
        floorPlans: found.floorPlans, publication: found.publication } : null;
}
