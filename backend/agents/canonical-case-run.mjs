#!/usr/bin/env node
// Manual, resumable golden-case runner. This is one use of the shared actor/action runtime, not a
// second agent system: two configured deterministic personas mint, pay, support and forecast one
// real parcel set, and checkpoint the same consensus.agent_run activity envelope used elsewhere.
// Outcome "attested" (canonical case v3, lens-model.md) mints with the notary-01 lens member, asks
// that member to attest each recorded owner, and has every owner sign accept_with_attestations; it
// refuses --live until LENS_V2_DEPLOYED=1 says the v2 programs are on devnet.
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
    assertAttestedLiveAllowed, attestedCasePlan, attestedCaseSteps, canonicalCaseConfig, canonicalProposalBody,
    canonicalTerminalActions, ownerKey,
    DEFAULT_ATTESTED_CASE_ID, DEFAULT_CASE_ID, DEFAULT_EXECUTED_CASE_ID, DEFAULT_EXECUTED_PARCELS, DEFAULT_PARCELS
} from './canonical-case.js';
import { mintProposal } from './minter.js';
import { resolveLens, describeLensChoice } from './lens-directory-client.js';
import { createPaidClient, paymentIdForProposal, postAgentProposal } from './x402-client.js';
import { ensureDonationEscrowAndDonate } from './donor.js';
import { ensurePledgeBookAndSet } from './pledger.js';
import { ensureMarketAndStake, usdcToAtomic } from './bettor.js';
import { getRun, startRun, updateRun } from './ledger.js';
import { sendAndConfirmPolling } from './solana-send.js';
import { createAction } from './run-policy.js';
import {
    acceptWithAttestations, cancelProposal, claimProposalMarket, decodeProposalState, ensureParcelAnchor,
    fulfillPledge, refundDonation, releaseDonations, resolveProposalMarket, voidPledge
} from './lifecycle-actions.js';
import { paymentIdForOwnership, requestOwnershipAttestation } from './lens-ownership-client.js';
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
        '  --outcome NAME            cancelled (default), executed, or attested (v3 lens model; --live needs',
        '                            LENS_V2_DEPLOYED=1 and always runs the terminal path)',
        `  --proposal-id ID          Stable public id (default ${DEFAULT_CASE_ID}; executed: ${DEFAULT_EXECUTED_CASE_ID};`,
        `                            attested: ${DEFAULT_ATTESTED_CASE_ID})`,
        `  --parcels ID,ID           2–8 cadastral parcel ids (default ${DEFAULT_PARCELS.join(',')};`,
        `                            executed: ${DEFAULT_EXECUTED_PARCELS.join(',')})`,
        '  --name TEXT               Proposal title for a custom case',
        '  --api URL                 Public backend base URL',
        '  --lens KEY,KEY            Lens member keys for the mint (default: chosen from GET /agent/lenses/members;',
        '                            attested: the notary-01 persona key). Never the proposer alone.',
        '  --owners FILE             attested: recorded owner rows [{parcelUid, owner, ownerCount}] (the lens member',
        '                            --owners format); every owner must be a persona wallet (its keypair signs);',
        '                            default: the supporter wallet owns each parcel with ownerCount 1',
        '  --lens-service URL        attested: the notary lens member service (default: notary-01 service.url)',
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
    const notary = config.personas.find(item => item.name === 'notary-01') || null;
    if (!proposer || !supporter) throw new Error('personas.json needs both proposer and supporter roles');
    return { proposer, supporter, notary, all: config.personas };
}

// The persona whose wallet an owner row names: only a persona's keypair can sign an owner's yes.
function ownerPersona(personas, wallet) {
    const persona = personas.find(item => item.wallet === wallet && item.keypairPath);
    if (!persona) throw new Error(`owner wallet ${wallet} is not a persona wallet with a keypair in personas.json; the case cannot sign its acceptance`);
    return persona;
}

// The notary's public key: the configured wallet, else read from its keypair file; null when neither exists.
function notaryKeyOf(notary) {
    if (!notary) return null;
    if (notary.wallet) return notary.wallet;
    const file = expandHome(notary.keypairPath || '');
    if (!file || !fs.existsSync(file)) return null;
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8')))).publicKey.toBase58();
}

// Recorded owners per parcel for the attested plan: an owner-rows file, or the supporter persona
// (lens-model.md: the supporter holds the devnet-recorded owner wallets).
function recordedOwners(parcelIds, ownersFile, supporter) {
    if (!ownersFile) {
        return Object.fromEntries(parcelIds.map(id => [id, {
            wallets: [supporter.wallet], ownerCount: 1,
            source: `assumed: ${supporter.name} (live reads consensus.lens_devnet_owner)`
        }]));
    }
    const rows = JSON.parse(fs.readFileSync(ownersFile, 'utf8'));
    return Object.fromEntries(parcelIds.map(id => {
        const own = rows.filter(row => row.parcelUid === id);
        return [id, { wallets: own.map(row => row.owner), ownerCount: own[0]?.ownerCount ?? 0, source: ownersFile }];
    }));
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
    const { proposer, supporter, notary, all: allPersonas } = loadPersonas();
    const runId = `hackathon-case:${config.proposalId}`;
    const plan = {
        runId, proposalId: config.proposalId, parcels: config.parcelIds, outcome: config.outcome,
        name: config.name, actors: [actor(proposer), actor(supporter)], amounts: config.amounts,
        actions: [
            'mint', 'x402_publish', 'donate', 'pledge', 'forecast_yes', 'forecast_no',
            ...(args.terminal || config.outcome === 'attested' ? canonicalTerminalActions(config.outcome) : [])
        ]
    };

    let attested = null;
    if (config.outcome === 'attested') {
        // The gate comes first: nothing is read, written or signed on a refused live run.
        if (args.live) assertAttestedLiveAllowed(process.env);
        const notaryKey = args.lens ? null : notaryKeyOf(notary);
        const lensChoice = args.lens
            ? await resolveLens({ explicit: args.lens, proposer: proposer.wallet })
            : notaryKey
                ? { lens: [notaryKey], source: 'persona', reason: 'notary-01 persona key (lens-model.md canonical case v3)', members: [{ key: notaryKey }] }
                : null;
        const owners = recordedOwners(config.parcelIds, args.owners, supporter);
        const member = lensChoice?.lens?.[0] ?? null;
        const serviceUrl = args['lens-service'] || notary?.service?.url || null;
        plan.actors.push(notary ? { ...actor(notary), wallet: notaryKey ?? member, role: 'lens-member', serviceUrl } : { id: 'notary-01', missing: true });
        plan.lens = lensChoice
            ? { keys: lensChoice.lens, source: lensChoice.source, why: lensChoice.reason }
            : { keys: [], refused: `notary-01 key not configured: generate ${notary?.keypairPath ?? '~/.config/solana/ugt-notary-01.json'} and set its wallet in personas.json` };
        plan.steps = attestedCasePlan({ config, notaryKey: member, owners }).steps;
        plan.live = { gate: 'LENS_V2_DEPLOYED=1', allowed: process.env.LENS_V2_DEPLOYED === '1', memberService: serviceUrl, credentialName: notary?.service?.credentialName ?? 'LensMember' };
        if (args.dryRun) {
            console.log(JSON.stringify(plan, null, 2));
            return;
        }
        if (!lensChoice) throw new Error(plan.lens.refused);
        if (!serviceUrl) throw new Error('no lens member service URL: pass --lens-service or set notary-01 service.url in personas.json');
        attested = { lensChoice, owners, member, serviceUrl, credentialName: plan.live.credentialName };
    }

    if (args.dryRun) {
        try {
            const choice = await resolveLens({ explicit: args.lens, proposer: proposer.wallet, apiBase });
            plan.lens = { keys: choice.lens, source: choice.source, why: choice.reason };
        } catch (error) {
            plan.lens = { keys: [], refused: `would refuse to mint: ${error.message}` };
        }
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
                canonicalCase: caseState, lensChoice: caseState.lensChoice ?? null, activities,
                outcome: status === 'done' ? 'completed' : 'partial'
            } });
        };
        const perform = async (persona, action, execute) => (await runtime.run(actor(persona), {
            source: 'live', action: { ...action, proposalId: config.proposalId }, execute
        })).outcome;

        if (!caseState.mint?.proposalPda) {
            // Chosen once and checkpointed; a directory without a qualifying member refuses the mint.
            if (!caseState.lensChoice) {
                const lensChoice = attested ? attested.lensChoice : await resolveLens({ explicit: args.lens, proposer: proposer.wallet, apiBase });
                console.log(`[${new Date().toISOString()}] ${describeLensChoice(lensChoice)}`);
                await checkpoint('lens', { lensChoice });
            }
            const mint = await perform(proposer, createAction({ lens: caseState.lensChoice.lens }), () => mintProposal({
                connection, programId: PROPOSAL_NFT_PROGRAM, ownerKeypair: proposerSigner.keypair,
                parcelIds: config.parcelIds, isConditional: true,
                imageUri: `${apiBase}/proposals/${config.proposalId}`, lamports: 0n,
                lens: caseState.lensChoice.lens, sendAndConfirm: sendAndConfirmPolling
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
        if (!args.terminal && !attested) {
            await checkpoint('funded_and_forecast', { completedAt: new Date().toISOString() }, 'done');
            console.log(JSON.stringify({ status: 'completed', case: `${apiBase}/hackathon/cases/${config.proposalId}`, ...caseState }, null, 2));
            return;
        }

        const metadataUri = parcelId => `${apiBase}/parcels/parcelIds?ids=${encodeURIComponent(parcelId)}`;
        if (config.outcome === 'attested') {
            // Canonical case v3. Each step below is one entry of attestedCaseSteps(); a resumed run skips
            // whatever the checkpoint already holds.
            const pending = attestedCaseSteps({ config, notaryKey: attested.member, owners: attested.owners, caseState }).filter(step => !step.done);
            console.log(`[${new Date().toISOString()}] attested case: ${pending.length} step(s) left: ${pending.map(step => step.action).join(', ') || 'none'}`);
            const signers = new Map();
            const signerOf = wallet => {
                if (!signers.has(wallet)) signers.set(wallet, { persona: ownerPersona(allPersonas, wallet), ...loadKeypair(ownerPersona(allPersonas, wallet)) });
                return signers.get(wallet);
            };
            const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
            for (const step of pending.filter(item => item.action === 'anchor_parcel')) {
                const anchor = await perform(supporter, { type: 'anchorParcel', parcelId: step.parcelUid }, () => ensureParcelAnchor({
                    connection, payerKeypair: supporterSigner.keypair, parcelId: step.parcelUid,
                    metadataUri: metadataUri(step.parcelUid), sendAndConfirm: sendAndConfirmPolling
                }));
                await checkpoint('anchoring', { anchors: { ...(caseState.anchors || {}), [step.parcelUid]: anchor } });
            }
            for (const step of pending.filter(item => item.action === 'attest_ownership')) {
                const owner = signerOf(step.owner);
                const attestation = await perform(owner.persona, { type: 'attestOwnership', parcelId: step.parcelUid, member: attested.member }, async () => {
                    const result = await requestOwnershipAttestation({
                        serviceUrl: attested.serviceUrl, parcelUid: step.parcelUid, secretKey: owner.secret,
                        pay: async ({ paymentId, url, init }) => {
                            const { paidFetch } = await createPaidClient({ secretKey: owner.secret, paymentId, rpcUrl });
                            return paidFetch(url, init);
                        }
                    });
                    if (result.record?.authority && result.record.authority !== attested.member) {
                        throw new Error(`lens service ${attested.serviceUrl} attested as ${result.record.authority}, not the lens member ${attested.member}`);
                    }
                    return {
                        address: result.address, accountHash: result.accountHash, reused: result.reused, paid: result.paid,
                        ownerCount: result.payload?.ownerCount ?? null, transaction: result.record?.transactionSignature ?? null,
                        paymentId: paymentIdForOwnership({ serviceUrl: attested.serviceUrl, parcelUid: step.parcelUid, owner: step.owner })
                    };
                });
                if (attestation.ownerCount !== null && attestation.ownerCount !== step.ownerCount) {
                    throw new Error(`notary attested ownerCount ${attestation.ownerCount} for ${step.parcelUid}, the plan recorded ${step.ownerCount}`);
                }
                await checkpoint('attesting', { attestations: { ...(caseState.attestations || {}), [ownerKey(step.parcelUid, step.owner)]: attestation } });
            }
            for (const step of pending.filter(item => item.action === 'accept_with_attestations')) {
                const owner = signerOf(step.owner);
                const id = ownerKey(step.parcelUid, step.owner);
                const acceptance = await perform(owner.persona, { type: 'acceptance', parcelId: step.parcelUid, member: attested.member }, () => acceptWithAttestations({
                    connection, ownerKeypair: owner.keypair, proposalAccount: proposalPda, parcelId: step.parcelUid,
                    ownershipAttestation: caseState.attestations[id].address, member: attested.member,
                    credentialName: attested.credentialName, sendAndConfirm: sendAndConfirmPolling
                }));
                await checkpoint('accepting', { ownerAcceptances: { ...(caseState.ownerAcceptances || {}), [id]: acceptance } });
            }
        } else if (config.outcome === 'executed') {
            // Executed path (v1, recorded 2026-09): the certificate holder accepted each parcel with the
            // since-removed accept_proposal. The recorded run replays from its checkpoint; the anchor
            // step reads the anchor (and mints it ownerless if missing), and a NEW executed case cannot
            // accept any more — use --outcome attested.
            for (const parcelId of config.parcelIds) {
                if (caseState.certificates?.[parcelId]) continue;
                const certificate = await perform(supporter, { type: 'anchorParcel', parcelId }, () => ensureParcelAnchor({
                    connection, payerKeypair: supporterSigner.keypair, parcelId, metadataUri: metadataUri(parcelId),
                    sendAndConfirm: sendAndConfirmPolling
                }));
                await checkpoint('certifying', { certificates: { ...(caseState.certificates || {}), [parcelId]: certificate } });
            }
            const missing = config.parcelIds.filter(parcelId => !caseState.acceptances?.[parcelId]);
            if (missing.length) {
                throw new Error(`executed case has no recorded acceptance for ${missing.join(', ')}: v1 accept_proposal was removed by lens model v2; run --outcome attested instead`);
            }
        }
        if (config.outcome === 'executed' || config.outcome === 'attested') {
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
