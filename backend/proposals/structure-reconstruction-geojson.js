// Canonical GeoJSON archive boundary for reconstructed park and square proposals.
// The site and authored structure stay ordinary GeoJSON features; proposal-only metadata is
// retained in a foreign member so desktop GIS tools can still consume the archive directly.

export const STRUCTURE_RECONSTRUCTION_GEOJSON_SCHEMA = 'consensus-builder.structure-reconstruction.v1';

const PROPOSAL_RUNTIME_KEYS = new Set([
    'applied',
    'serverProposalId',
    'geometry',
    'structureProposal'
]);
const STRUCTURE_GEOMETRY_KEYS = new Set(['geometry']);

function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function withoutKeys(value, keys) {
    return Object.fromEntries(Object.entries(value || {})
        .filter(([key]) => !keys.has(key))
        .map(([key, entry]) => [key, clone(entry)]));
}

function polygonFeature(value, label) {
    const wrapped = value?.type === 'Feature'
        ? value
        : { type: 'Feature', properties: {}, geometry: value };
    if (!wrapped || wrapped.type !== 'Feature' || !wrapped.geometry) {
        throw new Error(`${label} must be a GeoJSON Feature with geometry.`);
    }
    if (!['Polygon', 'MultiPolygon'].includes(wrapped.geometry.type)) {
        throw new Error(`${label} must contain Polygon or MultiPolygon geometry.`);
    }
    return clone(wrapped);
}

function withRole(input, role) {
    const output = clone(input);
    output.properties = {
        ...(output.properties || {}),
        'consensus:role': role
    };
    return output;
}

function stripArchiveProperties(input) {
    const output = clone(input);
    const properties = { ...(output.properties || {}) };
    delete properties['consensus:role'];
    output.properties = properties;
    return output;
}

export function structureProposalToReconstructionGeoJSON(proposal, siteFeature) {
    if (!proposal || typeof proposal !== 'object') throw new Error('Proposal is required.');
    const structure = proposal.structureProposal;
    if (!structure || typeof structure !== 'object') throw new Error('Structure proposal is required.');

    const kind = String(structure.kind || '').toLowerCase();
    if (!['park', 'square', 'lake'].includes(kind)) {
        throw new Error('Structure reconstruction supports park, square, or lake proposals.');
    }
    const site = polygonFeature(siteFeature, 'Site');
    const footprint = polygonFeature(structure.geometry, 'Structure footprint');
    const collection = {
        type: 'FeatureCollection',
        name: proposal.title || proposal.name || proposal.proposalId || 'Reconstructed structure',
        bbox: clone(proposal.bounds),
        reconstruction: {
            schema: STRUCTURE_RECONSTRUCTION_GEOJSON_SCHEMA,
            proposal: withoutKeys(proposal, PROPOSAL_RUNTIME_KEYS),
            structureProposal: withoutKeys(structure, STRUCTURE_GEOMETRY_KEYS)
        },
        features: [
            withRole(site, 'site'),
            withRole(footprint, 'structure-footprint')
        ]
    };
    if (!Array.isArray(collection.bbox) || collection.bbox.length !== 4) delete collection.bbox;
    return collection;
}

export function structureReconstructionGeoJSONToProposal(collection) {
    if (!collection || collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
        throw new Error('Expected a GeoJSON FeatureCollection.');
    }
    if (collection.reconstruction?.schema !== STRUCTURE_RECONSTRUCTION_GEOJSON_SCHEMA) {
        throw new Error(`Expected ${STRUCTURE_RECONSTRUCTION_GEOJSON_SCHEMA}.`);
    }

    const sites = collection.features.filter(feature => feature?.properties?.['consensus:role'] === 'site');
    const footprints = collection.features.filter(feature => feature?.properties?.['consensus:role'] === 'structure-footprint');
    if (sites.length !== 1) throw new Error(`Expected exactly one site feature; found ${sites.length}.`);
    if (footprints.length !== 1) throw new Error(`Expected exactly one structure footprint; found ${footprints.length}.`);

    const site = stripArchiveProperties(polygonFeature(sites[0], 'Site'));
    const footprint = stripArchiveProperties(polygonFeature(footprints[0], 'Structure footprint'));
    const structureProposal = {
        ...clone(collection.reconstruction.structureProposal || {}),
        geometry: clone(footprint.geometry)
    };
    const proposal = {
        ...clone(collection.reconstruction.proposal || {}),
        applied: false,
        geometry: clone(footprint.geometry),
        structureProposal
    };
    if (!proposal.bounds && Array.isArray(collection.bbox)) proposal.bounds = clone(collection.bbox);
    return { proposal, site };
}

export function assertStructureReconstructionGeoJSONRoundTrip(proposal, siteFeature) {
    const first = structureProposalToReconstructionGeoJSON(proposal, siteFeature);
    const imported = structureReconstructionGeoJSONToProposal(first);
    const second = structureProposalToReconstructionGeoJSON(imported.proposal, imported.site);
    if (JSON.stringify(first) !== JSON.stringify(second)) {
        throw new Error('Structure reconstruction GeoJSON did not survive a lossless export/import/export round trip.');
    }
    return {
        collection: first,
        imported: imported.proposal,
        site: imported.site,
        kind: imported.proposal.structureProposal.kind
    };
}
