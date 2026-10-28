// Fresh eligibility for supporter decisions. Agreement-market reads verify devnet and canonical
// sponsor-bound LMSR terms; pledges keep their independent codec and account namespace.
import { createRequire } from 'node:module';
import { PublicKey } from '@solana/web3.js';
import { accountsPerRequest, getMultipleAccountsBatched } from '../solana/account-batching.js';
import { eligibleSupportAgreements } from './supporter-picker.js';
import { AGREEMENT_STATUS } from './agreement-minter.js';
import { readAgreementMarket } from './bettor.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const market = require('../../frontend/js/solana/lmsr-client.js');
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
    const wantsMarket = actions.some(action => String(action).toLowerCase() === 'stake');
    const wantsPledges = actions.some(action => String(action).toLowerCase() === 'pledge');
    const owner = wallet ? new PublicKey(wallet) : null;
    const supported = new Set(), closed = new Set();

    if (wantsMarket) {
        for (const agreement of candidates) {
            const context = await readAgreementMarket(connection, agreement.account);
            const raw = context.market;
            if (!raw) continue;
            if (raw.resolved) { closed.add(agreement.cid); continue; }
            if (!owner) continue;
            const position = await market.readPosition(context.connection, context.address, owner, market.constants.SIDE_YES);
            if (position) supported.add(agreement.cid);
        }
    }

    if (wantsPledges && owner) {
        const reads = candidates.map(agreement => {
            const [book] = pledge.getPledgeBookPda(agreement.account);
            return { agreement, address: pledge.getPledgeCommitmentPda(book, owner)[0] };
        });
        const connectionReady = wantsMarket && candidates.length
            ? (await readAgreementMarket(connection, candidates[0].account)).connection
            : connection;
        const infos = await getMultipleAccountsBatched(connectionReady, reads.map(read => read.address), { batchSize: accountsPerRequest(env) });
        reads.forEach((read, index) => {
            const value = decode(infos[index], pledge.decodePledgeCommitment, pledge.constants.PROGRAM_ID);
            if (value && [pledge.constants.PLEDGE_ACTIVE, pledge.constants.PLEDGE_FULFILLED].includes(value.status)) supported.add(read.agreement.cid);
        });
    }
    return { agreements: candidates.filter(agreement => !closed.has(agreement.cid)), alreadySupportedCids: [...supported], closedMarketCids: [...closed] };
}

// Recheck the agreement and market immediately before a trade. The transaction's program checks are
// authoritative, but this avoids signing against a stale terminal agreement or noncanonical account.
export async function assertSupportEligibility({ connection, decision }) {
    const context = await readAgreementMarket(connection, decision.account);
    if (context.agreement.cid !== decision.agreementCid) {
        throw new Error(`Support target ${decision.agreementCid} does not match agreement account ${decision.account}; no action submitted`);
    }
    if (context.agreement.status !== AGREEMENT_STATUS.active) {
        throw new Error(`Support target ${decision.agreementCid} is ${context.agreement.status} on-chain; no action submitted`);
    }
    if (context.market?.resolved) throw new Error(`Support target ${decision.agreementCid} market is resolved; no action submitted`);
}
