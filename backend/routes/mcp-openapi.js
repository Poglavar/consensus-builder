// OpenAPI coverage for the public source reads used by hosted MCP, alongside the existing writes.
const query = (name, description, required = false) => ({ in: 'query', name, required, description, schema: { type: 'string' } });
const response = { 200: { description: 'Source JSON. Missing measurements remain null; incomplete source coverage is explicitly reported.' },
    400: { description: 'Correct the query parameters.' }, 422: { description: 'Unsupported source or ground; review in the app.' },
    429: { description: 'Retry after the source rate limit.' }, 503: { description: 'Source unavailable; retry later.' } };
const get = (summary, parameters = []) => ({ get: { summary, parameters, responses: response } });
const plotId = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_./~:#-]{0,249}$' };
const coordinate = { type:'array', minItems:2, maxItems:2, items:{type:'number'} };
const planPlot = {
    type:'object', required:['id','kind','geometry','cadastreParcelIds'],
    properties: {
        id:plotId, kind:{enum:['plot','remainder','formed','part','road','track']},
        geometry:{type:'object', required:['type','coordinates'], properties:{ type:{enum:['Polygon']},
            coordinates:{type:'array',minItems:1,items:{type:'array',minItems:4,items:coordinate}}}},
        label:{type:'string',maxLength:120}, cadastreParcelIds:{type:'array',maxItems:2000,items:plotId},
        producedByProposalId:plotId, cessionM2:{type:'number',minimum:0,maximum:1e7},
        planningArea:{type:'object',required:['source','recordId'],properties:{source:plotId,recordId:plotId}}
    }
};
const envelopeRead = {
    type:'object', required:['city','source','bbox','plots'],
    properties:{city:{type:'string'},source:{type:'string'},scenario:{type:'string'},
        bbox:{type:'array',minItems:4,maxItems:4,items:{type:'number'}},plots:{type:'array',maxItems:2000,items:planPlot}}
};
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
    '/planning/envelopes': {
        ...get('Permitted envelopes on the source land', [query('city', 'Caller city'), query('source', 'Planning source ID', true),
            query('bbox', 'WGS84 bounds, at most 0.5 square kilometres', true), query('scenario', 'Planning scenario')]),
        post: { summary:'Evaluate permitted building form on an applied parcel layout', responses:response,
            requestBody:{required:true, content:{'application/json':{ schema:envelopeRead }}} }
    },
    '/urban-rules': get('Urban rules at a point (Croatian database source)', [query('coordinates', 'WGS84 longitude,latitude', true)]),
    '/parcels': get('Exact database cadastral parcels or the parcel at a point', [query('parcel_id', 'Comma-separated stable parcel ids'), query('coordinates', 'WGS84 longitude,latitude')]),
    '/markets': get('Agreement contests and devnet pools for a city, or with scope=other for every other city', [query('city', 'Caller record label', true), query('scope', 'other: every city except city; each contest names its city')]),
    '/buildings/under': { post: { summary: 'Read buildings under regions; stores nothing', requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object', required: ['source', 'regions'], properties: { source: { type: 'string', description: 'Explicit building dataset id: osm, gdi-3d, dgu, nyc-arcgis, nyc-socrata, wien-lod2, nl-3dbag, nrw-lod2, nyc-3d, berlin-lod2, hamburg-lod2, bw-lod2, sachsen-lod2 or a portable building descriptor.' }, regions: { type: 'array', minItems: 1, maxItems: 400, items: { type: 'object', required: ['key', 'geometry'], properties: { key: { type: 'string' }, geometry: { type: 'object' } } } } }
    } } } }, responses: response } }
};
