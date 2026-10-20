// Configure Atlas slice providers from public HTTPS URLs. A process keeps one validated
// dataset per source; viewing and pagination never trigger a refresh of a loaded edition.
import { createPublicSourceFetch, validatePublicSourceUrl } from '../parcels/public-source-fetch.js';
import { atlasSourceDescriptor, createAtlasProvider } from './providers/atlas.js';

const publicFetch = createPublicSourceFetch({ maxBytes: 64 * 1024 * 1024, timeoutMs: 45000 });
const invalid = () => { throw new Error('Invalid PLANNING_ATLAS_SOURCES configuration. Expected unique source IDs, city, label, edition and public HTTPS URL.'); };
const text = (value, max) => typeof value === 'string' && value.trim().length > 0
    && value.length <= max && !/[\u0000-\u001f]/.test(value);

export function parseAtlasSources(value = '[]') {
    let entries;
    try { entries = JSON.parse(value); } catch { invalid(); }
    if (!Array.isArray(entries) || entries.length > 20) invalid();
    const ids = new Set();
    return entries.map(entry => {
        if (!entry || Array.isArray(entry) || typeof entry !== 'object'
            || Object.keys(entry).some(key => !['id', 'city', 'label', 'edition', 'url', 'default'].includes(key))
            || !text(entry.id, 100) || !/^[a-z0-9_-]+$/.test(entry.id) || ids.has(entry.id)
            || !text(entry.city, 80) || !/^[a-z][a-z0-9_-]*$/.test(entry.city)
            || !text(entry.label, 200) || !text(entry.edition, 100) || !text(entry.url, 2000)
            || entry.default !== undefined && typeof entry.default !== 'boolean') invalid();
        let url;
        try { url = validatePublicSourceUrl(entry.url).href; } catch { invalid(); }
        ids.add(entry.id);
        return { ...entry, url };
    });
}

export function createAtlasUrlProvider(metadata, { fetchImpl = publicFetch } = {}) {
    const descriptor = atlasSourceDescriptor(metadata);
    let loaded;
    function load() {
        if (!loaded) loaded = Promise.resolve().then(async () => {
            const response = await fetchImpl(metadata.url);
            if (!response.ok) throw new Error('Upstream request failed');
            const provider = createAtlasProvider(await response.json(), metadata);
            Object.assign(descriptor, provider.descriptor);
            return provider;
        }).catch(() => {
            // Failed loads remain unavailable, never an empty successful coverage result.
            // A later request may retry; transport details and URL parameters stay private.
            loaded = null;
            throw Object.assign(new Error('Atlas URL could not be loaded as a valid slices dataset.'), { status: 503 });
        });
        return loaded;
    }
    return { descriptor,
        async query(pool, query) { return (await load()).query(pool, query); },
        async record(pool, query) { return (await load()).record(pool, query); }
    };
}
