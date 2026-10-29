// OpenAPI coverage for the public source reads used by hosted MCP, alongside the existing writes.
const query = (name, description, required = false) => ({ in: 'query', name, required, description, schema: { type: 'string' } });
const response = { 200: { description: 'Source JSON. Missing measurements remain null; incomplete source coverage is explicitly reported.' },
    400: { description: 'Correct the query parameters.' }, 422: { description: 'Unsupported source or ground; review in the app.' },
    429: { description: 'Retry after the source rate limit.' }, 503: { description: 'Source unavailable; retry later.' } };
const get = (summary, parameters = []) => ({ get: { summary, parameters, responses: response } });
export const MCP_READ_PATHS = {
    '/docs/agents.json': get('Live schemas, endpoints, program ids, MCP capabilities and oracle prices'),
    '/agent/activity': get('Public human and agent activity', ['limit', 'actor', 'source', 'action'].map(name => query(name, name))),
    '/agent/pledges/{account}': get('Agreement support totals', [{ in: 'path', name: 'account', required: true, schema: { type: 'string' } }]),
    '/parcel-sources': get('Executable parcel source catalogue with cityIds and defaultForCity'),
    '/parcel-sources/{sourceId}': get('Read exact parcels using one of ids, point or bbox (WGS84)', [
        { in: 'path', name: 'sourceId', required: true, schema: { type: 'string' } },
        query('ids', 'Comma-separated source parcel ids'), query('point', 'longitude,latitude'), query('bbox', 'west,south,east,north')]),
    '/parcel-sources/{sourceId}/under': { post: { summary: 'Read source parcels intersecting a WGS84 polygon; stores nothing',
        parameters: [{ in: 'path', name: 'sourceId', required: true, schema: { type: 'string' } }], requestBody: { required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['geometry'], properties: { geometry: { type: 'object' } } } } } }, responses: response } },
    '/streets/near': get('Bounded OSM street centrelines from the same provider as the app', [query('bbox', 'WGS84 west,south,east,north', true)]),
    '/planning/sources': get('Planning source descriptors and availability', [query('city', 'Caller record label'), query('bbox', 'WGS84 bounds')]),
    '/planning/study': get('Parcel study: exact parcel, zoning evidence and constraints', [query('city', 'Caller record label'), query('source', 'Planning source id', true), query('parcel', 'Source parcel id; supply parcel or point'), query('point', 'WGS84 longitude,latitude'), query('scenario', 'Planning scenario')]),
    '/planning/envelopes': get('Partial permitted envelopes, with applicability and omissions reported', [query('city', 'Caller record label'), query('source', 'Planning source id', true), query('bbox', 'WGS84 bounds, at most 0.5 square kilometres', true), query('scenario', 'Planning scenario')]),
    '/urban-rules': get('Urban rules at a point (Croatian database source)', [query('coordinates', 'WGS84 longitude,latitude', true)]),
    '/parcels': get('Exact database cadastral parcels or the parcel at a point', [query('parcel_id', 'Comma-separated stable parcel ids'), query('coordinates', 'WGS84 longitude,latitude')]),
    '/markets': get('Agreement contests and devnet pools for a city, or with scope=other for every other city', [query('city', 'Caller record label', true), query('scope', 'other: every city except city; each contest names its city')]),
    '/buildings/under': { post: { summary: 'Read buildings under regions; stores nothing', requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object', required: ['source', 'regions'], properties: { source: { type: 'string', description: 'Explicit building dataset id: osm, gdi-3d, dgu, nyc-arcgis, nyc-socrata, wien-lod2 or a portable building descriptor.' }, regions: { type: 'array', minItems: 1, maxItems: 400, items: { type: 'object', required: ['key', 'geometry'], properties: { key: { type: 'string' }, geometry: { type: 'object' } } } } }
    } } } }, responses: response } }
};
