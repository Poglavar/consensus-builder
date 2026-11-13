// The agent's record and anchor actions on a chain (docs/blockchain-flows.md, R2/R3 "MCP parity"):
// list the design and plan records of a chain, mint a design or plan record as the agent's wallet on
// it (UGT_AGENT_KEYPAIR on Solana, UGT_AGENT_EVM_PRIVATE_KEY on EVM) after the IPFS courier made its
// content retrievable, and anchor parcels. The browser's adapters (frontend/js/chain/solana-adapter.js,
// evm-adapter.js, bound by chain/adapters.js) and the same
// courier order as the browser's mint checklist: every member design retrievable, then the plan,
// then its record. The record's token metadata is the browser's: title, a short description, the
// app link as external_url. The EVM half of ugt_mint_agreement runs the same checklist for an
// agreement (createEvmAgreementMint).
import { canonicalBytes, cidOf } from '../cid.js';
import { tokenMetadataOf, tokenUriOf } from '../chain/evm.js';
import { SOLANA_CHAIN_KEYS, normalizeChainKey } from '../chain/adapters.js';
import { isEvmAddress, sameKey } from '../chain/keys.js';

const failure = (code, message, extra = {}) => Object.assign(new Error(message), { code }, extra);
const adapterLog = line => process.stderr.write(`${line}\n`);

// The index row of `cid` with its content checked against the CID.
async function indexedObject(index, kind, cid) {
    const row = kind === 'design' ? await index().getDesign(cid) : await index().getPlan(cid);
    if (!row) throw failure('not-indexed', `${kind} ${cid} is not in the index; publish it first (ugt_publish_${kind}).`);
    const bytes = canonicalBytes(row.content);
    if (cidOf(bytes) !== cid) throw failure('cid-mismatch', `The index returned other content for ${kind} ${cid}.`);
    return { content: row.content, bytes };
}

/**
 * The EVM half of ugt_mint_agreement (ugt-agent-tools.js mintAgreement checks the live gate, that the
 * agreement binds its owners and the amount first): the browser's EVM mint checklist with the agent's
 * EVM key (UGT_AGENT_EVM_PRIVATE_KEY). The agent's address must be the sponsor and rule.lens exactly one
 * EVM address, the lens member's, not the agent's. Every member design, the plan and the agreement are
 * made retrievable from a public IPFS gateway, every input parcel is anchored on the chain, then the
 * agreement is created with `wei` as its escrow (agents/evm-agreement-minter.js) and recorded in the
 * index (POST /agreements/:cid/onchain { chain: 'evm', chainId, account, signature }). Each step reads
 * first, so a rerun signs nothing that is already done. `impl` supplies agreementSigner, signingAdapter,
 * ensureRetrievable and mintEvmAgreement.
 */
export function createEvmAgreementMint({ env, appOrigin, index, impl, log }) {
    return async function mintAgreementOnEvm({ agreementCid, content, chainKey, wei }) {
        const signer = impl.agreementSigner(chainKey, { env });
        if (!sameKey(content.sponsor, signer.wallet)) {
            throw failure('not-sponsor', `agreement ${agreementCid} names sponsor ${content.sponsor ?? 'none'}, not this agent's EVM wallet ${signer.wallet}: only its sponsor can create it`);
        }
        const lens = Array.isArray(content.rule?.lens) ? content.rule.lens : [];
        if (lens.length !== 1 || !isEvmAddress(lens[0])) {
            throw failure('invalid-lens', `the Agreement contract takes one lens address, but rule.lens holds ${lens.length === 1 ? `${lens[0]}, not an EVM address` : `${lens.length} entries`}`);
        }
        if (sameKey(lens[0], signer.wallet)) throw failure('own-lens', `rule.lens names only this agent's own address ${signer.wallet}: a sponsor cannot attest its own agreement`);
        const deadlineMs = content.deadline ? Date.parse(content.deadline) : null;
        if (deadlineMs !== null && !(deadlineMs > Date.now())) throw failure('deadline-passed', `agreement ${agreementCid} is past its deadline ${content.deadline}; it cannot be minted`);

        // The checklist's order: every member design retrievable, then the plan, then the agreement.
        const plan = await indexedObject(index, 'plan', content.planCid);
        const objects = [];
        for (const cid of plan.content.designCids) objects.push({ kind: 'design', cid, ...await indexedObject(index, 'design', cid) });
        const agreementBytes = canonicalBytes(content);
        if (cidOf(agreementBytes) !== agreementCid) throw failure('cid-mismatch', `The index returned other content for agreement ${agreementCid}.`);
        objects.push({ kind: 'plan', cid: content.planCid, bytes: plan.bytes }, { kind: 'agreement', cid: agreementCid, bytes: agreementBytes });
        const retrievable = [];
        for (const object of objects) {
            const courier = await impl.ensureRetrievable({ kind: object.kind, cid: object.cid, bytes: object.bytes });
            retrievable.push({ cid: object.cid, via: courier.via, gateway: courier.gateway });
        }

        // Every input parcel anchored on the chain; the agent's wallet only pays.
        const adapter = impl.signingAdapter(chainKey, { env, log: adapterLog });
        const parcelIds = [...new Set((content.inputs?.parcels || []).map(parcel => String(parcel?.parcelId || '')).filter(Boolean))];
        const missing = parcelIds.length ? await adapter.anchorsMissing(parcelIds) : [];
        const anchorTxHashes = missing.length ? (await adapter.mintAnchors(missing, {
            metadataUriOf: parcelId => `${appOrigin}/parcel/${parcelId}`,
            onBatch: ({ done, total, txHash }) => log(`anchored ${done}/${total} parcel(s) of ${agreementCid} on ${adapter.name} in ${txHash}`)
        })).txHashes : [];

        const minted = await impl.mintEvmAgreement({
            signer, cid: agreementCid, lens: lens[0], deadline: content.deadline ?? null, wei,
            payout: signer.wallet, openGround: Number(content.inputs?.openGroundM2) > 0
        });
        log(`${minted.created ? 'created' : 'found'} agreement ${agreementCid} at ${minted.account} on ${signer.name}${minted.signature ? ` in ${minted.signature}` : ''}`);
        const recorded = await index().recordOnchain(agreementCid, { chain: 'evm', chainId: minted.chainId, account: minted.account, signature: minted.createSignature });
        return { ...minted, chain: signer.name, retrievable, anchored: missing, alreadyAnchored: parcelIds.filter(id => !missing.includes(id)),
            anchorTxHashes, onchain: recorded.onchain ?? null };
    };
}

/**
 * `requireLive(confirm)` gates every signed action; `index()` is the index client
 * (publication-client.js); `impl` supplies readAdapter, signingAdapter and ensureRetrievable
 * (chain/adapters.js, chain/courier.js) and is where tests inject fakes.
 */
export function createMcpEvmRecordTools({ env, appOrigin, requireLive, index, impl, log }) {
    const chainOf = chainId => {
        const key = normalizeChainKey(chainId || SOLANA_CHAIN_KEYS[0]);
        if (!key) throw failure('unknown-chain', `Not a supported chain: ${chainId}.`);
        return key;
    };
    const linkOf = (kind, cid) => `${appOrigin}/${kind}s/${cid}`;
    const indexed = (kind, cid) => indexedObject(index, kind, cid);

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
