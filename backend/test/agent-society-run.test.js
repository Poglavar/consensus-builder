// The society runner's pure pieces: multi-turn run ids and seeds, invocation caps across turns,
// persona loading, the optional LLM choice parser, and the lifecycle-01 lens member wiring.
import { describe, expect, it } from 'vitest';
import { MAX_SOCIETY_TURNS, societyBudget, societyPolicy, societyTurnSpent, societyTurns } from '../agents/run-policy.js';
import { buildChoiceRequest, parseChoice } from '../agents/society-llm.js';
import { createAgentLlm } from '../agents/llm-picker.js';
import { loadSocietyPersona } from '../agents/society-run.mjs';
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

    it('bounds the whole invocation: spent turns shrink the budget of the next', () => {
        const policy = societyPolicy({ AGENT_SOCIETY_ACTION_CAP: '3', AGENT_SOCIETY_USDC_CAP: '0.02' });
        expect(societyPolicy({})).toEqual({ maxActions: 4, maxUsdc: 0.05 });
        const firstTurn = { society: { acted: true, action: { type: 'stake', side: 'no', usdc: 0.01 }, execution: { createSignature: 'c', stakeSignature: 's' } } };
        const replayed = { society: { acted: false, action: { type: 'pledge', usdc: 0.05 }, execution: { signature: null, replayed: true } } };
        const used = societyTurnSpent(firstTurn);
        expect(used).toEqual({ actions: 2, usdc: 0.01 });
        expect(societyTurnSpent(replayed)).toEqual({ actions: 0, usdc: 0 });
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
