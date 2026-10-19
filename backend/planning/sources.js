// Planning source registry: a city selects providers; consumers receive one representation schema.
import { queryZagrebGup, readZagrebParcel, zagrebGupSource, zagrebGup2016Source } from './providers/zagreb-gup.js';
import { queryNycPilot, readNycPilotParcel, nycPilotSource } from './providers/nyc-pilot.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createAtlasProvider } from './providers/atlas.js';

export const planningSources = [zagrebGupSource, zagrebGup2016Source].map(descriptor => ({
    descriptor,
    query: (pool, query) => queryZagrebGup(pool, { ...query, edition: descriptor.edition }),
    parcel: (pool, query) => readZagrebParcel(pool, { ...query, edition: descriptor.edition }),
    record: (pool, query) => readZagrebParcel(pool, { ...query, parcel: query.recordId, edition: descriptor.edition })
}));
planningSources.push({ descriptor: nycPilotSource, query: queryNycPilot, parcel: readNycPilotParcel,
    record: (pool, query) => readNycPilotParcel(pool, { ...query, parcel: `US-NY-${query.recordId}` }) });
// Explicit local/operator configuration only. Source data is not bundled or republished by default.
if (process.env.PLANNING_ATLAS_SAMPLE) planningSources.push(createAtlasProvider(
    JSON.parse(readFileSync(process.env.PLANNING_ATLAS_SAMPLE, 'utf8')), {
        id: 'atlas-lafayette-sample', city: 'colorado', label: 'Atlas · Lafayette sample', edition: 'public-sample',
        url: 'https://www.landuselabs.com/s/lafayette_co_slices_sample.geojson'
    }));

export function sourcesFor(query, sources = planningSources) {
    const providers = sources.filter(source => source.descriptor.city === query.city);
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

export async function planningParcel(pool, query, sources = planningSources) {
    const providers = sourcesFor(query, sources);
    const answers = await Promise.all(providers.map(provider => provider.parcel ? provider.parcel(pool, query) : []));
    return { schemaVersion: 'planning-representations.v1', city: query.city, parcel: query.parcel,
        sources: providers.map(provider => provider.descriptor), items: answers.flat() };
}

export async function planningRecord(pool, query, sources = planningSources) {
    const providers = sourcesFor(query, sources);
    const answers = await Promise.all(providers.map(provider => provider.record ? provider.record(pool, query) : []));
    return { schemaVersion: 'planning-representations.v1', city: query.city, recordId: query.recordId, items: answers.flat() };
}

export async function planningRepresentations(pool, query, sources = planningSources) {
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
