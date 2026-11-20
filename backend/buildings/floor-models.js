// Joins floor models onto buildings, read from the shared floor-plan publication (cadastre-data buildings.floor_plan
// via /api/floor-plans): native city buildings by their references, proposal buildings by the proposal reference and
// the footprint they were drawn for. Nothing here writes floor models.
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

// `floor-plan-publication` reads the plans a city's configuration declares (floorModels.published) for native
// buildings, and a proposal's plans (attachProposalFloorModels): the published documents are the only floor-plan store.
export const buildingDetailSourceRegistry = SourceRuntime.createRegistry({
    abstraction: 'building-details',
    adapters: { 'floor-plan-publication': { custom: false, validateConfig: validatePublicationConfig,
        create: (config, context) => createFloorPlanPublicationReader(config, context) } },
    required: ['fetchFloorModels', 'fetchFloorModelMarkers']
});

// A proposal building's model: the published plans whose reference names this proposal, this building and the
// footprint it has now ({ city, source: 'proposal', ownerId, buildingId, footprintSha256 }), so a building whose
// footprint changed shows none. Only cities that publish floor plans are asked. A publication that does not answer
// leaves the buildings without plans (logged); `report.publishedUnavailable` says so.
// Attaches properties.floorPlans and properties.floorModel { city, source, ownerId, buildingId, version: null,
// updatedAt, origin: 'publication', footprint, publication }.
const PROPOSAL_CONCURRENCY = 3;
export async function attachProposalFloorModels(proposals, { published = publishedFloorModels(), report = {} } = {}) {
    const groups = new Map();
    for (const proposal of proposals) {
        if (!proposal?.city || !proposal.proposalId || !published?.sources(proposal.city).length) continue;
        const ownerId = String(proposal.proposalId), key = JSON.stringify([proposal.city, ownerId]);
        for (const building of proposal.geometry?.buildings || []) {
            const buildingId = buildingSourceId(building);
            if (!buildingId || !building.geometry) continue;
            if (!groups.has(key)) groups.set(key, { city: proposal.city, ownerId, entries: [] });
            groups.get(key).entries.push({ building, identity: { city: proposal.city, source: 'proposal', ownerId, buildingId,
                footprintSha256: fingerprint(building.geometry) } });
        }
    }
    const pending = [...groups.values()];
    await Promise.all(Array.from({ length: Math.min(PROPOSAL_CONCURRENCY, pending.length) }, async () => {
        for (let group = pending.shift(); group; group = pending.shift()) {
            let found;
            try { found = await published.fetchProposalFloorModels(group.city, group.ownerId, group.entries.map(entry => entry.identity), report); } catch (error) {
                report.publishedUnavailable = true;
                logPublishedFailure(group.city, `proposal ${group.ownerId}`, error);
                continue;
            }
            for (const { building, identity } of group.entries) {
                const row = found.get(identity.buildingId);
                if (!row) continue;
                building.properties.floorPlans = row.floorPlans;
                building.properties.floorModel = { city: identity.city, source: 'proposal', ownerId: identity.ownerId, buildingId: identity.buildingId,
                    version: null, updatedAt: row.updatedAt, origin: 'publication', footprint: building.geometry, publication: row.publication };
            }
        }
    }));
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
        // identities: { city, source: 'proposal', ownerId, buildingId, footprintSha256 } of one proposal → Map(buildingId → model row)
        fetchProposalFloorModels(city, ownerId, identities, report = {}) {
            return createFloorPlanPublicationReader({ baseUrl, city, source: 'proposal', buildingSource: 'proposal', ownerId }, context)
                .fetchFloorModels(identities, report);
        },
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
// The source catalogue (/source-system) lists the cities' publication sources from the start. They are registered
// again, with the server's FLOOR_PLAN_PUBLICATION_API_URL, when the first read opens them (process.env is not yet
// loaded from .env while modules are imported).
declarePublishedSources(readCityConfigs(), DEFAULT_FLOOR_PLAN_PUBLICATION_API);

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
