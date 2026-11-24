import * as turf from '@turf/turf';
import { validateGeometry } from '../parcels/source-contract.js';
import { sourceRevision } from './source-proposal.js';

const identifier = /^[A-Za-z0-9][A-Za-z0-9_./~:#-]{0,249}$/;
const validId = value => typeof value === 'string' && identifier.test(value);
const kinds = new Set(['plot', 'remainder', 'formed', 'part', 'road', 'track']);
export const touches = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
export const corridor = plot => plot.kind === 'road' || plot.kind === 'track';
// A cadastral sibling or the land left outside a layout's chosen site keeps its
// previous land basis. It cannot replace a neighbouring lot defined by the government.
export function keepsGovernmentLot(plot, source, recordId) {
    return plot?.kind === 'part' || plot?.kind === 'remainder' && plot.planningArea?.source === source && plot.planningArea.recordId !== recordId;
}
export function expandBounds([w, s, e, n], metres) {
    const dy = metres / 111320, dx = dy / Math.max(0.000001, Math.cos((s + n) / 2 * Math.PI / 180));
    return [w - dx, s - dy, e + dx, n + dy];
}
function invalid() { throw Object.assign(new Error('Invalid plan plots'), { status: 422, code: 'invalid-plan-plots' }); }

// Only the normalized fields enter the calculation and its cache key. In particular, a supplied
// GeoJSON bbox must never override the coordinates when checking the viewport.
export function validatePlanPlots(input, bbox) {
    if (!Array.isArray(input) || input.length > 2000) invalid();
    const reach = expandBounds(bbox, 46), seen = new Set();
    let vertices = 0;
    return input.map(plot => {
        if (!plot || !validId(plot.id) || seen.has(plot.id) || !kinds.has(plot.kind)
            || !Array.isArray(plot.cadastreParcelIds) || plot.cadastreParcelIds.length > 2000
            || !plot.cadastreParcelIds.every(validId)
            || plot.label != null && (typeof plot.label !== 'string' || plot.label.length > 120)
            || plot.producedByProposalId != null && !validId(plot.producedByProposalId)
            || plot.cessionM2 != null && (!Number.isFinite(plot.cessionM2) || plot.cessionM2 < 0 || plot.cessionM2 > 1e7)
            || plot.planningArea != null && (!validId(plot.planningArea.source) || !validId(plot.planningArea.recordId))
            || plot.geometry?.type !== 'Polygon' || !validateGeometry(plot.geometry)) invalid();
        seen.add(plot.id);
        for (const ring of plot.geometry.coordinates) vertices += ring.length;
        if (vertices > 200000) invalid();
        const geometry = { type: 'Polygon', coordinates: plot.geometry.coordinates.map(ring => ring.map(([x, y]) => [x, y])) };
        if (!touches(reach, turf.bbox(geometry)) || !(turf.area(geometry) > 0)) invalid();
        return { id: plot.id, kind: plot.kind, geometry, cadastreParcelIds: [...new Set(plot.cadastreParcelIds)].sort(),
            ...(plot.label != null ? { label: plot.label } : {}),
            ...(plot.producedByProposalId ? { producedByProposalId: plot.producedByProposalId } : {}),
            ...(plot.cessionM2 != null ? { cessionM2: plot.cessionM2 } : {}),
            ...(plot.planningArea ? { planningArea: { source: plot.planningArea.source, recordId: plot.planningArea.recordId } } : {}) };
    }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function plotReference(plot) {
    const { id, geometry, kind, cadastreParcelIds, producedByProposalId, planningArea } = plot;
    return { sourceId: 'plan', parcelId: id, revision: sourceRevision({ id, geometry }), kind, cadastreParcelIds,
        ...(producedByProposalId ? { producedByProposalId } : {}), ...(planningArea ? { planningArea } : {}) };
}
export function plotRecord(plot) {
    const parcel = turf.feature(plot.geometry, { parcelNumber: plot.label || plot.id, planPlot: true }, { id: plot.id });
    return { parcel, bbox: turf.bbox(parcel), plot };
}
export function replaceCadastre(features, plots) {
    const incoming = new Set(plots.map(plot => plot.id));
    const replaced = new Set(plots.flatMap(plot => plot.cadastreParcelIds));
    const seen = new Set();
    const remaining = features.filter(parcel => {
        if (replaced.has(parcel.id)) { seen.add(parcel.id); return false; }
        if (incoming.has(parcel.id)) invalid();
        return true;
    });
    return { remaining, summary: { received: plots.length, replacedLots: seen.size,
        unmatchedCadastreIds: [...replaced].filter(id => !seen.has(id)).sort() } };
}
export function addCorridorStreets(streets, records) {
    const lines = records.filter(({ plot }) => corridor(plot)).map(({ parcel }) =>
        turf.lineString(parcel.geometry.coordinates[0], { highway: 'plan-road', name: parcel.properties.parcelNumber, id: parcel.id }));
    if (!lines.length) return streets;
    return { ...streets, type: 'FeatureCollection', source: streets ? `${streets.source || 'streets'} + plan` : 'plan',
        features: [...(streets?.features || []), ...lines] };
}

// A layout on an explicitly identified government lot may leave a known geometric remainder.
// Without that reference the two competing parcel identities are reported on both subjects.
export function composeGovernmentLots(lots, records, source) {
    const ground = [], conflicts = new Map(), claimed = new Set();
    for (const lot of lots) {
        let remainder = lot.parcel, cut = false;
        for (const { parcel, bbox, plot } of records) {
            if (parcel.id === lot.parcel.id) invalid();
            if (!touches(bbox, lot.bbox) || keepsGovernmentLot(plot, source, lot.zone)) continue;
            try {
                const shared = turf.intersect(lot.parcel, parcel);
                if (!shared || turf.area(shared) <= 0.01) continue;
                const ref = plot.planningArea;
                if (ref?.source !== source || ref.recordId !== lot.zone || plot.kind !== 'remainder' && turf.area(parcel) - turf.area(shared) > 0.1) {
                    conflicts.set(lot.parcel.id, 'plan-plot-source-conflict');
                    conflicts.set(parcel.id, 'plan-plot-source-conflict');
                    continue;
                }
                claimed.add(parcel.id);
                if (remainder) remainder = turf.difference(remainder, parcel);
                cut = true;
            } catch (_) {
                conflicts.set(lot.parcel.id, 'plan-plot-source-conflict');
                conflicts.set(parcel.id, 'plan-plot-source-conflict');
            }
        }
        if (!cut || conflicts.has(lot.parcel.id)) { ground.push(lot); continue; }
        if (!remainder) continue;
        const polygons = remainder.geometry.type === 'MultiPolygon' ? remainder.geometry.coordinates : [remainder.geometry.coordinates];
        for (const coordinates of polygons) {
            const parcel = turf.polygon(coordinates, lot.parcel.properties);
            if (turf.area(parcel) <= 0.1) continue;
            parcel.id = `${lot.parcel.id}~${sourceRevision(parcel.geometry).slice(0, 16)}`;
            ground.push({ parcel, zone: lot.zone, bbox: turf.bbox(parcel) });
        }
    }
    return { ground, conflicts, claimed };
}
