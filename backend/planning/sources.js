// Planning source registry: a city selects providers; consumers receive one representation schema.
import { queryZagrebGup, zagrebGupSource } from './providers/zagreb-gup.js';

export const planningSources = [{ descriptor: zagrebGupSource, query: queryZagrebGup }];

export async function planningRepresentations(pool, query, sources = planningSources) {
    const providers = sources.filter(source => source.descriptor.city === query.city);
    const answers = await Promise.all(providers.map(provider => provider.query(pool, query)));
    return {
        schemaVersion: 'planning-representations.v1',
        city: query.city,
        sources: providers.map(provider => provider.descriptor),
        items: answers.flatMap(answer => answer.items),
        coverage: providers.length ? 'source-results' : 'unavailable',
        summaries: answers.map(answer => answer.summary).filter(Boolean),
        truncated: answers.some(answer => answer.truncated),
        omitted: answers.reduce((sum, answer) => sum + answer.omitted, 0)
    };
}
