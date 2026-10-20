// Fresh, batched read-only eligibility for supporter decisions. Missing markets may be created;
// resolved markets and existing support positions must never become new stake attempts.
import { createRequire } from 'node:module';
import { PublicKey } from '@solana/web3.js';
import { accountsPerRequest, getMultipleAccountsBatched } from '../solana/account-batching.js';
import { eligibleSupportProposals, proposalAccount } from './supporter-picker.js';
import { refreshProposalStatuses } from './discovery.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const market = require('../../frontend/js/solana/market-client.js');
const pledge = require('../../frontend/js/solana/pledge-client.js');
market.configure({ web3 });
pledge.configure({ web3 });

function decode(info, codec, program) {
    if (!info) return null;
    if (!info.owner || !new PublicKey(info.owner).equals(new PublicKey(program))) {
        throw new Error('Support eligibility account is not owned by its expected program');
    }
    return codec(info.data);
}

export async function readSupportEligibility({ connection, wallet, persona, proposals, env = process.env }) {
    const candidates = eligibleSupportProposals(proposals, { wallet, personaName: persona.name });
    const actions = persona.support?.actions?.length ? persona.support.actions : ['pledge'];
    const stake = actions.some(action => String(action).toLowerCase() === 'stake');
    const pledges = actions.some(action => String(action).toLowerCase() === 'pledge');
    const owner = wallet ? new PublicKey(wallet) : null;
    const reads = [];
    candidates.forEach(proposal => {
        const account = proposalAccount(proposal);
        const [marketPda] = market.getMarketPda(account);
        if (stake) reads.push({ proposal, type: 'market', address: marketPda, codec: market.decodeMarket, program: market.constants.PROGRAM_ID });
        if (stake && owner) reads.push({ proposal, type: 'position', address: market.getPositionPda(marketPda, owner, 1)[0], codec: market.decodePosition, program: market.constants.PROGRAM_ID });
        if (pledges && owner) {
            const [book] = pledge.getPledgeBookPda(account);
            reads.push({ proposal, type: 'pledge', address: pledge.getPledgeCommitmentPda(book, owner)[0], codec: pledge.decodePledgeCommitment, program: pledge.constants.PROGRAM_ID });
        }
    });
    const infos = await getMultipleAccountsBatched(connection, reads.map(read => read.address), { batchSize: accountsPerRequest(env) });
    const supported = new Set(), closed = new Set();
    reads.forEach((read, index) => {
        const value = decode(infos[index], read.codec, read.program);
        if (!value) return;
        const id = String(read.proposal.proposalId || read.proposal.id);
        if (read.type === 'market' && value.resolved) closed.add(id);
        if (read.type === 'position' || (read.type === 'pledge'
            && [pledge.constants.PLEDGE_ACTIVE, pledge.constants.PLEDGE_FULFILLED].includes(value.status))) supported.add(id);
    });
    return {
        proposals: candidates.filter(proposal => !closed.has(String(proposal.proposalId || proposal.id))),
        alreadySupportedIds: [...supported], closedMarketIds: [...closed]
    };
}

// Recheck just the chosen target before funding/signing. A race remains a visible failure, never
// an invitation to repeat a signed action or silently spend on a different proposal.
export async function assertSupportEligibility({ connection, decision, pool }) {
    const proposals = [{ proposalId: decision.proposalId,
        onchain: { chainId: 'solana-devnet', proposalId: decision.proposalAccount } }];
    await refreshProposalStatuses(proposals, connection, { pool });
    if (proposals[0].lifecycleStatus !== 'Active') {
        throw new Error(`Support target ${decision.proposalId} is ${proposals[0].lifecycleStatus} on-chain; no action submitted`);
    }
    if (decision.type === 'stake') {
        const [address] = market.getMarketPda(decision.proposalAccount);
        const state = decode(await connection.getAccountInfo(address, 'confirmed'), market.decodeMarket, market.constants.PROGRAM_ID);
        if (state?.resolved) throw new Error(`Support target ${decision.proposalId} market is resolved; no action submitted`);
    }
}
