// buildPlan decides which retired-program instructions return devnet USDC and escrowed SOL to our wallets:
// expire/cancel an agreement, resolve its market, claim our positions, reclaim our seed, refund our
// donations; and it leaves foreign wallets' accounts alone. Accounts are encoded and decoded by the
// vendored IDLs, so the decoder is exercised too.
import { describe, expect, it } from 'vitest';
import web3 from '@solana/web3.js';
import { GENERATIONS, PROPOSAL_NFT, buildPlan, decodeAccount, encodeAccount, loadIdls, selectSteps, stepDone } from '../scripts/lib/clawback-plan.mjs';

const idls = loadIdls();
const OLD = GENERATIONS.find(g => g.name === 'single-lens');
const NEW = GENERATIONS.find(g => g.name === 'lens-set');
const key = n => new web3.PublicKey(Buffer.alloc(32, n)).toBase58();
const OURS = key(1), OURS_2 = key(2), FOREIGN = key(9);
const ours = new Map([[OURS, 'ugt-builder-02'], [OURS_2, 'ugt-gentle-01']]);
const NOW = 1_800_000_000;
const PROPOSAL_NFT = '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';

/** An account as the script's snapshot holds it, round-tripped through the IDL codec. */
const account = (program, type, value) => ({ program, lamports: 2_000_000n, ...decodeAccount(idls.get(program), encodeAccount(idls.get(program), type, value)) });
const agreement = (gen, value) => account(gen.agreement, 'Agreement', { status: 'Active', decision: 'Pending', cid: 'bafkreitest', ...value });
const plan = (entries, balances = {}, owners = {}) => buildPlan({ now: NOW, ours, accounts: new Map(entries), balances: new Map(Object.entries(balances)), owners: new Map(Object.entries(owners)) });

describe('decodeAccount', () => {
    it('round-trips both agreement layouts and rejects truncated data', () => {
        const old = agreement(OLD, { authority: OURS, deadline: 123n, escrow_lamports: 5n, cid: 'bafkreiabc' });
        expect(old).toMatchObject({ type: 'Agreement', data: { authority: OURS, status: 'Active', decision: 'Pending', deadline: 123n, escrow_lamports: 5n, cid: 'bafkreiabc' } });
        const lensSet = agreement(NEW, { authority: OURS, lens_count: 2, more_lenses: [OURS_2] });
        expect(lensSet.data).toMatchObject({ lens_count: 2, more_lenses: [OURS_2, ...Array(6).fill('11111111111111111111111111111111')] });
        const bytes = encodeAccount(idls.get(OLD.agreement), 'Agreement', { authority: OURS, status: 'Active', decision: 'Pending', cid: 'x' });
        expect(decodeAccount(idls.get(OLD.agreement), bytes.subarray(0, 100)).error).toMatch(/undecodable Agreement/);
    });
});

describe('buildPlan: parimutuel markets', () => {
    const market = (gen, agreementKey, extra = {}) => account(gen.market, 'Market', { proposal: agreementKey, stake_mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', vault: key(40), yes_pool: 0n, no_pool: 0n, ...extra });
    const position = (gen, marketKey, owner, side, amount, claimed = false) => account(gen.market, 'Position', { market: marketKey, owner, side, amount, claimed });

    it('expires a foreign agreement past its deadline, then resolves the market and claims our position; the foreign position is left alone', () => {
        const result = plan([
            [key(20), agreement(OLD, { authority: FOREIGN, deadline: BigInt(NOW - 60), escrow_lamports: 7n })],
            [key(30), market(OLD, key(20), { yes_pool: 3_000_000n, no_pool: 1_000_000n })],
            [key(31), position(OLD, key(30), OURS, 0, 1_000_000n)],
            [key(32), position(OLD, key(30), FOREIGN, 1, 3_000_000n)],
        ], { [key(40)]: 4_000_000n });
        expect(result.steps.map(s => [s.action, s.target, s.when, s.signer, s.dependsOn])).toEqual([
            ['expire', key(20), 'now', null, []],
            ['resolve', key(30), 'now', null, [`expire:${key(20)}`]],
            ['claim', key(31), 'now', OURS, [`resolve:${key(30)}`]],
        ]);
        // NO wins the whole pool; the foreign sponsor's escrow is not counted as ours.
        expect(result.steps[2].returns).toEqual([expect.objectContaining({ wallet: OURS, usdc: 4_000_000n })]);
        expect(result.steps[0].returns).toEqual([]);
        expect(result.steps[0].note).toMatch(/permissionless expire of a foreign sponsor's agreement/);
    });

    it('plans nothing for a market whose positions are all held by wallets we do not hold', () => {
        const result = plan([
            [key(20), agreement(OLD, { authority: FOREIGN, deadline: BigInt(NOW - 60) })],
            [key(30), market(OLD, key(20), { yes_pool: 5n })],
            [key(32), position(OLD, key(30), FOREIGN, 1, 5n)],
        ], { [key(40)]: 5n });
        expect(result.steps).toEqual([]);
        expect(result.foreign).toEqual([expect.objectContaining({ account: key(30), usdc: 5n, positions: 1 })]);
    });

    it('waits for the deadline when the agreement is foreign and not yet expirable, with the date it becomes recoverable', () => {
        const deadline = NOW + 3600;
        const result = plan([
            [key(20), agreement(OLD, { authority: FOREIGN, deadline: BigInt(deadline) })],
            [key(30), market(OLD, key(20), { no_pool: 2n })],
            [key(31), position(OLD, key(30), OURS, 0, 2n)],
        ], { [key(40)]: 2n });
        expect(result.steps.map(s => [s.action, s.when, s.at])).toEqual([
            ['expire', 'later', deadline + 1], ['resolve', 'later', deadline + 1], ['claim', 'later', deadline + 1],
        ]);
        expect(selectSteps(result.steps)).toEqual([]);
    });

    it('cancels our own Pending agreement (sponsor signs) and returns its escrow', () => {
        const result = plan([[key(20), agreement(OLD, { authority: OURS, deadline: BigInt(NOW + 86_400), escrow_lamports: 1_000_000n })]]);
        expect(result.steps).toEqual([expect.objectContaining({ action: 'cancel', signer: OURS, when: 'now', returns: [expect.objectContaining({ wallet: OURS, lamports: 1_000_000n })] })]);
    });

    it('cannot resolve a market whose subject belongs to another program (a pre-agreement proposal)', () => {
        const result = plan([
            [key(30), market(OLD, key(21), { yes_pool: 2n })],
            [key(31), position(OLD, key(30), OURS, 1, 2n)],
        ], { [key(40)]: 2n }, { [key(21)]: PROPOSAL_NFT });
        expect(result.steps).toEqual([]);
        expect(result.unrecoverable).toEqual([expect.objectContaining({ account: key(31), usdc: 2n, reason: expect.stringMatching(/owned by proposal_nft/) })]);
    });

    it('does not read a market against the other generation\'s agreement program', () => {
        const result = plan([
            [key(20), agreement(NEW, { authority: OURS, deadline: BigInt(NOW - 1) })],
            [key(30), market(OLD, key(20), { no_pool: 2n })],
            [key(31), position(OLD, key(30), OURS, 0, 2n)],
        ], { [key(40)]: 2n });
        expect(result.steps.filter(s => s.program === OLD.market)).toEqual([]);
        expect(result.unrecoverable[0].reason).toMatch(/agreement_ESJ1/);
    });
});

describe('buildPlan: LMSR markets', () => {
    const lmsr = (value) => account(NEW.market, 'LmsrMarket', { kind: 0, proposal: key(20), creator: OURS_2, stake_mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', vault: key(41), schema: '11111111111111111111111111111111', closes_at: BigInt(NOW - 100), grace_seconds: 50, ...value });
    const position = (owner, side, amount) => account(NEW.market, 'Position', { market: key(30), owner, side, amount });

    it('settles YES from an agreement executed before close: the YES holder claims, the NO holder loses, the creator reclaims the rest', () => {
        const result = plan([
            [key(20), agreement(NEW, { authority: FOREIGN, status: 'Executed', executed_at: BigInt(NOW - 500) })],
            [key(30), lmsr({ q_yes: 3_000_000n, q_no: 1_000_000n })],
            [key(31), position(OURS, 1, 3_000_000n)],
            [key(32), position(OURS, 0, 1_000_000n)],
        ], { [key(41)]: 5_000_000n });
        expect(result.steps.map(s => [s.action, s.signer, s.returns.map(r => r.usdc)])).toEqual([
            ['resolve_lmsr', null, []],
            ['claim_lmsr', OURS, [3_000_000n]],
            ['reclaim_seed', OURS_2, [2_000_000n]],
        ]);
        expect(result.unrecoverable).toEqual([expect.objectContaining({ account: key(32), reason: expect.stringMatching(/NO loses \(outcome YES\)/) })]);
    });

    it('resolves an Active agreement\'s kind 0 market as NO after grace without expiring a foreign agreement', () => {
        const result = plan([
            [key(20), agreement(NEW, { authority: FOREIGN, deadline: BigInt(NOW - 10) })],
            [key(30), lmsr({ q_no: 1_000_000n })],
            [key(31), position(OURS, 0, 1_000_000n)],
        ], { [key(41)]: 1_500_000n });
        expect(result.steps.map(s => s.action)).toEqual(['resolve_lmsr', 'claim_lmsr', 'reclaim_seed']);
    });

    it('proposes NO by absence for a recipe market and claims only after the 48 h challenge window', () => {
        const result = plan([
            [key(30), lmsr({ kind: 1, proposal: '11111111111111111111111111111111', q_no: 4n })],
            [key(31), position(OURS, 0, 4n)],
        ], { [key(41)]: 10n });
        expect(result.steps.map(s => [s.action, s.when])).toEqual([
            ['resolve_lmsr', 'now'], ['finalize_lmsr', 'later'], ['claim_lmsr', 'later'], ['reclaim_seed', 'later'],
        ]);
        expect(result.steps[1].at).toBe(NOW + 48 * 3600 + 1);
    });
});

describe('buildPlan: donations', () => {
    const escrow = (agreementKey, beneficiary) => account(OLD.pledge, 'DonationEscrow', { proposal: agreementKey, beneficiary, mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', vault: key(42) });
    const donation = (owner, amount) => account(OLD.pledge, 'DonationPosition', { escrow: key(50), owner, amount });

    it('refunds our donations once the agreement is cancelled, never a foreign donor\'s', () => {
        const result = plan([
            [key(20), agreement(OLD, { authority: FOREIGN, status: 'Cancelled' })],
            [key(50), escrow(key(20), FOREIGN)],
            [key(51), donation(OURS, 2_000_000n)],
            [key(52), donation(FOREIGN, 9_000_000n)],
        ], { [key(42)]: 11_000_000n });
        expect(result.steps.map(s => [s.action, s.target, s.signer])).toEqual([['refund_donation', key(51), OURS]]);
    });

    it('releases an executed agreement\'s donations when we are its sponsor', () => {
        const result = plan([
            [key(20), agreement(OLD, { authority: OURS, status: 'Executed' })],
            [key(50), escrow(key(20), OURS)],
            [key(51), donation(OURS_2, 2_000_000n)],
        ], { [key(42)]: 2_000_000n });
        expect(result.steps.map(s => [s.action, s.returns[0].wallet, s.returns[0].usdc])).toEqual([['release_donations', OURS, 2_000_000n]]);
    });
});

describe('buildPlan: proposal_nft and ugt', () => {
    const proposal = value => account(PROPOSAL_NFT, 'Proposal', { status: 'Active', parcel_ids: ['p1'], lens: [FOREIGN], ...value });
    const UGT = GENERATIONS.find(g => g.name === 'ugt');

    it('returns a proposal\'s locked SOL to our owner: cancel while Active, reclaim once Expired, distribute an executed one without accepted parcels', () => {
        const result = plan([
            [key(60), proposal({ owner: OURS, sol_balance: 5_000_000n })],
            [key(61), proposal({ owner: OURS_2, status: 'Expired', sol_balance: 3n })],
            [key(62), proposal({ owner: OURS, status: 'Executed', sol_balance: 4n })],
            [key(63), proposal({ owner: OURS, sol_balance: 0n })],
        ]);
        expect(result.steps.map(s => [s.action, s.target, s.signer, s.returns[0].lamports])).toEqual([
            ['cancel_and_refund', key(60), OURS, 5_000_000n],
            ['reclaim_expired_funds', key(61), OURS_2, 3n],
            ['distribute_funds', key(62), null, 4n],
        ]);
        expect(result.steps[2].remaining).toEqual([{ pubkey: OURS, isWritable: true }]);
    });

    it('leaves a foreign owner\'s proposal alone and reports an executed one with acceptance records as not planned', () => {
        const result = plan([
            [key(60), proposal({ owner: FOREIGN, sol_balance: 5n })],
            [key(61), proposal({ owner: OURS, status: 'Executed', accepted_parcels: ['p1'], sol_balance: 6n })],
        ]);
        expect(result.steps).toEqual([]);
        expect(result.foreign).toEqual([expect.objectContaining({ account: key(60), lamports: 5n })]);
        expect(result.unrecoverable).toEqual([expect.objectContaining({ account: key(61), lamports: 6n, reason: expect.stringMatching(/1 accepted parcel/) })]);
    });

    it('cancels our own Pending agreement on the ugt program', () => {
        const result = plan([[key(70), agreement(UGT, { authority: OURS, deadline: BigInt(NOW + 60), escrow_lamports: 9n })]]);
        expect(result.steps).toEqual([expect.objectContaining({ action: 'cancel', program: UGT.agreement, signer: OURS })]);
    });
});

describe('selectSteps and stepDone', () => {
    const steps = [
        { id: 'expire:a', action: 'expire', program: OLD.agreement, when: 'now', dependsOn: [] },
        { id: 'resolve:m', action: 'resolve', program: OLD.market, when: 'now', dependsOn: ['expire:a'] },
        { id: 'claim:p', action: 'claim', program: OLD.market, when: 'now', dependsOn: ['resolve:m'] },
        { id: 'refund:d', action: 'refund_donation', program: NEW.pledge, when: 'now', dependsOn: [] },
    ];
    it('--only market keeps the agreement step it depends on; --max takes a dependency-closed prefix', () => {
        expect(selectSteps(steps, { only: ['market'] }).map(s => s.id)).toEqual(['expire:a', 'resolve:m', 'claim:p']);
        expect(selectSteps(steps, { only: ['GDYn'], max: 2 }).map(s => s.id)).toEqual(['expire:a', 'resolve:m']);
        expect(selectSteps(steps, { only: ['pledge'] }).map(s => s.id)).toEqual(['refund:d']);
        // --simulate bundles one step with its prerequisites.
        expect(selectSteps(steps, { ids: ['claim:p'] }).map(s => s.id)).toEqual(['expire:a', 'resolve:m', 'claim:p']);
    });
    it('judges a step done by the on-chain account, not by the state file', () => {
        expect(stepDone({ action: 'claim' }, { data: { claimed: true } })).toBe(true);
        expect(stepDone({ action: 'claim' }, { data: { claimed: false } })).toBe(false);
        expect(stepDone({ action: 'expire' }, { data: { status: 'Expired' } })).toBe(true);
        expect(stepDone({ action: 'resolve_lmsr' }, { data: { resolved: false, resolved_at: 5n } })).toBe(true);
        expect(stepDone({ action: 'reclaim_seed' }, { data: { resolved: true, q_yes: 0n, q_no: 3n, outcome: 0, paid_out: 0n } }, 3n)).toBe(true);
        expect(stepDone({ action: 'reclaim_seed' }, { data: { resolved: true, q_yes: 0n, q_no: 3n, outcome: 0, paid_out: 0n } }, 5n)).toBe(false);
    });
});
