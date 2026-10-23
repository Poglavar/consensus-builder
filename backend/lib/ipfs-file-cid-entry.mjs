import { encode, prepare } from '@ipld/dag-pb';
import { UnixFS } from 'ipfs-unixfs';
import { CID } from 'multiformats/cid';
import { create as createDigest } from 'multiformats/hashes/digest';

export const MAX_BYTES = 10 * 1024 * 1024;
export const CHUNK_BYTES = 256 * 1024;

const RAW_CODEC = 0x55;
const DAG_PB_CODEC = 0x70;
const SHA2_256 = 0x12;
const SHA256_BYTES = 32;

function inputError(message, ErrorType = TypeError) {
    const error = new ErrorType(message);
    error.code = 'invalid-cid-input';
    return error;
}

function sha256Bytes(sha256, bytes) {
    const digest = sha256(bytes);
    if (!(digest instanceof Uint8Array) || digest.byteLength !== SHA256_BYTES) {
        throw inputError('sha256 must return a 32-byte Uint8Array');
    }
    return new Uint8Array(digest);
}

/**
 * Build the root multicodec and SHA-256 digest for raw bytes imported as flat UnixFS.
 * A one-chunk file keeps its raw CID; larger files use raw leaves and a flat DAG-PB file node.
 */
export function fileRoot(bytes, sha256) {
    if (!(bytes instanceof Uint8Array)) throw inputError('fileRoot expects a Uint8Array');
    if (bytes.byteLength > MAX_BYTES) throw inputError(`fileRoot accepts at most ${MAX_BYTES} bytes`, RangeError);
    if (typeof sha256 !== 'function') throw inputError('fileRoot expects a synchronous SHA-256 function');

    if (bytes.byteLength <= CHUNK_BYTES) {
        return { codec: RAW_CODEC, digest: sha256Bytes(sha256, bytes) };
    }

    const unixfs = new UnixFS({ type: 'file' });
    const links = [];
    for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
        const chunk = bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.byteLength));
        const digest = createDigest(SHA2_256, sha256Bytes(sha256, chunk));
        links.push({
            Hash: CID.createV1(RAW_CODEC, digest),
            Name: '',
            Tsize: chunk.byteLength
        });
        unixfs.addBlockSize(BigInt(chunk.byteLength));
    }

    const rootBlock = encode(prepare({ Data: unixfs.marshal(), Links: links }));
    return { codec: DAG_PB_CODEC, digest: sha256Bytes(sha256, rootBlock) };
}
