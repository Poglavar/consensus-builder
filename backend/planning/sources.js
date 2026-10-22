// Planning source registry: a city selects providers; consumers receive one representation schema.
import { queryZagrebGup, readZagrebParcel, zagrebGupSource, zagrebGup2016Source } from './providers/zagreb-gup.js';
import { queryNycPilot, readNycPilotParcel, nycPilotSource } from './providers/nyc-pilot.js';
import { createHash } from 'node:crypto';
import { parseAtlasSources, createAtlasUrlProvider } from './atlas-url-sources.js';

const builtInSources = [zagrebGupSource, zagrebGup2016Source].map(descriptor => ({
    descriptor,
    query: (pool, query) => queryZagrebGup(pool, { ...query, edition: descriptor.edition }),
    parcel: (pool, query) => readZagrebParcel(pool, { ...query, edition: descriptor.edition }),
    record: (pool, query) => readZagrebParcel(pool, { ...query, parcel: query.recordId, edition: descriptor.edition })
}));
builtInSources.push({ descriptor: nycPilotSource, query: queryNycPilot, parcel: readNycPilotParcel,
    record: (pool, query) => readNycPilotParcel(pool, { ...query, parcel: `US-NY-${query.recordId}` }) });
// Explicit operator configuration only. Read after dotenv initialization, not at import time.
export function createPlanningSources(config, options) {
    const configured = parseAtlasSources(config);
    if (configured.some(entry => builtInSources.some(source => source.descriptor.id === entry.id))) {
        throw new Error('Atlas source ID conflicts with a built-in planning source.');
    }
    return [...builtInSources, ...configured.map(metadata => createAtlasUrlProvider(metadata, options))];
}
let planningSources;
export function getPlanningSources() {
    return planningSources ??= createPlanningSources(process.env.PLANNING_ATLAS_SOURCES);
}

const intersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
// A city-scoped provider answers its city. A bounds-scoped provider answers any city whose
// viewport intersects its bounds, and resolves by explicit ID from any city (records, studies).
export function providersFor(query, sources = getPlanningSources()) {
    return sources.filter(({ descriptor }) => descriptor.city === query.city
        || descriptor.city == null && (query.source === descriptor.id
            || Array.isArray(query.bbox) && Array.isArray(descriptor.bbox) && intersects(descriptor.bbox, query.bbox)));
}
export function sourcesFor(query, sources = getPlanningSources()) {
    const providers = providersFor(query, sources);
    if (query.source) {
        const source = providers.find(provider => provider.descriptor.id === query.source);
        if (!source) throw Object.assign(new Error('Unknown planning source for city'), { status: 400 });
        if (query.scenario && !(source.descriptor.scenarios || [source.descriptor.scenario]).includes(query.scenario)) {
            throw Object.assign(new Error('Unsupported source scenario'), { status: 400 });
        }
        return [source];
    }
    const defaults = providers.filter(provider => provider.descriptor.default !== false);
    if (query.scenario && defaults.some(source => !(source.descriptor.scenarios || [source.descriptor.scenario]).includes(query.scenario))) {
        throw Object.assign(new Error('Unsupported source scenario'), { status: 400 });
    }
    return defaults;
}

export async function planningParcel(pool, query, sources = getPlanningSources()) {
    const providers = sourcesFor(query, sources);
    const answers = await Promise.all(providers.map(provider => provider.parcel ? provider.parcel(pool, query) : []));
    return { schemaVersion: 'planning-representations.v1', city: query.city, parcel: query.parcel,
        sources: providers.map(provider => provider.descriptor), items: answers.flat() };
}

export async function planningRecord(pool, query, sources = getPlanningSources()) {
    const providers = sourcesFor(query, sources);
    const answers = await Promise.all(providers.map(provider => provider.record ? provider.record(pool, query) : []));
    return { schemaVersion: 'planning-representations.v1', city: query.city, recordId: query.recordId, items: answers.flat() };
}

export async function planningRepresentations(pool, query, sources = getPlanningSources()) {
    const providers = sourcesFor(query, sources);
    const scope = createHash('sha256').update(JSON.stringify([query.city, query.bbox, query.scenario, providers.map(p => p.descriptor.id)])).digest('hex');
    let positions = null;
    if (query.cursor !== undefined) {
        try {
            if (typeof query.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(query.cursor)) throw new Error();
            const decoded = JSON.parse(Buffer.from(query.cursor, 'base64url').toString());
            positions = decoded.after;
            if (decoded.scope !== scope || !positions || Array.isArray(positions) || typeof positions !== 'object'
                || !Object.keys(positions).length || Object.entries(positions).some(([id, value]) =>
                    !providers.some(p => p.descriptor.id === id) || typeof value !== 'string' || !value.length || value.length > 200)) throw new Error();
        } catch (_) { throw Object.assign(new Error('Invalid planning cursor'), { status: 400 }); }
    }
    const active = providers.filter(p => !positions || Object.hasOwn(positions, p.descriptor.id));
    const answers = await Promise.all(active.map(provider => provider.query(pool, { ...query, after: positions?.[provider.descriptor.id] ?? null })));
    const after = Object.fromEntries(answers.flatMap((answer, index) => answer.nextAfter == null ? [] : [[active[index].descriptor.id, answer.nextAfter]]));
    const nextCursor = Object.keys(after).length ? Buffer.from(JSON.stringify({ scope, after })).toString('base64url') : null;
    return {
        schemaVersion: 'planning-representations.v1',
        city: query.city,
        sources: providers.map(provider => provider.descriptor),
        items: answers.flatMap(answer => answer.items),
        coverage: providers.length ? 'source-results' : 'unavailable',
        summaries: answers.map(answer => answer.summary).filter(Boolean),
        nextCursor,
        truncated: nextCursor !== null,
        omitted: answers.reduce((sum, answer) => sum + answer.omitted, 0)
    };
}
