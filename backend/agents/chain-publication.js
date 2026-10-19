// Agents use the same immutable proposal protocol as browser mints. All cadastral reads,
// validation, rendering and pinning finish before a wallet signs anything.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import * as turf from '@turf/turf';
import { createRetryingFetch } from '../utils/retrying-fetch.js';
import { buildProposalRecord } from './record-builder.js';
import { parcelSourceForCity, parcelSourceCatalog } from '../parcels/sources.js';
import { checkProposalBinding } from '../proposals/binding.js';
import { readChainMetadata } from '../proposals/chain-mirror.js';
import { normalizeChainRef } from '../proposals/chain-reader.js';
import { generateAndStoreProposalThumbnail } from '../thumbnails/proposal-thumbnail.js';
import { uploadImageToPinata, uploadMetadataToPinata } from '../routes/ipfs.js';
import { validateNftMetadata } from '../utils/nft-asset-upload.js';

const require = createRequire(import.meta.url);
const mintBinding = require('../../frontend/js/proposals/mint-binding.js');
const siteBinding = require('../../frontend/js/proposals/site-binding.js');
const chainRecord = require('../../frontend/js/proposals/chain-record.js');

// No planning area/size/row filters: the snapshot must include every parcel near the SITE,
// including a neighbour that the proposed building reaches across the candidate boundary.
export const MINT_GROUND_SQL = `
    WITH site AS (
        SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), 3765) AS geom
    )
    SELECT 'HR-' || p.maticni_broj_ko || '-' || p.broj_cestice AS parcel_id,
           ST_AsGeoJSON(ST_Transform(ST_Segmentize(ST_CollectionExtract(ST_MakeValid(p.geom), 3), 25), 4326), 9)::json AS geometry
    FROM public.parcel p, site s
    WHERE p.current = true AND p.geom && ST_Expand(s.geom, 1)
    ORDER BY p.cestica_id LIMIT 5001
`;

// A city may also offer a non-default source with a different cadastral namespace.
// The planner has already chosen canonical IDs from that source; use their identity,
// rather than silently switching an explicit NYC tax lot to the city's DB cadastre.
export function agentParcelSource(record, areas = []) {
    const ids = record.cadastreParcelIds || [];
    const chosen = new Set(areas.filter(area => area.city === record.city && area.sourceId).map(area => area.sourceId));
    const sources = parcelSourceCatalog.sources.filter(source => chosen.has(source.id) && source.cityIds.includes(record.city)
        && ids.length && ids.every(id => String(id).startsWith(source.idPrefix)));
    if (sources.length > 1) throw new Error('The agent parcel namespace names more than one cadastral source.');
    return parcelSourceForCity(record.city, sources[0]?.id);
}

export async function loadMintGround(pool, record, { areas = [], parcelSourceId = null } = {}) {
    const site = siteBinding.siteOf(record, { turf });
    if (!site) throw new Error('The agent proposal has no material site.');
    const provider = parcelSourceId ? parcelSourceForCity(record.city, parcelSourceId) : agentParcelSource(record, areas);
    if (provider) {
        const result = await provider.adapter.queryGeometry(site);
        if (result?.complete !== true || !Array.isArray(result.features) || result.features.length > 5000) {
            throw new Error('A complete cadastral source response is required before minting.');
        }
        if (result.features.some(feature => !feature.properties?.parcelId
            || feature.properties.sourceId !== provider.descriptor.id)) {
            throw new Error('The cadastral source returned a malformed or foreign parcel.');
        }
        return { parcels: result.features, source: provider.descriptor.id, parcelSourceId: provider.descriptor.id };
    }
    const { rows } = await pool.query(MINT_GROUND_SQL, [JSON.stringify(site)]);
    if (rows.length > 5000) throw new Error('The mint site reaches too many cadastral parcels.');
    return { source: 'hr-cadastre', parcels: rows.map(row => ({ type: 'Feature',
        geometry: row.geometry, properties: { parcelId: row.parcel_id, sourceId: 'hr-cadastre' } })) };
}

export async function prepareAgentPublication({ pool, candidate, pick, persona, runId, city, lens }, {
    loadGround = loadMintGround, checkBinding = checkProposalBinding,
    render = generateAndStoreProposalThumbnail, pinImage = uploadImageToPinata,
    pinMetadata = uploadMetadataToPinata, now = () => new Date()
} = {}) {
    if (!persona.wallet || !Array.isArray(lens) || !lens.length) throw new Error('A signer and resolving lens are required.');
    const draft = { ...buildProposalRecord({ candidate, pick, persona, runId, city, turf }),
        author: persona.wallet, createdAt: now().toISOString(), lens };
    const ground = await loadGround(pool, draft, { areas: persona.areas || [], parcelSourceId: candidate.parcelSourceId || null });
    if (!ground.parcels.length) throw new Error('No cadastral evidence covers the proposed building.');
    const record = await mintBinding.buildRecord(draft, { ...ground, regionHasCadastre: true, turf, now });
    // Independently recheck the full footprint before uploading, using the same public binding
    // rule as ordinary publication. This is a read, not /prepare or a server signature.
    const bound = await checkBinding(pool, record, record.cadastreParcelIds, {
        site: record.site, city, parcelSourceId: ground.parcelSourceId || null, toleranceM: record.toleranceM
    });
    if (!bound.ok || bound.binding?.coverage !== 'complete' || !record.cadastreParcelIds.includes(candidate.parcelId)) {
        throw Object.assign(new Error(bound.error || bound.message || 'The complete candidate footprint could not be verified.'), {
            code: bound.code || 'agent-cadastre-incomplete'
        });
    }
    const thumbnail = await render(pool, record, { city, proposalId: pick.proposalId, dryRun: true });
    if (!thumbnail?.buffer?.length) throw new Error('The proposal thumbnail could not be rendered.');
    const image = await pinImage({ buffer: thumbnail.buffer, fileName: `${pick.proposalId}.png`, contentType: 'image/png' });
    const metadata = { name: record.name, description: record.description, image: image.ipfsUri,
        image_url: image.gatewayUrl, properties: chainRecord.metadataProperties(record) };
    const invalid = validateNftMetadata(metadata);
    if (invalid) throw new Error(invalid);
    const pinned = await pinMetadata(metadata, record.name);
    if (!/^ipfs:\/\//.test(pinned?.ipfsUri || '')) throw new Error('No immutable metadata URI was returned.');
    return { record, metadataUri: pinned.ipfsUri, imageUri: image.ipfsUri };
}

export async function verifyPublicationReadable(publication, { readMetadata = readChainMetadata } = {}) {
    const stored = chainRecord.fromMetadata(await readMetadata(publication.metadataUri));
    if (!isDeepStrictEqual(stored, publication.record)) {
        throw new Error('Pinned proposal differs from the record prepared for minting.');
    }
    return publication;
}

export async function mirrorAgentPublication({ apiBase, mint, fetchImpl = fetch, retryOptions = {} }) {
    if (!/^ipfs:\/\//.test(mint.metadataUri || '')) {
        throw new Error('This earlier mint has no portable immutable metadata; it cannot be mirrored.');
    }
    const chainRef = normalizeChainRef({ chainType: 'solana', chainId: mint.chainId || 'solana-devnet',
        contract: mint.contractAddress, tokenId: mint.proposalPda });
    const expectedId = `chain_${createHash('sha256').update(JSON.stringify(chainRef)).digest('hex')}`;
    // This POST is safe to replay: its body is a canonical chain reference and the server
    // verifies an existing row before returning the same mirror on a duplicate request.
    const retryFetch = createRetryingFetch({ timeoutMs: 60_000, ...retryOptions, fetchImpl,
        retryMethods: new Set(['POST']), requestLabel: () => 'proposal-mirror' });
    const response = await retryFetch(`${apiBase.replace(/\/$/, '')}/proposals/mirror`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://urbangametheory.xyz' },
        body: JSON.stringify({ chainRef }), signal: AbortSignal.timeout(60_000)
    });
    const body = await response.json();
    if (![201, 409].includes(response.status) || !Number.isInteger(body.id) || body.id < 1
        || body.proposalId !== expectedId || body.code === 'chain-mirror-conflict') {
        throw new Error(`Chain mirror HTTP ${response.status}: ${body.code || body.error || 'unavailable'}`);
    }
    return { id: body.id, proposalId: body.proposalId, status: response.status, method: 'chain-mirror' };
}
