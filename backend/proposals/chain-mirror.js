// Read a proposal's committed metadata from decentralized storage and verify it against its chain.
// The mirror's caller supplies only a location; neither client geometry nor a server signature is proof.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { readChainProposal, chainProofError } from './chain-reader.js';
import { validateSiteGeometry } from './binding.js';
import { MAX_METADATA_BYTES } from '../utils/nft-asset-upload.js';
import { createRetryingFetch } from '../utils/retrying-fetch.js';

const require = createRequire(import.meta.url);
const chainRecord = require('../../frontend/js/proposals/chain-record.js');
const siteHash = require('../../frontend/js/proposals/site-hash.js');
const agentPersonas = JSON.parse(readFileSync(new URL('../agents/personas.json', import.meta.url), 'utf8')).personas;

// A persona label in metadata is only a claim. Our known agents get a public activity stamp
// when the account's actual signer is that persona's configured wallet. This is not an x402 receipt.
export function chainAgentStamp(record, chain, personas = agentPersonas) {
    if (!record.agent) return null;
    const persona = personas.find(item => item.name === record.agent.persona);
    if (!persona) return null;
    if (chain.ref.chainType !== 'solana' || persona.wallet !== chain.owner || record.author !== chain.owner) {
        throw chainProofError('The agent identity does not match the proposal signer.');
    }
    return { persona: persona.name, wallet: chain.owner,
        rationale: String(record.agent.rationale || record.description || '').slice(0, 10000),
        run_id: String(record.agent.run_id || '').slice(0, 255),
        ...(['algorithm', 'llm'].includes(record.agent.controller) ? { controller: record.agent.controller } : {}),
        ...(persona.housingResearch && record.agent.housing?.status === 'research-concept' ? { housing: structuredClone(record.agent.housing) } : {}),
        verified: { method: 'chain', chainRef: chain.ref } };
}

export function metadataReadUrl(uri, env = process.env) {
    // Only content identifiers enter these configured origins. A token cannot turn this API into
    // an arbitrary URL fetcher, even through an HTTP redirect or an IPFS path containing '..'.
    const ipfs = /^ipfs:\/\/(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,120})(\/[^?#]*)?$/.exec(String(uri));
    if (ipfs) {
        const suffix = ipfs[2] || '';
        if (suffix.split('/').some(part => !/^[A-Za-z0-9._-]*$/.test(part) || part === '.' || part === '..')) {
            throw chainProofError('Invalid IPFS metadata path.');
        }
        // The pinning service's own gateway by default (as the ecosystem file sets it): the public
        // ipfs.io gateway rate-limits (429), so a mirror right after a mint failed with it.
        const base = (env.IPFS_READ_GATEWAY || 'https://gateway.pinata.cloud/ipfs').replace(/\/$/, '');
        return `${base}/${ipfs[1]}${suffix}`;
    }
    const walrus = /^walrus:\/\/([A-Za-z0-9_-]{43})$/.exec(String(uri));
    if (walrus) {
        const base = (env.WALRUS_AGGREGATOR_URL || 'https://aggregator.walrus-testnet.walrus.space').replace(/\/$/, '');
        return `${base}/v1/blobs/${walrus[1]}`;
    }
    throw chainProofError('A public chain mirror requires immutable IPFS or Walrus metadata.');
}

export async function readChainMetadata(uri, { fetchImpl = fetch, env = process.env, retryOptions = {} } = {}) {
    const url = metadataReadUrl(uri, env);
    const retryFetch = createRetryingFetch({ ...retryOptions, fetchImpl,
        timeoutMs: retryOptions.timeoutMs ?? 12_000, requestLabel: () => 'chain-metadata' });
    let response;
    try {
        response = await retryFetch(url, { method: 'GET', redirect: 'error',
            headers: { Accept: 'application/json' } });
    } catch {
        throw chainProofError('The committed metadata is temporarily unavailable.', { unavailable: true });
    }
    if (!response.ok) throw chainProofError('The committed metadata could not be read.', { unavailable: true });
    if (Number(response.headers.get('content-length')) > MAX_METADATA_BYTES) {
        await response.body?.cancel();
        throw chainProofError('The committed metadata exceeds the size limit.');
    }
    let size = 0;
    const chunks = [];
    try {
        for await (const chunk of response.body) {
            size += chunk.length;
            if (size > MAX_METADATA_BYTES) throw chainProofError('The committed metadata exceeds the size limit.');
            chunks.push(chunk);
        }
    } catch (error) {
        if (error.code === 'chain-proof-invalid') throw error;
        throw chainProofError('The committed metadata could not be read completely.', { unavailable: true });
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw chainProofError('The committed metadata is not valid JSON.'); }
}

export async function verifyCadastreSnapshot(record) {
    const snapshot = record.cadastreSnapshot;
    if (snapshot?.protocol !== 'cadastre-snapshot/1' || !Array.isArray(snapshot.parcels)
        || typeof snapshot.regionHasCadastre !== 'boolean') throw chainProofError('NFT cadastral snapshot is invalid.');
    const ids = snapshot.parcels.map(parcel => parcel.id);
    chainRecord.parcelIds(ids);
    if (record.cadastreParcelIds.some(id => !ids.includes(id))) throw chainProofError('NFT snapshot omits a consent parcel.');
    for (const parcel of snapshot.parcels) {
        if (validateSiteGeometry(parcel.geometry) || await siteHash.siteHashHex(parcel.geometry) !== parcel.geometryHash) {
            throw chainProofError('NFT cadastral snapshot geometry differs from its recorded hash.');
        }
    }
}

export async function loadChainMirror(ref, { readChain = readChainProposal, readMetadata = readChainMetadata,
    now = () => new Date() } = {}) {
    const chain = await readChain(ref);
    const metadata = await readMetadata(chain.metadataUri);
    const record = chainRecord.fromMetadata(metadata);
    const geometryError = validateSiteGeometry(record.site);
    if (geometryError) throw chainProofError(geometryError);
    await chainRecord.verifyAgainstChain(record, chain);
    await verifyCadastreSnapshot(record);
    const canonicalRef = chain.ref;
    const agent = chainAgentStamp(record, chain);
    const key = createHash('sha256').update(JSON.stringify(canonicalRef)).digest('hex');
    return {
        record,
        proposalId: `chain_${key}`,
        onchain: { chainType: canonicalRef.chainType, chainId: canonicalRef.chainId,
            contractAddress: canonicalRef.contract, proposalId: canonicalRef.tokenId,
            metadataUri: chain.metadataUri, owner: chain.owner },
        evidence: { protocol: chainRecord.PROTOCOL, ref: canonicalRef, metadataUri: chain.metadataUri,
            verifiedAt: now().toISOString(), record, ...(agent ? { agent } : {}) }
    };
}

// Express middleware deliberately rejects authored data in a mirror request. All persistent
// proposal fields come from the chain URI; a local edit cannot masquerade as the minted version.
export function resolveChainMirror({ loadMirror = loadChainMirror } = {}) {
    return async (req, res, next) => {
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)
            || Object.keys(body).length !== 1 || !body.chainRef) {
            return res.status(400).json({ code: 'chain-mirror-location-required', error: 'Send only { chainRef } to mirror a proposal.' });
        }
        try {
            const mirror = await loadMirror(body.chainRef);
            req.chainMirror = mirror.evidence;
            req.body = { ...structuredClone(mirror.record), proposalId: mirror.proposalId,
                onchain: mirror.onchain, lifecycleStatus: 'Active' };
            req.proposalBound = { site: mirror.record.site, binding: mirror.record.binding, city: mirror.record.city || null };
            next();
        } catch (error) {
            const known = Number.isInteger(error.status) && error.code;
            console.warn(`[${new Date().toISOString()}] [chain-mirror] ${known ? error.code : 'verification-failed'}`);
            res.status(known ? error.status : 503).json({ code: known ? error.code : 'chain-proof-unavailable',
                error: known ? error.message : 'The chain proposal could not be verified. Nothing was stored.' });
        }
    };
}
