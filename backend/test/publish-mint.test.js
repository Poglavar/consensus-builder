// Unit tests for the pure half of frontend/js/proposals/publish-mint.js: the one mint plan and NFT
// metadata every publish path uses (proposal-kinds.md M2a), so the two dialogs can no longer
// mint the same proposal differently.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mintPlan, mintMetadata, nativeAmountOf } = require('../../frontend/js/proposals/publish-mint.js');

const SITE_ARGS = { siteHash: 'ab'.repeat(32), openGround: true };
const deal = (extra = {}) => ({ kind: 'owner-deal', cadastreParcelIds: ['HR-1'], offer: 2, offerCurrency: 'SOL', isConditional: true, ...extra });
const vote = (kind = 'community-vote') => ({ kind, cadastreParcelIds: ['HR-1'], offer: null, voteExpiryDays: 30 });
const plan = (proposal, chain, extra = {}) => mintPlan({ proposal, chain, metadataUri: 'ipfs://m', lensAddresses: ['0xa'], solanaLensKeys: ['Lens1'], siteArgs: SITE_ARGS, ...extra });

describe('mintPlan', () => {
    it('escrows an owner deal in the chain\'s own currency only', () => {
        expect(plan(deal(), 'solana').options.solAmount).toBe(2);
        expect(plan(deal({ offerCurrency: 'EUR' }), 'solana').options.solAmount).toBe(0);
        expect(plan(deal({ offerCurrency: 'ETH' }), 'evm').options.ethAmount).toBe(2);
        expect(nativeAmountOf(deal({ offer: -5 }))).toBe(0);
    });

    it('mints a vote fund-less with its deadline on EVM, and never executable on Solana', () => {
        expect(plan(vote('owner-vote'), 'evm').options).toMatchObject({ isVote: true, expiryDays: 30, ethAmount: 0 });
        expect(plan(vote(), 'solana').options).toMatchObject({ solAmount: 0, verdictMayExecute: false, siteHash: SITE_ARGS.siteHash });
        expect(plan(deal(), 'evm').options.isVote).toBe(false);
    });

    it('lets a binding proposal\'s verdict clear open ground, but not an approval setup\'s', () => {
        expect(plan(deal(), 'solana').options.verdictMayExecute).toBe(true);
        expect(plan(deal(), 'solana', { approvalSetup: true }).options).toMatchObject({ verdictMayExecute: false, solAmount: 0 });
    });

    it('escrows nothing for an owner offer', () => {
        expect(plan(deal({ proposalRole: 'owner-offer' }), 'solana').options.solAmount).toBe(0);
    });

    it('gives Canton the named price, which the share dialog used to leave out', () => {
        expect(plan(deal({ offer: 900, offerCurrency: 'EUR' }), 'canton')).toEqual({ bridge: 'canton', options: { parcelIds: ['HR-1'], price: 900, imageURI: 'ipfs://m' } });
    });

    it('refuses a Solana mint without the site commitment', () => {
        expect(() => plan(deal(), 'solana', { siteArgs: null })).toThrow(/site commitment/);
    });
});

describe('mintMetadata', () => {
    const properties = record => ({ proposalProtocol: 'test', proposal: record });
    it('names the kind and leaves the offer out of a vote', () => {
        const metadata = mintMetadata({ ...vote(), title: 'Pocket park', city: 'zagreb' }, { goalLabel: 'park', backendType: 'structure', author: 'Guest 1', lensAddresses: [], properties });
        const traits = Object.fromEntries(metadata.attributes.map(a => [a.trait_type, a.value]));
        expect(traits).toMatchObject({ Goal: 'park', Kind: 'community-vote', 'Parcel Count': 1, Author: 'Guest 1', City: 'zagreb' });
        expect(traits).not.toHaveProperty('Offer');
        expect(metadata.properties.proposal).toMatchObject({ type: 'structure', author: 'Guest 1', kind: 'community-vote' });
    });

    it('keeps the offer of an owner deal', () => {
        const metadata = mintMetadata(deal({ title: 'Buy it' }), { goalLabel: 'offer', backendType: 'parcel', author: 'A', lensAddresses: ['0xa'], properties });
        expect(metadata.attributes.find(a => a.trait_type === 'Offer').value).toBe('2 SOL');
    });
});
