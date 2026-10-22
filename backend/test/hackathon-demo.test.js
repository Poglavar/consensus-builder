// Headless tests for the judge-facing demo model (frontend/js/hackathon-demo.js): every card is earned
// from public live evidence (agent runs, the activity feed, docs/agents.json, the oracle), and the two
// cases followed end to end are agreements, by CID, with their signed transactions on devnet Explorer.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGREEMENT_EXECUTED_EVENT_TYPE, AGREEMENT_LIFECYCLE_EVENT_TYPE } from '../oracle/agreement-lifecycle.js';

const require = createRequire(import.meta.url);
const demo = require('../../frontend/js/hackathon-demo.js');
const { parseActivityLink } = require('../../frontend/js/agent-action-engine.js');

const AGREEMENT = 'bafkreiftzbz2gpufkdckedn2fgb6jiq3qxd6zeohfzmgm42rysek3kuf7y';
const EXECUTED = 'bafkreigb4spdl37uquwgdhzpvjfwicwgthlv2finkq5zibibrx66yk2eha';
const DESIGN = 'bafkreiehkrtqnkc7fjuviaz4oyqis7wexv3zsq3vfzknyf43rc5qvygce4';
// The MCP tools an outside agent needs for the whole loop on agreements (docs/agents.json mcp.tools).
const LOOP_TOOLS = ['ugt_publish_design', 'ugt_propose_agreement', 'ugt_mint_agreement', 'ugt_bet_on_agreement',
    'ugt_pledge', 'ugt_donate', 'ugt_buy_verified_fact'];

describe('hackathon demo evidence model', () => {
    const docs = {
        x402: {
            enabled: true, priceOracleFact: '$0.01',
            network: 'solana:devnet', facilitatorUrl: 'https://facilitator'
        },
        endpoints: {
            oracleFact: 'https://api.example/agent/oracle/facts?subject={agreementAccount}',
            oracleFactDiscovery: 'https://api.example/agent/discovery?resource=oracle-facts'
        },
        market: { programId: 'market-program' }, support: { programId: 'support-program' },
        mcp: {
            source: 'backend/agents/mcp-server.mjs',
            tools: ['ugt_capabilities', ...LOOP_TOOLS, 'ugt_claim_market']
        },
        oracle: {
            externalMarket: {
                status: 'live_devnet', proofMarket: 'external-market',
                proofResolution: 'resolution-transaction', proofClaim: 'claim-transaction',
                proof: {
                    recipeHash: 'aa'.repeat(32), yesStakeAtomic: '10000',
                    chronology: { classification: 'retrospective_integration', prospective: false }
                },
                prospectiveProof: {
                    status: 'market_open_awaiting_post_close_evidence',
                    market: 'prospective-market', closesAt: '2026-09-22T21:00:00.000Z'
                }
            }
        }
    };

    const proposer = { id: 'r1', persona: 'densifier-01', role: 'proposer', controller: 'algorithm', status: 'done', stage: 'minted', updatedAt: '2026-09-21T02:05:00Z', modelCostUsd: 0 };

    it('marks a recent completed deterministic proposer and its minted agreement as fresh evidence', () => {
        const model = demo.buildDemoModel({
            now: '2026-09-21T12:00:00Z', docs, runs: [proposer],
            events: [
                { recordedAt: '2026-09-21T02:04:00Z', action: { type: 'propose', agreementCid: AGREEMENT }, entity: { type: 'agreement', id: AGREEMENT } },
                { recordedAt: '2026-09-21T02:05:00Z', action: { type: 'mint', agreementCid: AGREEMENT }, entity: { type: 'agreement', id: AGREEMENT }, transaction: 'tx1' }
            ]
        });
        expect(model.algorithm).toMatchObject({ tone: 'success', label: 'Fresh deterministic run completed' });
        expect(model.evidence).toMatchObject({
            tone: 'success', latestAgreementCid: AGREEMENT, latestTransaction: 'tx1', detail: `Latest minted agreement: ${AGREEMENT}`
        });
        expect(model.proofChecks).toContainEqual({ label: 'Agent agreement on-chain', status: 'success' });
    });

    it('does not count a published design or an unminted agreement as an agent agreement on chain', () => {
        const model = demo.buildDemoModel({
            now: '2026-09-21T12:00:00Z', docs, runs: [proposer],
            events: [
                { recordedAt: '2026-09-21T02:03:00Z', action: { type: 'design', designCid: DESIGN }, entity: { type: 'design', id: DESIGN } },
                { recordedAt: '2026-09-21T02:04:00Z', action: { type: 'propose', agreementCid: AGREEMENT }, entity: { type: 'agreement', id: AGREEMENT } },
                { recordedAt: '2026-09-21T02:05:00Z', action: { type: 'stake', agreementCid: AGREEMENT }, entity: { type: 'agreement', id: AGREEMENT }, transaction: 'stake-tx' }
            ]
        });
        expect(model.proofChecks).toContainEqual({ label: 'Agent agreement on-chain', status: 'waiting' });
        expect(model.evidence).toMatchObject({
            tone: 'success', latestAgreementCid: null, latestTransaction: 'stake-tx',
            detail: 'No agreement mint was returned by the live activity endpoint.'
        });
    });

    it('does not call hosted-facilitator configuration a verified catalog listing', () => {
        const model = demo.buildDemoModel({ docs, oracleDiscovery: { state: 'not-listed' } });
        expect(model.oracleFacts).toMatchObject({ tone: 'waiting', label: 'Paid fact live; Bazaar indexing pending', detail: '$0.01 per fact · not-listed' });
        const unconfigured = demo.buildDemoModel({ docs: { ...docs, x402: { enabled: false } } });
        expect(unconfigured.oracleFacts).toMatchObject({ tone: 'waiting', label: 'Paid fact endpoint not configured' });
    });

    it('reports paid oracle-fact discovery from its own Bazaar listing', () => {
        const model = demo.buildDemoModel({
            docs,
            oracleDiscovery: {
                state: 'listed', verifiedAt: '2026-09-21T12:01:00Z',
                listing: { resource: 'https://api.example/agent/oracle/facts' }
            }
        });
        expect(model.oracleFacts).toMatchObject({
            tone: 'success',
            label: 'Paid verified facts listed in Bazaar',
            detail: expect.stringContaining('$0.01 per fact')
        });
    });

    it('surfaces the clean-room second-wallet x402 proof from the public manifest', () => {
        const model = demo.buildDemoModel({
            docs,
            oracleDiscovery: { state: 'listed', listing: { resource: 'https://api.example/agent/oracle/facts' } },
            proofManifest: { publicProof: { independentX402: {
                transaction: 'independent-payment', transactionUrl: 'https://explorer/independent-payment'
            } } }
        });
        expect(model.oracleFacts).toMatchObject({
            tone: 'success', label: 'Independent agent discovered, paid and verified a fact',
            independentProof: { transaction: 'independent-payment' }
        });
        expect(model.oracleFacts.detail).toContain('clean-room client');
    });

    it('reports the shared outside-agent tool surface from public metadata', () => {
        const model = demo.buildDemoModel({ docs });
        expect(model.agentTools).toMatchObject({
            tone: 'success', label: '9 MCP tools share one action layer',
            source: 'backend/agents/mcp-server.mjs'
        });
        // Without the tool that mints an agreement the loop is not complete.
        const partial = demo.buildDemoModel({ docs: { ...docs, mcp: { ...docs.mcp, tools: docs.mcp.tools.filter(tool => tool !== 'ugt_mint_agreement') } } });
        expect(partial.agentTools).toMatchObject({ tone: 'waiting', label: 'Agent tool package unavailable', source: null });
        // The tools docs/agents.json serves (routes/docs.js MCP_TOOLS) are the complete surface.
        const served = readFileSync(new URL('../routes/docs.js', import.meta.url), 'utf8').match(/const MCP_TOOLS = Object\.freeze\(\[([\s\S]*?)\]\);/);
        expect(served).not.toBeNull();
        const tools = [...served[1].matchAll(/'([a-z_]+)'/g)].map(match => match[1]);
        expect(tools).toEqual(expect.arrayContaining(LOOP_TOOLS));
        expect(demo.buildDemoModel({ docs: { ...docs, mcp: { ...docs.mcp, tools } } }).agentTools.tone).toBe('success');
    });

    it("surfaces an agreement's terminal lifecycle event as source-backed oracle evidence", () => {
        // What the lifecycle oracle writes and /oracle/events serves.
        const lifecycle = outcome => ({
            eventType: AGREEMENT_LIFECYCLE_EVENT_TYPE, outcome, observedAt: '2026-09-20T01:00:00Z',
            subject: { id: 'agreement-account' }, source: { transactionUrl: 'https://explorer/tx' }
        });
        expect(demo.buildDemoModel({ docs, oracleEvents: [lifecycle('cancelled')] }).oracle).toMatchObject({
            tone: 'success', label: 'Cancelled agreement event recorded', detail: 'agreement-account · observed 2026-09-20T01:00:00Z'
        });
        expect(demo.buildDemoModel({ docs, oracleEvents: [lifecycle('expired')] }).oracle.label).toBe('Expired agreement event recorded');
        expect(demo.buildDemoModel({ docs, oracleEvents: [lifecycle('executed')] }).oracle.label).toBe('Executed agreement event recorded');
        // An executed agreement's per-parcel entries are parcel history, not its lifecycle event.
        const parcelOnly = demo.buildDemoModel({ docs, oracleEvents: [{ ...lifecycle('executed'), eventType: AGREEMENT_EXECUTED_EVENT_TYPE }] });
        expect(parcelOnly.oracle).toMatchObject({ tone: 'waiting', label: 'Waiting for a terminal agreement event', event: null });
    });

    it('shows external public records separately from agreement-market resolution', () => {
        const model = demo.buildDemoModel({
            docs,
            publicRecords: {
                attestations: 62, decisions: 29, parcels: 60,
                v2: { status: 'live_devnet', attestations: 5 },
                schemaUrl: 'https://explorer.solana.com/address/schema?cluster=devnet'
            }
        });
        expect(model.publicRecords).toMatchObject({
            tone: 'success', label: '62 court attestations on Solana',
            detail: expect.stringContaining('5 source-timed V2')
        });
        expect(model.oracle).toMatchObject({ tone: 'waiting', event: null });
    });

    it('surfaces the live external market lifecycle from public agent metadata', () => {
        const model = demo.buildDemoModel({ docs });
        expect(model.externalMarket).toEqual({
            tone: 'success',
            label: 'Court evidence settled a two-sided integration proof',
            detail: expect.stringContaining('prospective V2 market open'),
            market: 'external-market',
            resolution: 'resolution-transaction',
            claim: 'claim-transaction',
            proof: {
                recipeHash: 'aa'.repeat(32), yesStakeAtomic: '10000',
                chronology: { classification: 'retrospective_integration', prospective: false }
            },
            prospective: false,
            chronology: { classification: 'retrospective_integration', prospective: false },
            evidence: null,
            nextProof: {
                status: 'market_open_awaiting_post_close_evidence',
                market: 'prospective-market', closesAt: '2026-09-22T21:00:00.000Z'
            }
        });
    });

    it('puts the redacted prospective resolver state into its own live model', () => {
        const model = demo.buildDemoModel({
            docs,
            prospectiveMarket: {
                state: 'awaiting_evidence', market: 'prospective-market', marketUrl: 'https://explorer/market',
                recipeHash: `sha256:${'b'.repeat(64)}`, closesAt: '2026-09-22T21:00:00.000Z',
                stakes: { yes: 0.01, no: 0.01, pool: 0.02 },
                resolver: { cadence: 'hourly at minute 45', lastRun: { endedAt: '2026-09-22T21:45:00Z' } }
            }
        });
        expect(model.prospectiveMarket).toMatchObject({
            tone: 'success', state: 'awaiting_evidence',
            label: 'Trading closed; waiting for matching later evidence', market: 'prospective-market'
        });
        expect(model.proofChecks).toContainEqual({ label: 'Two-sided market', status: 'success' });
    });

    it('promotes a settled prospective run to the main verified story automatically', () => {
        const settlement = {
            outcome: 'YES', evidence: { address: 'evidence-account', hash: `sha256:${'d'.repeat(64)}` },
            transactions: { evidenceFirstSeen: 'first-seen', resolution: 'resolution-v2', claim: 'claim-v2' },
            chronology: {
                classification: 'prospective', prospective: true,
                timestamps: {
                    marketCreatedAt: '2026-09-22T19:00:00Z', yesStakeAt: '2026-09-22T19:01:00Z',
                    noStakeAt: '2026-09-22T19:02:00Z', marketClosesAt: '2026-09-22T21:00:00Z',
                    sourceObservedAt: '2026-09-22T21:10:00Z', evidenceCreatedAt: '2026-09-22T21:20:00Z',
                    resolvedAt: '2026-09-22T21:30:00Z', claimedAt: '2026-09-22T21:31:00Z'
                }
            }
        };
        const model = demo.buildDemoModel({
            docs,
            prospectiveMarket: {
                state: 'settled', market: 'prospective-market', marketUrl: 'https://explorer/market',
                closesAt: '2026-09-22T21:00:00Z', stakes: { pool: 0.02 }, settlement
            }
        });
        expect(model.prospectiveMarket).toMatchObject({ state: 'settled', settlement });
        expect(model.externalMarket).toMatchObject({
            prospective: true, market: 'prospective-market', resolution: 'resolution-v2',
            claim: 'claim-v2', evidence: { address: 'evidence-account' }
        });
    });

    it('does not relabel an LLM run as algorithmic evidence', () => {
        const model = demo.buildDemoModel({
            now: '2026-09-21T12:00:00Z', docs,
            runs: [{ id: 'llm', persona: 'densifier-01', role: 'proposer', controller: 'llm', status: 'done', updatedAt: '2026-09-21T02:00:00Z' }]
        });
        expect(model.algorithm).toMatchObject({ tone: 'waiting', run: null });
        expect(model.latestLlm.id).toBe('llm');
    });

    it('reports supporter evidence independently of proposer evidence', () => {
        const model = demo.buildDemoModel({
            now: '2026-09-21T12:00:00Z', docs,
            runs: [{
                id: 'support', persona: 'supporter-01', role: 'supporter', controller: 'algorithm',
                status: 'done', updatedAt: '2026-09-21T02:15:00Z',
                support: { type: 'pledge', agreementCid: AGREEMENT, account: 'agreement-account', signature: 'support-tx' }
            }]
        });
        expect(model.algorithm.run).toBeNull();
        expect(model.supporter).toMatchObject({
            tone: 'success', detail: `supporter-01 · pledge · agreement ${AGREEMENT}`,
            transaction: 'support-tx', agreementCid: AGREEMENT
        });
        expect(model.programs).toEqual({ market: 'market-program', support: 'support-program' });
    });

    it('presents one aggregate case without treating partial branches as complete', () => {
        const model = demo.buildDemoModel({
            docs,
            canonicalCase: {
                id: AGREEMENT, state: 'in_progress',
                agreement: { cid: AGREEMENT, name: 'Three-parcel courtyard', status: 'active' },
                parcelSet: { parcelCount: 3 }, progress: { complete: 2, total: 7 },
                stages: [{ id: 'forecast', label: 'Forecast', state: 'partial', detail: 'YES only.' }],
                links: { map: `https://site.example/agreements/${AGREEMENT}`, self: `https://api.example/hackathon/cases/${AGREEMENT}` }
            }
        });
        expect(model.canonicalCase).toMatchObject({
            tone: 'waiting', state: 'in_progress', label: 'Three-parcel courtyard', lifecycle: 'active',
            detail: '3 real cadastral parcels · 2/7 independently verified stages'
        });
    });
});

// The smallest DOM render() needs: elements that hold children and an owner document.
function renderInto(model) {
    const doc = {
        createElement: tagName => ({
            tagName: tagName.toUpperCase(), children: [], className: '', textContent: '',
            classList: { add() {} }, append(...nodes) { this.children.push(...nodes); },
            replaceChildren(...nodes) { this.children = nodes; }, addEventListener() {},
            all() { return this.children.flatMap(child => [child, ...child.all()]); }
        })
    };
    const element = doc.createElement('main');
    element.ownerDocument = doc;
    demo.render(element, model, { apiBase: 'https://api.example' });
    return element;
}

describe('hackathon demo executed case card', () => {
    const actor = id => ({ id });
    const action = (type, extra = {}) => ({ type, agreementCid: EXECUTED, ...extra });
    // One case of routes/hackathon-cases.js: an agreement by its CID, its stages and its activity.
    const executed = {
        id: EXECUTED, state: 'complete',
        agreement: { cid: EXECUTED, name: 'Two-parcel infill', status: 'executed' },
        parcelSet: { parcelCount: 2 }, progress: { complete: 7, total: 7 },
        branches: { forecast: { exists: true, resolved: true, outcome: 'YES' } },
        stages: [{ id: 'resolution', label: 'Permissionless resolution', state: 'complete', detail: 'Market resolved YES.' }],
        links: { map: `https://site.example/agreements/${EXECUTED}`, self: `https://api.example/hackathon/cases/${EXECUTED}` },
        activity: [
            { actor: actor('densifier'), action: action('propose') },
            { actor: actor('densifier'), action: action('claim', { side: 'yes' }), transaction: 'tx-claim' },
            { actor: actor('supporter'), action: action('claim', { side: 'no' }), transaction: 'tx-no-claim' },
            { actor: actor('densifier'), action: action('execute'), transaction: 'tx-execute' },
            { actor: actor('densifier'), action: action('attest'), transaction: 'tx-attest' },
            { actor: actor('densifier'), action: action('decide') },
            { actor: actor('densifier'), action: action('mint'), transaction: 'tx-mint' },
            { actor: actor('densifier'), action: action('fund'), transaction: 'tx-fund-failed', ok: false },
            { actor: actor('densifier'), action: action('fund'), transaction: 'tx-fund' },
            { actor: actor('supporter'), action: action('stake', { side: 'yes' }), transaction: 'tx-stake' },
            { actor: actor('supporter'), action: action('resolve'), transaction: 'tx-resolve' },
            { actor: actor('supporter'), action: action('releaseDonations'), transaction: 'tx-release' },
            { actor: actor('supporter'), action: action('fulfillPledge'), transaction: 'tx-fulfil' }
        ]
    };

    it('lists only signed, successful agreement and settlement actions, in lifecycle order, as devnet Explorer links', () => {
        const txs = demo.caseTransactions(executed);
        expect(txs.map(tx => tx.signature)).toEqual(['tx-mint', 'tx-fund', 'tx-attest', 'tx-execute', 'tx-resolve', 'tx-release', 'tx-fulfil', 'tx-claim']);
        expect(txs[0]).toMatchObject({ type: 'mint', label: 'Agreement minted', url: 'https://explorer.solana.com/tx/tx-mint?cluster=devnet' });
        expect(txs.map(tx => tx.label).slice(1, 4)).toEqual(['Escrow funded', 'Decision recorded', 'Execution']);
        expect(txs.at(-1).label).toBe('YES claim');
        // A cancelled or expired agreement lists its end the same way.
        const expired = { activity: [{ action: action('expire'), transaction: 'tx-expire' }, { action: action('cancel'), transaction: 'tx-cancel' }] };
        expect(demo.caseTransactions(expired).map(tx => tx.label)).toEqual(['Cancellation', 'Expiry']);
        // An agreement action is the agreement's, never a parcel's: a stray parcelId names nothing.
        const stray = { activity: [{ action: action('execute', { parcelId: 'HR-335614-1754/1' }), transaction: 'tx-execute' }] };
        expect(demo.caseTransactions(stray).map(tx => tx.label)).toEqual(['Execution']);
    });

    it('marks a complete executed case live with its lifecycle and market outcome', () => {
        const model = demo.buildDemoModel({ docs: {}, executedCase: executed, proofManifest: { publicProof: { executedCase: 'https://api/x' } } });
        expect(model.executedCase).toMatchObject({
            tone: 'success', state: 'complete', label: 'Two-parcel infill', lifecycle: 'executed', marketOutcome: 'YES',
            detail: '2 real cadastral parcels · 7/7 independently verified stages'
        });
        expect(model.executedCase.transactions).toHaveLength(8);
    });

    it("links a case to every action on its agreement in the map's explorer", () => {
        const model = demo.buildDemoModel({ docs: {}, executedCase: executed, proofManifest: { publicProof: { executedCase: 'https://api/x' } } });
        const element = renderInto(model);
        const links = element.all().filter(node => node.tagName === 'A');
        const explorer = links.find(link => link.textContent === 'Every action in the explorer');
        const activity = new URL(explorer.href, 'https://site.example').searchParams.get('activity');
        expect(parseActivityLink(activity)).toEqual({ agreementCid: EXECUTED });
        expect(links.find(link => link.textContent === 'Open on the map').href).toBe(`https://site.example/agreements/${EXECUTED}`);
        expect(links.filter(link => link.textContent === 'Agreement minted').map(link => link.href)).toEqual(['https://explorer.solana.com/tx/tx-mint?cluster=devnet']);
    });

    it('keeps an incomplete executed case pending rather than successful', () => {
        const partial = { ...executed, state: 'in_progress', branches: { forecast: { exists: true, resolved: false } } };
        const model = demo.buildDemoModel({ docs: {}, executedCase: partial });
        expect(model.executedCase).toMatchObject({ tone: 'waiting', state: 'in_progress', marketOutcome: 'Unresolved' });
    });

    it('stays pending when the manifest declares no executed case, and errors when the fetch failed', () => {
        expect(demo.buildDemoModel({ docs: {}, proofManifest: { publicProof: {} } }).executedCase).toMatchObject({
            tone: 'waiting', state: 'pending', label: 'Executed case pending',
            detail: 'The proof manifest does not declare an executed case yet.', transactions: []
        });
        expect(demo.buildDemoModel({ docs: {}, errors: { executedCase: 'returned 500' } }).executedCase).toMatchObject({
            tone: 'error', state: 'unavailable', label: 'Executed case unavailable', detail: 'returned 500'
        });
    });

    it('does not fetch an executed case the manifest does not declare', async () => {
        const previous = globalThis.fetch;
        const requested = [];
        globalThis.fetch = async url => {
            requested.push(url);
            const body = url.endsWith('/hackathon/proof.json') ? { publicProof: { canonicalCase: 'https://api/cases/golden' } } : {};
            return { ok: true, json: async () => body };
        };
        try {
            const { values } = await demo.fetchEvidence('https://api');
            expect(requested).toContain('https://api/cases/golden');
            expect(requested.some(url => url.includes('executed'))).toBe(false);
            expect(values.executedCase).toBeUndefined();
        } finally { globalThis.fetch = previous; }
    });

    it('fetches no case at all when the manifest declares none: there is no fallback agreement', async () => {
        const previous = globalThis.fetch;
        const requested = [];
        globalThis.fetch = async url => {
            requested.push(url);
            return { ok: true, json: async () => (url.endsWith('/hackathon/proof.json') ? { publicProof: {} } : {}) };
        };
        try {
            const { values } = await demo.fetchEvidence('https://api');
            expect(requested).toContain('https://api/hackathon/proof.json');
            expect(requested.some(url => url.includes('/cases/'))).toBe(false);
            expect(values.canonicalCase).toBeUndefined();
        } finally { globalThis.fetch = previous; }
    });
});

describe('hackathon demo API base', () => {
    const withLocation = (location, fn) => {
        const previous = globalThis.location;
        globalThis.location = location;
        try { return fn(); } finally { globalThis.location = previous; }
    };

    it('follows dev.sh ?backend= on localhost, but never off localhost or to a foreign host', () => {
        expect(withLocation({ hostname: 'localhost', search: '?backend=http://localhost:4680' }, demo.backendBase)).toBe('http://localhost:4680');
        expect(withLocation({ hostname: 'localhost', search: '' }, demo.backendBase)).toBe('http://localhost:3000');
        expect(withLocation({ hostname: 'localhost', search: '?backend=https://evil.example' }, demo.backendBase)).toBe('http://localhost:3000');
        expect(withLocation({ hostname: 'urbangametheory.xyz', search: '?backend=http://localhost:4680' }, demo.backendBase)).toBe('https://api.urbangametheory.xyz');
    });
});
