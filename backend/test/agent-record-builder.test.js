// Unit tests for backend/agents/record-builder.js — the POST body an agent sends to /agent/proposals.
// Two things this must never get wrong: it must not name an `author` (the paid route binds that to
// the wallet the facilitator verified, and a mismatching one is refused before any USDC moves), and
// when it carries a mint it must carry it in the fields the frontend actually reads, which is
// chain.js isProposalMinted / getProposalNftInfo — asserted here against those functions themselves.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { buildProposalRecord } from '../agents/record-builder.js';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');

const CANDIDATE = {
    candidateId: 'densifier-01:HR-335614-2178',
    parcelId: 'HR-335614-2178',
    koName: 'RUDEŠ',
    areaM2: 422.09,
    centroid: { lng: 15.9343, lat: 45.7971 },
    geometry: { type: 'Polygon', coordinates: [[[15.934, 45.797], [15.935, 45.797], [15.935, 45.798], [15.934, 45.798], [15.934, 45.797]]] },
    buildingCount: 2,
    builtGfaM2: 295.3,
    rule: { maxFloors: 4, minSetbackM: 3, source: 'urban-rule' },
    allowedFloors: 4,
    envelope: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] } },
    massing: {
        type: 'Feature',
        properties: { floors: 3, height: 9, massing: false },
        geometry: { type: 'Polygon', coordinates: [[[15.9341, 45.7971], [15.9349, 45.7971], [15.9349, 45.7979], [15.9341, 45.7979], [15.9341, 45.7971]]] }
    },
    proposedGfaM2: 900,
    gainEur: 2418800,
    offerEur: 725640,
    score: 0.71,
    scoreParts: { density: 0.67, valueUplift: 1, openSpace: 0.75, heritage: 0 },
    normalizedRule: { typology: 'parcelBased', kind: 'max', minDistance: 3, maxFloors: 4, minFloors: 0, minFootprintAreaM2: 0, floorHeightM: 3, minPlotAreaM2: 0 }
};

const PICK = {
    proposalId: 'agent-2026-09-17-densifier-01-1',
    name: 'Four storeys on Rudeš 2178',
    rationale: 'This lot carries two small outbuildings and the plan permits four storeys. Building to the permitted envelope adds roughly 600 m² of floor area, and the offer is a third of the value that creates.'
};

const PERSONA = { name: 'densifier-01', wallet: 'G4R6RCCcQHN9fLoExvTBBfhbw8BgvTEqhJezG3A1HvEg' };
const RUN_ID = '2026-09-17T02:00Z-densifier-01';

function build(extra = {}) {
    return buildProposalRecord({ candidate: CANDIDATE, pick: PICK, persona: PERSONA, runId: RUN_ID, city: 'zagreb', turf, ...extra });
}

describe('buildProposalRecord — the stored shape', () => {
    const record = build();

    it('declares a single freeform building, the way the app stores one', () => {
        expect(record.type).toBe('building');
        expect(record.goal).toBe('single');
        expect(record.typologyType).toBe('single');
        expect(record.primaryType).toBe('Urban Rule');
        expect(record.facets).toEqual({ landUse: 'single', parcels: 'as-is', ownership: 'to-me' });
        expect(record.isConditional).toBe(true);
        expect(record.disbursementMode).toBe('conditional');
        expect(record.city).toBe('zagreb');
    });

    it('takes its id, name and text from the pick', () => {
        expect(record.proposalId).toBe(PICK.proposalId);
        expect(record.name).toBe(PICK.name);
        expect(record.title).toBe(PICK.name);
        expect(record.description).toBe(PICK.rationale);
    });

    it('omits author entirely — the paid route binds it to the verified payer', () => {
        expect('author' in record).toBe(false);
    });

    it('carries the agent stamp the record keeps: persona, rationale, run id', () => {
        expect(record.agent).toEqual({ persona: 'densifier-01', rationale: PICK.rationale, run_id: RUN_ID });
        // wallet and paid are written by the server from the settlement, never by the agent.
        expect(record.agent.wallet).toBeUndefined();
        expect(record.agent.paid).toBeUndefined();
    });

    it('records the selected controller when the runner supplies one', () => {
        expect(build({ persona: { ...PERSONA, controller: 'algorithm' } }).agent.controller).toBe('algorithm');
    });

    it('declares its land once, and its offer in USDC', () => {
        expect(record.cadastreParcelIds).toEqual(['HR-335614-2178']);
        expect(record.offer).toBe(725640);
        expect(record.offerCurrency).toBe('EUR');
    });

    it('builds the building feature the 3D and 2D views read', () => {
        expect(record.geometry.buildings).toHaveLength(1);
        const [building] = record.geometry.buildings;
        expect(building.type).toBe('Feature');
        expect(building.geometry).toEqual(CANDIDATE.massing.geometry);
        expect(building.properties).toEqual({
            type: 'proposedBuildingSingle',
            block: 'Parcel HR-335614-2178',
            height: 9,
            floors: 3,
            title: PICK.name,
            author: 'densifier-01',
            rotation: 0
        });
    });

    it('mirrors the height and floors into buildingProposal, with the rule it was derived from', () => {
        expect(record.buildingProposal.blockName).toBe('Parcel HR-335614-2178');
        expect(record.buildingProposal.typologyType).toBe('single');
        expect(record.buildingProposal.parameters).toEqual({
            height: 9,
            floors: 3,
            rotation: 0,
            typology: 'single',
            rule: CANDIDATE.normalizedRule
        });
    });

    it('computes bounds as turf.bbox of the massing', () => {
        expect(record.bounds).toEqual(turf.bbox(CANDIDATE.massing));
        expect(record.bounds).toHaveLength(4);
        expect(record.bounds.every(Number.isFinite)).toBe(true);
    });

    it('carries no lifecycle or applied state — the server owns those', () => {
        expect('status' in record).toBe(false);
        expect('applied' in record).toBe(false);
        expect('lifecycleStatus' in record).toBe(false);
    });

    it('says nothing about a mint when there is none', () => {
        expect('onchain' in record).toBe(false);
        expect('nft' in record).toBe(false);
        expect('isMinted' in record).toBe(false);
        expect('tokenId' in record).toBe(false);
    });

    it('refuses to build without a massing, a proposalId or turf', () => {
        expect(() => build({ candidate: { ...CANDIDATE, massing: null } })).toThrow(/massing/);
        expect(() => build({ pick: { ...PICK, proposalId: null } })).toThrow(/proposalId/);
        expect(() => build({ turf: null })).toThrow(/turf/);
    });
});

describe('buildProposalRecord — with a mint', () => {
    const onchain = {
        transactionHash: '3kR8x1sig',
        proposalId: 'Ax7pDaPDAaddress11111111111111111111111111',
        chainId: 'solana:devnet',
        contractAddress: 'ProposalNFT1111111111111111111111111111111'
    };
    const record = build({ onchain });

    it('writes onchain, nft, isMinted and tokenId from one source', () => {
        expect(record.onchain).toEqual({
            transactionHash: '3kR8x1sig',
            proposalId: onchain.proposalId,
            chainId: 'solana:devnet',
            contractAddress: onchain.contractAddress
        });
        expect(record.nft).toEqual({
            chain: 'solana:devnet',
            contract: onchain.contractAddress,
            tokenId: onchain.proposalId
        });
        expect(record.isMinted).toBe(true);
        expect(record.tokenId).toBe(onchain.proposalId);
    });

    it('leaves everything else identical to the unminted record', () => {
        const { onchain: _o, nft: _n, isMinted: _m, tokenId: _t, ...rest } = record;
        expect(rest).toEqual(build());
    });

    // The point of the shape is that the frontend reads it. Load chain.js's two functions in this
    // realm and run them on the real records, so a rename over there breaks this test.
    it('reads as minted through frontend/js/proposals/chain.js itself', () => {
        const source = readFileSync(new URL('../../frontend/js/proposals/chain.js', import.meta.url), 'utf8');
        const scope = {};
        // chain.js is a classic script of bare top-level functions; evaluate it and hand back the
        // two the records must satisfy. Its other helpers are stubbed to what a Solana ref implies.
        const load = new Function('scope', `
            function isLocalProposalId(id) { return String(id).startsWith('local-'); }
            function normalizeChainId(id) { return String(id); }
            function resolveProposalResourceUrl() { return ''; }
            const proposalMetadataFetchPromises = new Map();
            ${source}
            scope.isProposalMinted = isProposalMinted;
            scope.getProposalNftInfo = getProposalNftInfo;
        `);
        load(scope);

        expect(scope.isProposalMinted(record)).toBe(true);
        expect(scope.getProposalNftInfo(record)).toEqual({
            chain: 'solana:devnet',
            contract: onchain.contractAddress,
            tokenId: onchain.proposalId
        });
        // An unminted agent record must NOT read as minted, or the UI would offer to trade it.
        expect(scope.isProposalMinted(build())).toBe(false);
    });
});

describe('onchain guard', () => {
    it('refuses an onchain block that lacks the PDA or the signature', () => {
        expect(() => build({ onchain: { transactionHash: 'sig', chainId: 'solana-devnet', contractAddress: 'x' } })).toThrow(/proposalId/);
        expect(() => build({ onchain: { proposalId: 'pda', chainId: 'solana-devnet', contractAddress: 'x' } })).toThrow(/proposalId/);
    });
});
