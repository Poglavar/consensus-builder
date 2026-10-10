// The society runner's pure pieces: multi-turn and slotted run ids and seeds, invocation caps across
// turns, persona loading, city discovery, YES/NO stake and claim execution wiring, the optional LLM
// choice parser, and the lifecycle-01 lens member wiring.
import { describe, expect, it } from 'vitest';
import { MAX_SOCIETY_TURNS, societyBudget, societyPolicy, societySlot, societyTurnSpent, societyTurns } from '../agents/run-policy.js';
import { buildChoiceRequest, parseChoice } from '../agents/society-llm.js';
import { createAgentLlm } from '../agents/llm-picker.js';
import { activityMessage, discoveryCities, execute, loadSocietyPersona } from '../agents/society-run.mjs';
import { lensMemberCommand, loadLensMemberPersona } from '../agents/lens-member-run.mjs';

describe('society turns', () => {
    it('keeps the daily run id and seed without --turns', () => {
        expect(societyTurns({ day: '2026-10-01', personaName: 'speculator-01' })).toEqual([
            { turn: null, runId: '2026-10-01-speculator-01', seed: '2026-10-01' }
        ]);
    });

    it('gives turn k its own run id <day>-<persona>-t<k> and seed <day>:t<k>', () => {
        expect(societyTurns({ day: '2026-10-01', personaName: 'preservationist-01', turns: 3 })).toEqual([
            { turn: 1, runId: '2026-10-01-preservationist-01-t1', seed: '2026-10-01:t1' },
            { turn: 2, runId: '2026-10-01-preservationist-01-t2', seed: '2026-10-01:t2' },
            { turn: 3, runId: '2026-10-01-preservationist-01-t3', seed: '2026-10-01:t3' }
        ]);
        expect(() => societyTurns({ day: '2026-10-01', personaName: 'x', turns: 0 })).toThrow(/--turns/);
        expect(() => societyTurns({ day: '2026-10-01', personaName: 'x', turns: MAX_SOCIETY_TURNS + 1 })).toThrow(/--turns/);
        expect(() => societyTurns({ day: 'today', personaName: 'x' })).toThrow(/YYYY-MM-DD/);
    });

    it('slots a second run on the same day into its own run ids and seeds', () => {
        expect(societyTurns({ day: '2026-10-11', personaName: 'backer-01', slot: 'h08' })).toEqual([
            { turn: null, runId: '2026-10-11-h08-backer-01', seed: '2026-10-11:h08' }
        ]);
        expect(societyTurns({ day: '2026-10-11', personaName: 'backer-01', slot: 'h14', turns: 2 })).toEqual([
            { turn: 1, runId: '2026-10-11-h14-backer-01-t1', seed: '2026-10-11:h14:t1' },
            { turn: 2, runId: '2026-10-11-h14-backer-01-t2', seed: '2026-10-11:h14:t2' }
        ]);
        expect(societySlot('auto', new Date('2026-10-11T08:59:00Z'))).toBe('h08');
        expect(societySlot('auto', new Date('2026-10-11T23:00:00Z'))).toBe('h23');
        expect(societySlot('Evening')).toBe('evening');
        expect(societySlot(null)).toBeNull();
        expect(() => societySlot('a b')).toThrow(/--slot/);
        expect(() => societyTurns({ day: '2026-10-11', personaName: 'x', slot: 'bad slot' })).toThrow(/slot/);
    });

    it('bounds the whole invocation: spent turns shrink the budget of the next', () => {
        const policy = societyPolicy({ AGENT_SOCIETY_ACTION_CAP: '3', AGENT_SOCIETY_USDC_CAP: '0.02' });
        expect(societyPolicy({})).toEqual({ maxActions: 4, maxUsdc: 0.05 });
        const firstTurn = { society: { acted: true, action: { type: 'stake', side: 'no', usdc: 0.01 }, execution: { createSignature: 'c', stakeSignature: 's' } } };
        const replayed = { society: { acted: false, action: { type: 'pledge', usdc: 0.05 }, execution: { signature: null, replayed: true } } };
        const used = societyTurnSpent(firstTurn);
        expect(used).toEqual({ actions: 2, usdc: 0.01 });
        expect(societyTurnSpent(replayed)).toEqual({ actions: 0, usdc: 0 });
        const settledClaim = { society: { acted: true, action: { type: 'claim', side: 'no', usdc: 0 }, execution: { resolveSignature: 'r', signature: 'c' } } };
        expect(societyTurnSpent(settledClaim)).toEqual({ actions: 2, usdc: 0 });
        expect(societyBudget(policy, used)).toEqual({ actionsLeft: 1, usdcLeft: 0.01 });
        expect(societyBudget(policy, { actions: 5, usdc: 1 })).toEqual({ actionsLeft: 0, usdcLeft: 0 });
    });
});

describe('society personas', () => {
    it('loads the contrarian and speculator personas with their wallets and keypair paths', () => {
        expect(loadSocietyPersona('preservationist-01')).toMatchObject({
            role: 'contrarian', wallet: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/), keypairPath: '~/.config/solana/ugt-preservationist-01.json', policy: { amountUsdc: '0.01' }
        });
        expect(loadSocietyPersona('speculator-01')).toMatchObject({
            role: 'speculator', wallet: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/), keypairPath: '~/.config/solana/ugt-speculator-01.json'
        });
    });

    it('refuses the core roles, which have their own runners', () => {
        expect(() => loadSocietyPersona('supporter-01')).toThrow(/policies/);
        expect(() => loadSocietyPersona('densifier-01')).toThrow(/policies/);
        expect(() => loadSocietyPersona('nobody')).toThrow(/no persona named/);
    });

    it('runs lifecycle-01 as a lens member whose operator token is the retire phase\'s variable', () => {
        const persona = loadLensMemberPersona('lifecycle-01');
        expect(persona).toMatchObject({ wallet: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/), keypairPath: '~/.config/solana/ugt-lifecycle-01.json', service: { port: 3096, kind: 'lifecycle' } });
        const dry = lensMemberCommand(persona, { sourceEnv: { AGENT_LIFECYCLE_LENS_OPERATOR_TOKEN: 'secret' } });
        expect(dry.args.slice(1, 4)).toEqual(['--dry-run', '--port', '3096']);
        expect(dry.env).toEqual({ LENS_OPERATOR_TOKEN: 'secret' });
        expect(() => lensMemberCommand(persona, { live: true, sourceEnv: {} })).toThrow(/AGENT_LIFECYCLE_LENS_OPERATOR_TOKEN/);
        expect(lensMemberCommand(persona, { sourceEnv: {} }).env).toEqual({});
    });
});

describe('society cities', () => {
    it('reads every city at once for *, an explicit list city by city, and Zagreb by default', () => {
        expect(discoveryCities({ policy: { cities: ['*'] } })).toEqual([null]);
        expect(discoveryCities({ policy: { cities: ['zagreb', '*'] } })).toEqual([null]);
        expect(discoveryCities({ policy: { cities: ['zagreb', 'sibenik', 'zagreb'] } })).toEqual(['zagreb', 'sibenik']);
        expect(discoveryCities({ policy: {} })).toEqual(['zagreb']);
    });
});

describe('society execution wiring', () => {
    const caps = { maxActions: 4, maxUsdc: 0.05 };
    const keypair = { publicKey: 'Owner' };
    function recorder() {
        const calls = [];
        const adapters = {
            ensureMarketAndStake: async args => { calls.push(['stake', args]); return { stakeSignature: 's', replayed: false }; },
            resolveProposalMarket: async args => { calls.push(['resolve', args]); return { signature: 'r', replayed: false, outcome: 'NO' }; },
            claimProposalMarket: async args => { calls.push(['claim', args]); return { signature: 'c', replayed: false, claimed: true }; }
        };
        return { calls, adapters };
    }

    it('stakes YES on side 1 and NO on side 0, both as a target amount so a retry replays', async () => {
        const { calls, adapters } = recorder();
        await execute({ action: { type: 'stake', side: 'yes', amount: '0.02', usdc: 0.02, proposalAccount: 'PDA-a' }, keypair, caps, adapters });
        await execute({ action: { type: 'stake', side: 'no', amount: '0.01', usdc: 0.01, proposalAccount: 'PDA-b' }, keypair, caps, adapters });
        expect(calls.map(([, args]) => [args.proposalPda, args.side, args.amountAtomic, args.targetAmount])).toEqual([
            ['PDA-a', 1, 20000n, true], ['PDA-b', 0, 10000n, true]
        ]);
        await expect(execute({ action: { type: 'stake', side: 'yes', amount: '0.06', usdc: 0.06 }, keypair, caps, adapters })).rejects.toThrow(/USDC_CAP/);
    });

    it('claims, resolving the market first only when the action says so', async () => {
        const plain = recorder();
        const result = await execute({ action: { type: 'claim', side: 'yes', usdc: 0, proposalAccount: 'PDA-w' }, keypair, caps, adapters: plain.adapters });
        expect(plain.calls.map(([name, args]) => [name, args.proposalAccount, args.side])).toEqual([['claim', 'PDA-w', 'yes']]);
        expect(result).toEqual({ resolveSignature: null, outcome: null, signature: 'c', replayed: false });
        const first = recorder();
        const settled = await execute({ action: { type: 'claim', side: 'no', resolveFirst: true, usdc: 0, proposalAccount: 'PDA-t' }, keypair, caps, adapters: first.adapters });
        expect(first.calls.map(([name]) => name)).toEqual(['resolve', 'claim']);
        expect(settled).toMatchObject({ resolveSignature: 'r', signature: 'c', outcome: 'NO', replayed: false });
        const replay = recorder();
        replay.adapters.claimProposalMarket = async () => ({ signature: null, replayed: true, claimed: true });
        expect(await execute({ action: { type: 'claim', side: 'yes', usdc: 0, proposalAccount: 'PDA-w' }, keypair, caps, adapters: replay.adapters })).toMatchObject({ replayed: true });
    });

    it('words a YES bet as backing, a NO bet as opposition, and a claim as collecting', () => {
        const persona = { name: 'backer-01' };
        expect(activityMessage(persona, { type: 'stake', side: 'yes', amount: '0.02', proposalName: 'Pocket park' })).toBe('backer-01 bet YES 0.02 USDC on proposal Pocket park.');
        expect(activityMessage(persona, { type: 'stake', side: 'no', amount: '0.01', proposalName: 'Tower' })).toBe('backer-01 bet NO 0.01 USDC against proposal Tower.');
        expect(activityMessage(persona, { type: 'claim', side: 'no', payout: '0.0125', resolveFirst: true, proposalName: 'Tower' }))
            .toBe('backer-01 collected 0.0125 USDC from its NO bet on proposal Tower after settling its market.');
    });
});

describe('optional LLM choice among policy options', () => {
    const options = [
        { proposalId: 'a', evidence: { detail: 'GFA 4800 m²' }, action: { type: 'stake', side: 'no', amount: '0.01', proposalId: 'a', proposalName: 'A', rationale: 'densest' } },
        { proposalId: 'b', action: { type: 'stake', side: 'no', amount: '0.01', proposalId: 'b', proposalName: 'B', rationale: 'second' } }
    ];

    it('builds one request listing only the options', () => {
        const llm = createAgentLlm({ client: { messages: { create() { throw new Error('no network in tests'); } } } });
        const request = buildChoiceRequest({ llm, runId: '2026-10-01-preservationist-01-t2', persona: { name: 'preservationist-01' }, role: 'contrarian', seed: '2026-10-01:t2', options });
        expect(request.custom_id).toBe('2026-10-01-preservationist-01-t2_preservationist-01');
        expect(JSON.parse(request.params.messages[0].content[0].text).options.map(option => option.optionId)).toEqual(['stake:a', 'stake:b']);
        expect(request.params.system).toMatch(/preservationist/);
    });

    it('accepts a listed option or none, and refuses anything else', () => {
        expect(parseChoice(JSON.stringify({ choice: 'stake:b', rationale: 'smaller but closer to the river' }), options)).toMatchObject({ option: options[1], rejected: null });
        expect(parseChoice(JSON.stringify({ choice: 'none', rationale: 'nothing worth opposing' }), options)).toMatchObject({ option: null, rejected: null });
        expect(parseChoice(JSON.stringify({ choice: 'stake:zzz', rationale: 'x' }), options).rejected).toMatch(/unknown optionId/);
        expect(parseChoice('not json', options).rejected).toMatch(/unparseable/);
        expect(parseChoice(JSON.stringify({ choice: 'stake:a', rationale: '' }), options).rejected).toMatch(/missing rationale/);
    });
});
