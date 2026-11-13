// Creates and funds an agreement on an EVM chain's Agreement contract with the agent's wallet: the node
// twin of the browser's EVM mint (frontend/js/chain/evm-agreement.js), on the same ABI, key and checks.
// The key is keyOf(sponsor, cid), so only the sponsor that published the agreement can create it. The
// contract is read first, so a rerun creates nothing twice and funds only what the escrow still lacks.
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import { isEvmAddress, sameKey } from '../chain/keys.js';

const require = createRequire(import.meta.url);
const EvmAgreement = require('../../frontend/js/chain/evm-agreement.js');

const failure = (code, message, extra = {}) => Object.assign(new Error(message), { code }, extra);

function toWei(value, label = 'wei') {
    if (value === undefined || value === null || value === '') return 0n;
    if (typeof value === 'bigint') {
        if (value < 0n) throw failure('invalid-amount', `${label} cannot be negative`);
        return value;
    }
    const text = String(value).trim();
    if (!/^\d+$/.test(text)) throw failure('invalid-amount', `${label} must be a non-negative whole number of wei, got ${JSON.stringify(value)}`);
    return BigInt(text);
}

// Simulate (so a refusal names the contract's error), send, wait for the receipt; the transaction hash.
async function send(contract, method, args, value) {
    const call = value > 0n ? [...args, { value }] : args;
    try {
        await contract[method].staticCall(...call);
    } catch (error) {
        const reason = EvmAgreement.revertReason(error, contract.interface);
        throw failure('simulation-failed', `${method} would fail: ${reason}; nothing signed`, { reason, cause: error });
    }
    const tx = await contract[method](...call);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw failure('confirmation-failed', `the ${method} transaction ${tx.hash} failed on chain`, { txHash: tx.hash });
    return tx.hash;
}

/**
 * Create the agreement (if missing) with `wei` as both its first escrow and the escrow execution
 * requires: create(cid, lens, deadline, openGround, requiredWei, payout) with value `wei`. An existing
 * agreement must carry the same lens, deadline, required wei and payout, or nothing is signed; one whose
 * escrow holds less than `wei` is funded with the shortfall.
 * @param {{ signer: { contract, chainId: string, address: string, wallet: string }, cid: string, lens: string,
 *   deadline?: string|null, wei?: bigint|string, payout?: string|null, openGround?: boolean, nowSeconds?: number }} options
 *   signer: chain/evm.js agreementSigner; payout defaults to the sponsor (the agent's wallet)
 * @returns {Promise<{ chainId, contract, account, signature: string|null, createSignature: string|null, created: boolean,
 *   fundedWei: string, requiredWei: string, escrowWei: string, status: string, explorerUrl: string|null }>}
 */
export async function mintEvmAgreement({
    signer, cid, lens, deadline = null, wei = 0n, payout = null, openGround = false, nowSeconds = Math.floor(Date.now() / 1000)
} = {}) {
    if (!signer?.contract || !isEvmAddress(signer.wallet)) throw failure('no-signer', 'an Agreement signer (chain/evm.js agreementSigner) is required');
    const { contract, wallet, chainId, address } = signer;
    if (!isEvmAddress(lens)) throw failure('invalid-lens', `the lens ${lens} is not an EVM address`);
    if (sameKey(lens, wallet)) throw failure('own-lens', `the lens is the sponsor's own address ${wallet}: a sponsor cannot attest its own agreement`);
    const payoutAddress = payout ?? wallet;
    if (!isEvmAddress(payoutAddress)) throw failure('invalid-payout', `the payout ${payoutAddress} is not an EVM address`);
    const required = toWei(wei);
    const deadlineSeconds = EvmAgreement.deadlineSeconds(deadline);
    const key = EvmAgreement.keyOf(wallet, cid, ethers);
    const read = () => EvmAgreement.readAgreement(contract, { key, cid, sponsor: wallet, chainId, address, ethers });

    const existing = await read();
    let createSignature = null;
    let fundSignature = null;
    let funded = 0n;
    if (existing) {
        const differs = [
            !sameKey(existing.lens, lens) ? `lens ${existing.lens}` : null,
            existing.deadline !== deadlineSeconds ? `deadline ${existing.deadline}` : null,
            existing.requiredLamports !== required ? `required wei ${existing.requiredLamports}` : null,
            !sameKey(existing.payout, payoutAddress) ? `payout ${existing.payout}` : null
        ].filter(Boolean);
        if (differs.length) throw failure('terms-differ', `agreement ${key} exists with other terms (${differs.join(', ')}); nothing signed`);
        const shortfall = required > existing.escrowLamports ? required - existing.escrowLamports : 0n;
        if (shortfall > 0n) {
            if (existing.statusCode !== EvmAgreement.constants.STATUS_ACTIVE) {
                throw failure('not-active', `agreement ${key} is ${existing.status}; its escrow can no longer be funded`);
            }
            fundSignature = await send(contract, 'fund', [key], shortfall);
            funded = shortfall;
        }
    } else {
        if (deadlineSeconds !== EvmAgreement.constants.NO_DEADLINE && deadlineSeconds <= nowSeconds) {
            throw failure('deadline-passed', `agreement ${cid} has a deadline in the past (${deadline}); it cannot be minted`);
        }
        createSignature = await send(contract, 'create',
            [cid, ethers.getAddress(lens.toLowerCase()), deadlineSeconds, Boolean(openGround), required, ethers.getAddress(payoutAddress.toLowerCase())], required);
        funded = required;
    }

    const after = await read();
    const signature = createSignature ?? fundSignature;
    if (!after) throw failure('account-missing', `agreement ${key} is missing after ${signature || 'no transaction'}`);
    if (after.escrowLamports < required) throw failure('escrow-short', `agreement ${key} holds ${after.escrowLamports} of ${required} wei after ${signature || 'no transaction'}`);
    return {
        chainId, contract: address, account: key, signature, createSignature, created: !existing,
        fundedWei: String(funded), requiredWei: String(required), escrowWei: String(after.escrowLamports), status: after.status,
        explorerUrl: EvmAgreement.explorerUrl(signature ? { signature, chainId } : { chainId, contract: address })
    };
}
