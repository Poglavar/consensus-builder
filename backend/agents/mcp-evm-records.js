// The agent's record and anchor actions on a chain (docs/blockchain-flows.md, R2/R3 "MCP parity"):
// list the design and plan records of a chain, mint a design or plan record as the agent's wallet on
// it (UGT_AGENT_KEYPAIR on Solana, UGT_AGENT_EVM_PRIVATE_KEY on EVM) after the IPFS courier made its
// content retrievable, and anchor parcels. The browser's adapters (frontend/js/chain/solana-adapter.js,
// evm-adapter.js, bound by chain/adapters.js) and the same
// courier order as the browser's mint checklist: every member design retrievable, then the plan,
// then its record. The record's token metadata is the browser's: title, a short description, the
// app link as external_url.
import { canonicalBytes, cidOf } from '../cid.js';
import { tokenMetadataOf, tokenUriOf } from '../chain/evm.js';
import { SOLANA_CHAIN_KEYS, normalizeChainKey } from '../chain/adapters.js';

const failure = (code, message, extra = {}) => Object.assign(new Error(message), { code }, extra);

/**
 * `requireLive(confirm)` gates every signed action; `index()` is the index client
 * (publication-client.js); `impl` supplies readAdapter, signingAdapter and ensureRetrievable
 * (chain/adapters.js, chain/courier.js) and is where tests inject fakes.
 */
export function createMcpEvmRecordTools({ env, appOrigin, requireLive, index, impl, log }) {
    const adapterLog = line => process.stderr.write(`${line}\n`);
    const chainOf = chainId => {
        const key = normalizeChainKey(chainId || SOLANA_CHAIN_KEYS[0]);
        if (!key) throw failure('unknown-chain', `Not a supported chain: ${chainId}.`);
        return key;
    };
    const linkOf = (kind, cid) => `${appOrigin}/${kind}s/${cid}`;

    // The index row of `cid` with its content checked against the CID.
    async function indexed(kind, cid) {
        const row = kind === 'design' ? await index().getDesign(cid) : await index().getPlan(cid);
        if (!row) throw failure('not-indexed', `${kind} ${cid} is not in the index; publish it first (ugt_publish_${kind}).`);
        const bytes = canonicalBytes(row.content);
        if (cidOf(bytes) !== cid) throw failure('cid-mismatch', `The index returned other content for ${kind} ${cid}.`);
        return { content: row.content, bytes };
    }

    async function refuseMinted(adapter, kind, cid) {
        const existing = await adapter.recordOf(cid);
        if (existing) {
            throw failure('record-exists', `${kind} ${cid} already has a record on ${adapter.name}, minted by ${existing.minter}.`, {
                next: { tool: 'ugt_chain_records', arguments: { kind, chainId: adapter.chainId }, action: 'The record exists; read it instead of minting again.' }
            });
        }
    }

    async function mint(adapter, kind, cid, tokenUri) {
        const { txHash, record } = await adapter.mintRecord(kind, cid, tokenUri);
        log(`minted ${kind} ${cid} on ${adapter.name} in ${txHash}`);
        return { chainId: adapter.chainId, chain: adapter.name, cid, txHash, explorerUrl: adapter.explorerUrl({ tx: txHash }),
            record: { ...record, metadata: tokenMetadataOf(record?.tokenUri) }, url: linkOf(kind, cid) };
    }

    return {
        // Every record of `kind` on the chain, newest first, at most `limit`.
        async listChainRecords({ kind, chainId, limit = 50 } = {}) {
            const adapter = impl.readAdapter(chainOf(chainId), { env, log: adapterLog });
            const rows = await adapter.listRecords(kind);
            return {
                chainId: adapter.chainId, chain: adapter.name, kind, count: rows.length, truncated: rows.length > limit,
                records: rows.slice(0, limit).map(row => ({ ...row, metadata: tokenMetadataOf(row.tokenUri), url: linkOf(kind, row.cid) }))
            };
        },

        async mintDesign({ designCid, chainId, confirm } = {}) {
            requireLive(confirm);
            const adapter = impl.signingAdapter(chainOf(chainId), { env, log: adapterLog });
            const { content, bytes } = await indexed('design', designCid);
            await refuseMinted(adapter, 'design', designCid);
            const courier = await impl.ensureRetrievable({ kind: 'design', cid: designCid, bytes });
            const tokenUri = tokenUriOf({ name: content.title || designCid, description: `Published as ${designCid}`, externalUrl: linkOf('design', designCid) });
            return { ...await mint(adapter, 'design', designCid, tokenUri), retrievable: [{ cid: designCid, via: courier.via, gateway: courier.gateway }] };
        },

        async mintPlan({ planCid, chainId, confirm } = {}) {
            requireLive(confirm);
            const adapter = impl.signingAdapter(chainOf(chainId), { env, log: adapterLog });
            const { content, bytes } = await indexed('plan', planCid);
            await refuseMinted(adapter, 'plan', planCid);
            const members = [];
            for (const cid of content.designCids) members.push({ cid, ...await indexed('design', cid) });
            // The checklist's order: every member design retrievable, then the plan, then its record.
            const retrievable = [];
            for (const object of [...members.map(member => ({ kind: 'design', ...member })), { kind: 'plan', cid: planCid, bytes }]) {
                const courier = await impl.ensureRetrievable({ kind: object.kind, cid: object.cid, bytes: object.bytes });
                retrievable.push({ cid: object.cid, via: courier.via, gateway: courier.gateway });
            }
            const tokenUri = tokenUriOf({ name: content.title || planCid, description: `${content.designCids.length} design(s)`, externalUrl: linkOf('plan', planCid) });
            return { ...await mint(adapter, 'plan', planCid, tokenUri), retrievable };
        },

        // Anchors the parcels that have no anchor yet; each anchor's metadata URI is the parcel's app page.
        async anchorParcels({ parcelIds, chainId, confirm } = {}) {
            requireLive(confirm);
            const adapter = impl.signingAdapter(chainOf(chainId), { env, log: adapterLog });
            const ids = [...new Set(parcelIds.map(String))];
            const missing = await adapter.anchorsMissing(ids);
            const alreadyAnchored = ids.filter(id => !missing.includes(id));
            if (!missing.length) {
                return { chainId: adapter.chainId, chain: adapter.name, anchored: [], alreadyAnchored, txHashes: [], explorerUrls: [] };
            }
            // The deep-link route reads the raw path, slashes included (ens/gateway.js builds the same link).
            const { txHashes } = await adapter.mintAnchors(missing, {
                metadataUriOf: parcelId => `${appOrigin}/parcel/${parcelId}`,
                onBatch: ({ done, total, txHash }) => log(`anchored ${done}/${total} parcel(s) on ${adapter.name} in ${txHash}`)
            });
            return { chainId: adapter.chainId, chain: adapter.name, anchored: missing, alreadyAnchored, txHashes,
                explorerUrls: txHashes.map(tx => adapter.explorerUrl({ tx })).filter(Boolean) };
        }
    };
}
