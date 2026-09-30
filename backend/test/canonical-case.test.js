import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
    assertAttestedLiveAllowed, attestedCasePlan, attestedCaseSteps, canonicalCaseConfig, canonicalProposalBody,
    canonicalTerminalActions, DEFAULT_CASE_ID, DEFAULT_EXECUTED_CASE_ID, ownerKey
} from '../agents/canonical-case.js';

describe('canonical hackathon case', () => {
    it('defaults to a small plural real-parcel set and low-value devnet actions', () => {
        const config = canonicalCaseConfig();
        expect(config.proposalId).toBe(DEFAULT_CASE_ID);
        expect(config.parcelIds).toHaveLength(3);
        expect(config.parcelIds.every(id => id.startsWith('HR-'))).toBe(true);
        expect(config.amounts).toEqual({ donationUsdc: '0.05', pledgeUsdc: '0.10', yesUsdc: '0.01', noUsdc: '0.01' });
    });

    it('refuses a one-parcel golden case', () => {
        expect(() => canonicalCaseConfig({ parcels: ['HR-1-1'] })).toThrow(/at least two/);
    });

    it('publishes the exact minted parcel set and shared agent provenance', () => {
        const config = canonicalCaseConfig({ proposalId: 'case-1', parcels: ['HR-1-2', 'HR-1-1'] });
        const body = canonicalProposalBody({
            config, runId: 'run-1', proposer: { name: 'planner', wallet: 'wallet' },
            mint: { proposalPda: 'proposal-pda', signature: 'mint-tx' }, apiBase: 'https://api.example.test/'
        });
        expect(body).toMatchObject({
            proposalId: 'case-1', cadastreParcelIds: ['HR-1-2', 'HR-1-1'], isConditional: true,
            facets: { ownership: 'to-city' },
            agent: { persona: 'planner', controller: 'algorithm', run_id: 'run-1' },
            onchain: { proposalId: 'proposal-pda', transactionHash: 'mint-tx' },
            nft: { tokenId: 'proposal-pda' }, isMinted: true
        });
        expect(body.sourceUrl).toBe('https://api.example.test/hackathon/cases/case-1');
    });
});

describe('executed canonical case', () => {
    it('defaults to a second plural real-parcel set with its own public id', () => {
        const config = canonicalCaseConfig({ outcome: 'executed' });
        expect(config.proposalId).toBe(DEFAULT_EXECUTED_CASE_ID);
        expect(config.proposalId).not.toBe(DEFAULT_CASE_ID);
        expect(config.outcome).toBe('executed');
        expect(config.parcelIds).toHaveLength(2);
        expect(config.parcelIds.every(id => id.startsWith('HR-'))).toBe(true);
        expect(config.name).toMatch(/Borovje/);
        expect(config.rationale).toMatch(/accepts/);
    });

    it('keeps the cancelled defaults and text for the golden case', () => {
        const config = canonicalCaseConfig();
        expect(config.outcome).toBe('cancelled');
        expect(config.name).toBe('Borovje three-parcel civic courtyard');
    });

    it('refuses an unknown outcome and lists both terminal action plans', () => {
        expect(() => canonicalCaseConfig({ outcome: 'expired' })).toThrow(/outcome must be one of cancelled, executed/);
        expect(canonicalTerminalActions('cancelled')).toEqual(['cancel', 'resolve', 'refund_donation', 'void_pledge', 'claim_no']);
        expect(canonicalTerminalActions('executed')).toEqual(['certify_parcels', 'accept_parcels', 'resolve', 'release_donations', 'fulfill_pledge', 'claim_yes']);
    });

    it('publishes the case name and rationale from the config', () => {
        const config = canonicalCaseConfig({ outcome: 'executed', name: 'Custom title' });
        const body = canonicalProposalBody({
            config, runId: 'run-2', proposer: { name: 'planner', wallet: 'wallet' },
            mint: { proposalPda: 'pda', signature: 'tx' }, apiBase: 'https://api.example.test'
        });
        expect(body.name).toBe('Custom title');
        expect(body.title).toBe('Custom title');
        expect(body.description).toBe(config.rationale);
        expect(body.agent.rationale).toBe(config.rationale);
    });
});

const CASE_RUN = fileURLToPath(new URL('../agents/canonical-case-run.mjs', import.meta.url));

describe('canonical case v3 (attested) plan', () => {
    const NOTARY = 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ';
    const OWNER_A = 'FoPmPhKE6bykLoumQSvygZCSJYLkxBfsqjE3ybMvSjYs';
    const OWNER_B = 'G4R6RCCcQHN9fLoExvTBBfhbw8BgvTEqhJezG3A1HvEg';

    it('mints with the notary lens, attests every recorded owner and needs one signature per owner', () => {
        const config = canonicalCaseConfig({ outcome: 'attested' });
        expect(config.outcome).toBe('attested');
        expect(canonicalTerminalActions('attested')).toEqual(['anchor_parcels', 'attest_ownership', 'accept_with_attestations', 'verify_executed', 'resolve', 'release_donations', 'fulfill_pledge', 'claim_yes']);
        const [p1, p2] = config.parcelIds;
        const plan = attestedCasePlan({ config, notaryKey: NOTARY, owners: {
            [p1]: { wallets: [OWNER_A], ownerCount: 1, source: 'test' },
            [p2]: { wallets: [OWNER_A, OWNER_B], ownerCount: 2, source: 'test' }
        } });
        expect(plan.lens).toEqual([NOTARY]);
        expect(plan.steps[0]).toMatchObject({ action: 'mint', lens: [NOTARY] });
        const attest = plan.steps.filter(step => step.action === 'attest_ownership');
        const accept = plan.steps.filter(step => step.action === 'accept_with_attestations');
        expect(attest.map(step => [step.parcelUid, step.owner, step.ownerCount, step.member])).toEqual([
            [p1, OWNER_A, 1, NOTARY], [p2, OWNER_A, 2, NOTARY], [p2, OWNER_B, 2, NOTARY]
        ]);
        expect(accept.map(step => step.signer)).toEqual([OWNER_A, OWNER_A, OWNER_B]);
        expect(accept[2].recordPda).toEqual(['acceptance', '<proposal>', p2, OWNER_B]);
        expect(plan.steps.find(step => step.action === 'resolve')).toMatchObject({ expect: 'YES' });
        expect(() => attestedCasePlan({ config, notaryKey: NOTARY, owners: {} })).toThrow(/no recorded owner wallets/);
    });

    const owners = (config, wallets = [OWNER_A]) => Object.fromEntries(config.parcelIds.map(id => [id, { wallets, ownerCount: wallets.length, source: 'test' }]));

    it('plans every v3 step in order and marks exactly what the checkpoint holds as done', () => {
        const config = canonicalCaseConfig({ outcome: 'attested' });
        const [p1, p2] = config.parcelIds;
        const fresh = attestedCaseSteps({ config, notaryKey: NOTARY, owners: owners(config) });
        expect(fresh.map(step => step.action)).toEqual([
            'mint', 'x402_publish', 'donate', 'pledge', 'forecast_yes', 'forecast_no',
            'anchor_parcel', 'anchor_parcel', 'attest_ownership', 'attest_ownership',
            'accept_with_attestations', 'accept_with_attestations',
            'verify_executed', 'resolve', 'release_donations', 'fulfill_pledge', 'claim_yes'
        ]);
        expect(fresh.every(step => step.done === false)).toBe(true);
        expect(fresh.find(step => step.action === 'mint').lens).toEqual([NOTARY]);

        // A run that stopped after attesting p1 and accepting nothing resumes at p2's attestation.
        const caseState = {
            mint: { proposalPda: 'pda' }, publish: { proposalId: config.proposalId }, donation: {}, pledge: {}, yes: {}, no: {},
            anchors: { [p1]: {}, [p2]: {} }, attestations: { [ownerKey(p1, OWNER_A)]: { address: 'att-1' } }
        };
        const pending = attestedCaseSteps({ config, notaryKey: NOTARY, owners: owners(config), caseState }).filter(step => !step.done);
        expect(pending.map(step => [step.action, step.parcelUid ?? null])).toEqual([
            ['attest_ownership', p2], ['accept_with_attestations', p1], ['accept_with_attestations', p2],
            ['verify_executed', null], ['resolve', null], ['release_donations', null], ['fulfill_pledge', null], ['claim_yes', null]
        ]);
        const finished = attestedCaseSteps({ config, notaryKey: NOTARY, owners: owners(config), caseState: {
            ...caseState, attestations: { [ownerKey(p1, OWNER_A)]: { address: 'a' }, [ownerKey(p2, OWNER_A)]: { address: 'b' } },
            ownerAcceptances: { [ownerKey(p1, OWNER_A)]: {}, [ownerKey(p2, OWNER_A)]: {} },
            executed: {}, resolution: {}, release: {}, fulfilment: {}, claim: {}
        } });
        expect(finished.filter(step => !step.done)).toEqual([]);
    });

    it('refuses an owner set that cannot reach its own ownerCount', () => {
        const config = canonicalCaseConfig({ outcome: 'attested' });
        const [p1, p2] = config.parcelIds;
        expect(() => attestedCaseSteps({ config, notaryKey: NOTARY, owners: {
            [p1]: { wallets: [OWNER_A], ownerCount: 1, source: 't' }, [p2]: { wallets: [OWNER_A], ownerCount: 2, source: 't' }
        } })).toThrow(/every attested owner must sign/);
    });

    it('refuses a live v3 run until LENS_V2_DEPLOYED=1', () => {
        expect(() => assertAttestedLiveAllowed({})).toThrow(/NOT deployed to devnet[\s\S]*LENS_V2_DEPLOYED=1/);
        expect(() => assertAttestedLiveAllowed({ LENS_V2_DEPLOYED: 'true' })).toThrow(/LENS_V2_DEPLOYED=1/);
        expect(() => assertAttestedLiveAllowed({ LENS_V2_DEPLOYED: '1' })).not.toThrow();
    });

    it('prints the full v3 plan in a dry run and refuses to run it live before touching anything', () => {
        const out = execFileSync(process.execPath, [CASE_RUN, '--dry-run', '--outcome', 'attested', '--lens', NOTARY], { encoding: 'utf8', env: { ...process.env, LENS_V2_DEPLOYED: '' } });
        const plan = JSON.parse(out);
        expect(plan.lens).toMatchObject({ keys: [NOTARY], source: 'explicit' });
        expect(plan.steps.filter(step => step.action === 'accept_with_attestations')).toHaveLength(plan.parcels.length);
        expect(plan.steps.map(step => step.action)).toEqual(expect.arrayContaining(['mint', 'anchor_parcel', 'attest_ownership', 'verify_executed', 'claim_yes']));
        expect(plan.live).toMatchObject({ gate: 'LENS_V2_DEPLOYED=1', allowed: false });
        let failed = null;
        try {
            // PGPORT 9: were the gate to let it through, the run would fail on the database instead.
            execFileSync(process.execPath, [CASE_RUN, '--live', '--outcome', 'attested', '--lens', NOTARY], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, LENS_V2_DEPLOYED: '', PGHOST: '127.0.0.1', PGPORT: '9' } });
        } catch (error) {
            failed = error;
        }
        expect(failed?.stderr).toMatch(/--outcome attested --live is refused: lens model v2/);
        expect(failed?.stderr).not.toMatch(/ECONNREFUSED/);
    });

    it('shows the chosen lens in the dry-run plan of the existing outcomes, never the proposer alone', () => {
        const explicit = JSON.parse(execFileSync(process.execPath, [CASE_RUN, '--dry-run', '--lens', NOTARY], { encoding: 'utf8' }));
        expect(explicit.lens).toEqual({ keys: [NOTARY], source: 'explicit', why: 'explicit --lens (1 key)' });
        const self = JSON.parse(execFileSync(process.execPath, [CASE_RUN, '--dry-run', '--lens', OWNER_B], { encoding: 'utf8' }));
        expect(self.lens.keys).toEqual([]);
        expect(self.lens.refused).toMatch(/would refuse to mint: .*own key/);
    });
});
