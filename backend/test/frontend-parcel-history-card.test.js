// Unit tests for the pure builders of frontend/js/proposals/parcel-history-card.js (Details "Parcel
// history"): URL encoding, link safety, untimed events, timeline HTML and i18n key coverage.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const card = require('../../frontend/js/proposals/parcel-history-card.js');

const history = {
    parcelUid: 'HR-335347-1208/3',
    anchor: { account: 'AnchorPda1111111111111111111111111111111111', exists: true, mintedAt: '2026-09-16T10:04:00.000Z' },
    events: [
        { type: 'proposal_created', at: '2026-09-16T10:00:00.000Z', proposalId: 'p-1', title: 'Corner <b>', link: '/proposals/p-1' },
        { type: 'parcel_ownership', at: '2026-09-20T08:00:00.000Z', member: 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ', owner: 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB', ownerCount: 2, hash: 'sha256:' + 'ab'.repeat(32), link: 'https://explorer.solana.com/address/x?cluster=devnet' },
        { type: 'proposal_lifecycle', at: null, outcome: 'executed', link: 'javascript:alert(1)' }
    ]
};

describe('parcel history card builders', () => {
    it('encodes the parcel id into the history URL', () => {
        expect(card.historyUrl('https://api.example/', 'HR-335347-1208/3')).toBe('https://api.example/parcels/HR-335347-1208%2F3/history');
    });

    it('keeps http links, resolves API paths against the base and drops other schemes', () => {
        expect(card.resolveLink('https://explorer.solana.com/tx/a', 'https://api')).toBe('https://explorer.solana.com/tx/a');
        expect(card.resolveLink('/proposals/p-1', 'https://api/')).toBe('https://api/proposals/p-1');
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

    it('renders every event in order with escaped text, explorer links and short keys', () => {
        const html = card.buildTimelineHtml(history, { base: 'https://api' });
        const types = [...html.matchAll(/data-history-type="([^"]+)"/g)].map(m => m[1]);
        expect(types).toEqual(['proposal_created', 'parcel_ownership', 'proposal_lifecycle']);
        expect(html).toContain('Corner &lt;b&gt;');
        expect(html).not.toContain('<b>');
        expect(html).toContain('href="https://api/proposals/p-1"');
        expect(html).not.toContain('javascript:');
        expect(html).toContain('Member AMbs…koQ'.replace('koQ', 'mkoQ'));
        expect(html).toContain('2 attested owner(s)');
        expect(html).toContain('Anchored on chain since 2026-09-16 10:04 UTC');
    });

    it('describes an empty history and a missing anchor', () => {
        const html = card.buildTimelineHtml({ parcelUid: 'x', anchor: { account: 'Pda1', exists: false }, events: [] });
        expect(html).toContain('Not anchored on chain yet');
        expect(html).toContain('Nothing recorded for this parcel yet.');
    });

    it('builds one collapsible History per parcel', () => {
        const html = card.buildCardHtml(['HR-1', 'HR-2']);
        expect(html.match(/<details class="parcel-history-parcel"/g)).toHaveLength(2);
        expect(html).toContain('data-parcel-history="HR-2"');
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
