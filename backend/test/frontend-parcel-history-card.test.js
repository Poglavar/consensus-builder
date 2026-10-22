// Unit tests for the pure builders of frontend/js/proposals/parcel-history-card.js (the parcel panel's
// History section: agreements proposed over the parcel, lens ownership attestations and executed
// agreements): URL encoding, link safety, untimed events, event text, timeline and section HTML and
// i18n key coverage.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const card = require('../../frontend/js/proposals/parcel-history-card.js');

const CID = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
const LENS = 'Cp886ML2Ja4FF3SMmyUeW16rRGsLrBcRW8kfWS1VfN7W';
const MEMBER = 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ';
// The card's short form of a long key: its two ends.
const short = value => `${value.slice(0, 4)}…${value.slice(-4)}`;

// GET /parcels/:parcelUid/history (backend/oracle/parcel-history.js), plus an event type the card
// does not know, untimed and with a link it must not render.
const history = {
    parcelUid: 'HR-335347-1208/3',
    anchor: { account: 'AnchorPda1111111111111111111111111111111111', exists: true, source: 'chain' },
    events: [
        { type: 'agreement_published', at: '2026-10-21T10:00:00.000Z', agreementCid: CID, title: 'Corner <b>', link: `/agreements/${CID}` },
        { type: 'parcel_ownership', at: '2026-10-21T12:00:00.000Z', member: MEMBER, owner: 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB', ownerCount: 2, hash: 'sha256:' + 'ab'.repeat(32), link: 'https://explorer.solana.com/address/x?cluster=devnet' },
        { type: 'agreement_executed', at: '2026-10-22T08:00:00.000Z', outcome: 'executed', agreementCid: CID, account: 'Ekpt4qMsJWyyraDfPfq2zkT1JwMsJCKrSmkoNGgHreFR', lens: LENS, hash: 'sha256:' + 'cd'.repeat(32), link: 'https://explorer.solana.com/tx/sig?cluster=devnet' },
        { type: 'parcel_survey', at: null, link: 'javascript:alert(1)' }
    ]
};

describe('parcel history card builders', () => {
    it('encodes the parcel id into the history URL', () => {
        expect(card.historyUrl('https://api.example/', 'HR-335347-1208/3')).toBe('https://api.example/parcels/HR-335347-1208%2F3/history');
    });

    it('keeps http links, resolves API paths against the base and drops other schemes', () => {
        expect(card.resolveLink('https://explorer.solana.com/tx/a', 'https://api')).toBe('https://explorer.solana.com/tx/a');
        expect(card.resolveLink(`/agreements/${CID}`, 'https://api/')).toBe(`https://api/agreements/${CID}`);
        expect(card.resolveLink('javascript:alert(1)', 'https://api')).toBeNull();
        expect(card.resolveLink('//evil.example/x', 'https://api')).toBeNull();
    });

    it('never shows a guessed time for an untimed event', () => {
        expect(card.formatAt(null)).toBeNull();
        expect(card.formatAt('2026-09-21T09:00:00.000Z')).toBe('2026-09-21 09:00 UTC');
        const html = card.buildTimelineHtml(history, { base: 'https://api' });
        expect(html).toContain('time unknown');
        expect(html).not.toContain('datetime="null"');
    });

    it('names an agreement by its short CID and an executed one by the lens key that attested it', () => {
        expect(card.describeEvent({ type: 'agreement_published', agreementCid: CID, title: 'Corner' }))
            .toEqual({ title: 'Agreement proposed', details: ['Corner', `Agreement ${short(CID)}`] });
        expect(card.describeEvent({ type: 'agreement_executed', agreementCid: CID, lens: LENS }))
            .toEqual({ title: 'Agreement executed', details: [`Agreement ${short(CID)}`, `Lens: ${short(LENS)}`] });
        // The lens comes as one key or a list of keys; an empty one is no lens.
        expect(card.describeEvent({ type: 'agreement_executed', lens: [MEMBER, LENS] }).details).toEqual([`Lens: ${short(MEMBER)}, ${short(LENS)}`]);
        expect(card.describeEvent({ type: 'agreement_executed', lens: '' }).details).toEqual([]);
        expect(card.describeEvent({ type: 'parcel_ownership', member: MEMBER, ownerCount: 0 }))
            .toEqual({ title: 'Ownership attested', details: [`Member ${short(MEMBER)}`, '0 attested owner(s)'] });
        expect(card.describeEvent({})).toEqual({ title: 'Event', details: [] });
    });

    it('renders every event in order with escaped text, explorer links and short keys', () => {
        const html = card.buildTimelineHtml(history, { base: 'https://api' });
        const types = [...html.matchAll(/data-history-type="([^"]+)"/g)].map(m => m[1]);
        expect(types).toEqual(['agreement_published', 'parcel_ownership', 'agreement_executed', 'parcel_survey']);
        expect(html).toContain('<strong>Agreement proposed</strong>');
        expect(html).toContain('<strong>Ownership attested</strong>');
        expect(html).toContain('<strong>Agreement executed</strong>');
        // A type the card does not know is shown by its name.
        expect(html).toContain('<strong>parcel_survey</strong>');
        expect(html).toContain('Corner &lt;b&gt;');
        expect(html).not.toContain('<b>');
        expect(html.match(new RegExp(`Agreement ${short(CID)}`, 'g'))).toHaveLength(2);
        expect(html).toContain(`href="https://api/agreements/${CID}"`);
        expect(html).toContain('href="https://explorer.solana.com/tx/sig?cluster=devnet"');
        expect(html).not.toContain('javascript:');
        expect(html).toContain(`Member ${short(MEMBER)}`);
        expect(html).toContain('2 attested owner(s)');
        expect(html).toContain(`Lens: ${short(LENS)}`);
        expect(html).toContain(`title="sha256:${'cd'.repeat(32)}"`);
        expect(html).toContain('Parcel anchor observed on Solana devnet');
    });

    it('describes an empty history and a missing anchor', () => {
        const html = card.buildTimelineHtml({ parcelUid: 'x', anchor: { account: 'Pda1', exists: false, source: 'chain' }, events: [] });
        expect(html).toContain('No parcel anchor found on Solana devnet');
        expect(html).toContain('Nothing recorded for this parcel yet.');
    });

    it('keeps unavailable evidence distinct from absence and never renders an inferred mint time', () => {
        for (const anchor of [null, { account: 'Pda1', exists: null, source: 'unavailable' },
            { account: 'Pda1', exists: false, source: 'unavailable' },
            { account: 'Pda1', exists: true, source: 'transaction-store', mintedAt: '2026-09-16T10:04:00Z' }]) {
            expect(card.buildAnchorHtml(anchor)).toContain('Parcel anchor status unavailable');
            expect(card.buildAnchorHtml(anchor)).not.toContain('No parcel anchor found');
        }
        expect(card.buildAnchorHtml({ ...history.anchor, mintedAt: '2026-09-16T10:04:00Z' })).not.toContain('since');
        expect(card.buildAnchorHtml({ account: null, exists: false, source: 'unseedable' })).toContain('too long');
        expect(card.normalizeHistory({}).anchor.exists).toBeNull();
    });

    it('builds the parcel panel section collapsed, one History per parcel, named History for one parcel and by id for several', () => {
        const rows = html => html.match(/<details class="parcel-history-parcel parcel-history-section"/g) || [];
        const one = card.buildSectionHtml(['HR-1']);
        expect(rows(one)).toHaveLength(1);
        expect(one).toContain('data-parcel-history="HR-1"');
        expect(one).toContain('>History<');
        expect(one).not.toMatch(/<details[^>]*\bopen\b/);
        expect(one).toContain('title="Every agreement proposed over the parcel, ownership attestation and executed agreement, oldest first, at the time its source states."');
        const several = card.buildSectionHtml(['HR-1', 'HR-<2>']);
        expect(rows(several)).toHaveLength(2);
        expect(several).toContain('History: HR-1');
        expect(several).toContain('History: HR-&lt;2&gt;');
        expect(several).toContain('data-parcel-history="HR-&lt;2&gt;"');
    });

    it('keeps a long parcel id whole and escaped in its row\'s label and data attribute', () => {
        const parcelUid = 'KE-NAIROBI-NM-g1~368402797~-12643572~hash#chain_0123456789abcdef-2&x';
        const html = card.buildSectionHtml([parcelUid, 'HR-1']);
        expect(html).toContain('<span class="parcel-id-text">History: KE-NAIROBI-NM-g1~368402797~-12643572~hash#chain_0123456789abcdef-2&amp;x</span>');
        expect(html).toContain('data-parcel-history="KE-NAIROBI-NM-g1~368402797~-12643572~hash#chain_0123456789abcdef-2&amp;x"');
    });

    it('has every UI string in en, hr, es and sr', () => {
        const keysOf = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) => (typeof v === 'object' ? keysOf(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
        const en = keysOf(require('../../frontend/i18n/en.json').panel.proposal.parcelHistory).sort();
        for (const lang of ['hr', 'es', 'sr']) {
            expect(keysOf(require(`../../frontend/i18n/${lang}.json`).panel.proposal.parcelHistory).sort()).toEqual(en);
        }
        const source = require('node:fs').readFileSync(require.resolve('../../frontend/js/proposals/parcel-history-card.js'), 'utf8');
        for (const [, key] of source.matchAll(/'panel\.proposal\.parcelHistory\.([\w.]+)'/g)) {
            expect(en).toContain(key);
        }
    });
});
