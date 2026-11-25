// The lens walkthrough's checklist and lens member states, from source states alone (no DOM, no chain).
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Model = require('../../frontend/js/lens-walkthrough-model.js');

const PROGRAM = 'CurrentProgram1111111111111111111111111111';
const A = 'LensA111111111111111111111111111111111111111';
const B = 'LensB111111111111111111111111111111111111111';
const C = 'LensC111111111111111111111111111111111111111';
const owners = (lens = [A], extra = {}) => ({
    cid: 'bafkreiexample',
    content: { sponsor: 'Sponsor', rule: { electorate: 'owners', binding: true, lens, ...extra } },
    onchain: null
});
const account = (extra = {}) => ({
    address: 'Account', status: 'Active', lenses: [A, B, C], lensThreshold: 2, lensConfirmed: [],
    decisionCode: 0, decisionAttestation: null, requiredFunding: 0n, fundingMet: false, fundingObserved: 0n, ...extra
});
const check = (model, id) => model.checks.find(row => row.id === id);
const receipt = (decidedAt, decision = 'approve') => ({ receipt: { ownerId: 'Owner', actorId: 'Owner', decision, decidedAt, evidence: { rights: { member: A }, authority: { member: A } } }, verified: true });

describe('LensWalkthroughModel.build', () => {
    it('shows each lens member of a 2-of-3 lens and counts the confirmations Solana recorded', () => {
        const model = Model.build({
            record: owners([A, B, C]), programId: PROGRAM,
            chain: { account: account({ lensConfirmed: [B] }) },
            issued: [{ authority: C, address: 'StatementC' }], services: { A: 'ok', [B]: 'ok', [C]: 'ok', [A]: 'unlisted' }
        });
        expect(check(model, 'lens')).toMatchObject({ state: 'waiting', confirmed: 1, threshold: 2, count: 3 });
        expect(model.lens.members.map(m => [m.key, m.state])).toEqual([[A, 'unlisted'], [B, 'confirmed'], [C, 'issued']]);
    });

    it('meets the lens check once the threshold is reached, and every confirming lens member stays visible', () => {
        const model = Model.build({
            record: owners([A, B, C]), programId: PROGRAM,
            chain: { account: account({ lensConfirmed: [A, C], decisionCode: 1, decisionAttestation: 'Att', status: 'Executed' }), statement: { signer: C, fields: { evidenceRef: 'sha256:x' } } },
            issued: [], services: {}
        });
        expect(check(model, 'lens').state).toBe('met');
        expect(model.lens.members.filter(m => m.state === 'confirmed').map(m => m.key)).toEqual([A, C]);
        expect(model.lens.members.find(m => m.key === C).recorded).toMatchObject({ signer: C });
        expect(check(model, 'execution')).toMatchObject({ state: 'met', execution: 'executed' });
    });

    it('reads an agreement minted under a retired program as not on Solana, without a retry', () => {
        const record = { ...owners([A]), onchain: { programId: 'OldProgram', status: 'executed', lens: A } };
        const model = Model.build({ record, programId: PROGRAM, chainError: true, receipts: [], tally: { ready: true, passed: false } });
        expect(model.retired).toBe(true);
        expect(model.execution.state).toBe('retired');
        expect(check(model, 'execution').state).toBe('unknown');
        expect(model.retry).toBe(false);
        expect(check(model, 'lens').state).toBe('waiting');
    });

    it('says a lens-free crowdfunding round has no lens and waits on its funding target', () => {
        const record = { cid: 'x', content: { sponsor: 'S', rule: { electorate: 'investors', binding: true, lens: [] } }, onchain: null };
        const model = Model.build({ record, programId: PROGRAM, chain: { account: account({ lenses: [], lensThreshold: 0, requiredFunding: 5_000_000n, fundingObserved: 2_000_000n }) } });
        expect(check(model, 'lens').state).toBe('none');
        expect(check(model, 'funding')).toMatchObject({ state: 'waiting', observed: 2_000_000n, required: 5_000_000n });
        expect(check(model, 'approvals')).toBeUndefined();
    });

    it('fails the citation check when the approvals shown do not hash to the statement’s evidence', () => {
        const base = { record: owners([A]), programId: PROGRAM, receipts: [receipt('2026-11-19T12:05:30.464Z')], tally: { ready: true, passed: true, acceptedOwners: 1, totalOwners: 1 },
            chain: { account: account({ lenses: [A], lensThreshold: 1, lensConfirmed: [A], decisionCode: 1, decisionAttestation: 'Att', status: 'Executed' }), statement: { signer: A, fields: { evidenceRef: 'sha256:good' } } } };
        expect(check(Model.build({ ...base, approvalsRef: 'sha256:good' }), 'cited').state).toBe('met');
        expect(check(Model.build({ ...base, approvalsRef: 'sha256:other' }), 'cited').state).toBe('failed');
        expect(check(Model.build({ ...base, receipts: null, receiptsError: true }), 'cited').state).toBe('unknown');
        expect(check(Model.build({ ...base, chain: { account: base.chain.account } }), 'cited')).toBeUndefined();
    });

    it('marks the owner check from the tally and keeps who vouched for each approval', () => {
        const waiting = Model.build({ record: owners(), programId: PROGRAM, receipts: [receipt('2026-11-19T12:05:30Z')], tally: { ready: true, passed: false, acceptedOwners: 1, totalOwners: 2 } });
        expect(check(waiting, 'approvals')).toMatchObject({ state: 'waiting', approved: 1, total: 2 });
        expect(waiting.approvals[0]).toMatchObject({ owner: 'Owner', rightsBy: A, authorityBy: A, verified: true });
        expect(check(Model.build({ record: owners(), programId: PROGRAM }), 'approvals').state).toBe('loading');
        expect(check(Model.build({ record: owners(), programId: PROGRAM, receiptsError: true }), 'approvals').state).toBe('unknown');
    });

    it('asks for a retry only for sources a retry can reach', () => {
        expect(Model.build({ record: owners(), programId: PROGRAM, services: { [A]: 'unlisted' } }).retry).toBe(false);
        expect(Model.build({ record: owners(), programId: PROGRAM, services: { [A]: 'error' } }).retry).toBe(true);
        expect(Model.build({ record: owners(), programId: PROGRAM, chainError: true }).retry).toBe(true);
    });

    it('treats a non-binding vote as a poll with no chain checks', () => {
        const model = Model.build({ record: owners([A], { binding: false }), programId: PROGRAM });
        expect(model.kind).toBe('poll');
        expect(model.checks).toEqual([]);
    });
});

describe('LensWalkthroughModel.approvalsCountedBy', () => {
    it('keeps the approvals signed up to the statement’s source second and drops later ones', () => {
        const rows = [{ decidedAt: '2026-11-19T12:05:30.464Z' }, { decidedAt: '2026-11-19T12:05:31.000Z' }, { decidedAt: 'not a time' }];
        expect(Model.approvalsCountedBy(rows, Math.floor(Date.parse('2026-11-19T12:05:30Z') / 1000))).toEqual([rows[0]]);
        expect(Model.approvalsCountedBy(rows, 1_790_000_000n + 0n)).toEqual([]);
        expect(Model.approvalsCountedBy(rows, null)).toEqual([]);
    });
});
