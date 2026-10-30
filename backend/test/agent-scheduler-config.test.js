import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { executionPolicy, settlementPolicy, summarizeExecutionPlan } from '../agents/run-policy.js';
import { SIGNED_SETTLEMENT_STEPS } from '../agents/lifecycle-actions.js';

const require = createRequire(import.meta.url);
const repoRoot = path.join(os.homedir(), 'code', 'consensus-builder');
const backendRoot = path.join(repoRoot, 'backend');
const solanaConfig = path.join(os.homedir(), '.config', 'solana');
const backendLogs = path.join(backendRoot, 'logs');
const apps = require('../agents/ecosystem.config.cjs').apps;
const app = apps.find(item => item.name === 'consensus-builder-agents');

describe('algorithmic agent schedule', () => {
    it('lets every proposer seed its own land and leaves its action cap room for its pick and its settlements', () => {
        const personas = JSON.parse(fs.readFileSync(new URL('../agents/personas.json', import.meta.url), 'utf8')).personas;
        const proposers = apps.filter(item => item.script === 'agents/run.mjs');
        expect(proposers.map(item => item.name).sort()).toEqual(['consensus-builder-affordabot', 'consensus-builder-agents', 'consensus-builder-builder', 'consensus-builder-gentle']);
        // A settled agreement signs at most four transactions: attest, execute or expire, resolve, claim.
        const perSettlement = SIGNED_SETTLEMENT_STEPS.length - 1;
        for (const proposer of proposers) {
            expect(proposer.env.AGENT_MARKET_SEED_USDC_CAP).toBe('3.5');
            expect(proposer.args).toContain('--seed-owners');
            expect(proposer.args).toContain('--live');
            const name = proposer.args.match(/--persona (\S+)/)[1];
            const persona = personas.find(item => item.name === name);
            // The runner's own caps, read the way run.mjs reads them from this env.
            const policy = executionPolicy(proposer.env);
            const settle = settlementPolicy(proposer.env);
            expect(settle.maxPerRun).toBe(3);
            const picks = summarizeExecutionPlan([{ persona, run: { summary: { picks: Array.from({ length: persona.dailyProposals }, (_, index) => ({ pickId: `p${index}` })) } } }], policy);
            expect(policy.maxActions).toBeGreaterThanOrEqual(picks.actionCount + settle.maxPerRun * perSettlement);
            expect(policy.maxUsdc).toBeGreaterThanOrEqual(picks.maxUsdc);
            expect(policy.maxMarketSeedUsdc).toBeGreaterThanOrEqual(picks.maxMarketSeedUsdc);
            // The proposer renders no thumbnails any more: the index does.
            expect(proposer.env).not.toHaveProperty('MAPTILER_API_KEY');
            expect(proposer.env).not.toHaveProperty('AGENT_RETIRE_AFTER_DAYS');
            expect(proposer.env).not.toHaveProperty('AGENT_LIFECYCLE_LENS_SERVICE_URL');
        }
    });
    it('enables bounded devnet fee funding for all configured actor and lens jobs', () => {
        const actors = apps.filter(item => /^agents\/(run|support-run|society-run|lens-member-run)\.mjs$/.test(item.script));
        expect(actors).toHaveLength(11);
        for (const actor of actors) {
            expect(actor.env.AGENT_SOL_FUNDING_ENABLED).toBe('1');
            expect(actor.env.AGENT_USDC_FUNDING_ENABLED).toBe('1');
        }
    });
    it('uses the production provider account limit for the API and every actor', () => {
        const apiEnv = require('../ecosystem.config.cjs').apps.find(item => item.name === 'consensus-builder-api').env;
        expect(apiEnv.SOLANA_RPC_MAX_ACCOUNTS).toBe('5');
        const actors = apps.filter(item => /^agents\/(run|support-run|society-run|lens-member-run)\.mjs$/.test(item.script));
        for (const actor of actors) expect(actor.env.SOLANA_RPC_MAX_ACCOUNTS).toBe(apiEnv.SOLANA_RPC_MAX_ACCOUNTS);
    });
    it('checkpoints support and society runs before RPC reads and persists pre-action failures', () => {
        const supporter = fs.readFileSync(new URL('../agents/support-run.mjs', import.meta.url), 'utf8');
        const society = fs.readFileSync(new URL('../agents/society-run.mjs', import.meta.url), 'utf8');
        expect(supporter.indexOf('await discoverOpenAgreements')).toBeGreaterThan(-1);
        expect(supporter.indexOf('await startRun')).toBeLessThan(supporter.indexOf('await discoverOpenAgreements'));
        expect(supporter.indexOf('await startRun')).toBeLessThan(supporter.indexOf('await readSupportEligibility'));
        expect(supporter).toContain('markAgentRunFailed(pool, runId, error');
        expect(society.indexOf('await startRun')).toBeLessThan(society.indexOf('await gatherInputs'));
        expect(society).toContain('markAgentRunFailed(pool, turn.runId, error');
    });

    it('is one opt-in, non-restarting process every three hours with hard public limits per run', () => {
        expect(app).toMatchObject({
            name: 'consensus-builder-agents',
            script: 'agents/run.mjs',
            instances: 1,
            autorestart: false,
            cron_restart: '0 */3 * * *',
            merge_logs: true
        });
        expect(app.args).toContain('--persona densifier-01');
        // Several runs a day: each is its own checkpoint, keyed by the UTC hour.
        expect(app.args).toContain('--slot auto');
        expect(app.args).toContain('--candidates 4');
        expect(app.args).toContain('--controller algorithm');
        expect(app.env).toMatchObject({
            AGENT_DAILY_ACTION_CAP: '15',
            AGENT_SETTLE_MAX_PER_RUN: '3',
            AGENT_DAILY_USDC_CAP: '0.35', AGENT_MARKET_SEED_USDC_CAP: '3.5'
        });
        expect(app.env).not.toHaveProperty('AGENT_LLM_MODEL');
        expect(app.env).not.toHaveProperty('AGENT_LLM_DAILY_CAP_USD');
    });

    it('emits an outcome sentinel only from the successful runner path', () => {
        const source = fs.readFileSync(new URL('../agents/run.mjs', import.meta.url), 'utf8');
        expect(source).toContain('AGENT DAILY RUN — status=completed');
        expect(source.indexOf('AGENT DAILY RUN — status=completed')).toBeGreaterThan(source.indexOf('if (failures.length)'));
    });

    it('schedules the supporter as another bounded persona in the shared runtime', () => {
        const supporter = apps.find(item => item.name === 'consensus-builder-supporter');
        expect(supporter).toMatchObject({
            script: 'agents/support-run.mjs',
            instances: 1,
            autorestart: false,
            cron_restart: '45 */3 * * *',
            merge_logs: true,
            env: { AGENT_SUPPORT_USDC_CAP: '0.25' }
        });
        expect(supporter.args).toContain('--persona supporter-01');
        expect(supporter.args).toContain('--slot auto');
        const source = fs.readFileSync(new URL('../agents/support-run.mjs', import.meta.url), 'utf8');
        expect(source).toContain('AGENT SUPPORT RUN — status=completed');
        expect(source).toContain('AGENT_SUPPORT_USDC_CAP');
    });

    it('schedules the society personas as opt-in, non-restarting runs of the generic society runner', () => {
        const personas = JSON.parse(fs.readFileSync(new URL('../agents/personas.json', import.meta.url), 'utf8')).personas;
        for (const [name, persona, cron, role] of [
            ['consensus-builder-preservationist', 'preservationist-01', '20 */2 * * *', 'contrarian'],
            ['consensus-builder-speculator', 'speculator-01', '40 */3 * * *', 'speculator'],
            ['consensus-builder-skeptic', 'skeptic-02', '50 1-23/2 * * *', 'contrarian'],
            ['consensus-builder-backer', 'backer-01', '10 1-23/2 * * *', 'backer']
        ]) {
            const entry = apps.find(item => item.name === name);
            expect(entry).toMatchObject({ script: 'agents/society-run.mjs', instances: 1, autorestart: false, cron_restart: cron, merge_logs: true });
            expect(entry.args).toContain(`--persona ${persona}`);
            expect(entry.args).toContain('--live');
            expect(entry.args).toContain('--slot auto');
            expect(Number(entry.env.AGENT_SOCIETY_USDC_CAP)).toBeLessThanOrEqual(0.05);
            // A stake plus a possible market creation, or a claim that settles its market first.
            expect(Number(entry.env.AGENT_SOCIETY_ACTION_CAP)).toBeLessThanOrEqual(3);
            expect(entry.env).not.toHaveProperty('AGENT_LLM_MODEL');
            // Opt-in until the key exists on the operator host; the persona names its wallet and keypair path.
            expect(personas.find(item => item.name === persona)).toMatchObject({ role, wallet: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/), keypairPath: `~/.config/solana/ugt-${persona}.json` });
        }
        const config = fs.readFileSync(new URL('../agents/ecosystem.config.cjs', import.meta.url), 'utf8');
        expect(config).toMatch(/OPT-IN until keys exist[\s\S]*consensus-builder-preservationist/);
        expect(config).toMatch(/OPT-IN until keys exist[\s\S]*consensus-builder-speculator/);
        const source = fs.readFileSync(new URL('../agents/society-run.mjs', import.meta.url), 'utf8');
        expect(source).toContain('AGENT SOCIETY RUN — status=completed');
    });

    it('schedules the second proposer and the rival on the same bounded runner, between the first', () => {
        const personas = JSON.parse(fs.readFileSync(new URL('../agents/personas.json', import.meta.url), 'utf8')).personas;
        for (const [name, persona, cron] of [
            ['consensus-builder-builder', 'builder-02', '30 1-22/3 * * *'],
            ['consensus-builder-gentle', 'gentle-01', '15 2-23/3 * * *']
        ]) {
            const entry = apps.find(item => item.name === name);
            expect(entry).toMatchObject({ script: 'agents/run.mjs', instances: 1, autorestart: false, cron_restart: cron,
                env: { AGENT_DAILY_ACTION_CAP: '15', AGENT_SETTLE_MAX_PER_RUN: '3', AGENT_DAILY_USDC_CAP: '0.35', AGENT_MARKET_SEED_USDC_CAP: '3.5' } });
            expect(entry.args).toContain(`--persona ${persona}`);
            expect(entry.args).toContain('--controller algorithm');
            expect(entry.args).toContain('--slot auto');
            expect(personas.find(item => item.name === persona)).toMatchObject({ role: 'proposer', keypairPath: `~/.config/solana/ugt-${persona}.json` });
        }
        expect(personas.find(item => item.name === 'gentle-01').areas).toEqual([expect.objectContaining({ mode: 'contest' })]);
    });

    it('refreshes the transaction store the activity feed reads every 20 minutes', () => {
        const sync = apps.find(item => item.name === 'consensus-builder-tx-sync');
        expect(sync).toMatchObject({ script: 'scripts/sync-transactions.mjs', args: '--run', autorestart: false, cron_restart: '*/20 * * * *' });
    });

    it('declares lifecycle-01 as an unscheduled lens member service that PM2 restarts with backoff', () => {
        const member = apps.find(item => item.name === 'consensus-builder-lifecycle-member');
        expect(member).toMatchObject({ script: 'agents/lens-member-run.mjs', instances: 1, autorestart: true,
            max_restarts: 10, exp_backoff_restart_delay: 2000 });
        expect(member.args).toContain('--persona lifecycle-01');
        expect(member).not.toHaveProperty('cron_restart');
    });

    it('materializes agreement land events with one applied lifecycle pass every 15 minutes', () => {
        const oracle = apps.find(item => item.name === 'consensus-builder-land-oracle');
        expect(oracle).toMatchObject({
            script: 'oracle/agreement-lifecycle-job.mjs',
            args: '--once --apply',
            instances: 1,
            autorestart: false,
            cron_restart: '*/15 * * * *',
            merge_logs: true,
            env: { LAND_ORACLE_RUN_STATS: path.join(backendLogs, 'land-oracle-stats.json') }
        });
        expect(fs.existsSync(new URL('../scripts/sync-land-events.mjs', import.meta.url))).toBe(false);
        const source = fs.readFileSync(new URL('../oracle/agreement-lifecycle-job.mjs', import.meta.url), 'utf8');
        expect(source).toContain('buildLandOracleRunStats');
        expect(source).toContain('writeRunStatsAtomic');
    });

    it('checks the live prospective market hourly with its original two signers', () => {
        const resolver = apps.find(item => item.name === 'consensus-builder-prospective-resolver');
        expect(resolver).toMatchObject({
            script: 'blockchain/solana/scripts/prospective-external-market.mjs',
            args: '--settle --live',
            cwd: repoRoot,
            instances: 1,
            autorestart: false,
            cron_restart: '45 * * * *',
            merge_logs: true,
            env: {
                SOLANA_KEYPAIR: path.join(solanaConfig, 'court-oracle.json'),
                PROSPECTIVE_BETTOR_KEYPAIR: path.join(solanaConfig, 'ugt-persona-01.json'),
                PROSPECTIVE_MARKET_STATE: path.join(solanaConfig, 'ugt-prospective-court-v2.json'),
                PROSPECTIVE_RUN_STATS: path.join(backendLogs, 'prospective-resolver-stats.json')
            }
        });
    });

    it('records a machine-readable outcome for every prospective resolver run', () => {
        const source = fs.readFileSync(
            new URL('../../blockchain/solana/scripts/prospective-external-market.mjs', import.meta.url),
            'utf8'
        );
        expect(source).toContain("job: 'prospective-market-resolver'");
        expect(source).toContain("runStatus: 'completed'");
        expect(source).toContain("runStatus: 'failed'");
        expect(source).toContain('fs.renameSync(tempFile, RUN_STATS_FILE)');
    });

    it('declares the notary-01 lens member as an unscheduled opt-in service that PM2 restarts with backoff', () => {
        const lensMember = apps.find(item => item.name === 'consensus-builder-lens-member');
        expect(lensMember).toMatchObject({
            script: 'agents/lens-member-run.mjs',
            instances: 1,
            autorestart: true,
            max_restarts: 10,
            exp_backoff_restart_delay: 2000
        });
        expect(lensMember.args).toContain('--persona notary-01');
        expect(lensMember).not.toHaveProperty('cron_restart');
        const config = fs.readFileSync(new URL('../agents/ecosystem.config.cjs', import.meta.url), 'utf8');
        expect(config).toMatch(/Opt-in: the notary-01[\s\S]*schemas are registered/);
        const personas = JSON.parse(fs.readFileSync(new URL('../agents/personas.json', import.meta.url), 'utf8')).personas;
        expect(personas.find(persona => persona.name === 'notary-01')).toMatchObject({
            role: 'lens-member',
            keypairPath: '~/.config/solana/ugt-notary-01.json',
            service: { port: 3095, kind: 'owner-consent', priceUsdc: '0.01' }
        });
    });
});
