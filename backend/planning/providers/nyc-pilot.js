// Read the existing, bounded NYC audit as evidence. It contains no accepted massing.
import { getSavedPilotRecords } from '../../zoning/pilot.js';
import { fetchPluto } from '../../zoning/pluto.js';
import { computeEnvelope } from '../../zoning/envelope.js';
import * as turf from '@turf/turf';
import { withSourceProposal, sourceRevision } from '../source-proposal.js';

export const nycPilotSource = Object.freeze({
    id: 'nyc-r6a-pilot-2026-10-19', city: 'new_york', label: 'NYC R6A · 2026-10-19',
    edition: '2026-10-19', default: true, kind: 'regulation', coverage: 'pilot-records',
    url: 'https://zoningresolution.planning.nyc.gov/', storage: 'zoning/pilot/2026-10-19',
    capabilities: { volumes: false, parcelEvidence: true, constraintEvaluation: false },
    scenario: 'new-attached-multifamily'
});

export function pilotRecord(record) {
    const parcel = `US-NY-${record.bbl}`;
    return withSourceProposal({
        id: `${nycPilotSource.id}:${record.bbl}`, role: 'permitted', proposalId: null,
        title: record.address, site: null, volumes: [],
        spatialReference: { horizontal: 'OGC:CRS84', vertical: 'relative-ground', unit: 'm' },
        source: { ...nycPilotSource, recordId: record.bbl, parcel, version: sourceRevision(record),
            fetchedAt: record.fetchedAt, url: record.zolaUrl },
        authority: { effect: 'obligatory', basis: 'public-screen', applicability: 'unresolved' },
        assessment: { meaning: 'public-screen', status: record.publicScreen,
            reason: record.flags?.length ? record.flags.join('\n') : null,
            geometry: 'not-available', constraints: 'not-evaluated', current: true },
        metrics: { floorAreaM2: null, heightM: null }, constraints: [],
        sourceEvidence: { publicScreen: record.publicScreen, flags: record.flags,
            snapshotHash: record.snapshotHash, inputFingerprint: record.inputFingerprint, pluto: record.pluto }
    });
}

export async function readNycPilotParcel(_pool, { parcel }) {
    const bbl = parcel.replace(/^(US-NY-|US-NYC-BBL-)/, '');
    return getSavedPilotRecords().filter(record => record.bbl === bbl).map(pilotRecord);
}

export async function queryNycPilot(_pool, { bbox }) {
    const records = getSavedPilotRecords().filter(({ pluto }) => pluto.longitude >= bbox[0]
        && pluto.latitude >= bbox[1] && pluto.longitude <= bbox[2] && pluto.latitude <= bbox[3]);
    const statuses = {};
    for (const record of records) statuses[record.publicScreen] = (statuses[record.publicScreen] || 0) + 1;
    return { items: [], nextAfter: null, omitted: 0, summary: {
        sourceId: nycPilotSource.id, cachedResults: records.length, withGeometry: 0,
        withoutGeometry: records.length, statuses
    } };
}

// Evaluate a user plot against the PLUTO rows that supply its zoning identity.
export async function evaluatePlot(_pool, { plot, frontage, standing }, options = {}) {
    const ids = plot.cadastreParcelIds;
    const rows = [];
    for (let i = 0; i < ids.length; i += 6) rows.push(...await Promise.all(ids.slice(i, i + 6).map(id => fetchPluto(id, options))));
    if (!rows.length || rows.some(row => !row?.zonedist1)) return { reason: 'plot-without-lot-record' };
    const districts = [...new Set(rows.flatMap(row => [row.zonedist1, row.zonedist2, row.zonedist3, row.zonedist4].filter(Boolean)))];
    if (districts.length > 1) return { reason: 'plot-spans-districts', evidence: { districts } };
    const ring = plot.geometry.coordinates[0], edge = frontage?.frontEdge;
    if (!Number.isInteger(edge) || !ring[edge + 1]) return { reason: 'needs-review', evidence: { code: 'frontage-unresolved' } };
    const layout = standing?.();
    const [x, y] = ring[edge], cos = Math.cos(y * Math.PI / 180), ftPerDegree = 6371008.8 * Math.PI / 180 / 0.3048;
    const local = ([lng, lat]) => [(lng - x) * ftPerDegree * cos, (lat - y) * ftPerDegree];
    const [dx, dy] = local(ring[edge + 1]), lotFront = Math.hypot(dx, dy);
    if (lotFront <= 0) return { reason: 'needs-review', evidence: { code: 'frontage-unresolved' } };
    let minDepth = 0, maxDepth = 0;
    for (const point of ring) {
        const [px, py] = local(point), depth = (dx * py - dy * px) / lotFront;
        minDepth = Math.min(minDepth, depth);
        maxDepth = Math.max(maxDepth, depth);
    }
    const corners = turf.cleanCoords(turf.feature(plot.geometry)).geometry.coordinates[0].slice(0, -1).map(local);
    const regular = plot.geometry.coordinates.length === 1 && corners.length === 4 && corners.every(([cx, cy], i) => {
        const a = corners[(i + 3) % 4], b = corners[(i + 1) % 4];
        const u = [a[0] - cx, a[1] - cy], v = [b[0] - cx, b[1] - cy];
        const cosine = (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(...u) * Math.hypot(...v));
        return Math.abs(cosine) < Math.sin(3 * Math.PI / 180);
    });
    const pluto = { ...rows[0], lotArea: turf.area(plot.geometry) / 0.09290304, lotFront,
        lotDepth: maxDepth - minDepth, lotType: layout?.corner ? '3' : layout?.openEdges?.length === 1 ? '5' : null,
        irregularLot: !regular, version: 'plan-plot:' + sourceRevision({ id: plot.id, geometry: plot.geometry }) };
    const envelope = computeEnvelope(pluto);
    return { reason: envelope.status, evidence: { screening: envelope.screening, review: envelope.review, pluto, bbls: rows.map(row => row.bbl) } };
}
