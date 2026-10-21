// The Proposals tab for a set of parcels (frontend/js/parcels/parcel-set-proposals.js): a multi-parcel
// selection or a drawn site lists each proposal once with the parcels of the set it covers.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SetProposals = require('../../frontend/js/parcels/parcel-set-proposals.js');

const proposals = {
    road: { proposalId: 'p-road', title: 'Road <b>' },
    park: { proposalId: 'p-park', title: 'Park' },
    block: { proposalId: 'p-block', title: 'Block' }
};
const byParcel = { a: [proposals.park, proposals.road], b: [proposals.road], c: [proposals.road, proposals.block] };
const forParcel = id => byParcel[id] || [];
const PARK_CID = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';
const NEW_CID = 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq';
const describe_ = proposal => ({ title: proposal.title, typeLabel: 'Type', statusText: 'Draft', statusClass: 'draft', thumbHtml: '' });

describe('proposals on a set of parcels', () => {
    it('lists each proposal once with every parcel it covers, widest first, ties in the order met', () => {
        const entries = SetProposals.collect(['a', 'b', 'c', 'a'], forParcel, proposal => proposal.proposalId);
        expect(entries.map(entry => [entry.key, entry.parcelIds])).toEqual([
            ['p-road', ['a', 'b', 'c']],
            ['p-park', ['a']],
            ['p-block', ['c']]
        ]);
    });

    it('skips proposals without an identity', () => {
        expect(SetProposals.collect(['a'], () => [{ title: 'x' }], proposal => proposal.proposalId)).toEqual([]);
    });

    it('renders a total, rows that open their proposal, coverage only for several parcels, escaped text', () => {
        const entries = SetProposals.collect(['a', 'b', 'c'], forParcel, proposal => proposal.proposalId);
        const html = SetProposals.listHtml(entries, { parcelCount: 3, describe: describe_ });
        expect(html).toContain('3 proposals on these parcels');
        expect(html).toContain('data-parcel-set-proposal="p-road" data-parcel-id="a"');
        expect(html).toContain('On 3 of 3 parcels');
        expect(html).toContain('Road &lt;b&gt;');
        const single = SetProposals.listHtml(SetProposals.collect(['a'], forParcel, p => p.proposalId), { parcelCount: 1, describe: describe_ });
        expect(single).not.toContain(' of 1 parcels');
    });

    it('adds published designs this browser does not hold, by the cadastral parcels the index bound them to', () => {
        const local = { a: [proposals.park] };
        // Index summaries (DesignSync.designSummary) are named by their CID.
        const held = { proposalId: PARK_CID, cid: PARK_CID, cadastreParcelIds: ['HR-a'] };
        const fresh = { proposalId: NEW_CID, cid: NEW_CID, cadastreParcelIds: ['HR-b', 'HR-c'] };
        const cadastral = { a: ['HR-a'], b: ['HR-b'], c: ['HR-c'], ground: [] };
        const merged = SetProposals.withPublished(id => local[id] || [], [held, fresh], id => cadastral[id], s => s.cid === PARK_CID);
        expect([...merged.publishedOnly]).toEqual([fresh]);
        expect(merged.proposalsForParcel('a')).toEqual([proposals.park]);
        expect(merged.proposalsForParcel('b')).toEqual([fresh]);
        expect(merged.proposalsForParcel('ground')).toEqual([]);
        const entries = SetProposals.collect(['a', 'b', 'c'], merged.proposalsForParcel, p => p.proposalId);
        expect(entries.map(entry => [entry.key, entry.parcelIds])).toEqual([[NEW_CID, ['b', 'c']], ['p-park', ['a']]]);
    });

    it('marks published-only rows with the CID to import them from, and shows the lookup state', () => {
        const entry = { key: NEW_CID, proposal: { title: 'New' }, parcelIds: ['b'], serverId: NEW_CID };
        const html = SetProposals.listHtml([entry], { parcelCount: 2, describe: describe_, published: { loading: true } });
        expect(html).toContain(`data-server-id="${NEW_CID}"`);
        expect(html).toContain('Checking published proposals…');
        expect(SetProposals.listHtml([], { parcelCount: 2, describe: describe_, emptyText: false, published: { error: 'HTTP 500' } }))
            .toBe('<p class="parcel-set-proposals-status">Published proposals could not be loaded: HTTP 500</p>');
    });

    it('says so when nothing stands on the parcels', () => {
        expect(SetProposals.listHtml([], { parcelCount: 2, describe: describe_ })).toContain('No proposals on these parcels yet.');
        expect(SetProposals.listHtml([], { parcelCount: 2, describe: describe_, emptyText: 'Nothing here' })).toContain('Nothing here');
    });

    it('has its strings in en, es, hr and sr, with the plural forms each language needs', () => {
        for (const lang of ['en', 'es', 'hr', 'sr']) {
            const i18n = require(`../../frontend/i18n/${lang}.json`);
            const set = i18n.panel.parcel.setProposals;
            expect(typeof set.empty).toBe('string');
            expect(Object.keys(set.summary)).toContain('other');
            expect(Object.keys(set.covers)).toContain('other');
            if (lang === 'hr' || lang === 'sr') expect(Object.keys(set.summary)).toEqual(['one', 'few', 'other']);
            expect(typeof i18n.panel.parcel.tabPropose).toBe('string');
            expect(typeof i18n.panel.parcel.historySection).toBe('string');
            expect(Object.keys(i18n.siteTool.proposals).sort()).toEqual(['existing', 'none', 'show']);
        }
    });
});
