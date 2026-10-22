// Fresh, batched read-only eligibility for supporter decisions. Missing markets may be created;
// resolved markets and existing support positions must never become new support attempts. The subject
// of every market, position and pledge read here is the agreement's chain account.
import { createRequire } from 'node:module';
import { PublicKey } from '@solana/web3.js';
import { accountsPerRequest, getMultipleAccountsBatched } from '../solana/account-batching.js';
import { eligibleSupportAgreements } from './supporter-picker.js';
import { AGREEMENT_STATUS, readAgreementAccount } from './agreement-minter.js';

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

export async function readSupportEligibility({ connection, wallet, persona, agreements, env = process.env }) {
    const candidates = eligibleSupportAgreements(agreements, { wallet, personaName: persona.name });
    const actions = persona.support?.actions?.length ? persona.support.actions : ['pledge'];
    const stake = actions.some(action => String(action).toLowerCase() === 'stake');
    const pledges = actions.some(action => String(action).toLowerCase() === 'pledge');
    const owner = wallet ? new PublicKey(wallet) : null;
    const reads = [];
    candidates.forEach(agreement => {
        const [marketPda] = market.getMarketPda(agreement.account);
        if (stake) reads.push({ agreement, type: 'market', address: marketPda, codec: market.decodeMarket, program: market.constants.PROGRAM_ID });
        if (stake && owner) reads.push({ agreement, type: 'position', address: market.getPositionPda(marketPda, owner, 1)[0], codec: market.decodePosition, program: market.constants.PROGRAM_ID });
        if (pledges && owner) {
            const [book] = pledge.getPledgeBookPda(agreement.account);
            reads.push({ agreement, type: 'pledge', address: pledge.getPledgeCommitmentPda(book, owner)[0], codec: pledge.decodePledgeCommitment, program: pledge.constants.PROGRAM_ID });
        }
    });
    const infos = await getMultipleAccountsBatched(connection, reads.map(read => read.address), { batchSize: accountsPerRequest(env) });
    const supported = new Set(), closed = new Set();
    reads.forEach((read, index) => {
        const value = decode(infos[index], read.codec, read.program);
        if (!value) return;
        if (read.type === 'market' && value.resolved) closed.add(read.agreement.cid);
        if (read.type === 'position' || (read.type === 'pledge'
            && [pledge.constants.PLEDGE_ACTIVE, pledge.constants.PLEDGE_FULFILLED].includes(value.status))) supported.add(read.agreement.cid);
    });
    return {
        agreements: candidates.filter(agreement => !closed.has(agreement.cid)),
        alreadySupportedCids: [...supported], closedMarketCids: [...closed]
    };
}

// Recheck just the chosen target before funding/signing. A race remains a visible failure, never
// an invitation to repeat a signed action or silently spend on a different agreement.
export async function assertSupportEligibility({ connection, decision }) {
    const state = await readAgreementAccount(connection, { account: decision.account });
    if (!state || state.cid !== decision.agreementCid) {
        throw new Error(`Support target ${decision.agreementCid} has no agreement account ${decision.account}; no action submitted`);
    }
    if (state.status !== AGREEMENT_STATUS.active) {
        throw new Error(`Support target ${decision.agreementCid} is ${state.status} on-chain; no action submitted`);
    }
    if (decision.type === 'stake') {
        const [address] = market.getMarketPda(decision.account);
        const marketState = decode(await connection.getAccountInfo(address, 'confirmed'), market.decodeMarket, market.constants.PROGRAM_ID);
        if (marketState?.resolved) throw new Error(`Support target ${decision.agreementCid} market is resolved; no action submitted`);
    }
}
