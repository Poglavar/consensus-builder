// Planning dataset services selected explicitly by consumers; one representation schema.
import { queryZagrebGup, readZagrebParcel, zagrebGupSource, zagrebGup2016Source } from './providers/zagreb-gup.js';
import { queryNycPilot, readNycPilotParcel, nycPilotSource } from './providers/nyc-pilot.js';
import { createHash } from 'node:crypto';
import configuredSources from '../../frontend/data/planning-sources.json' with { type: 'json' };
import { parseAtlasSources, createAtlasUrlProvider } from './atlas-url-sources.js';

const builtInSources = [zagrebGupSource, zagrebGup2016Source].map(descriptor => ({
    descriptor,
    query: (pool, query) => queryZagrebGup(pool, { ...query, edition: descriptor.edition }),
    parcel: (pool, query) => readZagrebParcel(pool, { ...query, edition: descriptor.edition }),
    record: (pool, query) => readZagrebParcel(pool, { ...query, parcel: query.recordId, edition: descriptor.edition })
}));
builtInSources.push({ descriptor: nycPilotSource, query: queryNycPilot, parcel: readNycPilotParcel,
    record: (pool, query) => readNycPilotParcel(pool, { ...query, parcel: `US-NY-${query.recordId}` }) });
// Public provider definitions are owned by frontend/data/planning-sources.json.
export function createPlanningSources(config, options) {
    const configured = parseAtlasSources(config);
    if (configured.some(entry => builtInSources.some(source => source.descriptor.id === entry.id))) {
        throw new Error('Atlas source ID conflicts with a built-in planning source.');
    }
    return [...builtInSources, ...configured.map(metadata => createAtlasUrlProvider(metadata, options))];
}
let planningSources;
export function getPlanningSources() {
    return planningSources ??= createPlanningSources(JSON.stringify(configuredSources.sources));
}

// Catalogue listing is consumer-neutral. Data reads require an explicitly named source.
export function providersFor(_query, sources = getPlanningSources()) { return sources; }
export function sourcesFor(query, sources = getPlanningSources()) {
    const ids = query.sources || (query.source ? [query.source] : []);
    if (!Array.isArray(ids) || !ids.length || ids.length > 20 || new Set(ids).size !== ids.length) {
        throw Object.assign(new Error('Choose explicit planning sources.'), { status: 400 });
    }
    return ids.map(id => {
        const source = sources.find(provider => provider.descriptor.id === id);
        if (!source) throw Object.assign(new Error('Unknown planning source.'), { status: 400 });
        if (query.scenario && !(source.descriptor.scenarios || [source.descriptor.scenario]).includes(query.scenario)) {
            throw Object.assign(new Error('Unsupported source scenario'), { status: 400 });
        }
        return source;
    });
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
