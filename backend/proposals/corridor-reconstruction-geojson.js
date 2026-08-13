// Canonical GeoJSON archive boundary for reconstructed real-world road proposals.
//
// A corridor proposal has three kinds of geometry that must not be conflated:
//   * the observed site, retained as reconstruction context;
//   * one or more editable centreline segments;
//   * the authoritative land-take footprint used by the proposal fabric.
//
// All three remain ordinary GeoJSON features. Proposal-only state lives in the
// collection's foreign `reconstruction` member, which GeoJSON explicitly permits.

export const CORRIDOR_RECONSTRUCTION_GEOJSON_SCHEMA = 'consensus-builder.corridor-reconstruction.v1';

const PROPOSAL_RUNTIME_KEYS = new Set([
    'applied',
    'serverProposalId',
    'geometry',
    'roadProposal'
]);

const ROAD_RUNTIME_KEYS = new Set(['definition']);
const DEFINITION_GEOMETRY_KEYS = new Set(['points', 'segments', 'segmentIds', 'polygon']);

function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function withoutKeys(value, keys) {
    return Object.fromEntries(Object.entries(value || {})
        .filter(([key]) => !keys.has(key))
        .map(([key, entry]) => [key, clone(entry)]));
}

function geometryFeature(value, allowedTypes, label) {
    if (!value || value.type !== 'Feature' || !value.geometry) {
        throw new Error(`${label} must be a GeoJSON Feature with geometry.`);
    }
    if (!allowedTypes.includes(value.geometry.type)) {
        throw new Error(`${label} must contain ${allowedTypes.join(' or ')} geometry.`);
    }
    return clone(value);
}

function polygonFeature(value, label) {
    const wrapped = value?.type === 'Feature'
        ? value
        : { type: 'Feature', properties: {}, geometry: value };
    return geometryFeature(wrapped, ['Polygon', 'MultiPolygon'], label);
}

function centrelineSegments(definition) {
    const raw = Array.isArray(definition?.points) && definition.points.length
        ? definition.points
        : definition?.segments;
    if (!Array.isArray(raw) || raw.length === 0) return [];
    const nested = Array.isArray(raw[0]);
    const segments = nested ? raw : [raw];
    return segments.map((segment, index) => {
        const coordinates = (Array.isArray(segment) ? segment : []).map(point => {
            const lat = Number(point?.lat !== undefined ? point.lat : point?.[1]);
            const lng = Number(point?.lng !== undefined ? point.lng : point?.[0]);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                throw new Error(`Centreline ${index + 1} contains an invalid point.`);
            }
            return [lng, lat];
        });
        if (coordinates.length < 2) throw new Error(`Centreline ${index + 1} needs at least two points.`);
        return coordinates;
    });
}

function withRole(input, role, properties = {}) {
    const output = clone(input);
    output.properties = {
        ...(output.properties || {}),
        ...properties,
        'consensus:role': role
    };
    return output;
}

function stripArchiveProperties(input) {
    const output = clone(input);
    const properties = { ...(output.properties || {}) };
    delete properties['consensus:role'];
    delete properties['consensus:index'];
    delete properties['consensus:segment-id'];
    output.properties = properties;
    return output;
}

export function corridorProposalToReconstructionGeoJSON(proposal, siteFeature) {
    if (!proposal || typeof proposal !== 'object') throw new Error('Proposal is required.');
    const definition = proposal.roadProposal?.definition;
    if (!definition || typeof definition !== 'object') throw new Error('Road proposal definition is required.');

    const site = geometryFeature(siteFeature, ['Polygon', 'MultiPolygon'], 'Site');
    const footprint = polygonFeature(definition.polygon, 'Corridor footprint');
    const segments = centrelineSegments(definition);
    if (!segments.length) throw new Error('Road proposal needs at least one centreline segment.');
    const segmentIds = Array.isArray(definition.segmentIds) ? definition.segmentIds : [];

    const collection = {
        type: 'FeatureCollection',
        name: proposal.title || proposal.name || proposal.proposalId || 'Reconstructed corridor',
        bbox: clone(proposal.bounds),
        reconstruction: {
            schema: CORRIDOR_RECONSTRUCTION_GEOJSON_SCHEMA,
            proposal: withoutKeys(proposal, PROPOSAL_RUNTIME_KEYS),
            roadProposal: withoutKeys(proposal.roadProposal, ROAD_RUNTIME_KEYS),
            definition: withoutKeys(definition, DEFINITION_GEOMETRY_KEYS)
        },
        features: [
            withRole(site, 'site'),
            ...segments.map((coordinates, index) => withRole({
                type: 'Feature',
                properties: {},
                geometry: { type: 'LineString', coordinates }
            }, 'corridor-centerline', {
                'consensus:index': index,
                'consensus:segment-id': segmentIds[index] ?? null
            })),
            withRole(footprint, 'corridor-footprint')
        ]
    };
    if (!Array.isArray(collection.bbox) || collection.bbox.length !== 4) delete collection.bbox;
    return collection;
}

export function corridorReconstructionGeoJSONToProposal(collection) {
    if (!collection || collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
        throw new Error('Expected a GeoJSON FeatureCollection.');
    }
    if (collection.reconstruction?.schema !== CORRIDOR_RECONSTRUCTION_GEOJSON_SCHEMA) {
        throw new Error(`Expected ${CORRIDOR_RECONSTRUCTION_GEOJSON_SCHEMA}.`);
    }

    const sites = collection.features.filter(feature => feature?.properties?.['consensus:role'] === 'site');
    const footprints = collection.features.filter(feature => feature?.properties?.['consensus:role'] === 'corridor-footprint');
    const centrelineFeatures = collection.features
        .filter(feature => feature?.properties?.['consensus:role'] === 'corridor-centerline')
        .sort((left, right) => Number(left.properties?.['consensus:index']) - Number(right.properties?.['consensus:index']));
    if (sites.length !== 1) throw new Error(`Expected exactly one site feature; found ${sites.length}.`);
    if (footprints.length !== 1) throw new Error(`Expected exactly one corridor footprint; found ${footprints.length}.`);
    if (!centrelineFeatures.length) throw new Error('Expected at least one corridor centreline.');

    const site = stripArchiveProperties(geometryFeature(sites[0], ['Polygon', 'MultiPolygon'], 'Site'));
    const footprint = stripArchiveProperties(polygonFeature(footprints[0], 'Corridor footprint'));
    const points = centrelineFeatures.map((entry, index) => {
        const line = geometryFeature(entry, ['LineString'], `Centreline ${index + 1}`);
        return line.geometry.coordinates.map(([lng, lat]) => ({ lat: Number(lat), lng: Number(lng) }));
    });
    const segmentIds = centrelineFeatures.map(entry => entry.properties?.['consensus:segment-id'] ?? null);
    const definition = {
        ...clone(collection.reconstruction.definition || {}),
        points,
        segments: clone(points),
        segmentIds,
        polygon: clone(footprint.geometry)
    };
    const proposal = {
        ...clone(collection.reconstruction.proposal || {}),
        applied: false,
        geometry: clone(footprint.geometry),
        roadProposal: {
            ...clone(collection.reconstruction.roadProposal || {}),
            definition
        }
    };
    if (!proposal.bounds && Array.isArray(collection.bbox)) proposal.bounds = clone(collection.bbox);
    return { proposal, site };
}

export function assertCorridorReconstructionGeoJSONRoundTrip(proposal, siteFeature) {
    const first = corridorProposalToReconstructionGeoJSON(proposal, siteFeature);
    const imported = corridorReconstructionGeoJSONToProposal(first);
    const second = corridorProposalToReconstructionGeoJSON(imported.proposal, imported.site);
    if (JSON.stringify(first) !== JSON.stringify(second)) {
        throw new Error('Corridor reconstruction GeoJSON did not survive a lossless export/import/export round trip.');
    }
    return {
        collection: first,
        imported: imported.proposal,
        site: imported.site,
        segmentCount: first.features.filter(feature => feature.properties?.['consensus:role'] === 'corridor-centerline').length
    };
}
