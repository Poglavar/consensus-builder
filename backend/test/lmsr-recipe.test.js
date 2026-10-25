// Immutable dated-market terms remain stable while fresh chain observations change independently.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';
import { AGREEMENT_PROGRAM_ID } from '../agreements/onchain.js';
import {
    AGREEMENT_EXECUTION_BY_DEADLINE_RECIPE_ID, buildAgreementExecutionByDeadlineRecipe,
    deriveAgreementMarketAddress
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
        executedAt: null, chainTime: 1_899_999_900, observedSlot: 42,
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
        expect(before.body.recipe.market.address).toBe(deriveAgreementMarketAddress(source.account, source.sponsor));
        expect(before.body.recipe.market.b).toBe('100000000');
        expect(before.body.recipe.assets).toEqual(['points', 'devnet-usdc']);
        expect(before.body.recipe.priceBooks).toBe('independent per asset');
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

    it('requires the supplied market address to equal the canonical agreement PDA', async () => {
        const source = fixture();
        const canonical = deriveAgreementMarketAddress(source.account, source.sponsor);
        await request(routeFor(source)).get(`/oracle/recipes/agreement-execution-by-deadline-v1?agreement=${source.account}&market=${canonical}`)
            .expect(200);
        const other = Keypair.generate().publicKey.toBase58();
        await request(routeFor(source)).get(`/oracle/recipes/agreement-execution-by-deadline-v1?agreement=${source.account}&market=${other}`)
            .expect(400);
        await request(routeFor(source)).get('/oracle/recipes/agreement-execution-by-deadline-v1?agreement=not-an-account')
            .expect(400);
    });

    it('uses source chain time so stale Active evidence cannot settle NO from wall time', async () => {
        const source = fixture({ closesAt: 100, chainTime: 99 });
        const route = routeFor(source, 200_000);
        const path = `/oracle/recipes/agreement-execution-by-deadline-v1?agreement=${source.account}`;
        expect((await request(route).get(path).expect(200)).body.observation.outcome).toBeNull();
        source.chainTime = 100; source.observedSlot++;
        expect((await request(route).get(path).expect(200)).body.observation.outcome).toBe('no');
    });

    it('resolves timely execution YES, late execution NO, expiry NO, and cancellation VOID', async () => {
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
        expect((await request(route).get(path).expect(200)).body.observation.outcome).toBe('void');
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
