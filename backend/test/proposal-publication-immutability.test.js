// Verify that publication (a design's CID, proposals/design-sync.js) or a mint record makes a design
// immutable (proposals/chain.js isProposalImmutable), which decides whether a road may reshape it and
// whether its local author may still be restamped.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const displayState = require('../../frontend/js/proposals/display-state.js');
const Cid = require('../../frontend/js/cid.js');
const source = readFileSync(new URL('../../frontend/js/proposals/chain.js', import.meta.url), 'utf8');
const start = source.indexOf('function isProposalMinted(');
const end = source.indexOf('\nfunction buildChainProposalId(', start);
const load = new Function('window', `${source.slice(start, end)}\nreturn isProposalImmutable;`);

const CID = Cid.cidOfObject({ schema: 'design/v1', title: 'Published park' });

describe('design immutability', () => {
    const isImmutable = load({ __proposalDisplayState: displayState, Cid });

    it('leaves a design that never left the device mutable', () => {
        expect(isImmutable(null)).toBe(false);
        expect(isImmutable({ proposalId: 'draft' })).toBe(false);
        expect(isImmutable({ published: { cid: 'not-a-cid', apiBase: 'https://api.example.test' } })).toBe(false);
        // A server row number is no publication.
        expect(isImmutable({ serverProposalId: '42', publicationApiBase: 'https://api.example.test' })).toBe(false);
    });

    it('treats a design published under its CID as immutable, whichever index it went to', () => {
        expect(isImmutable({ published: { cid: CID, publishedAt: null, apiBase: 'https://api.example.test' } })).toBe(true);
        expect(isImmutable({ published: { cid: CID, publishedAt: null, apiBase: 'https://other.example.test' } })).toBe(true);
    });

    it('keeps minted records immutable independently of publication', () => {
        expect(isImmutable({ isMinted: true })).toBe(true);
        expect(isImmutable({ onchain: { transactionHash: '0xabc' } })).toBe(true);
    });
});
