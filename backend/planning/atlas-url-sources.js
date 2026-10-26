// Configure Atlas providers from public HTTPS URLs. Cities can share one regional edition;
// viewing and pagination never trigger a refresh of a loaded edition.
// An entry is scoped either to one app city (`city`) or to geographic bounds (`bbox`,
// west,south,east,north) that any city viewport can intersect; a national dataset is one entry.
import { createPublicSourceFetch, validatePublicSourceUrl } from '../parcels/public-source-fetch.js';
import { atlasSourceDescriptor, createAtlasProvider } from './providers/atlas.js';
import { readAtlasArchive } from './atlas-archive.js';

const publicFetch = createPublicSourceFetch({ maxBytes: 192 * 1024 * 1024, timeoutMs: 180000 });
const datasets = new WeakMap();
const invalid = () => { throw new Error('Invalid planning source configuration. Expected unique source IDs, a city or bbox scope, label, edition and public HTTPS URL.'); };
const finite = value => typeof value === 'number' && Number.isFinite(value);
const validBbox = value => Array.isArray(value) && value.length === 4 && value.every(finite)
    && value[0] >= -180 && value[2] <= 180 && value[1] >= -90 && value[3] <= 90 && value[0] < value[2] && value[1] < value[3];
const text = (value, max) => typeof value === 'string' && value.trim().length > 0
    && value.length <= max && !/[\u0000-\u001f]/.test(value);
const member = value => text(value, 500) && !value.startsWith('/') && !value.split('/').some(part => !part || part === '.' || part === '..')
    && !/[\\:]/.test(value);
function validArchive(archive) {
    return archive && typeof archive === 'object' && !Array.isArray(archive)
        && Object.keys(archive).every(key => ['geometry', 'rules', 'join', 'sheets', 'jurisdiction', 'columnNames', 'repeatedHeaderTail'].includes(key)) && member(archive.geometry)
        && (archive.repeatedHeaderTail === undefined || typeof archive.repeatedHeaderTail === 'boolean')
        && (archive.columnNames === undefined || archive.columnNames && typeof archive.columnNames === 'object'
            && !Array.isArray(archive.columnNames) && Object.keys(archive.columnNames).length <= 10
            && Object.entries(archive.columnNames).every(([key, value]) => /^(?:0|[1-9]\d{0,2})$/.test(key) && text(value, 100)))
        && (archive.sheets === undefined || typeof archive.rules === 'string' && archive.rules.endsWith('.xlsx') && Array.isArray(archive.sheets)
            && archive.sheets.length > 0 && archive.sheets.length <= 10 && new Set(archive.sheets).size === archive.sheets.length
            && archive.sheets.every(name => text(name, 100)))
        && (archive.jurisdiction === undefined || archive.jurisdiction && Object.keys(archive.jurisdiction).length === 2
            && text(archive.jurisdiction.field, 100) && Array.isArray(archive.jurisdiction.values)
            && archive.jurisdiction.values.length > 0 && archive.jurisdiction.values.length <= 100
            && archive.jurisdiction.values.every(value => text(value, 200)))
        && (archive.rules === undefined ? archive.join === undefined && archive.columnNames === undefined && archive.repeatedHeaderTail === undefined : member(archive.rules) && archive.rules !== archive.geometry
            && Array.isArray(archive.join) && archive.join.length > 0 && archive.join.length <= 3
            && archive.join.every(pair => pair && typeof pair === 'object'
                && Object.keys(pair).every(key => ['geometry', 'rule', 'stripPrefix'].includes(key))
                && text(pair.geometry, 100) && text(pair.rule, 100) && (pair.stripPrefix === undefined || text(pair.stripPrefix, 100))));
}

export function parseAtlasSources(value = '[]') {
    let entries;
    try { entries = JSON.parse(value); } catch { invalid(); }
    if (!Array.isArray(entries)) invalid();
    const ids = new Set();
    return entries.map(entry => {
        if (!entry || Array.isArray(entry) || typeof entry !== 'object'
            || Object.keys(entry).some(key => !['id', 'city', 'bbox', 'label', 'edition', 'url', 'default', 'parcelSourceId', 'product', 'archive'].includes(key))
            || !text(entry.id, 100) || !/^[a-z0-9_-]+$/.test(entry.id) || ids.has(entry.id)
            || entry.city !== undefined && (!text(entry.city, 80) || !/^[a-z][a-z0-9_-]*$/.test(entry.city))
            || entry.bbox !== undefined && !validBbox(entry.bbox)
            || entry.city === undefined && entry.bbox === undefined
            || !text(entry.label, 200) || !text(entry.edition, 100) || !text(entry.url, 2000)
            || entry.product !== undefined && !['slices', 'districts'].includes(entry.product)
            || entry.archive !== undefined && (!validArchive(entry.archive) || entry.product !== 'districts')
            || entry.default !== undefined && typeof entry.default !== 'boolean'
            || entry.parcelSourceId !== undefined && (!text(entry.parcelSourceId, 100) || !/^[a-z0-9_-]+$/.test(entry.parcelSourceId))) invalid();
        let url;
        try { url = validatePublicSourceUrl(entry.url).href; } catch { invalid(); }
        ids.add(entry.id);
        return { ...entry, url };
    });
}

const datasetKey = metadata => JSON.stringify([metadata.url, metadata.edition, metadata.product || 'slices', metadata.archive || null]);
function loadDataset(metadata, fetchImpl) {
    let cache = datasets.get(fetchImpl);
    if (!cache) { cache = new Map(); datasets.set(fetchImpl, cache); }
    const key = datasetKey(metadata);
    if (!cache.has(key)) cache.set(key, Promise.resolve().then(async () => {
        const response = await fetchImpl(metadata.url);
        if (!response.ok) throw new Error('Upstream request failed');
        return metadata.archive ? readAtlasArchive(new Uint8Array(await response.arrayBuffer()), metadata.archive) : response.json();
    }).catch(error => { cache.delete(key); throw error; }));
    return cache.get(key);
}

export function createAtlasUrlProvider(metadata, { fetchImpl = publicFetch } = {}) {
    const descriptor = atlasSourceDescriptor(metadata);
    let loaded;
    function load() {
        if (!loaded) loaded = Promise.resolve().then(async () => {
            const provider = createAtlasProvider(await loadDataset(metadata, fetchImpl), metadata);
            Object.assign(descriptor, provider.descriptor);
            return provider;
        }).catch(() => {
            // Failed loads remain unavailable, never an empty successful coverage result.
            // A later request may retry; transport details and URL parameters stay private.
            loaded = null;
            datasets.get(fetchImpl)?.delete(datasetKey(metadata));
            throw Object.assign(new Error('Atlas URL could not be loaded as a valid zoning dataset.'), { status: 503 });
        });
        return loaded;
    }
    return { descriptor,
        async query(pool, query) { return (await load()).query(pool, query); },
        async record(pool, query) { return (await load()).record(pool, query); }
    };
}
