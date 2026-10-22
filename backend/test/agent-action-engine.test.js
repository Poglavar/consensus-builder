// Headless tests for the one action contract (frontend/js/agent-action-engine.js): humans, algorithms
// and LLM agents act through the same handlers, every outcome becomes the same activity event about an
// agreement or a design (by CID), and the explorer filters and deep-links by actor, agreement and run.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const engineApi = require('../../frontend/js/agent-action-engine.js');

const AGREEMENT = 'bafkreiftzbz2gpufkdckedn2fgb6jiq3qxd6zeohfzmgm42rysek3kuf7y';
const OTHER_AGREEMENT = 'bafkreigb4spdl37uquwgdhzpvjfwicwgthlv2finkq5zibibrx66yk2eha';
const DESIGN = 'bafkreiehkrtqnkc7fjuviaz4oyqis7wexv3zsq3vfzknyf43rc5qvygce4';

describe('unified agent action engine', () => {
    it('runs algorithmic and LLM actors through the same handler and activity schema', async () => {
        const activities = [];
        const handler = vi.fn((_actor, action) => ({ ok: true, message: `did ${action.type}` }));
        const engine = engineApi.createEngine({
            decisionProviders: {
                algorithm: () => ({ type: 'donate', agreementCid: AGREEMENT, amount: 2 }),
                llm: async () => ({ type: 'pledge', agreementCid: OTHER_AGREEMENT, amount: 5 })
            },
            actionHandlers: { '*': handler },
            onActivity: event => activities.push(event)
        });

        await engine.run({ id: 'a1', name: 'Alex', controller: 'algorithm' });
        await engine.run({ id: 'a2', name: 'Mira', controller: 'llm' }, { source: 'live' });

        expect(handler).toHaveBeenCalledTimes(2);
        expect(activities[0]).toMatchObject({ source: 'simulation', actor: { kind: 'agent', controller: 'algorithm' }, action: { type: 'donate' }, entity: { type: 'agreement', id: AGREEMENT } });
        expect(activities[1]).toMatchObject({ source: 'live', actor: { kind: 'agent', controller: 'llm' }, action: { type: 'pledge' }, entity: { type: 'agreement', id: OTHER_AGREEMENT } });
    });

    it('normalizes humans without exposing a different action shape', () => {
        expect(engineApi.normalizeActor({ id: 'u1', name: 'Dana', userControlled: true })).toMatchObject({
            id: 'u1', name: 'Dana', kind: 'human', controller: 'human'
        });
        expect(engineApi.matchesActivity({ source: 'live', actor: { kind: 'human' } }, { kind: 'human' })).toBe(true);
    });

    it('does not label HTTP failures as successful activity', () => {
        const event = engineApi.createActivityEvent({
            actor: { id: 'a1', name: 'Alex', controller: 'llm' },
            action: { type: 'propose', agreementCid: AGREEMENT },
            outcome: { status: 400 }
        });
        expect(event).toMatchObject({ ok: false, message: `Alex proposed agreement ${AGREEMENT}.` });
    });

    it('makes every activity about an agreement or a design, by its CID, or else a parcel', () => {
        const actor = { id: 'a1', name: 'Alex', controller: 'algorithm' };
        const about = action => engineApi.createActivityEvent({ actor, action });
        expect(about({ type: 'design', designCid: DESIGN })).toMatchObject({ entity: { type: 'design', id: DESIGN }, message: `Alex published design ${DESIGN}.` });
        expect(about({ type: 'mint', agreementCid: AGREEMENT })).toMatchObject({ entity: { type: 'agreement', id: AGREEMENT }, message: `Alex minted agreement ${AGREEMENT}.` });
        expect(about({ type: 'fund', agreementCid: AGREEMENT }).message).toBe(`Alex funded the escrow of agreement ${AGREEMENT}.`);
        expect(about({ type: 'attest', agreementCid: AGREEMENT }).message).toBe(`Alex recorded the decision on agreement ${AGREEMENT}.`);
        expect(about({ type: 'stake', agreementCid: AGREEMENT, amount: 1, side: 'yes' }).message).toBe(`Alex staked 1 USDC YES on agreement ${AGREEMENT}.`);
        // The agreement wins over its design and parcel when an action names them all.
        expect(about({ type: 'execute', agreementCid: AGREEMENT, designCid: DESIGN, parcelId: 'P/1' }).entity).toEqual({ type: 'agreement', id: AGREEMENT });
        expect(about({ type: 'create', parcelId: 'P/1' }).entity).toEqual({ type: 'parcel', id: 'P/1' });
        expect(about({ type: 'expire' })).toMatchObject({ entity: null, message: 'Alex expired an agreement.' });
        // A handler that knows better names the entity itself.
        expect(engineApi.createActivityEvent({ actor, action: { type: 'stake', agreementCid: AGREEMENT }, outcome: { ok: true, entity: { type: 'market', id: 'm1' } } }).entity)
            .toEqual({ type: 'market', id: 'm1' });
    });

    it('runs human, algorithmic and LLM controllers through the same handler contract', async () => {
        const handled = [];
        const engine = engineApi.createEngine({
            decisionProviders: {
                human: (_actor, context) => context.action,
                algorithm: (_actor, context) => context.action,
                llm: (_actor, context) => context.action
            },
            actionHandlers: { '*': (actor, action) => { handled.push([actor.id, action.type]); return { ok: true }; } }
        });
        for (const controller of ['human', 'algorithm', 'llm']) {
            const result = await engine.run({ id: controller, controller }, { action: { type: 'pledge', agreementCid: AGREEMENT } });
            expect(result.activity).toMatchObject({ actor: { controller }, action: { type: 'pledge' }, entity: { type: 'agreement', id: AGREEMENT } });
        }
        expect(handled).toEqual([['human', 'pledge'], ['algorithm', 'pledge'], ['llm', 'pledge']]);
    });

    it('combines source, controller, action, result and search filters', () => {
        const event = engineApi.createActivityEvent({
            actor: { id: 'wallet-1', name: 'Densifier', controller: 'llm', wallet: 'wallet-1' },
            action: { type: 'stake', agreementCid: AGREEMENT }, outcome: { ok: true, transaction: 'tx-1' }, source: 'live'
        });
        expect(engineApi.matchesActivity(event, { source: 'live', kind: 'agent', controller: 'llm', action: 'stake', status: 'success', query: AGREEMENT.slice(0, 16) })).toBe(true);
        expect(engineApi.matchesActivity(event, { source: 'simulation' })).toBe(false);
        expect(engineApi.matchesActivity(event, { controller: 'algorithm' })).toBe(false);
        expect(engineApi.matchesActivity(event, { kind: 'human' })).toBe(false);
        expect(engineApi.matchesActivity(event, { status: 'failed' })).toBe(false);
        expect(engineApi.matchesActivity(event, { query: DESIGN })).toBe(false);
        expect(engineApi.matchesActivity(event, {})).toBe(true);
        expect(engineApi.matchesActivity(event, engineApi.EMPTY_ACTIVITY_FILTER)).toBe(true);
    });

    it('filters by actor, agreement and run', () => {
        const event = { source: 'live', actor: { id: 'w1', kind: 'agent', controller: 'llm' }, action: { type: 'pledge', agreementCid: AGREEMENT }, entity: { type: 'agreement', id: AGREEMENT }, runId: 'run-9' };
        expect(engineApi.matchesActivity(event, { actorId: 'w1', agreementCid: AGREEMENT, runId: 'run-9' })).toBe(true);
        expect(engineApi.matchesActivity(event, { actorId: 'w2' })).toBe(false);
        expect(engineApi.matchesActivity(event, { agreementCid: OTHER_AGREEMENT })).toBe(false);
        expect(engineApi.matchesActivity(event, { runId: 'run-1' })).toBe(false);
        // A bet is about its market and names its agreement on the action; a design is no agreement.
        const bet = { source: 'live', actor: { id: 'w1' }, action: { type: 'stake', agreementCid: AGREEMENT }, entity: { type: 'market', id: 'm1' } };
        const design = { source: 'live', actor: { id: 'w1' }, action: { type: 'design', designCid: DESIGN }, entity: { type: 'design', id: DESIGN } };
        expect(engineApi.activityAgreementCid(event)).toBe(AGREEMENT);
        expect(engineApi.activityAgreementCid(bet)).toBe(AGREEMENT);
        expect(engineApi.activityAgreementCid(design)).toBeNull();
        expect(engineApi.matchesActivity(bet, { agreementCid: AGREEMENT })).toBe(true);
        expect(engineApi.matchesActivity(design, { agreementCid: AGREEMENT })).toBe(false);
        expect(engineApi.matchesActivity(design, { agreementCid: DESIGN })).toBe(false);
    });

    it('round-trips explorer deep links and rejects unknown dimensions', () => {
        const link = engineApi.activityLinkFor('agreement', AGREEMENT);
        expect(link).toBe(`activity=agreement%3A${AGREEMENT}`);
        expect(engineApi.parseActivityLink(new URLSearchParams(link).get('activity'))).toEqual({ agreementCid: AGREEMENT });
        const actor = engineApi.activityLinkFor('actor', 'agent demo/1');
        expect(actor).toBe('activity=actor%3Aagent%20demo%2F1');
        expect(engineApi.parseActivityLink(new URLSearchParams(actor).get('activity'))).toEqual({ actorId: 'agent demo/1' });
        expect(engineApi.parseActivityLink('run:r1')).toEqual({ runId: 'r1' });
        expect(engineApi.parseActivityLink('wallet:x')).toBeNull();
        expect(engineApi.parseActivityLink('proposal:p1')).toBeNull();
        expect(engineApi.parseActivityLink('agreement:')).toBeNull();
        expect(() => engineApi.activityLinkFor('wallet', 'x')).toThrow();
        expect(() => engineApi.activityLinkFor('agreement', '')).toThrow();
    });

    it('loads live, simulation and combined through one source contract and reports failures', async () => {
        const source = engineApi.createActivitySource({
            simulation: () => [{ id: 's1', recordedAt: '2026-01-01T00:00:00Z' }],
            live: async () => [{ id: 'l1', recordedAt: '2026-01-02T00:00:00Z' }, { id: 's1', recordedAt: '2026-01-01T00:00:00Z' }]
        });
        expect((await source.load('simulation')).events.map(event => event.id)).toEqual(['s1']);
        expect((await source.load('combined')).events.map(event => event.id)).toEqual(['s1', 'l1']);
        const broken = engineApi.createActivitySource({ simulation: () => [{ id: 's1' }], live: async () => { throw new Error('HTTP 502'); } });
        expect(await broken.load('combined')).toEqual({ events: [{ id: 's1' }], failures: [{ source: 'live', error: 'HTTP 502' }] });
        await expect(broken.load('chain')).rejects.toThrow('unknown activity source chain');
    });
});
