// Immutable dated-market terms remain stable while fresh chain observations change independently.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';
import { AGREEMENT_PROGRAM_ID } from '../agreements/onchain.js';
import { DEVNET_USDC_MINT } from '../solana/address-book.js';
import {
    AGREEMENT_EXECUTION_BY_DEADLINE_RECIPE_ID, buildAgreementExecutionByDeadlineRecipe
} from '../oracle/lmsr-recipe.js';
import { setupLmsrRecipesRoute } from '../routes/lmsr-recipes.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const { Keypair } = web3;

function fixture(overrides = {}) {
    const account = Keypair.generate().publicKey.toBase58();
    const sponsor = Keypair.generate().publicKey.toBase58();
    return {
        account, sponsor, cid: 'bafy-test-agreement-cid', city: 'Test city',
        closesAt: 1_900_000_000, graceSeconds: 0, chainStatus: 'active',
        executedAt: null, chainTime: 1_899_999_900, observedSlot: 42, lenses: [], insiders: [sponsor],
        ...overrides
    };
}

function routeFor(source, currentTime = 1_899_999_999_000) {
    const app = express();
    setupLmsrRecipesRoute(app, {}, { readAgreement: async () => ({ ...source }),
        now: typeof currentTime === 'function' ? currentTime : () => currentTime });
    return app;
}

describe('agreement execution by deadline LMSR recipe', () => {
    it('hashes immutable terms while exposing fresh status and slot separately', async () => {
        const source = fixture();
        const route = routeFor(source);
        const path = `/oracle/recipes/agreement-execution-by-deadline-v1?agreement=${source.account}`;
        const before = await request(route).get(path).expect(200);
        expect(before.headers['cache-control']).toBe('private, no-store');
        expect(before.body.recipe.id).toBe(AGREEMENT_EXECUTION_BY_DEADLINE_RECIPE_ID);
        expect(before.body.recipe.agreement.program).toBe(AGREEMENT_PROGRAM_ID);
        expect(before.body.recipe.market.address).toBeNull();
        expect(before.body.recipe.assets).toEqual(['points']);
        expect(before.body.recipe.payouts).toEqual({ yes: { yes: '1', no: '0' }, no: { yes: '0', no: '1' }, void: { yes: '0.5', no: '0.5' } });
        expect(before.body.recipe.observation).toBeUndefined();
        expect(before.body.observation).toMatchObject({ chainStatus: 'active', outcome: null, slot: 42 });

        source.chainStatus = 'executed'; source.executedAt = source.closesAt - 5;
        source.chainTime = source.closesAt - 4; source.observedSlot = 99;
        const after = await request(route).get(path).expect(200);
        expect(after.body.recipe.hash).toBe(before.body.recipe.hash);
        expect(after.body.observation).toMatchObject({ chainStatus: 'executed', outcome: 'yes', slot: 99 });

        const changedTerms = buildAgreementExecutionByDeadlineRecipe(
            { ...source, closesAt: source.closesAt + 1 }, before.body.recipe.market.address
        );
        expect(changedTerms.hash).not.toBe(before.body.recipe.hash);
    });

    it('reads the selected execution market’s own cutoff and rejects a foreign subject or stake mint', async () => {
        const source = fixture({ closesAt: 200, chainTime: 150 });
        const address = Keypair.generate().publicKey.toBase58();
        const creator = Keypair.generate().publicKey.toBase58();
        const terms = { kind: 0, proposal: source.account, stakeMint: DEVNET_USDC_MINT, creator, b: 5_000_000n,
            closesAt: 145, graceSeconds: 2, maxPosition: 0n, seed: 3_465_737n };
        const app = express();
        setupLmsrRecipesRoute(app, {}, { readAgreement: async () => source, readMarket: async key => key === address ? terms : null, now: () => 150 });
        const base = `/oracle/recipes/agreement-execution-by-deadline-v1?agreement=${source.account}`;
        const selected = base + '&market=' + address;
        const { body } = await request(app).get(selected).expect(200);
        expect(body.recipe.market).toMatchObject({ address, creator, b: '5000000', closesAt: 145 });
        expect(body.recipe.assets).toEqual(['devnet-usdc']);
        expect(body.observation.outcome).toBe('no');
        expect((await request(app).get(base).expect(200)).body.observation.outcome).toBeNull();
        await request(app).get(base + '&market=' + creator).expect(400);
        terms.proposal = creator;
        await request(app).get(selected).expect(400);
        terms.proposal = source.account; terms.stakeMint = creator;
        await request(app).get(selected).expect(400);
        await request(app).get('/oracle/recipes/agreement-execution-by-deadline-v1?agreement=not-an-account').expect(400);
    });

    it('reports the external market’s proposed outcome independently of agreement execution', async () => {
        const verifier = Keypair.generate().publicKey.toBase58();
        const source = fixture({ chainStatus: 'executed', executedAt: 100 });
        // The verifier is the second of two lens members: any member may be the external market's attester.
        source.lenses = [Keypair.generate().publicKey.toBase58(), verifier];
        source.insiders = [source.sponsor, ...source.lenses];
        const address = Keypair.generate().publicKey.toBase58();
        const terms = { kind: 1, proposal: source.account, stakeMint: DEVNET_USDC_MINT, creator: verifier, trustedAttester: verifier,
            recipeHash: Buffer.alloc(32, 1), subjectHash: Buffer.alloc(32, 2), yesValueHash: Buffer.alloc(32, 3), noValueHash: Buffer.alloc(32, 4),
            credential: source.sponsor, schema: address, b: 5n, seed: 4n, maxPosition: 0n, closesAt: 1900000000,
            graceSeconds: 0, proposed: true, resolved: false, outcome: 0, challengeEndsAt: 1900172800 };
        const app = express();
        setupLmsrRecipesRoute(app, {}, { readAgreement: async () => source, readMarket: async () => terms });
        const path = `/oracle/recipes/agreement-execution-by-deadline-v1?agreement=${source.account}&market=${address}`;
        const { body } = await request(app).get(path).expect(200);
        expect(body.recipe).toMatchObject({ kind: 'recipe', trustedAttester: verifier, cid: expect.stringMatching(/^bafkrei/) });
        expect(body.observation).toMatchObject({ proposedOutcome: 'no', outcome: null, challengeEndsAt: 1900172800 });
        terms.trustedAttester = source.sponsor;
        await request(app).get(path).expect(400);
    });

    it('uses source chain time so stale Active evidence cannot settle NO from wall time', async () => {
        const source = fixture({ closesAt: 100, chainTime: 99 });
        const route = routeFor(source, 200_000);
        const path = `/oracle/recipes/agreement-execution-by-deadline-v1?agreement=${source.account}`;
        expect((await request(route).get(path).expect(200)).body.observation.outcome).toBeNull();
        // At exactly the deadline an execution still counts, so absence is not yet NO (strict grace).
        source.chainTime = 100; source.observedSlot++;
        expect((await request(route).get(path).expect(200)).body.observation.outcome).toBeNull();
        source.chainTime = 101; source.observedSlot++;
        expect((await request(route).get(path).expect(200)).body.observation.outcome).toBe('no');
    });

    it('resolves timely execution YES, late execution NO, expiry NO, and cancellation NO', async () => {
        const source = fixture({ closesAt: 100, chainTime: 100, chainStatus: 'executed', executedAt: 100 });
        let currentTime = 100_000;
        const route = routeFor(source, () => currentTime);
        const path = `/oracle/recipes/agreement-execution-by-deadline-v1?agreement=${source.account}`;
        expect((await request(route).get(path).expect(200)).body.observation.outcome).toBe('yes');
        source.executedAt = 101; source.chainTime = 101; currentTime = 101_000;
        expect((await request(route).get(path).expect(200)).body.observation.outcome).toBe('no');
        source.chainStatus = 'expired'; source.executedAt = null;
        expect((await request(route).get(path).expect(200)).body.observation.outcome).toBe('no');
        source.chainStatus = 'cancelled';
        expect((await request(route).get(path).expect(200)).body.observation.outcome).toBe('no');
    });

    it('rejects unknown status, absent or invalid execution timestamps, and bad source identity', async () => {
        const source = fixture({ chainStatus: 'mystery' });
        const route = routeFor(source);
        const path = `/oracle/recipes/agreement-execution-by-deadline-v1?agreement=${source.account}`;
        await request(route).get(path).expect(503);
        source.chainStatus = 'executed'; source.executedAt = null;
        await request(route).get(path).expect(503);
        source.executedAt = source.chainTime + 1;
        await request(route).get(path).expect(503);
        source.executedAt = source.closesAt - 1; source.chainTime = source.closesAt - 2;
        await request(route).get(path).expect(503);
        source.account = Keypair.generate().publicKey.toBase58();
        await request(route).get(path).expect(503);
    });
});
