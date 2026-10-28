// The import boundary for published designs (frontend/js/proposals/design-sync.js localDesignFromRow):
// an index row becomes a parked local design that hashes back to the CID it is filed under, with the
// parcels the index bound as its cadastral declaration; content that is not that CID, or not a
// design/v1 object, is refused rather than healed. The list's summaries of index rows are
// server-proposal-summary.test.js.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { localDesignFromRow } = require('../../frontend/js/proposals/design-sync.js');
const DesignRecord = require('../../frontend/js/design-record.js');
const Cid = require('../../frontend/js/cid.js');

const API = 'https://api.example.test';
const SITE = { type: 'Polygon', coordinates: [[[15, 43], [15.01, 43], [15.01, 43.01], [15, 43.01], [15, 43]]] };
// The index row of a local design, as GET /designs/:cid answers it.
function rowOf(localDesign, extra = {}) {
    const content = DesignRecord.published(localDesign);
    return { cid: Cid.cidOfObject(content), city: 'zagreb', goal: content.goal, title: content.title, author: content.author,
        binding: { parcels: [] }, content, createdAt: '2026-10-21T08:00:00.000Z', ...extra };
}
const park = () => ({
    proposalId: 'p-park', goal: 'park', title: 'Pocket park', author: 'Mara', site: SITE, createdAt: '2026-10-20T09:00:00.000Z',
    applied: true, lifecycleStatus: 'Executed', structureProposal: { kind: 'park', geometry: SITE, applied: true }
});

describe('importing a published design', () => {
    it('parks it under its CID, with the index binding as its parcels and the row as its publication', () => {
        const row = rowOf(park(), { binding: { parcels: [{ parcelId: 'HR-2' }, { parcelId: 'HR-1' }, { parcelId: 'HR-2' }] } });
        const record = localDesignFromRow(row, { apiBase: `${API}/` });
        expect(record).toMatchObject({ proposalId: `design-${row.cid}`, goal: 'park', title: 'Pocket park', author: 'Mara',
            createdAt: '2026-10-20T09:00:00.000Z', cadastreParcelIds: ['HR-1', 'HR-2'],
            published: { cid: row.cid, publishedAt: row.createdAt, apiBase: API } });
        // Nothing of the publishing browser's map state travels: the copy is parked until applied here.
        expect(record).not.toHaveProperty('applied');
        expect(record).not.toHaveProperty('lifecycleStatus');
        expect(record.structureProposal).not.toHaveProperty('applied');
        expect(DesignRecord.cidOf(record)).toBe(row.cid);
    });

    it('keeps authored block membership and block-wide courtyard geometry', () => {
        const ruleMassing = {
            type: 'Feature',
            properties: {},
            geometry: {
                type: 'Polygon',
                coordinates: [
                    [[15, 43], [15.01, 43], [15.01, 43.01], [15, 43.01], [15, 43]],
                    [[15.002, 43.002], [15.008, 43.002], [15.008, 43.008], [15.002, 43.008], [15.002, 43.002]]
                ]
            }
        };
        const ineligibleParcels = [{ status: 'below-min-plot', geometry: ruleMassing.geometry, wouldBe: ruleMassing }];
        const row = rowOf({
            proposalId: 'shared-block', goal: 'buildings', title: 'Block 1', createdAt: '2026-10-20T09:00:00.000Z',
            geometry: { buildings: [ruleMassing] },
            buildingProposal: { typologyType: 'block', blockName: 'Block 1', ineligibleParcels }
        });
        const record = localDesignFromRow(row, { apiBase: API });
        expect(record.buildingProposal).toMatchObject({ typologyType: 'block', blockName: 'Block 1', ineligibleParcels });
        expect(record.geometry.buildings).toHaveLength(1);
        expect(record.geometry.buildings[0].geometry.coordinates).toHaveLength(2);
        expect(row.content.geometry.buildings[0].geometry.coordinates).toEqual(ruleMassing.geometry.coordinates);
        expect(record.geometry.buildings[0].geometry.coordinates).toEqual(ruleMassing.geometry.coordinates);
        expect(DesignRecord.cidOf(record)).toBe(row.cid);
    });

    it('refuses content that is not the design its CID names', () => {
        const row = rowOf(park());
        expect(() => localDesignFromRow({ ...row, content: { ...row.content, title: 'Renamed on the way' } }, { apiBase: API }))
            .toThrow(expect.objectContaining({ code: 'cid-mismatch' }));
    });

    it('refuses parcel declarations in the content instead of healing them during import', () => {
        const row = rowOf(park());
        for (const extra of [{ parentParcelIds: ['HR-1#c-old-1'] }, { cadastreParcelIds: ['HR-1'] }]) {
            const content = { ...row.content, ...extra };
            expect(() => localDesignFromRow({ ...row, cid: Cid.cidOfObject(content), content }, { apiBase: API }))
                .toThrow(expect.objectContaining({ code: 'invalid-design' }));
        }
        expect(() => localDesignFromRow({ ...row, content: null }, { apiBase: API })).toThrow(expect.objectContaining({ code: 'invalid-design' }));
    });

    it('needs the index it was read from', () => {
        expect(() => localDesignFromRow(rowOf(park()), {})).toThrow(/API base/);
    });
});
