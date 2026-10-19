// Planning source registry: a city selects providers; consumers receive one representation schema.
import { queryZagrebGup, zagrebGupSource } from './providers/zagreb-gup.js';
import { createHash } from 'node:crypto';

export const planningSources = [{ descriptor: zagrebGupSource, query: queryZagrebGup }];

export async function planningRepresentations(pool, query, sources = planningSources) {
    const providers = sources.filter(source => source.descriptor.city === query.city);
    const scope = createHash('sha256').update(JSON.stringify([query.city, query.bbox, providers.map(p => p.descriptor.id)])).digest('hex');
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
