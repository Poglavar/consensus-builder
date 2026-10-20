// Verify qualified publication identity controls immutable editing and local author handling.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const origin = require('../../frontend/js/proposals/origin.js');
const source = readFileSync(new URL('../../frontend/js/proposals/chain.js', import.meta.url), 'utf8');
const start = source.indexOf('function isProposalMinted(');
const end = source.indexOf('\nfunction buildChainProposalId(', start);
const load = new Function('window', 'ProposalOrigin', `${source.slice(start, end)}\nreturn isProposalImmutable;`);

describe('server publication immutability', () => {
    const isImmutable = load({ __proposalDisplayState: { hasMintRecord: proposal => proposal?.isMinted === true } }, origin);

    it('requires both a positive server row and an explicit valid publication API', () => {
        expect(isImmutable({ serverProposalId: '42' })).toBe(false);
        expect(isImmutable({ serverProposalId: '0', publicationApiBase: 'https://api.example.test' })).toBe(false);
        expect(isImmutable({ serverProposalId: '42', publicationApiBase: 'not-a-url' })).toBe(false);
    });

    it('treats a qualified publication from any API as immutable', () => {
        expect(isImmutable({ serverProposalId: '42', publicationApiBase: 'https://other.example.test' })).toBe(true);
    });

    it('keeps minted records immutable independently of publication identity', () => {
        expect(isImmutable({ isMinted: true })).toBe(true);
    });
});
