// ENS CCIP-Read gateway route. Resolves names forwarded by the L1
// OffchainResolver and returns signed records, for two namespaces:
//   <slug>.parcels.urbangametheory.eth     -> parcel_ens mapping
//   <id>.proposals.urbangametheory.eth     -> legacy numeric proposal, unique chain mirror, or named plan
// ownerOf (addr record) is best-effort and parcel-only.
import { JsonRpcProvider, Contract } from 'ethers';
import { createRequire } from 'node:module';
import { resolveQuery, buildTextValue } from '../ens/gateway.js';
import { parcelIdToCity } from '../ens/slug.js';
import { cityNameAt } from '../jurisdiction.js';
import { planCommitmentError } from '../plans/plan-commitment.js';

const require = createRequire(import.meta.url);
const { buildChainProposalPath } = require('../../frontend/js/proposals/chain-ref.js');

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

// Text records for numeric legacy proposal names and chain-qualified mirror names.
function proposalTextValue(key, { record, config, isApex }) {
    if (!record) {
        if (!isApex) return ''; // not a resolvable proposal / plan
        if (key === 'url') return config.publicBaseUrl;
        if (key === 'description') return 'Urban Game Theory — proposals';
        return '';
    }
    const ids = record.ids || [];
    switch (key) {
        case 'url':
            if (record.isPlan && record.slug) return `${config.publicBaseUrl}/proposals/${record.slug}`;
            if (record.chainRef) {
                const path = buildChainProposalPath(record.chainRef);
                return path ? `${config.publicBaseUrl}${path}` : '';
            }
            return `${config.publicBaseUrl}/proposals/${ids.join(',')}`;
        case 'description':
            return record.title || (ids.length > 1 ? `Plan of ${ids.length} proposals` : `Proposal ${ids[0]}`);
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
        // where the parcel lies when it is known (location-first.md phase 4), else its id's city
        const hasPoint = row.lon !== null && row.lat !== null && Number.isFinite(Number(row.lon)) && Number.isFinite(Number(row.lat));
        const placed = hasPoint ? cityNameAt(Number(row.lon), Number(row.lat)) : null;
        const city = placed ? null : parcelIdToCity(row.parcel_id);
        return { ...row, city_name: placed || (city ? city.cityName : null) };
    }

    // Resolve a proposals label to a legacy proposal id list, one chain mirror, or a named plan:
    //   - numeric / hyphen-chain (1, 1-2-3) → those minted proposal id(s)
    //   - chain-<48 hex chars> → one unique canonical chain_<sha256> mirror
    //   - otherwise a named plan slug → its short, slug-based PlanView route
    async function lookupProposal(label) {
        const chainMatch = /^chain-([0-9a-f]{48})$/i.exec(label);
        if (chainMatch) {
            const prefix = `chain_${chainMatch[1].toLowerCase()}`;
            const upperBound = `${prefix}g`;
            try {
                const { rows } = await pool.query(
                    `SELECT proposal_id, title, name, screenshot_url,
                            proposal_data->'chainMirror'->'ref' AS chain_ref
                     FROM proposal
                     WHERE proposal_id >= $1 AND proposal_id < $2
                     LIMIT 2`,
                    [prefix, upperBound],
                );
                // A truncated hash is only a name when it maps to one stored row.
                if (rows.length !== 1 || !rows[0].chain_ref) return null;
                const row = rows[0];
                const chainRef = { ...row.chain_ref };
                // The canonical stored Solana network is namespaced; public paths
                // use the bare cluster expected by the chain proposal loader.
                if (chainRef.chainType === 'solana') {
                    chainRef.chainId = String(chainRef.chainId || '').replace(/^solana-/i, '');
                }
                if (!buildChainProposalPath(chainRef)) return null;
                return { chainRef, title: row.title || row.name,
                    screenshot_url: row.screenshot_url };
            } catch (_) {
                return null; // absent/old schema or query failure → fail closed
            }
        }
        if (/^[0-9]+(-[0-9]+)*$/.test(label)) {
            const ids = label.split('-');
            let title;
            let screenshot_url;
            // Resolve only ids that actually exist on THIS server. A proposal
            // minted on-chain elsewhere (e.g. saved to a different DB) would
            // otherwise yield a live ENS name pointing at a dead /proposals/<id>
            // link. Fail closed: if we can't confirm existence, don't resolve.
            try {
                const { rows } = await pool.query(
                    'SELECT proposal_id, title, name, screenshot_url FROM proposal WHERE proposal_id = ANY($1)',
                    [ids],
                );
                const found = new Set(rows.map(r => String(r.proposal_id)));
                if (!ids.every(id => found.has(id))) return null; // unknown proposal → not resolvable
                if (ids.length === 1) {
                    const row = rows[0];
                    title = row.title || row.name;
                    screenshot_url = row.screenshot_url;
                }
            } catch (_) {
                return null; // proposal table absent / query failed → don't fabricate a link
            }
            return { ids, title, screenshot_url };
        }
        // Named plan
        try {
            const { rows } = await pool.query('SELECT slug, proposal_ids, title, member_hashes, plan_hash FROM ens_plan WHERE slug = $1 LIMIT 1', [label]);
            if (rows.length && !planCommitmentError(rows[0])) {
                return { slug: label, title: rows[0].title, isPlan: true };
            }
        } catch (_) { /* ens_plan absent */ }
        return null;
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
