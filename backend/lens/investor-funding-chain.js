// Finalized, read-only evidence for an investor-funded agreement, read when this lens member qualifies
// an apartment buyer.  The agreement account, the donation escrow, its USDC vault and the apartment
// listings are read in one RPC context so a qualification cannot be assembled from a mix of slots.
// The funding target is not judged here: the program confirms it (confirm_funding).  This is
// intentionally not the soft-pledge book: crowdfunding is paid USDC held in the canonical donation vault.
import { createRequire } from 'node:module';
import { AGREEMENT_PROGRAM_ID, DEVNET_GENESIS_HASH } from '../agreements/onchain.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const agreementClient = require('../../frontend/js/solana/agreement-client.js').configure({ web3 });
const pledgeClient = require('../../frontend/js/solana/pledge-client.js').configure({ web3 });
const agreementRecord = require('../../frontend/js/agreement-record.js');

const TOKEN_ACCOUNT_SIZE = 165;

function keyAt(data, offset) {
    return new web3.PublicKey(data.subarray(offset, offset + 32)).toBase58();
}

function tokenAmount(info, vault, escrow) {
    if (!info?.data || info.owner?.toBase58?.() !== pledgeClient.constants.TOKEN_PROGRAM_ID) {
        throw new Error(`USDC vault ${vault} is absent or not owned by the token program`);
    }
    const data = new Uint8Array(info.data);
    if (data.length !== TOKEN_ACCOUNT_SIZE) throw new Error(`USDC vault ${vault} is not a token account`);
    if (keyAt(data, 0) !== pledgeClient.constants.USDC_DEVNET_MINT || keyAt(data, 32) !== escrow) {
        throw new Error(`USDC vault ${vault} does not belong to the canonical escrow`);
    }
    // spl_token::state::AccountState::Initialized is 1; Frozen (2) cannot be released safely.
    if (data[108] !== 1) throw new Error(`USDC vault ${vault} is not initialized and unfrozen`);
    return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);
}

/**
 * A production adapter for observeInvestorFunding.  `observe` returns only data read at
 * finalized commitment, including the finalized slot and its chain block time.  It never signs.
 */
export function createInvestorFundingChain({ connection, rpcUrl = 'https://api.devnet.solana.com' } = {}) {
    const rpc = connection || new web3.Connection(rpcUrl, 'finalized');
    let networkCheck = null;
    async function ready() {
        networkCheck ??= rpc.getGenesisHash().then(hash => {
            if (hash !== DEVNET_GENESIS_HASH) throw new Error(`funding RPC answers genesis ${hash}, not devnet`);
        }).catch(error => { networkCheck = null; throw error; });
        await networkCheck;
        return rpc;
    }
    return {
        agreementProgramId: AGREEMENT_PROGRAM_ID,
        pledgeProgramId: pledgeClient.constants.PROGRAM_ID,
        async observe({ cid, sponsor, account, funding }) {
            const conn = await ready();
            const expectedAgreement = agreementClient.getAgreementPda(cid, sponsor)[0].toBase58();
            if (expectedAgreement !== account) throw new Error('agreement account is not the sponsor/CID PDA');
            const escrow = pledgeClient.getDonationEscrowPda(account)[0].toBase58();
            const vault = pledgeClient.getAssociatedTokenAddress(escrow, pledgeClient.constants.USDC_DEVNET_MINT).toBase58();
            const offers = pledgeClient.apartmentOffers(funding, sponsor, agreementRecord);
            const { context, value } = await conn.getMultipleAccountsInfoAndContext([
                new web3.PublicKey(account), new web3.PublicKey(escrow), new web3.PublicKey(vault), ...offers.map(offer => new web3.PublicKey(offer.account))
            ], 'finalized');
            if (!Array.isArray(value) || value.length !== 3 + offers.length) throw new Error('funding RPC did not return all canonical accounts');
            const [agreementInfo, escrowInfo, vaultInfo] = value;
            if (!agreementInfo?.data || agreementInfo.owner?.toBase58?.() !== AGREEMENT_PROGRAM_ID) {
                throw new Error(`agreement ${account} is absent or belongs to another program`);
            }
            if (!escrowInfo?.data || escrowInfo.owner?.toBase58?.() !== pledgeClient.constants.PROGRAM_ID) {
                throw new Error(`donation escrow ${escrow} is absent or belongs to another program`);
            }
            const agreement = agreementClient.readAgreement(new Uint8Array(agreementInfo.data), account);
            if (!agreement) throw new Error(`agreement ${account} does not decode`);
            const donation = pledgeClient.decodeDonationEscrow(new Uint8Array(escrowInfo.data));
            const blockTime = await conn.getBlockTime(context.slot);
            if (!Number.isSafeInteger(context.slot) || !Number.isSafeInteger(blockTime)) {
                throw new Error(`finalized slot ${context.slot} has no usable block time`);
            }
            return { slot: context.slot, blockTime, agreement, donation, escrow, vault,
                ...(offers.length ? { reservations: pledgeClient.apartmentInventoryRows(offers, value.slice(3), account, sponsor) } : {}),
                vaultUsdcAtomic: tokenAmount(vaultInfo, vault, escrow) };
        }
    };
}
