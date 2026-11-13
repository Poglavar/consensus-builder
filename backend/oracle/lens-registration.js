// Lens member self-registration for the attester directory: a member signs a canonical message
// with its own key, and the directory lists it once the signature, its SAS credential and schemas on
// chain, and its own /lens/status all agree. Nobody approves a member; they only have to be real.
// A member is one identity with an address per chain family: `key`, its Solana address, signs the
// registration, and an EVM address it also publishes signs its own statement (EIP-191).

import { createPrivateKey, sign } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { getBase58Decoder } from '@solana/kit';
import { ethers } from 'ethers';
import { isEvmAddress } from '../chain/keys.js';
import { verifyWalletSignature } from '../lens/identity/devnet-registry.js';
import { LENS_MEMBER_KINDS } from '../lens/member.js';
import { deriveLensSchemaPdas, SAS_PROGRAM_ID } from './lens-schemas.js';

export const LENS_REGISTRATION_TITLE = 'Urban Game Theory lens member registration v2';
export const LENS_EVM_ADDRESS_TITLE = 'Urban Game Theory lens member EVM address v1';
export const REGISTRATION_MAX_SKEW_SECONDS = 600;
const FIELDS = ['key', 'credentialName', 'kind', 'name', 'description', 'serviceUrl', 'evmAddress', 'signedAt'];
const CREDENTIAL_DISCRIMINATOR = 0;
const SCHEMA_DISCRIMINATOR = 1;
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export class RegistrationError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

const refuse = (status, code, message) => { throw new RegistrationError(status, code, message); };

function text(value, name, { max, required = true }) {
    if (value === undefined || value === null || value === '') {
        if (required) refuse(400, 'bad_request', `${name} is required`);
        return '';
    }
    if (typeof value !== 'string') refuse(400, 'bad_request', `${name} must be a string`);
    if (/[\r\n]/.test(value)) refuse(400, 'bad_request', `${name} must be one line`);
    if (value.length > max) refuse(400, 'bad_request', `${name} is longer than ${max} characters`);
    return value;
}

// https only, so a listed member can be called from any browser; allowHttp is for local tests.
export function normalizeServiceUrl(value, { allowHttp = false } = {}) {
    let url;
    try {
        url = new URL(text(value, 'serviceUrl', { max: 200 }));
    } catch (error) {
        if (error instanceof RegistrationError) throw error;
        refuse(400, 'bad_request', 'serviceUrl must be an absolute URL');
    }
    if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) refuse(400, 'bad_request', 'serviceUrl must be https');
    if (url.username || url.password || url.search || url.hash) refuse(400, 'bad_request', 'serviceUrl must not carry credentials, a query or a fragment');
    return url.toString().replace(/\/+$/, '');
}

export function normalizeRegistration(input = {}, options = {}) {
    let key;
    try {
        key = new PublicKey(input.key).toBase58();
    } catch {
        refuse(400, 'bad_request', 'key must be a base58 public key');
    }
    if (key !== input.key) refuse(400, 'bad_request', 'key must be a base58 public key');
    const kind = text(input.kind, 'kind', { max: 32 });
    if (!LENS_MEMBER_KINDS.includes(kind)) refuse(400, 'bad_request', `kind must be one of ${LENS_MEMBER_KINDS.join(', ')}`);
    if (!Number.isSafeInteger(input.signedAt) || input.signedAt <= 0) refuse(400, 'bad_request', 'signedAt must be Unix seconds');
    const evmAddress = input.evmAddress === undefined || input.evmAddress === null || input.evmAddress === '' ? '' : input.evmAddress;
    if (evmAddress && !isEvmAddress(evmAddress)) refuse(400, 'bad_request', 'evmAddress must be an EVM address');
    return {
        key,
        credentialName: text(input.credentialName, 'credentialName', { max: 32 }),
        kind,
        name: text(input.name, 'name', { max: 64 }),
        description: text(input.description, 'description', { max: 280, required: false }),
        serviceUrl: normalizeServiceUrl(input.serviceUrl, options),
        // Checksummed, so the signed text and the stored address are one spelling.
        evmAddress: evmAddress ? ethers.getAddress(evmAddress) : '',
        signedAt: input.signedAt
    };
}

// The exact UTF-8 text the member's key signs: a title line, then one `field: value` line each.
export function registrationMessage(registration) {
    return [LENS_REGISTRATION_TITLE, ...FIELDS.map(field => `${field}: ${registration[field] ?? ''}`)].join('\n');
}

// The exact text the member's EVM key signs (EIP-191 personal_sign) to publish that address: it names
// the member's Solana key and the registration's signed time, so it proves this address for this
// member in this registration and nothing else.
export function evmAddressStatement({ key, evmAddress, signedAt }) {
    return [LENS_EVM_ADDRESS_TITLE, `member: ${key}`, `evmAddress: ${evmAddress}`, `signedAt: ${signedAt}`].join('\n');
}

// The member side: sign a registration with a web3.js Keypair (base58 signature) and, when the member
// holds an EVM key, its EVM address statement with that ethers wallet (`evmSignature`).
export async function signRegistration(fields, keypair, { evmWallet = null } = {}) {
    const registration = normalizeRegistration({ ...fields, key: keypair.publicKey.toBase58(), evmAddress: evmWallet ? evmWallet.address : '' }, { allowHttp: true });
    const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(keypair.secretKey.slice(0, 32))]), format: 'der', type: 'pkcs8' });
    const signature = getBase58Decoder().decode(sign(null, Buffer.from(registrationMessage(registration), 'utf8'), privateKey));
    if (!evmWallet) return { ...registration, signature };
    return { ...registration, signature, evmSignature: await evmWallet.signMessage(evmAddressStatement(registration)) };
}

// Whether `signature` is the EVM address's EIP-191 signature of its statement; never throws.
function evmSignatureValid(registration, signature) {
    if (typeof signature !== 'string' || !signature) return false;
    try {
        return ethers.verifyMessage(evmAddressStatement(registration), signature) === registration.evmAddress;
    } catch {
        return false;
    }
}

function credentialAuthority(data) {
    if (!data || data.length < 33 || data[0] !== CREDENTIAL_DISCRIMINATOR) return null;
    return new PublicKey(data.subarray(1, 33)).toBase58();
}

function schemaCredential(data) {
    if (!data || data.length < 33 || data[0] !== SCHEMA_DISCRIMINATOR) return null;
    return new PublicKey(data.subarray(1, 33)).toBase58();
}

// An owner-consent member must be able to issue ownership; every other kind issues agreement decisions.
export function requiredSchemaKinds(kind) {
    return kind === 'owner-consent' ? ['ownership'] : ['decision'];
}

/**
 * Verify a signed registration. `readAccounts(addresses)` returns [{ owner, data } | null] in order;
 * `fetchStatus(serviceUrl)` returns the member's GET /lens/status JSON.
 */
export async function verifyRegistration(input, { nowSeconds, readAccounts, fetchStatus, allowHttp = false }) {
    const registration = normalizeRegistration(input, { allowHttp });
    if (Math.abs(nowSeconds - registration.signedAt) > REGISTRATION_MAX_SKEW_SECONDS) {
        refuse(400, 'stale_registration', `signedAt must be within ${REGISTRATION_MAX_SKEW_SECONDS} s of now; sign a fresh registration`);
    }
    if (!verifyWalletSignature({ owner: registration.key, message: registrationMessage(registration), signature: input.signature })) {
        refuse(401, 'bad_signature', 'signature does not verify for this key and registration');
    }
    if (registration.evmAddress && !evmSignatureValid(registration, input.evmSignature)) {
        refuse(401, 'bad_evm_signature', 'evmSignature is not the EVM address\'s EIP-191 signature of its statement (member, evmAddress, signedAt)');
    }

    const { credential, schemas } = deriveLensSchemaPdas({ authority: registration.key, credentialName: registration.credentialName });
    const needed = requiredSchemaKinds(registration.kind);
    const accounts = await readAccounts([credential, ...needed.map(kind => schemas[kind])]);
    const [credentialAccount, ...schemaAccounts] = accounts;
    if (credentialAccount?.owner !== SAS_PROGRAM_ID || credentialAuthority(credentialAccount.data) !== registration.key) {
        refuse(422, 'credential_missing', `SAS credential ${credential} ("${registration.credentialName}") under ${registration.key} does not exist on chain; run scripts/register-lens-schemas.mjs --live first`);
    }
    needed.forEach((kind, index) => {
        const account = schemaAccounts[index];
        if (account?.owner !== SAS_PROGRAM_ID || schemaCredential(account.data) !== credential) {
            refuse(422, 'schema_missing', `the ${kind} schema ${schemas[kind]} is not registered under credential ${credential}`);
        }
    });

    let status;
    try {
        status = await fetchStatus(registration.serviceUrl);
    } catch (error) {
        refuse(422, 'service_unreachable', `GET ${registration.serviceUrl}/lens/status failed: ${error.message}`);
    }
    const mismatch = [
        ['key', status?.key, registration.key],
        ['credential', status?.credential, credential],
        ['kind', status?.kind, registration.kind]
    ].find(([, actual, expected]) => actual !== expected);
    if (mismatch) refuse(422, 'service_mismatch', `${registration.serviceUrl}/lens/status reports ${mismatch[0]} ${mismatch[1] ?? 'nothing'}, expected ${mismatch[2]}`);
    // A published EVM address is the one the service attests EVM agreement decisions with.
    if (registration.evmAddress && String(status.evmAddress || '').toLowerCase() !== registration.evmAddress.toLowerCase()) {
        refuse(422, 'service_mismatch', `${registration.serviceUrl}/lens/status reports evmAddress ${status.evmAddress ?? 'nothing'}, expected ${registration.evmAddress}`);
    }
    if (status.dryRun || status.ephemeralKey) refuse(422, 'service_mismatch', `${registration.serviceUrl} is a dry-run member; only live members are listed`);

    return { ...registration, credential };
}

// Server side probe: GET <serviceUrl>/lens/status, no redirects, 5 s, JSON only, small bodies.
export async function fetchLensStatus(serviceUrl, { fetchImpl = fetch, timeoutMs = 5000, maxBytes = 64 * 1024 } = {}) {
    const response = await fetchImpl(`${serviceUrl}/lens/status`, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.text();
    if (body.length > maxBytes) throw new Error('status response too large');
    return JSON.parse(body);
}

export function connectionAccountReader(connection) {
    return async addresses => {
        const infos = await connection.getMultipleAccountsInfo(addresses.map(address => new PublicKey(address)));
        return infos.map(info => info ? { owner: info.owner.toBase58(), data: Buffer.from(info.data) } : null);
    };
}

// The member side: sign a registration for this running member and POST it to a directory's
// headless path, publishing its EVM address too when it holds an EVM key (`evmWallet`, an ethers
// wallet). Returns the listed member; throws with the directory's refusal otherwise.
export async function announceLensMember({ directoryUrl, publicUrl, keypair, evmWallet = null, status, name, description = '', nowSeconds, fetchImpl = fetch }) {
    const signed = await signRegistration({
        credentialName: status.credentialName,
        kind: status.kind,
        name,
        description,
        serviceUrl: publicUrl,
        signedAt: nowSeconds
    }, keypair, { evmWallet });
    const response = await fetchImpl(`${directoryUrl.replace(/\/+$/, '')}/agent/lenses/members`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(signed)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`directory refused (${response.status} ${body.error ?? ''}): ${body.message ?? 'no message'}`);
    return body.member;
}
