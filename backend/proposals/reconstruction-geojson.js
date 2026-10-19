// Canonical GeoJSON archive boundary for reconstructed real-world building proposals.
// Geometry lives once, as ordinary GeoJSON features. Proposal-only metadata is kept in a
// foreign member, which GeoJSON explicitly permits, so GIS tools can still open the file.

export const RECONSTRUCTION_GEOJSON_SCHEMA = 'consensus-builder.reconstruction.v1';

const RUNTIME_KEYS = new Set([
    'applied',
    'serverProposalId',
    'buildingGeometry',
    'buildingProperties',
    'properties',
    'geometry',
    'buildingProposal'
]);

function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function feature(value, label) {
    if (!value || value.type !== 'Feature' || !value.geometry) {
        throw new Error(`${label} must be a GeoJSON Feature with geometry.`);
    }
    if (!['Polygon', 'MultiPolygon'].includes(value.geometry.type)) {
        throw new Error(`${label} must contain Polygon or MultiPolygon geometry.`);
    }
    return clone(value);
}

function withoutKeys(value, keys) {
    return Object.fromEntries(Object.entries(value || {})
        .filter(([key]) => !keys.has(key))
        .map(([key, entry]) => [key, clone(entry)]));
}

function roleFeature(input, role, index = null) {
    const output = feature(input, role === 'site' ? 'Site' : `Building ${index + 1}`);
    output.properties = {
        ...(output.properties || {}),
        'consensus:role': role
    };
    if (index !== null) output.properties['consensus:index'] = index;
    return output;
}

function stripArchiveProperties(input) {
    const output = clone(input);
    const properties = { ...(output.properties || {}) };
    delete properties['consensus:role'];
    delete properties['consensus:index'];
    output.properties = properties;
    return output;
}

export function proposalToReconstructionGeoJSON(proposal) {
    if (!proposal || typeof proposal !== 'object') throw new Error('Proposal is required.');

    const site = feature(proposal.geometry?.superParcel, 'Site');
    const buildings = Array.isArray(proposal.geometry?.buildings)
        ? proposal.geometry.buildings.map((entry, index) => feature(entry, `Building ${index + 1}`))
        : [];
    if (!buildings.length) throw new Error('Proposal must contain at least one building.');

    const proposalMetadata = withoutKeys(proposal, RUNTIME_KEYS);
    const buildingProposalMetadata = withoutKeys(proposal.buildingProposal || {}, new Set(['buildingFeature', 'buildings']));
    const collection = {
        type: 'FeatureCollection',
        name: proposal.title || proposal.name || proposal.proposalId || 'Reconstructed proposal',
        bbox: clone(proposal.bounds),
        reconstruction: {
            schema: RECONSTRUCTION_GEOJSON_SCHEMA,
            proposal: proposalMetadata,
            buildingProposal: buildingProposalMetadata
        },
        features: [
            roleFeature(site, 'site'),
            ...buildings.map((building, index) => roleFeature(building, 'building', index))
        ]
    };
    if (!Array.isArray(collection.bbox) || collection.bbox.length !== 4) delete collection.bbox;
    return collection;
}

export function reconstructionGeoJSONToProposal(collection) {
    if (!collection || collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
        throw new Error('Expected a GeoJSON FeatureCollection.');
    }
    if (collection.reconstruction?.schema !== RECONSTRUCTION_GEOJSON_SCHEMA) {
        throw new Error(`Expected ${RECONSTRUCTION_GEOJSON_SCHEMA}.`);
    }

    const siteFeatures = collection.features.filter(entry => entry?.properties?.['consensus:role'] === 'site');
    const buildingFeatures = collection.features
        .filter(entry => entry?.properties?.['consensus:role'] === 'building')
        .sort((left, right) => Number(left.properties?.['consensus:index']) - Number(right.properties?.['consensus:index']));
    if (siteFeatures.length !== 1) throw new Error(`Expected exactly one site feature; found ${siteFeatures.length}.`);
    if (!buildingFeatures.length) throw new Error('Expected at least one building feature.');

    const site = stripArchiveProperties(feature(siteFeatures[0], 'Site'));
    const buildings = buildingFeatures.map((entry, index) => stripArchiveProperties(feature(entry, `Building ${index + 1}`)));
    const proposal = {
        ...clone(collection.reconstruction.proposal || {}),
        applied: false,
        geometry: {
            superParcel: site,
            buildings
        },
        buildingGeometry: clone(buildings[0].geometry),
        buildingProperties: clone(buildings[0].properties || {}),
        properties: clone(buildings[0].properties || {}),
        buildingProposal: {
            ...clone(collection.reconstruction.buildingProposal || {}),
            buildingFeature: clone(buildings[0]),
            buildings: clone(buildings)
        }
    };
    if (!proposal.bounds && Array.isArray(collection.bbox)) proposal.bounds = clone(collection.bbox);
    return proposal;
}

export function assertReconstructionGeoJSONRoundTrip(proposal) {
    const first = proposalToReconstructionGeoJSON(proposal);
    const imported = reconstructionGeoJSONToProposal(first);
    const second = proposalToReconstructionGeoJSON(imported);
    if (JSON.stringify(first) !== JSON.stringify(second)) {
        throw new Error('Reconstruction GeoJSON did not survive a lossless export/import/export round trip.');
    }
    return {
        collection: first,
        imported,
        buildingCount: first.features.length - 1
    };
}
