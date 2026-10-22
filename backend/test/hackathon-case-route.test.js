// The judge's case graph of one agreement (hackathon/case-model.js) and GET /hackathon/cases/:cid
// (routes/hackathon-cases.js): the parcel set identity, the stages from minting to settlement without
// inventing completion, the agreement's chain account as the subject of its readers, and the readers
// over the index (a mock pool).
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { buildHackathonCase, parcelSetIdentity } from '../hackathon/case-model.js';
import { loadActivity, loadCaseAgreement, loadOracleEvents, setupHackathonCasesRoute } from '../routes/hackathon-cases.js';
import { agreementAccountOf } from '../agreements/onchain.js';
import { cidOfObject } from '../cid.js';
import { createRouteApp } from './helpers/create-route-app.js';

const SPONSOR = 'G4R6RCCcQHN9fLoExvTBBfhbw8BgvTEqhJezG3A1HvEg';
const CID = cidOfObject({ schema: 'agreement/v1', title: 'Three-parcel courtyard' });
const ACCOUNT = agreementAccountOf(CID, SPONSOR);

// The agreement as loadCaseAgreement hands it to the case model.
const agreement = {
    cid: CID,
    city: 'zagreb',
    title: 'Three-parcel courtyard',
    author: 'planner-01',
    sponsor: SPONSOR,
    status: 'active',
    createdAt: '2026-09-22T08:00:00.000Z',
    deadline: '2026-12-01T00:00:00.000Z',
    inputParcelIds: ['HR-1-3', 'HR-1-1', 'HR-1-2'],
    onchain: { chain: 'solana', cluster: 'devnet', account: ACCOUNT, signature: 'create-tx', status: 'active' },
    account: ACCOUNT
};
const stateOf = result => result.stages.map(item => [item.id, item.state]);

describe('hackathon case model', () => {
    it('gives an unordered input parcel list one deterministic set identity', () => {
        const first = parcelSetIdentity(agreement);
        const replay = parcelSetIdentity({ ...agreement, inputParcelIds: [...agreement.inputParcelIds].reverse() });
        expect(first).toMatchObject({ parcelCount: 3, parcelIds: ['HR-1-1', 'HR-1-2', 'HR-1-3'] });
        expect(first.setHash).toBe(replay.setHash);
        expect(first.authority).toBeNull();
        expect(parcelSetIdentity({ ...agreement, createdAt: '2027-01-01T00:00:00Z' })).toEqual(first);
        expect(parcelSetIdentity({ ...agreement, inputParcelIds: ['HR-1-1'] }).setHash).not.toBe(first.setHash);
    });

    it('models support, forecast and the decision as parallel branches of a minted agreement without inventing completion', () => {
        const result = buildHackathonCase({
            agreement,
            activity: [{ id: 'stake-1', actor: { id: 'agent-1', kind: 'agent' }, action: { type: 'stake', side: 'yes' }, transaction: 'stake-tx' }],
            support: { state: 'available', donations: null, pledges: { book: ACCOUNT, activeUsdc: '0.10', fulfilledUsdc: '0' } },
            market: { state: 'available', exists: true, account: ACCOUNT, yesUsdc: '0.25', noUsdc: '0', resolved: false },
            oracleEvents: [], generatedAt: '2026-09-22T09:00:00Z'
        });
        expect(result).toMatchObject({ version: 2, id: CID, state: 'early', generatedAt: '2026-09-22T09:00:00Z' });
        expect(result.agreement).toEqual({
            cid: CID, name: 'Three-parcel courtyard', city: 'zagreb', author: 'planner-01', sponsor: SPONSOR, status: 'active',
            createdAt: '2026-09-22T08:00:00.000Z', deadline: '2026-12-01T00:00:00.000Z', account: ACCOUNT
        });
        expect(stateOf(result)).toEqual([
            ['agreement', 'complete'], ['support', 'partial'], ['forecast', 'partial'], ['decision', 'pending'],
            ['evidence', 'pending'], ['resolution', 'pending'], ['settlement', 'blocked']
        ]);
        expect(result.stages[0].detail).toBe(`The agreement settles 3 cadastral parcels and is minted as Solana account ${ACCOUNT}.`);
        expect(result.stages[0].evidence).toEqual([
            'https://explorer.solana.com/tx/create-tx?cluster=devnet',
            `https://explorer.solana.com/address/${ACCOUNT}?cluster=devnet`
        ]);
        expect(result.relationships).toEqual(expect.arrayContaining([
            { from: 'agreement', to: 'support', kind: 'can_progress_in_parallel' },
            { from: 'agreement', to: 'forecast', kind: 'can_progress_in_parallel' },
            { from: 'agreement', to: 'decision', kind: 'can_progress_in_parallel' }
        ]));
        expect(result.transactions).toEqual([{ signature: 'stake-tx', url: 'https://explorer.solana.com/tx/stake-tx?cluster=devnet', action: 'stake' }]);
        expect(result.progress).toEqual({ complete: 1, total: 7 });
    });

    it('marks a published agreement without a recorded account as not yet minted', () => {
        const result = buildHackathonCase({ agreement: { ...agreement, onchain: null, account: null }, support: null, market: null });
        expect(result.stages[0]).toMatchObject({ id: 'agreement', state: 'partial', detail: 'The agreement is published, but its Solana account is not recorded yet.', evidence: [] });
        expect(result.state).toBe('early');
    });

    it('completes every stage of a cancelled agreement whose donation was refunded, pledge voided and pool settled', () => {
        const result = buildHackathonCase({
            agreement: { ...agreement, status: 'cancelled' },
            activity: [
                { actor: { id: 'supporter' }, action: { type: 'pledge', amount: '0.10' }, transaction: 'pledge' },
                { actor: { id: 'supporter' }, action: { type: 'voidPledge' }, transaction: 'void' },
                { actor: { id: 'supporter' }, action: { type: 'claim' }, transaction: 'claim' }
            ],
            support: {
                state: 'available',
                donations: { totalUsdc: '0.05', donationCount: '1', refundedUsdc: '0.05' },
                pledges: { activeUsdc: '0', fulfilledUsdc: '0', revokedUsdc: '0', pledgeCount: '1' }
            },
            market: { state: 'available', exists: true, account: 'market', yesUsdc: '0.01', noUsdc: '0.01', resolved: true, outcome: 'NO' },
            oracleEvents: [{ eventType: 'agreement_lifecycle', outcome: 'cancelled', source: { transaction: 'cancel' } }]
        });
        expect(result.stages.find(item => item.id === 'support')).toMatchObject({
            state: 'complete', detail: '0.05 devnet USDC donated and later refunded; 0.1 devnet USDC pledged and later voided.'
        });
        expect(result.stages.find(item => item.id === 'decision')).toMatchObject({ state: 'complete', detail: 'The agreement is cancelled.' });
        expect(result.stages.find(item => item.id === 'evidence')).toMatchObject({ detail: 'agreement_lifecycle recorded outcome cancelled.' });
        expect(result.progress).toEqual({ complete: 7, total: 7 });
        expect(result.state).toBe('complete');
    });

    it('lets the attest and execute transactions stand as evidence of the decision', () => {
        const result = buildHackathonCase({
            agreement: { ...agreement, status: 'executed' },
            activity: [{ action: { type: 'attest' }, transaction: 'attest-tx' }, { action: { type: 'execute' }, transaction: 'execute-tx' }]
        });
        expect(result.stages.find(item => item.id === 'decision')).toEqual({
            id: 'decision', label: 'Decision and lifecycle', state: 'complete', detail: 'The agreement is executed.',
            evidence: ['https://explorer.solana.com/tx/attest-tx?cluster=devnet', 'https://explorer.solana.com/tx/execute-tx?cluster=devnet']
        });
    });

    it('refuses to build a case without an agreement CID', () => {
        expect(() => buildHackathonCase({ agreement: { title: 'x' } })).toThrow(/cid/);
    });
});

describe('GET /hackathon/cases/:cid', () => {
    function appWith(readers) {
        return createRouteApp(expressApp => setupHackathonCasesRoute(expressApp, {}, {
            env: { PUBLIC_API_BASE_URL: 'https://api.example.test', PUBLIC_SITE_BASE_URL: 'https://site.example.test' },
            agreementReader: async (_pool, cid) => (cid === CID ? agreement : null),
            activityReader: async () => [{
                id: 'mint', actor: { id: 'planner-01', kind: 'agent', controller: 'algorithm' },
                action: { type: 'mint' }, entity: { type: 'agreement', id: CID }, transaction: 'create-tx'
            }],
            oracleReader: async () => [],
            supportReader: async () => { throw new Error('rpc support timeout'); },
            marketReader: async () => ({ state: 'available', exists: true, account: 'market', yesUsdc: '0.25', noUsdc: '0.10', resolved: false }),
            connection: {},
            ...readers
        }));
    }

    it('serves a data-derived aggregate on the agreement account and keeps failed optional readers explicit', async () => {
        const oracleReader = vi.fn(async () => []);
        const marketReader = vi.fn(async () => ({ state: 'available', exists: true, account: 'market', yesUsdc: '0.25', noUsdc: '0.10', resolved: false }));
        const response = await request(appWith({ oracleReader, marketReader })).get(`/hackathon/cases/${CID}`);
        expect(response.status).toBe(200);
        expect(oracleReader).toHaveBeenCalledWith({}, { account: ACCOUNT, cid: CID });
        expect(marketReader).toHaveBeenCalledWith({}, ACCOUNT);
        expect(response.body).toMatchObject({
            id: CID, state: 'in_progress', parcelSet: { parcelCount: 3 }, agreement: { account: ACCOUNT, sponsor: SPONSOR },
            links: {
                self: `https://api.example.test/hackathon/cases/${CID}`,
                agreement: `https://api.example.test/agreements/${CID}`,
                map: `https://site.example.test/agreements/${CID}?city=zagreb`,
                activity: `https://api.example.test/agent/activity?agreement=${CID}&limit=200`,
                support: `https://api.example.test/agent/pledges/${ACCOUNT}`,
                events: `https://api.example.test/oracle/events?agreement=${CID}`
            }
        });
        expect(response.body.stages.find(item => item.id === 'support')).toMatchObject({ state: 'unavailable', detail: 'rpc support timeout' });
        expect(response.body.stages.find(item => item.id === 'forecast')).toMatchObject({ state: 'complete' });
    });

    it('reads no chain state for an agreement that has no account', async () => {
        const supportReader = vi.fn();
        const marketReader = vi.fn();
        const response = await request(appWith({
            agreementReader: async () => ({ ...agreement, sponsor: null, onchain: null, account: null }), supportReader, marketReader
        })).get(`/hackathon/cases/${CID}`);
        expect(response.status).toBe(200);
        expect(supportReader).not.toHaveBeenCalled();
        expect(marketReader).not.toHaveBeenCalled();
        expect(response.body.links.support).toBeNull();
        expect(response.body.stages.find(item => item.id === 'agreement').state).toBe('partial');
        expect(response.body.stages.filter(item => item.state === 'complete')).toEqual([]);
    });

    it('answers 400 for an id that is not an agreement CID, 404 for an unknown one and 500 when the index fails', async () => {
        const reader = vi.fn(async () => null);
        expect((await request(appWith({ agreementReader: reader })).get('/hackathon/cases/golden-case')).status).toBe(400);
        expect(reader).not.toHaveBeenCalled();
        expect((await request(appWith({ agreementReader: reader })).get(`/hackathon/cases/${CID}`)).status).toBe(404);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const failing = await request(appWith({ agreementReader: async () => { throw new Error('index down'); } })).get(`/hackathon/cases/${CID}`);
        errorSpy.mockRestore();
        expect(failing.status).toBe(500);
    });
});

describe('hackathon case readers', () => {
    const indexRow = (overrides = {}) => ({
        cid: CID, city: 'zagreb', title: 'Three-parcel courtyard', author: 'planner-01', design_cids: [], input_parcel_ids: ['HR-1-1'],
        parcel_source_id: null, deadline: null, status: 'active', content: { sponsor: SPONSOR }, onchain: null,
        screenshot_url: null, screenshot_before_url: null, screenshot_pair_url: null, created_at: new Date('2026-09-22T08:00:00Z'), ...overrides
    });
    const poolOf = rows => ({ query: vi.fn(async () => ({ rows })) });

    it('takes the recorded account, else the PDA of the sponsor and CID, else none', async () => {
        const recorded = await loadCaseAgreement(poolOf([indexRow({ onchain: { account: ACCOUNT, status: 'executed' }, status: 'executed' })]), CID);
        expect(recorded).toMatchObject({ cid: CID, sponsor: SPONSOR, status: 'executed', account: ACCOUNT, inputParcelIds: ['HR-1-1'], createdAt: '2026-09-22T08:00:00.000Z' });
        expect((await loadCaseAgreement(poolOf([indexRow()]), CID)).account).toBe(ACCOUNT);
        expect((await loadCaseAgreement(poolOf([indexRow({ content: { sponsor: null } })]), CID)).account).toBeNull();
        expect((await loadCaseAgreement(poolOf([indexRow({ content: { sponsor: 'not-a-wallet' } })]), CID)).account).toBeNull();
        expect(await loadCaseAgreement(poolOf([]), CID)).toBeNull();
    });

    it('reads the lifecycle event of the account and the per-parcel events naming the CID', async () => {
        const pool = poolOf([{
            event_id: 'e1', event_type: 'agreement_lifecycle', subject_type: 'agreement', subject_id: ACCOUNT, outcome: 'executed',
            source_url: 'https://explorer.example/tx', source_hash: 'sha256:abc', source_observed_at: '2026-10-01T00:00:00.000Z',
            attester: 'Agreement1111111111111111111111111111111111', transaction_signature: 'exec-tx', evidence: {}, created_at: '2026-10-01T00:05:00.000Z'
        }]);
        const events = await loadOracleEvents(pool, { account: ACCOUNT, cid: CID });
        expect(pool.query.mock.calls[0][1]).toEqual([ACCOUNT, CID]);
        expect(pool.query.mock.calls[0][0]).toMatch(/subject_id = \$1\) OR evidence->>'agreementCid' = \$2/);
        expect(events).toEqual([expect.objectContaining({ id: 'e1', eventType: 'agreement_lifecycle', subject: { type: 'agreement', id: ACCOUNT }, outcome: 'executed' })]);
    });

    it('keeps only the activity about this agreement', async () => {
        const other = cidOfObject({ other: true });
        const pool = { query: vi.fn(async (sql) => {
            if (/FROM consensus\.agent_run/.test(sql)) {
                return { rows: [{
                    run_id: 'run-1', persona: 'planner-01', mode: 'live', status: 'completed', stage: 'minted',
                    started_at: '2026-09-22T08:00:00Z', updated_at: '2026-09-22T08:10:00Z',
                    summary: { activities: [
                        { action: { type: 'mint' }, entity: { type: 'agreement', id: CID }, transaction: 'create-tx', occurredAt: '2026-09-22T08:05:00Z' },
                        { action: { type: 'mint' }, entity: { type: 'agreement', id: other }, transaction: 'other-tx', occurredAt: '2026-09-22T08:06:00Z' }
                    ] }
                }] };
            }
            return { rows: [{ cid: CID, title: 'Three-parcel courtyard', created_at: new Date('2026-09-22T08:01:00Z') }] };
        }) };
        const events = await loadActivity(pool, CID);
        expect(events.map(event => [event.action.type, event.entity.id, event.transaction])).toEqual(expect.arrayContaining([
            ['propose', CID, null], ['mint', CID, 'create-tx']
        ]));
        expect(events.some(event => event.entity?.id === other)).toBe(false);
        expect(pool.query.mock.calls[1][1]).toEqual([CID]);
    });
});
