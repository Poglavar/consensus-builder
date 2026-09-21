// Judge-facing repository contract: licensing and protocol documentation must remain discoverable
// from the root and must name the same deployed programs as the checked-in Solana workspace.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const PROGRAMS = [
    '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1',
    '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg',
    'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB',
    '1jESRS3mJiPUJTtmQ5ncyBhGNmGeXTpUqPyJcTYrp6g'
];

describe('hackathon repository documentation', () => {
    it('ships a repository-level Apache-2.0 license', () => {
        const license = read('LICENSE');
        expect(license).toContain('Apache License');
        expect(license).toContain('Version 2.0, January 2004');
        expect(license).toContain('Copyright 2026 Urban Game Theory contributors');
    });

    it('links the build, architecture, protocol, and scope from the root readme', () => {
        const readme = read('readme.md');
        for (const target of ['HACKATHON.md', 'docs/architecture.md', 'docs/hackathon-build.md', 'docs/protocol.md']) {
            expect(readme).toContain(target);
        }
        expect(read('docs/architecture.md')).toContain('```mermaid');
        expect(read('docs/hackathon-build.md')).toContain('npm ci');
    });

    it('documents every deployed program and a machine-readable recipe schema', () => {
        const protocol = read('docs/protocol.md');
        const anchor = read('blockchain/solana/Anchor.toml');
        for (const address of PROGRAMS) {
            expect(protocol).toContain(address);
            expect(anchor).toContain(address);
        }
        const schema = JSON.parse(read('backend/oracle/recipe.schema.json'));
        expect(schema.required).toEqual(expect.arrayContaining([
            'id', 'version', 'eventType', 'subject', 'trustedAttesters', 'outcomes', 'verification', 'hash'
        ]));
        expect(protocol).toContain('Evidence adapter interface');
        expect(protocol).toContain('Security and trust assumptions');
    });

    it('ships an honest two-phase runner for prospective evidence', () => {
        const runner = read('blockchain/solana/scripts/prospective-external-market.mjs');
        expect(runner).toContain("choose exactly one phase: --open or --settle");
        expect(runner).toContain('firstAddressTime');
        expect(runner).toContain('buildCourtParcelOperationRecipeV2');
        expect(runner).toContain('assertProspectiveChronology');
        expect(read('docs/hackathon-build.md')).toContain('market.closesAt <= sourceObservedAt <= resolution time');
        const program = read('blockchain/solana/programs/proposal_market/src/lib.rs');
        expect(program).toContain('validate_source_chronology(evidence.source_observed_at, market.closes_at, now)');
        expect(program).toContain('EvidencePredatesMarketClose');
    });

    it('ships a paid, discoverable and independently auditable oracle-fact capability', () => {
        const route = read('backend/routes/agent-oracle-facts.js');
        expect(route).toContain("AGENT_ORACLE_FACTS_PATH = '/agent/oracle/facts'");
        expect(route).toContain('declareDiscoveryExtension');
        expect(route).toMatch(/parseFactQuery,\s*loadVerifiedFact\(pool\),\s*gate,/);
        expect(read('backend/ecosystem.config.cjs')).toContain("X402_PRICE_ORACLE_FACT: '$0.01'");
        expect(read('backend/routes/docs-agents.md')).toContain('/agent/discovery?resource=oracle-facts');
        expect(read('backend/scripts/oracle-fact-demo.mjs')).toContain('inspect → pay → verify → discover');
    });

    it('uses one deterministic Lens evaluator for single and composite source recipes', () => {
        const evaluator = read('backend/oracle/recipe-evaluator.js');
        expect(evaluator).toContain("status: 'disputed'");
        expect(evaluator).toContain("status: 'challenge_window'");
        expect(evaluator).toContain('requiredAttesterKinds');
        expect(read('backend/oracle/verified-fact.js')).toContain('evaluateResolutionRecipe');
        expect(read('docs/protocol.md')).toContain('unique-attester thresholds');
    });

    it('ships a read-only public proof audit for judges and agents', () => {
        const audit = read('backend/agents/hackathon-proof-audit.js');
        const script = read('backend/scripts/hackathon-proof-audit.mjs');
        expect(audit).toContain("'/agent/discovery?resource=oracle-facts'");
        expect(audit).toContain('deterministic_supporter');
        expect(audit).toContain('external_market_lifecycle');
        expect(script).toContain('result.status !== \'verified\'');
        expect(read('docs/hackathon-build.md')).toContain('npm run audit:hackathon');
    });

    it('ships one guarded MCP action surface over the existing agent adapters', () => {
        const server = read('backend/agents/mcp-server.mjs');
        const tools = read('backend/agents/ugt-agent-tools.js');
        for (const name of ['ugt_submit_proposal', 'ugt_pledge', 'ugt_donate', 'ugt_forecast', 'ugt_buy_verified_fact']) {
            expect(server).toContain(name);
        }
        expect(tools).toContain("live actions are disabled; set UGT_MCP_LIVE=1");
        expect(tools).toContain('UGT_MCP_MAX_USDC_PER_ACTION');
        expect(read('backend/routes/docs-agents.md')).toContain('npm run mcp');
    });
});
