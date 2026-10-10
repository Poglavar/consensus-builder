// The read-only publication-city audit (scripts/audit-publication-cities.mjs, projections.md §10 M9)
// places each stored record by the rule new publications follow and names the ones filed elsewhere.
import { describe, it, expect } from 'vitest';
import { placeRecord, buildReport } from '../scripts/audit-publication-cities.mjs';

const square = (lat, lon, d = 0.0003) => JSON.stringify({ type: 'Polygon', coordinates: [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]] });
const row = (city, site, extra = {}) => ({ id: 1, proposal_id: 'p1', city, created_at: new Date('2026-09-14T10:00:00Z'), site_geojson: site, proposal_data: { goal: 'buildings' }, ...extra });

describe('placing stored records', () => {
    it('sorts them into same, moved, refused, no-city and no-geometry', () => {
        expect(placeRecord(row('zagreb', square(45.8131, 15.9775)))).toMatchObject({ status: 'same', placed: 'zagreb', month: '2026-09' });
        expect(placeRecord(row('zagreb', square(43.5081, 16.4402)))).toMatchObject({ status: 'moved', placed: 'split' });
        expect(placeRecord(row('new_york', square(45.8131, 15.9775)))).toMatchObject({ status: 'refused', placed: 'zagreb' });
        expect(placeRecord(row('explore', square(40.758, -73.9855)))).toMatchObject({ status: 'refused', placed: 'new_york' });
        expect(placeRecord(row('city', square(45.8131, 15.9775)))).toMatchObject({ status: 'no-city', placed: 'zagreb' });
        expect(placeRecord(row(null, null, { proposal_data: { goal: 'ownership-transfer', cadastreParcelIds: ['HR-1-1'] } }))).toMatchObject({ status: 'no-geometry' });
    });

    it('reports the refused ones by name', () => {
        const report = buildReport([placeRecord(row('new_york', square(45.8131, 15.9775)))], { label: 'test', generatedAt: 'now' });
        expect(report).toMatch(/\| refused \| 1 \|/);
        expect(report).toMatch(/new_york → zagreb: 1/);
    });
});
