// ENS CCIP-Read gateway route. Resolves <slug>.parcels.urbangametheory.eth
// queries forwarded by the L1 OffchainResolver and returns signed records.
// Reads slug -> parcel mappings from parcel_ens; ownerOf is best-effort.
import { JsonRpcProvider, Contract } from 'ethers';
import { resolveQuery } from '../ens/gateway.js';
import { parcelIdToCity } from '../ens/slug.js';

const DEFAULT_PUBLIC_BASE_URL = 'https://urbangametheory.xyz';
const DEFAULT_PARENT_NAME = 'parcels.urbangametheory.eth';
const DEFAULT_TTL_SECONDS = 300;

function normalizeSigningKey(raw) {
    if (!raw) return null;
    const trimmed = raw.trim();
    return trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
}

function buildConfig(env) {
    const signingKey = normalizeSigningKey(env.ENS_GATEWAY_SIGNER_KEY);
    if (!signingKey) return null;
    return {
        parentLabels: (env.ENS_PARENT_NAME || DEFAULT_PARENT_NAME).split('.'),
        publicBaseUrl: (env.ENS_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL).replace(/\/$/, ''),
        ttlSeconds: Number(env.ENS_TTL_SECONDS) || DEFAULT_TTL_SECONDS,
        signingKey,
        apexAddress: env.ENS_PARCEL_NFT_ADDRESS || null,
        now: () => Math.floor(Date.now() / 1000),
    };
}

// Lazily build a read-only ownerOf resolver (only when RPC + contract are set).
function buildOwnerResolver(env) {
    const rpcUrl = env.ENS_ADDR_RPC_URL;
    const contractAddr = env.ENS_PARCEL_NFT_ADDRESS;
    if (!rpcUrl || !contractAddr) return null;
    let contract;
    return async (record) => {
        if (!record || record.token_id == null) return null;
        try {
            if (!contract) {
                const provider = new JsonRpcProvider(rpcUrl);
                contract = new Contract(contractAddr, ['function ownerOf(uint256) view returns (address)'], provider);
            }
            return await contract.ownerOf(BigInt(record.token_id));
        } catch (_) {
            // Unminted parcel / RPC failure → no addr record (best-effort).
            return null;
        }
    };
}

export function setupEnsRoute(app, pool) {
    const config = buildConfig(process.env);
    const resolveOwner = buildOwnerResolver(process.env);

    async function lookupSlug(slug) {
        const { rows } = await pool.query(
            `SELECT slug, parcel_id, city_code, lat, lon, area_m2, token_id, image_url
             FROM parcel_ens WHERE slug = $1 LIMIT 1`,
            [slug],
        );
        if (!rows.length) return null;
        const row = rows[0];
        const city = parcelIdToCity(row.parcel_id);
        return { ...row, city_name: city ? city.cityName : null };
    }

    // ERC-3668 gateway endpoint: GET /ens/{sender}/{callData}.json
    // (the OffchainResolver's configured url template). GET keeps it off the
    // write-origin/rate-limit middleware and matches how ethers calls it.
    app.get('/ens/:sender/:data', async (req, res) => {
        if (!config) {
            return res.status(503).json({ message: 'ENS gateway not configured' });
        }
        try {
            const sender = req.params.sender;
            const callData = (req.params.data || '').replace(/\.json$/i, '');
            if (!/^0x[0-9a-fA-F]{40}$/.test(sender) || !/^0x[0-9a-fA-F]+$/.test(callData)) {
                return res.status(400).json({ message: 'Invalid sender or data' });
            }
            const data = await resolveQuery({ sender, callData, lookupSlug, resolveOwner, config });
            return res.json({ data });
        } catch (error) {
            // 400 → client surfaces the error (vs 5xx which triggers url retry).
            return res.status(400).json({ message: error.message || 'Resolution failed' });
        }
    });
}
