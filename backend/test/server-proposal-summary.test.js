// Unit test for designSummary (frontend/js/proposals/design-sync.js): the mapper that turns a row of
// the designs index (GET /designs) into the object the proposal list's Server tab renders.
//
// Its predecessor silently dropped `screenshotUrl`, so every row in the list's Server tab fell back
// to the goal emoji even though the server had rendered a thumbnail for nearly all of them. The field
// is only ever read by buildProposalThumbHtml, so nothing else noticed.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { designSummary } = require('../../frontend/js/proposals/design-sync.js');
const Cid = require('../../frontend/js/cid.js');

const CID = Cid.cidOfObject({ schema: 'design/v1', title: 'Road 1407-0247' });

describe('designSummary', () => {
    // The shape GET /designs returns (backend/routes/designs.js serializeDesignSummaryRow): the
    // design row without its content.
    const indexRow = {
        cid: CID,
        city: 'zagreb',
        goal: 'road-track',
        title: 'Road 1407-0247',
        author: 'Guest 9888',
        originCid: null,
        binding: { coverage: 'complete', parcels: [{ parcelId: 'HR-335789-1204' }, { parcelId: 'HR-335789-1199' }] },
        screenshotUrl: 'https://api.urbangametheory.xyz/uploads/images/design-thumb-1784065207119.png',
        screenshotBeforeUrl: null,
        screenshotPairUrl: null,
        createdAt: '2026-07-14T00:47:49.263Z'
    };

    it('carries the server-rendered thumbnail url through to the list item', () => {
        expect(designSummary(indexRow).screenshotUrl).toBe(indexRow.screenshotUrl);
    });

    it('leaves screenshotUrl null when the server has no thumbnail for the design', () => {
        const { screenshotUrl, ...withoutThumb } = indexRow;
        expect(designSummary(withoutThumb).screenshotUrl).toBeNull();
    });

    it('maps the identifying fields the list keys off, and the parcels the index bound', () => {
        expect(designSummary(indexRow)).toMatchObject({
            id: CID, cid: CID, proposalId: CID, indexed: true, city: 'zagreb', goal: 'road-track',
            title: 'Road 1407-0247', name: 'Road 1407-0247', author: 'Guest 9888',
            createdAt: indexRow.createdAt, cadastreParcelIds: ['HR-335789-1199', 'HR-335789-1204']
        });
    });

    it('carries no lifecycle, minted state or consent tally: a design has none', () => {
        const summary = designSummary({ ...indexRow, lifecycleStatus: 'Cancelled', status: 'Active', applied: true, isMinted: true, acceptedParcelIds: ['HR-335789-1199'] });
        expect(summary).not.toHaveProperty('lifecycleStatus');
        expect(summary).not.toHaveProperty('status');
        expect(summary).not.toHaveProperty('applied');
        // Designs are not minted (M3) and owners decide on agreements, not on designs (M2).
        expect(summary).not.toHaveProperty('isMinted');
        expect(summary).not.toHaveProperty('acceptedParcelIds');
    });

    it('does not infer a goal from a backend type, and lists nothing that is not filed under a CID', () => {
        expect(designSummary({ ...indexRow, goal: undefined, type: 'road' }).goal).toBeNull();
        expect(designSummary({ ...indexRow, cid: '62' })).toBeNull();
        expect(designSummary(null)).toBeNull();
    });
});
