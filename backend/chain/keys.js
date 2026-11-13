// The wallet keys an agreement may name as its sponsor or a lens member (docs/blockchain-flows.md, R4):
// a canonical base58 Solana public key or an EVM address. One place for the check and the comparison,
// so the index, the lens member and its schemas accept the same keys: base58 keys compare exactly, EVM
// addresses case-insensitively (a mixed-case address must carry a valid EIP-55 checksum).

import { PublicKey } from '@solana/web3.js';
import { ethers } from 'ethers';

export const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** Whether `value` is a canonical base58 public key. */
export function isBase58Key(value) {
    if (typeof value !== 'string' || !value) return false;
    try {
        return new PublicKey(value).toBase58() === value;
    } catch {
        return false;
    }
}

/** Whether `value` is an EVM address: 0x and 40 hex digits, all lower, all upper or EIP-55 checksummed. */
export function isEvmAddress(value) {
    return typeof value === 'string' && EVM_ADDRESS_PATTERN.test(value) && ethers.isAddress(value);
}

/** Whether `value` is a key an agreement may name: a base58 key or an EVM address. */
export const isChainKey = value => isBase58Key(value) || isEvmAddress(value);

/** 'solana', 'evm' or null: which chain family a key belongs to. */
export const keyFamily = value => (isBase58Key(value) ? 'solana' : isEvmAddress(value) ? 'evm' : null);

/** Whether two keys name the same wallet: base58 exactly, EVM addresses whatever their case. */
export function sameKey(a, b) {
    if (isEvmAddress(a) && isEvmAddress(b)) return a.toLowerCase() === b.toLowerCase();
    return isBase58Key(a) && a === b;
}
