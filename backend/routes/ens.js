// ENS CCIP-Read gateway route. Resolves names forwarded by the L1
// OffchainResolver and returns signed records, for two namespaces:
//   <slug>.parcels.urbangametheory.eth     -> parcel_ens mapping
//   <id>.proposals.urbangametheory.eth     -> minted proposal (numeric on-chain id)
// ownerOf (addr record) is best-effort and parcel-only.
import { JsonRpcProvider, Contract } from 'ethers';
import { resolveQuery, buildTextValue } from '../ens/gateway.js';
import { parcelIdToCity } from '../ens/slug.js';

const DEFAULT_PUBLIC_BASE_URL = 'https://urbangametheory.xyz';
const DEFAULT_PARCELS_PARENT = 'parcels.urbangametheory.eth';
const DEFAULT_PROPOSALS_PARENT = 'proposals.urbangametheory.eth';
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
        publicBaseUrl: (env.ENS_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL).replace(/\/$/, ''),
        ttlSeconds: Number(env.ENS_TTL_SECONDS) || DEFAULT_TTL_SECONDS,
        signingKey,
        now: () => Math.floor(Date.now() / 1000),
    };
}

// Text records for a minted proposal name (<id>.proposals.…). Mirrors the
// parcel text builder's shape; `label` is the numeric proposal id.
function proposalTextValue(key, { record, label, config, isApex }) {
    if (!record) {
        if (!isApex) return ''; // not a resolvable (minted) proposal
        if (key === 'url') return config.publicBaseUrl;
        if (key === 'description') return 'Urban Game Theory — proposals';
        return '';
    }
    switch (key) {
        case 'url':
            return `${config.publicBaseUrl}/proposals/${record.proposal_id}`;
        case 'description':
            return record.title || record.name || `Proposal ${record.proposal_id}`;
        case 'avatar':
            return record.screenshot_url || '';
        default:
            return '';
    }
}

// Lazily build a read-only parcel ownerOf resolver (only when RPC + contract set).
function buildOwnerResolver(env) {
    const rpcUrl = env.ENS_ADDR_RPC_URL;
    const contractAddr = env.ENS_PARCEL_NFT_ADDRESS;
    if (!rpcUrl || !contractAddr) return null;
    let contract;
    return async (record) => {
        if (!record || record.token_id == null) return null; // proposals have no token_id → no addr
        try {
            if (!contract) {
                const provider = new JsonRpcProvider(rpcUrl);
                contract = new Contract(contractAddr, ['function ownerOf(uint256) view returns (address)'], provider);
            }
            return await contract.ownerOf(BigInt(record.token_id));
        } catch (_) {
            return null;
        }
    };
}

export function setupEnsRoute(app, pool) {
    const config = buildConfig(process.env);
    const resolveOwner = buildOwnerResolver(process.env);

    async function lookupParcel(slug) {
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

    // Minted proposals use numeric on-chain ids (matching the /proposals/<id>
    // deep link); local drafts use p-… ids and are not resolvable. Enrich from
    // the `proposal` table when a row exists; otherwise still resolve a numeric
    // id to its deep link (the proposal page loads it from chain).
    async function lookupProposal(label) {
        if (!/^[0-9]+$/.test(label)) return null;
        try {
            const { rows } = await pool.query(
                `SELECT proposal_id, title, name, screenshot_url
                 FROM proposal WHERE proposal_id = $1 LIMIT 1`,
                [label],
            );
            if (rows.length) return rows[0];
        } catch (_) {
            // table absent in this env → fall through to the minimal record
        }
        return { proposal_id: label };
    }

    const namespaces = [
        {
            parentLabels: (process.env.ENS_PARENT_NAME || DEFAULT_PARCELS_PARENT).split('.'),
            lookup: lookupParcel,
            buildText: buildTextValue,
            apexAddress: process.env.ENS_PARCEL_NFT_ADDRESS || null,
        },
        {
            parentLabels: (process.env.ENS_PROPOSALS_PARENT_NAME || DEFAULT_PROPOSALS_PARENT).split('.'),
            lookup: lookupProposal,
            buildText: proposalTextValue,
            apexAddress: process.env.ENS_PROPOSAL_NFT_ADDRESS || null,
        },
    ];

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
            const data = await resolveQuery({ sender, callData, namespaces, resolveOwner, config });
            return res.json({ data });
        } catch (error) {
            // 400 → client surfaces the error (vs 5xx which triggers url retry).
            return res.status(400).json({ message: error.message || 'Resolution failed' });
        }
    });
}
