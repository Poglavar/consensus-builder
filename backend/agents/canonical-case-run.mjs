#!/usr/bin/env node
// Manual, resumable golden-case runner. This is one use of the shared actor/action runtime, not a
// second agent system: two configured deterministic personas mint, pay, support and forecast one
// real parcel set, and checkpoint the same consensus.agent_run activity envelope used elsewhere.
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
    canonicalCaseConfig, canonicalProposalBody, canonicalTerminalActions,
    DEFAULT_CASE_ID, DEFAULT_EXECUTED_CASE_ID, DEFAULT_EXECUTED_PARCELS, DEFAULT_PARCELS
} from './canonical-case.js';
import { mintProposal } from './minter.js';
import { createPaidClient, paymentIdForProposal, postAgentProposal } from './x402-client.js';
import { ensureDonationEscrowAndDonate } from './donor.js';
import { ensurePledgeBookAndSet } from './pledger.js';
import { ensureMarketAndStake, usdcToAtomic } from './bettor.js';
import { getRun, startRun, updateRun } from './ledger.js';
import { sendAndConfirmPolling } from './solana-send.js';
import {
    acceptProposal, cancelProposal, claimProposalMarket, decodeProposalState, ensureParcelCertificate,
    fulfillPledge, refundDonation, releaseDonations, resolveProposalMarket, voidPledge
} from './lifecycle-actions.js';
import { STATUS_EXECUTED } from '../oracle/proposal-lifecycle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const actionEngineApi = require('../../frontend/js/agent-action-engine.js');
const PROPOSAL_NFT_PROGRAM = '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';
const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const SIDE_NO = 0;
const SIDE_YES = 1;

function usage(code) {
    console.log([
        'Canonical hackathon case: one parcel set → paid proposal → donation + pledge → YES + NO,',
        'then one of two terminal paths: cancelled (refund, void, claim NO) or executed (accept, release, fulfil, claim YES).', '',
        '  --dry-run                 Print the deterministic plan; write and sign nothing',
        '  --live                    Execute/resume the case on Solana devnet',
        '  --outcome NAME            cancelled (default) or executed; selects the default case id and parcels',
        `  --proposal-id ID          Stable public id (default ${DEFAULT_CASE_ID}; executed: ${DEFAULT_EXECUTED_CASE_ID})`,
        `  --parcels ID,ID           2–8 cadastral parcel ids (default ${DEFAULT_PARCELS.join(',')};`,
        `                            executed: ${DEFAULT_EXECUTED_PARCELS.join(',')})`,
        '  --name TEXT               Proposal title for a custom case',
        '  --api URL                 Public backend base URL',
        '  --terminal                Run the terminal path for --outcome after setup (with --dry-run: show it in the plan)',
        '  --help                    This text'
    ].join('\n'));
    process.exit(code);
}

function parseArgs(argv) {
    const args = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--help') usage(0);
        if (token === '--dry-run') { args.dryRun = true; continue; }
        if (token === '--live') { args.live = true; continue; }
        if (token === '--terminal') { args.terminal = true; continue; }
        if (!token.startsWith('--') || !argv[index + 1] || argv[index + 1].startsWith('--')) usage(2);
        args[token.slice(2)] = argv[index + 1];
        index += 1;
    }
    if (Boolean(args.dryRun) === Boolean(args.live)) usage(2);
    return args;
}

function expandHome(value) {
    return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

function loadPersonas() {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'personas.json'), 'utf8'));
    const proposer = config.personas.find(item => (item.role || 'proposer') === 'proposer');
    const supporter = config.personas.find(item => item.role === 'supporter');
    if (!proposer || !supporter) throw new Error('personas.json needs both proposer and supporter roles');
    return { proposer, supporter };
}

function loadKeypair(persona) {
    const secret = Uint8Array.from(JSON.parse(fs.readFileSync(expandHome(persona.keypairPath), 'utf8')));
    const keypair = Keypair.fromSecretKey(secret);
    if (persona.wallet && persona.wallet !== keypair.publicKey.toBase58()) throw new Error(`${persona.name} keypair does not match configured wallet`);
    return { secret, keypair };
}

function actor(persona) {
    return { id: persona.name, name: persona.name, controller: 'algorithm', wallet: persona.wallet };
}

function safeResult(value) {
    return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const config = canonicalCaseConfig({
        proposalId: args['proposal-id'], parcels: args.parcels, outcome: args.outcome, name: args.name
    });
    const apiBase = (args.api || process.env.AGENT_API_BASE || 'https://api.urbangametheory.xyz').replace(/\/$/, '');
    const { proposer, supporter } = loadPersonas();
    const runId = `hackathon-case:${config.proposalId}`;
    const plan = {
        runId, proposalId: config.proposalId, parcels: config.parcelIds, outcome: config.outcome,
        name: config.name, actors: [actor(proposer), actor(supporter)], amounts: config.amounts,
        actions: [
            'mint', 'x402_publish', 'donate', 'pledge', 'forecast_yes', 'forecast_no',
            ...(args.terminal ? canonicalTerminalActions(config.outcome) : [])
        ]
    };
    if (args.dryRun) {
        console.log(JSON.stringify(plan, null, 2));
        return;
    }

    const pool = new pg.Pool({
        host: process.env.PGHOST, port: process.env.PGPORT, user: process.env.PGUSER,
        password: process.env.PGPASSWORD, database: process.env.PGDATABASE
    });
    const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
    const proposerSigner = loadKeypair(proposer);
    const supporterSigner = loadKeypair(supporter);
    try {
        let run = await getRun(pool, runId);
        if (!run) run = await startRun(pool, { runId, persona: 'hackathon-case', day: new Date().toISOString().slice(0, 10), mode: 'live' });
        const summary = run.summary || {};
        const caseState = { ...(summary.canonicalCase || {}), config, plan };
        const activities = Array.isArray(summary.activities) ? [...summary.activities] : [];
        const runtime = actionEngineApi.createEngine({
            decisionProviders: { algorithm: (_currentActor, context) => context.action },
            actionHandlers: { '*': (_currentActor, _action, context) => context.execute() },
            onActivity: activity => activities.push({ ...activity, runId })
        });
        const checkpoint = async (stage, patch, status = 'running') => {
            Object.assign(caseState, safeResult(patch));
            run = await updateRun(pool, runId, { stage, status, summaryPatch: {
                role: 'proposer', controller: 'algorithm', wallet: proposer.wallet,
                canonicalCase: caseState, activities, outcome: status === 'done' ? 'completed' : 'partial'
            } });
        };
        const perform = async (persona, action, execute) => (await runtime.run(actor(persona), {
            source: 'live', action: { ...action, proposalId: config.proposalId }, execute
        })).outcome;

        if (!caseState.mint?.proposalPda) {
            const mint = await perform(proposer, { type: 'create' }, () => mintProposal({
                connection, programId: PROPOSAL_NFT_PROGRAM, ownerKeypair: proposerSigner.keypair,
                parcelIds: config.parcelIds, isConditional: true,
                imageUri: `${apiBase}/proposals/${config.proposalId}`, lamports: 0n,
                lens: [proposer.wallet], sendAndConfirm: sendAndConfirmPolling
            }));
            await checkpoint('minted', { mint });
        }

        if (!caseState.publish?.proposalId) {
            const body = canonicalProposalBody({ config, runId, proposer, mint: caseState.mint, apiBase });
            const publish = await perform(proposer, { type: 'publish' }, async () => {
                const { paidFetch } = await createPaidClient({
                    secretKey: proposerSigner.secret,
                    paymentId: paymentIdForProposal(config.proposalId),
                    rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com'
                });
                const response = await postAgentProposal({ baseUrl: apiBase, paidFetch, body });
                if (response.status !== 201) throw new Error(`paid proposal returned HTTP ${response.status}`);
                return { proposalId: response.body.proposalId, rowId: response.body.id, transaction: response.receipt?.transaction || null };
            });
            await checkpoint('published', { publish });
        }

        const proposalPda = caseState.mint.proposalPda;
        if (!caseState.donation) {
            const donation = await perform(supporter, { type: 'donate', amount: config.amounts.donationUsdc }, () => ensureDonationEscrowAndDonate({
                connection, donorKeypair: supporterSigner.keypair, proposalPda,
                amountAtomic: usdcToAtomic(config.amounts.donationUsdc),
                operationId: `${runId}:donation`, sendAndConfirm: sendAndConfirmPolling
            }));
            await checkpoint('supported', { donation });
        }
        if (!caseState.pledge) {
            const pledge = await perform(supporter, { type: 'pledge', amount: config.amounts.pledgeUsdc }, () => ensurePledgeBookAndSet({
                connection, pledgerKeypair: supporterSigner.keypair, proposalPda,
                amountAtomic: usdcToAtomic(config.amounts.pledgeUsdc), sendAndConfirm: sendAndConfirmPolling
            }));
            await checkpoint('supported', { pledge });
        }
        if (!caseState.yes) {
            const yes = await perform(proposer, { type: 'stake', side: 'yes', amount: config.amounts.yesUsdc }, () => ensureMarketAndStake({
                connection, ownerKeypair: proposerSigner.keypair, proposalPda, stakeMint: USDC_DEVNET,
                side: SIDE_YES, amountAtomic: usdcToAtomic(config.amounts.yesUsdc), targetAmount: true,
                sendAndConfirm: sendAndConfirmPolling
            }));
            await checkpoint('forecasting', { yes });
        }
        if (!caseState.no) {
            const no = await perform(supporter, { type: 'stake', side: 'no', amount: config.amounts.noUsdc }, () => ensureMarketAndStake({
                connection, ownerKeypair: supporterSigner.keypair, proposalPda, stakeMint: USDC_DEVNET,
                side: SIDE_NO, amountAtomic: usdcToAtomic(config.amounts.noUsdc), targetAmount: true,
                sendAndConfirm: sendAndConfirmPolling
            }));
            await checkpoint('forecasting', { no });
        }
        if (!args.terminal) {
            await checkpoint('funded_and_forecast', { completedAt: new Date().toISOString() }, 'done');
            console.log(JSON.stringify({ status: 'completed', case: `${apiBase}/hackathon/cases/${config.proposalId}`, ...caseState }, null, 2));
            return;
        }

        if (config.outcome === 'executed') {
            // Executed path. The supporter persona holds the devnet ownership certificate of every listed
            // parcel and accepts each one; the last acceptance flips the proposal to Executed on-chain, which
            // is the only state the market program accepts as YES.
            for (const parcelId of config.parcelIds) {
                if (caseState.certificates?.[parcelId]) continue;
                const certificate = await perform(supporter, { type: 'certifyParcel', parcelId }, () => ensureParcelCertificate({
                    connection, ownerKeypair: supporterSigner.keypair, parcelId,
                    metadataUri: `${apiBase}/parcels/parcelIds?ids=${encodeURIComponent(parcelId)}`,
                    sendAndConfirm: sendAndConfirmPolling
                }));
                await checkpoint('certifying', { certificates: { ...(caseState.certificates || {}), [parcelId]: certificate } });
            }
            for (const parcelId of config.parcelIds) {
                if (caseState.acceptances?.[parcelId]) continue;
                const acceptance = await perform(supporter, { type: 'accept', parcelId }, () => acceptProposal({
                    connection, accepterKeypair: supporterSigner.keypair, proposalAccount: proposalPda, parcelId,
                    sendAndConfirm: sendAndConfirmPolling
                }));
                await checkpoint('accepting', { acceptances: { ...(caseState.acceptances || {}), [parcelId]: acceptance } });
            }
            if (!caseState.executed) {
                const info = await connection.getAccountInfo(new PublicKey(proposalPda), 'confirmed');
                const state = decodeProposalState(info?.data);
                if (state.status !== STATUS_EXECUTED) {
                    throw new Error(`proposal status is ${state.status} after every acceptance; expected Executed (${STATUS_EXECUTED})`);
                }
                await checkpoint('executed', { executed: { acceptedParcels: state.acceptedParcels, observedAt: new Date().toISOString() } });
            }
            if (!caseState.resolution) {
                const resolution = await perform(supporter, { type: 'resolve' }, () => resolveProposalMarket({
                    connection, resolverKeypair: supporterSigner.keypair, proposalAccount: proposalPda,
                    sendAndConfirm: sendAndConfirmPolling
                }));
                if (resolution.outcome !== 'YES') throw new Error(`market resolved ${resolution.outcome}; expected YES`);
                await checkpoint('resolved', { resolution });
            }
            if (!caseState.release) {
                const release = await perform(supporter, { type: 'releaseDonations' }, () => releaseDonations({
                    connection, releaserKeypair: supporterSigner.keypair, proposalAccount: proposalPda,
                    sendAndConfirm: sendAndConfirmPolling
                }));
                await checkpoint('settling', { release });
            }
            if (!caseState.fulfilment) {
                const fulfilment = await perform(supporter, { type: 'fulfillPledge' }, () => fulfillPledge({
                    connection, pledgerKeypair: supporterSigner.keypair, proposalAccount: proposalPda,
                    sendAndConfirm: sendAndConfirmPolling
                }));
                await checkpoint('settling', { fulfilment });
            }
            if (!caseState.claim) {
                const claim = await perform(proposer, { type: 'claim', side: 'yes' }, () => claimProposalMarket({
                    connection, claimerKeypair: proposerSigner.keypair, proposalAccount: proposalPda,
                    side: SIDE_YES, sendAndConfirm: sendAndConfirmPolling
                }));
                await checkpoint('settling', { claim });
            }
        } else {
            if (!caseState.cancel) {
                const cancel = await perform(proposer, { type: 'cancel' }, () => cancelProposal({
                    connection, ownerKeypair: proposerSigner.keypair, proposalAccount: proposalPda,
                    sendAndConfirm: sendAndConfirmPolling
                }));
                await checkpoint('cancelled', { cancel });
            }
            if (!caseState.resolution) {
                const resolution = await perform(supporter, { type: 'resolve' }, () => resolveProposalMarket({
                    connection, resolverKeypair: supporterSigner.keypair, proposalAccount: proposalPda,
                    sendAndConfirm: sendAndConfirmPolling
                }));
                await checkpoint('resolved', { resolution });
            }
            if (!caseState.refund) {
                const refund = await perform(supporter, { type: 'refundMyDonations' }, () => refundDonation({
                    connection, donorKeypair: supporterSigner.keypair, proposalAccount: proposalPda,
                    operationId: `${runId}:donation`, sendAndConfirm: sendAndConfirmPolling
                }));
                await checkpoint('settling', { refund });
            }
            if (!caseState.voidPledge) {
                const voided = await perform(supporter, { type: 'voidPledge' }, () => voidPledge({
                    connection, feePayerKeypair: supporterSigner.keypair, proposalAccount: proposalPda,
                    pledger: supporterSigner.keypair.publicKey, sendAndConfirm: sendAndConfirmPolling
                }));
                await checkpoint('settling', { voidPledge: voided });
            }
            if (!caseState.claim) {
                const claim = await perform(supporter, { type: 'claim', side: 'no' }, () => claimProposalMarket({
                    connection, claimerKeypair: supporterSigner.keypair, proposalAccount: proposalPda,
                    side: SIDE_NO, sendAndConfirm: sendAndConfirmPolling
                }));
                await checkpoint('settling', { claim });
            }
        }
        await checkpoint('settled', { terminalCompletedAt: new Date().toISOString() }, 'done');
        console.log(JSON.stringify({ status: 'completed', case: `${apiBase}/hackathon/cases/${config.proposalId}`, ...caseState }, null, 2));
    } finally {
        await pool.end();
    }
}

main().catch(error => {
    console.error(`[${new Date().toISOString()}] CANONICAL CASE FAILED:`, error);
    process.exit(1);
});
