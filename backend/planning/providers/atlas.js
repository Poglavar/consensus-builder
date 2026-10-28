// Read a supplied Atlas slice dataset as zoning areas and source constraints. No solver or
// parcel conversion: numeric evidence methods and the original source fields remain intact.
import * as turf from '@turf/turf';
import { atlasInventory, inspectNumericConstraint } from '../atlas-audit.js';
import { withSourceProposal, sourceRevision } from '../source-proposal.js';
import { validateGeometry } from '../../parcels/source-contract.js';
import { atlasScenarios as scenarios, atlasDimensions as dimensions, districtRecord, reconcileDistrictRecord } from '../atlas-districts.js';

// A source is registered either under one app city or by geographic bounds (a dataset
// spanning many jurisdictions). Parcel massing always needs an explicitly pinned parcel provider.
export function atlasSourceDescriptor({ id, city = null, label, edition, url, parcelSourceId, bbox: configuredBbox = null,
    default: isDefault = true, product = 'slices' }, bbox = null) {
    return { id, city, label, edition, url, product, default: isDefault, kind: 'regulation',
        coverage: 'zoning-areas', bbox: bbox || configuredBbox, scope: city ? 'city' : 'bounds', storage: 'supplied-atlas-dataset',
        capabilities: { volumes: false, areas: true, parcelEvidence: false, constraintEvaluation: false },
        ...(parcelSourceId ? { parcelSourceId } : {}), parcelStudy: 'direct-dimensions.v1',
        scenarios, scenario: scenarios[0] };
}
// Housing types the source records as usable, in dictionary order. Only these can become
// configurations; prohibited, overlay-dependent and unmentioned uses stay excluded evidence.
export const configurationTreatments = Object.freeze(['allowed', 'hearing']);
export function createAtlasProvider(collection, metadata) {
    const { id, product = 'slices' } = metadata;
    if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features)
        || !collection.features.length || collection.features.length > 50000
        || collection.crs && !(collection.crs.type === 'name'
            && collection.crs.properties?.name === 'urn:ogc:def:crs:OGC:1.3:CRS84')) throw new Error('Invalid Atlas collection');
    const entries = collection.features.map((feature, index) => {
        const district = product === 'districts' ? reconcileDistrictRecord(
            districtRecord(feature?.properties || {}, feature.atlasFeatureIndex ?? index),
            feature.atlasGeometryProperties, feature.atlasFeatureIndex ?? index) : null;
        const recordId = district?.id ?? feature?.properties?.slice_id;
        if (feature?.type !== 'Feature' || !(product === 'districts' && feature.geometry === null || validateGeometry(feature.geometry))
            || !(typeof recordId === 'string' && recordId.trim().length > 0 && recordId.length <= 200
                || Number.isSafeInteger(recordId) && (product === 'districts' || recordId >= 0))) throw new Error('Invalid Atlas record');
        return { id: String(recordId), feature, district, bbox: feature.geometry ? turf.bbox(feature) : null, revision: sourceRevision(feature) };
    }).sort((a, b) => a.id.localeCompare(b.id, 'en'));
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('Duplicate Atlas slice identity');
    const mapped = { type: 'FeatureCollection', features: entries.filter(entry => entry.bbox).map(entry => entry.feature) };
    const descriptor = atlasSourceDescriptor(metadata, mapped.features.length ? turf.bbox(mapped) : null);
    function treatment(entry, scenario) {
        const applicability = entry.district?.applicability;
        if (applicability?.extinct || applicability?.conflicts.some(conflict =>
            ['overlay', 'extinct', `${scenario}_treatment`].includes(conflict.field))) return null;
        if (applicability?.overlay) return 'overlay';
        return (entry.district?.values || entry.feature.properties)[`${scenario}_treatment`] || null;
    }
    // `city` names the app city that routed the request; a bounds-registered source has none of its own.
    function record(entry, scenario = descriptor.scenario, displayGeometry = entry.feature.geometry, city = descriptor.city) {
        const p = entry.feature.properties;
        const numericEvidence = entry.district?.numericEvidence || Object.fromEntries(Object.keys(p).filter(key => key.endsWith('_method'))
            .map(key => [key.slice(0, -7), inspectNumericConstraint(p, key.slice(0, -7))]));
        const constraints = dimensions.flatMap(([suffix, quantity, unit, bound]) => {
            const field = `${scenario}_${suffix}`, evidence = numericEvidence[field] || { status: 'absent' };
            return evidence.value === undefined ? [] : [{ quantity, value: evidence.value, unit, bound,
                evidence: evidence.status, evaluation: 'not-evaluated', sourceField: evidence.sourceField || field, scenario }];
        });
        return withSourceProposal({
            id: `${id}:${entry.id}`, role: 'permitted', title: `${entry.district?.jurisdiction || p.jurisdiction} · ${entry.district ? entry.district.code || 'Unidentified district' : entry.id}`,
            site: displayGeometry, areas: displayGeometry ? [{ id: `${id}:${entry.id}:area`, geometry: displayGeometry }] : [], volumes: [],
            spatialReference: { horizontal: 'OGC:CRS84', vertical: 'relative-ground', unit: 'm' },
            source: { ...descriptor, city: city || descriptor.city, scenario, recordId: entry.id, version: entry.revision,
                publishedAt: p.updated || null },
            authority: { effect: 'obligatory', basis: 'source-summary', applicability: 'unresolved' },
            assessment: { meaning: 'zoning-area', status: treatment(entry, scenario),
                reason: entry.district?.applicability.conflicts.length ? 'district-evidence-conflict' : null,
                geometry: 'source-area', constraints: 'not-evaluated', current: entry.district?.applicability.extinct !== true },
            metrics: { floorAreaM2: null, heightM: null }, constraints,
            sourceEvidence: { product, dictionaryUrl: product === 'districts'
                ? 'https://www.mercatus.org/sites/default/files/2024-09/zoning_atlas_data_dictionary_1.pdf' : atlasInventory.products.slices.dictionaryUrl,
                properties: p, numericEvidence, ...(entry.district ? { applicability: entry.district.applicability } : {}), ...(entry.feature.atlasJoin ? {
                    join: entry.feature.atlasJoin, geometryProperties: entry.feature.atlasGeometryProperties,
                    ...(entry.feature.atlasRuleRow ? { tableRow: entry.feature.atlasRuleRow } : {}) } : {}) }
        });
    }
    return { descriptor,
        async record(_pool, query) {
            const entry = entries.find(entry => entry.id === query.recordId);
            return entry ? [record(entry, query.scenario, entry.feature.geometry, query.city)] : [];
        },
        async query(_pool, { bbox, limit, after = null, scenario = descriptor.scenario, city }) {
            const area = turf.bboxPolygon(bbox);
            const visible = entries.filter(entry => entry.bbox && !(entry.bbox[2] < bbox[0] || entry.bbox[0] > bbox[2]
                || entry.bbox[3] < bbox[1] || entry.bbox[1] > bbox[3]) && turf.booleanIntersects(entry.feature, area));
            const remaining = visible.filter(entry => after === null || entry.id.localeCompare(after, 'en') > 0);
            const page = remaining.slice(0, limit);
            const items = page.map(entry => record(entry, scenario, turf.bboxClip(entry.feature, bbox).geometry, city));
            const statuses = {};
            for (const entry of visible) {
                const status = treatment(entry, scenario) || 'unknown';
                statuses[status] = (statuses[status] || 0) + 1;
            }
            return { items, nextAfter: remaining.length > limit ? page.at(-1).id : null, omitted: 0,
                summary: { sourceId: id, cachedResults: visible.length, withGeometry: visible.length, withoutGeometry: 0, statuses } };
        }
    };
}
