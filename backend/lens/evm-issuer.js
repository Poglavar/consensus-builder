// The lens member's EVM issuer (docs/blockchain-flows.md, R4): attests AgreementDecision-v1 through the
// Ethereum Attestation Service of the chain an agreement is minted on, signed by the member's EVM key
// (LENS_EVM_PRIVATE_KEY, else UGT_AGENT_EVM_PRIVATE_KEY). The Agreement contract
// (blockchain/contracts/Agreement.sol attest) takes the attestation when its attester is the agreement's
// lens, its schema the AgreementDecisionSchema of addresses.json and its data the five fields
// abi-encoded. After the transaction, the issuer reads the attestation back and checks it before
// returning: the uid comes from the receipt's Attested log, the issue time is the attestation's own.

import { ethers } from 'ethers';
import { agreementConfig, evmProvider } from '../chain/evm.js';

// AgreementDecision-v1 as EAS schema text, and the types its data is encoded with.
export const DECISION_SCHEMA_TEXT = 'string agreementCid, address sponsor, string decision, string evidenceRef, uint64 sourceObservedAt';
export const DECISION_DATA_TYPES = Object.freeze(['string', 'address', 'string', 'string', 'uint64']);

export const EAS_ABI = Object.freeze([
    'function attest((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value) data) request) payable returns (bytes32)',
    'function getAttestation(bytes32 uid) view returns ((bytes32 uid,bytes32 schema,uint64 time,uint64 expirationTime,uint64 revocationTime,bytes32 refUID,address recipient,address attester,bool revocable,bytes data))',
    'event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)'
]);
const EAS_INTERFACE = new ethers.Interface(EAS_ABI);

const failure = (code, message) => Object.assign(new Error(message), { code });

/** The attestation data of AgreementDecision-v1: abi.encode(agreementCid, sponsor, decision, evidenceRef, sourceObservedAt). */
export function encodeDecisionData({ agreementCid, sponsor, decision, evidenceRef, sourceObservedAt }) {
    return ethers.AbiCoder.defaultAbiCoder().encode(DECISION_DATA_TYPES, [agreementCid, sponsor, decision, evidenceRef, BigInt(sourceObservedAt)]);
}

/**
 * The uid of the one Attested event `eas` emitted in `receipt` for `attester` and `schemaUid`. Throws
 * 'attestation-not-logged' when there is none and 'attestation-ambiguous' when there are several.
 */
export function attestedUidOf(receipt, { eas, attester, schemaUid }) {
    const uids = [];
    for (const log of receipt?.logs || []) {
        if (typeof log.address !== 'string' || log.address.toLowerCase() !== eas.toLowerCase()) continue;
        let parsed = null;
        try { parsed = EAS_INTERFACE.parseLog({ topics: log.topics, data: log.data }); } catch { parsed = null; }
        if (parsed?.name !== 'Attested') continue;
        if (parsed.args.attester.toLowerCase() !== attester.toLowerCase() || parsed.args.schemaUID.toLowerCase() !== schemaUid.toLowerCase()) continue;
        uids.push(parsed.args.uid.toLowerCase());
    }
    if (!uids.length) throw failure('attestation-not-logged', `transaction ${receipt?.hash} logged no Attested event of ${attester} on schema ${schemaUid}`);
    if (uids.length > 1) throw failure('attestation-ambiguous', `transaction ${receipt?.hash} logged ${uids.length} Attested events of ${attester}`);
    return uids[0];
}

/** The EVM wallet of a private key; 'invalid-evm-key' without the key ever appearing in a message. */
function walletOf(privateKey) {
    try {
        return new ethers.Wallet(privateKey);
    } catch {
        throw failure('invalid-evm-key', 'the lens EVM key (LENS_EVM_PRIVATE_KEY or UGT_AGENT_EVM_PRIVATE_KEY) is not a valid EVM private key');
    }
}

/** The member's EVM key from the env: LENS_EVM_PRIVATE_KEY, else UGT_AGENT_EVM_PRIVATE_KEY, else null. */
export const lensEvmKeyOf = env => (env.LENS_EVM_PRIVATE_KEY || env.UGT_AGENT_EVM_PRIVATE_KEY || '').trim() || null;

/**
 * { address, attest({ chainId, schemaUid, data, expirationTime }) → { uid, txHash, issuedAt } }.
 * issuedAt is the attestation's EAS time (Unix seconds, the chain's block time). The EAS contract is the
 * chain's in addresses.json; `easFor({ config, wallet })` (the ethers Contract signing with the wallet over
 * `providerFor(chainId)` by default) and `addressBook` are injectable for tests.
 */
export function createEvmIssuer({
    privateKey,
    env = process.env,
    providerFor = chainId => evmProvider(chainId, { env }),
    easFor = ({ config, wallet }) => new ethers.Contract(config.addresses.EAS, EAS_ABI, wallet.connect(providerFor(config.chainId))),
    addressBook,
    log = () => {}
}) {
    if (!privateKey) throw failure('no-evm-key', 'the lens member has no EVM key: set LENS_EVM_PRIVATE_KEY (or UGT_AGENT_EVM_PRIVATE_KEY)');
    const wallet = walletOf(privateKey);
    return {
        kind: 'eas',
        address: wallet.address,
        async attest({ chainId, schemaUid, data, expirationTime }) {
            const config = agreementConfig(chainId, env, addressBook ? { addressBook } : {});
            if (schemaUid.toLowerCase() !== config.addresses.AgreementDecisionSchema.toLowerCase()) {
                throw failure('wrong-schema', `schema ${schemaUid} is not the AgreementDecisionSchema of ${config.name}`);
            }
            const eas = easFor({ config, wallet });
            const tx = await eas.attest({
                schema: schemaUid,
                data: { recipient: ethers.ZeroAddress, expirationTime: BigInt(expirationTime), revocable: true, refUID: ethers.ZeroHash, data, value: 0n }
            });
            log(`EAS attest sent on ${config.name}: ${tx.hash}`);
            const receipt = await tx.wait();
            if (!receipt || receipt.status !== 1) throw failure('attest-failed', `EAS attest ${tx.hash} on ${config.name} did not succeed`);
            const uid = attestedUidOf(receipt, { eas: config.addresses.EAS, attester: wallet.address, schemaUid });
            // The artifact, not the receipt's word for it: the attestation as EAS stores it.
            const stored = await eas.getAttestation(uid);
            if (stored.attester.toLowerCase() !== wallet.address.toLowerCase() || stored.schema.toLowerCase() !== schemaUid.toLowerCase()
                || stored.data.toLowerCase() !== data.toLowerCase() || BigInt(stored.expirationTime) !== BigInt(expirationTime)) {
                throw failure('attestation-mismatch', `EAS attestation ${uid} on ${config.name} does not carry this member's request`);
            }
            return { uid, txHash: receipt.hash, issuedAt: Number(stored.time) };
        }
    };
}

/**
 * A dry-run EVM issuer: an ephemeral address, uids and transaction hashes made up from the request,
 * the clock's time. Signs and sends nothing.
 */
export function createFakeEvmIssuer({ clock, address = ethers.Wallet.createRandom().address } = {}) {
    let count = 0;
    return {
        kind: 'fake-eas',
        address,
        async attest({ chainId, schemaUid, data, expirationTime }) {
            count += 1;
            const seed = ethers.AbiCoder.defaultAbiCoder().encode(['string', 'bytes32', 'bytes', 'uint64', 'uint256'], [String(chainId), schemaUid, data, BigInt(expirationTime), BigInt(count)]);
            return { uid: ethers.keccak256(seed), txHash: ethers.keccak256(ethers.concat([seed, '0x01'])), issuedAt: clock.nowSeconds() };
        }
    };
}
