// Stable SHA-256 identity shared by browser and server parcel adapters.
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

export function sha256Hex(value) {
    const bytes = typeof value === 'string' ? utf8ToBytes(value) : value;
    return bytesToHex(sha256(bytes));
}
