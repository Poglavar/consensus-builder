// SAS issuers for the reference lens member, behind one interface:
//   createAttestation({ credential, schema, payload, expiry, nonce, address })
//     -> { address, accountBytes, signature, issuedAt }   (issuedAt: chain Unix seconds or null)
// The fake issuer builds the exact on-chain account bytes in memory (dry runs, tests). The SAS
// issuer sends a real create_attestation through sas-lib, confirms by polling, and reads the account
// and block time back from chain. sas-lib is a backend dependency (package.json).

import * as kit from '@solana/kit';
import * as sas from 'sas-lib';
import { Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { buildSasAttestationAccount, sha256Hex } from '../oracle/lens-schemas.js';
import { sendAndConfirmPolling } from '../agents/solana-send.js';
import { lensLog } from './errors.js';

export function createFakeIssuer({ authority, clock }) {
    const accounts = new Map();
    return {
        kind: 'fake',
        authority,
        accounts,
        async createAttestation({ credential, schema, payload, expiry, nonce, address }) {
            if (accounts.has(address)) throw new Error(`attestation ${address} already exists`);
            const accountBytes = buildSasAttestationAccount({ nonce, credential, schema, payload, authority, expiry });
            accounts.set(address, accountBytes);
            return {
                address,
                accountBytes,
                signature: `dry-run:${sha256Hex(accountBytes).slice(0, 32)}`,
                // The fake chain's clock: this is the dry run's stand-in for block time.
                issuedAt: clock.nowSeconds()
            };
        }
    };
}

// Kit instruction (sas-lib) -> web3.js instruction, so the send goes through the repo's polling
// confirm (agents/solana-send.js) instead of a WebSocket subscription.
function toWeb3Instruction(instruction) {
    return new TransactionInstruction({
        programId: new PublicKey(instruction.programAddress),
        keys: instruction.accounts.map(account => ({
            pubkey: new PublicKey(account.address),
            isSigner: account.role >= 2,
            isWritable: (account.role & 1) === 1
        })),
        data: Buffer.from(instruction.data)
    });
}

export async function loadSasIssuer({ keypair, rpcUrl, commitment = 'confirmed' }) {
    const signer = await kit.createKeyPairSignerFromBytes(keypair.secretKey);
    const connection = new Connection(rpcUrl, commitment);
    const authority = keypair.publicKey.toBase58();

    return {
        kind: 'sas',
        authority,
        async createAttestation({ credential, schema, payload, expiry, nonce, address }) {
            const [derived] = await sas.deriveAttestationPda({ credential: kit.address(credential), schema: kit.address(schema), nonce: kit.address(nonce) });
            if (derived !== address) throw new Error(`attestation PDA mismatch: sas-lib ${derived} vs ${address}`);
            const instruction = sas.getCreateAttestationInstruction({
                payer: signer,
                authority: signer,
                credential: kit.address(credential),
                schema: kit.address(schema),
                attestation: kit.address(address),
                nonce: kit.address(nonce),
                data: payload,
                expiry
            });
            const signature = await sendAndConfirmPolling(connection, new Transaction().add(toWeb3Instruction(instruction)), [keypair], { commitment });
            lensLog(`create_attestation ${address} confirmed: ${signature}`);
            const info = await connection.getAccountInfo(new PublicKey(address), commitment);
            if (!info) throw new Error(`attestation ${address} not found after confirmed transaction ${signature}`);
            const tx = await connection.getTransaction(signature, { commitment, maxSupportedTransactionVersion: 0 });
            const blockTime = tx?.blockTime ?? (tx?.slot !== undefined ? await connection.getBlockTime(tx.slot) : null);
            if (blockTime === null || blockTime === undefined) {
                lensLog(`WARNING: no block time for ${signature}; attestation ${address} is recorded with issued_at NULL`);
            }
            return { address, accountBytes: Buffer.from(info.data), signature, issuedAt: blockTime ?? null };
        }
    };
}
