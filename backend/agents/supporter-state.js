// Fresh eligibility for supporter decisions. Agreement-market reads verify devnet and canonical
// sponsor-bound LMSR terms; pledges keep their independent codec and account namespace.
import { createRequire } from 'node:module';
import { PublicKey } from '@solana/web3.js';
import { accountsPerRequest, getMultipleAccountsBatched } from '../solana/account-batching.js';
import { eligibleSupportAgreements } from './supporter-picker.js';
import { AGREEMENT_STATUS } from './agreement-minter.js';
import { readAgreementMarket, readAgreementMarkets } from './bettor.js';

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
    const supported = new Set(), closed = new Set(), unopened = new Set();
    const batchSize = accountsPerRequest(env);
    let connectionReady = connection;

    if (wantsMarket && candidates.length) {
        const contexts = await readAgreementMarkets(connection, candidates.map(agreement => agreement.account), { env });
        connectionReady = contexts.get(candidates[0].account).connection;
        const openWithMarket = [];
        for (const agreement of candidates) {
            const context = contexts.get(agreement.account);
            const raw = context?.market;
            if (!raw) { unopened.add(agreement.cid); continue; }
            if (raw.resolved) { closed.add(agreement.cid); continue; }
            openWithMarket.push({ agreement, context });
        }
        if (owner && openWithMarket.length) {
            const positionPdas = openWithMarket.map(({ context }) => market.getPositionPda(context.address, owner, market.constants.SIDE_YES)[0]);
            const positionInfos = await getMultipleAccountsBatched(connectionReady, positionPdas, { batchSize });
            openWithMarket.forEach(({ agreement, context }, index) => {
                if (market.readPositionAccount(positionInfos[index], context.address, owner, market.constants.SIDE_YES)) supported.add(agreement.cid);
            });
        }
    }

    if (wantsPledges && owner && candidates.length) {
        const reads = candidates.map(agreement => {
            const [book] = pledge.getPledgeBookPda(agreement.account);
            return { agreement, address: pledge.getPledgeCommitmentPda(book, owner)[0] };
        });
        const infos = await getMultipleAccountsBatched(connectionReady, reads.map(read => read.address), { batchSize });
        reads.forEach((read, index) => {
            const value = decode(infos[index], pledge.decodePledgeCommitment, pledge.constants.PROGRAM_ID);
            if (value && [pledge.constants.PLEDGE_ACTIVE, pledge.constants.PLEDGE_FULFILLED].includes(value.status)) supported.add(read.agreement.cid);
        });
    }
    return {
        agreements: candidates.filter(agreement => !closed.has(agreement.cid)),
        alreadySupportedCids: [...supported],
        closedMarketCids: [...closed],
        unopenedMarketCids: [...unopened]
    };
}

// Recheck the agreement and market immediately before a trade. The transaction's program checks are
// authoritative, but this avoids signing against a stale terminal agreement or noncanonical account.
// Optional `onContext` receives the freshly verified market context so a stake can reuse it without re-reading.
export async function assertSupportEligibility({ connection, decision, onContext = null }) {
    const context = await readAgreementMarket(connection, decision.account);
    if (context.agreement.cid !== decision.agreementCid) {
        throw new Error(`Support target ${decision.agreementCid} does not match agreement account ${decision.account}; no action submitted`);
    }
    if (context.agreement.status !== AGREEMENT_STATUS.active) {
        throw new Error(`Support target ${decision.agreementCid} is ${context.agreement.status} on-chain; no action submitted`);
    }
    if (context.market?.resolved) throw new Error(`Support target ${decision.agreementCid} market is resolved; no action submitted`);
    onContext?.(context);
}
