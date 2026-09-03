// Reconstruct a proposal from its on-chain LOCATION (a ChainRef). The shared URL carries only the
// location; this reads the NFT + its metadata JSON and rebuilds the full proposal. Chain-agnostic by
// dispatch: EVM is wired today (composing the existing ChainDataLoader + importOnChainProposal), and
// the Solana/Canton adapters implement the same loadFrom(ref) signature when they land.
//
// Wallet/RPC only, by design: the read goes through ChainDataLoader, which uses the CONNECTED
// WALLET'S provider (no public RPC). No wallet → { ok:false, reason:'chain-unavailable' }, and the
// caller shows a connect-wallet prompt. This never touches the server.

(function (global) {
    'use strict';

    // ipfs:// → a gateway; otherwise defer to the app's resolver if present, else pass through.
    function resolveMetadataUrl(uri) {
        if (!uri) return null;
        if (typeof global.resolveResourceUrl === 'function') {
            try {
                const resolved = global.resolveResourceUrl(uri);
                if (resolved) return resolved;
            } catch (_) { /* fall through */ }
        }
        const s = String(uri);
        if (s.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + s.slice('ipfs://'.length);
        return s;
    }

    function canonicalCadastreIds(values) {
        const ids = Array.from(new Set((Array.isArray(values) ? values : [])
            .map(value => String(value == null ? '' : value).trim())
            .filter(Boolean)));
        const authored = global.ProposalAuthoredRecord;
        if (!authored || typeof authored.isDerivedParcelId !== 'function') {
            throw new Error('Authored proposal boundary is unavailable.');
        }
        const derived = ids.find(id => authored.isDerivedParcelId(id));
        if (derived) {
            throw new Error(`On-chain proposal names a generated parcel (${derived}); it must be republished against cadastral parcels.`);
        }
        return ids;
    }

    function rejectLegacyGround(record, metadataProperties, label) {
        const own = (value, key) => value && typeof value === 'object'
            && Object.prototype.hasOwnProperty.call(value, key);
        if (own(record, 'parentParcelIds')) {
            throw new Error(`${label} uses retired parentParcelIds; it must be republished with cadastreParcelIds.`);
        }
        if (own(metadataProperties, 'parcelIds')) {
            throw new Error(`${label} metadata uses retired parcelIds; it must be republished with cadastreParcelIds.`);
        }
    }

    function authoredChainRecord(raw, cadastreParcelIds) {
        const depth = global.__formationDepth;
        if (!depth || typeof depth.stripDerivedRecordData !== 'function') {
            throw new Error('Authored proposal boundary is unavailable.');
        }
        return depth.stripDerivedRecordData({ ...(raw || {}), cadastreParcelIds });
    }

    async function loadEvmProposal(ref) {
        const loader = global.ChainDataLoader;
        const storage = global.proposalStorage;
        if (!loader || typeof loader.getProposalsByIds !== 'function'
            || !storage || typeof storage.importOnChainProposal !== 'function') {
            return { ok: false, reason: 'chain-unavailable' };
        }

        let rows;
        try {
            rows = await loader.getProposalsByIds(ref.chainId, ref.contract, [ref.tokenId]);
        } catch (error) {
            return { ok: false, reason: 'read-failed', error };
        }
        const row = rows && rows[0];
        if (!row) return { ok: false, reason: 'not-found' };

        // The on-chain imageURI field is actually the metadata URI (see minted-proposals.js).
        let metadata = null;
        const metaUrl = resolveMetadataUrl(row.imageURI);
        if (metaUrl && typeof fetch === 'function') {
            try {
                const resp = await fetch(metaUrl);
                if (resp.ok) metadata = await resp.json();
            } catch (_) { /* reconstruct with what the chain gave us */ }
        }

        let cadastreParcelIds;
        try {
            rejectLegacyGround(row, metadata?.properties, 'On-chain proposal');
            cadastreParcelIds = canonicalCadastreIds(
                row.cadastreParcelIds
                || metadata?.properties?.cadastreParcelIds
                || []
            );
        } catch (error) {
            return { ok: false, reason: 'non-canonical-ground', error };
        }
        const imported = storage.importOnChainProposal(authoredChainRecord({
            ...row,
            cadastreParcelIds,
            chainId: ref.chainId,
            contractAddress: ref.contract,
            metadata,
            lens: row.lens,
            onchain: { chainId: ref.chainId, contractAddress: ref.contract, proposalId: ref.tokenId, metadata }
        }, cadastreParcelIds));
        return imported ? { ok: true, proposal: imported } : { ok: false, reason: 'import-failed' };
    }

    // Solana: proposals are program accounts read by address. ref.chainId = cluster (e.g. 'devnet'),
    // ref.contract = the proposal program id, ref.tokenId = the proposal account address (PDA). The
    // metadata + reconstruct step is the SAME as EVM — importOnChainProposal is metadata-driven.
    async function loadSolanaProposal(ref) {
        const loader = global.SolanaChainDataLoader;
        const storage = global.proposalStorage;
        if (!loader || typeof loader.getConnection !== 'function' || typeof loader.parseProposalAccount !== 'function'
            || !global.solanaWeb3 || !storage || typeof storage.importOnChainProposal !== 'function') {
            return { ok: false, reason: 'chain-unavailable' };
        }

        let parsed;
        try {
            const connection = loader.getConnection(ref.chainId);
            const accountInfo = await connection.getAccountInfo(new global.solanaWeb3.PublicKey(ref.tokenId));
            if (!accountInfo || !accountInfo.data) return { ok: false, reason: 'not-found' };
            parsed = loader.parseProposalAccount(accountInfo.data, ref.tokenId);
        } catch (error) {
            return { ok: false, reason: 'read-failed', error };
        }
        if (!parsed) return { ok: false, reason: 'not-found' };

        const metaUri = parsed.metadataUri || parsed.metadataURI || '';
        let metadata = null;
        const metaUrl = resolveMetadataUrl(metaUri);
        if (metaUrl && typeof fetch === 'function') {
            try {
                const resp = await fetch(metaUrl);
                if (resp.ok) metadata = await resp.json();
            } catch (_) { /* reconstruct with what the chain gave us */ }
        }

        let cadastreParcelIds;
        try {
            rejectLegacyGround(parsed, metadata?.properties, 'Solana proposal');
            cadastreParcelIds = canonicalCadastreIds(
                parsed.cadastreParcelIds
                || metadata?.properties?.cadastreParcelIds
                || []
            );
        } catch (error) {
            return { ok: false, reason: 'non-canonical-ground', error };
        }
        const imported = storage.importOnChainProposal({
            proposalId: parsed.proposalId || ref.tokenId,
            cadastreParcelIds,
            imageURI: metaUri,
            metadata,
            lens: parsed.lens || [],
            chainId: ref.chainId,
            contractAddress: ref.contract,
            onchain: { chainType: 'solana', chainId: ref.chainId, contractAddress: ref.contract, proposalId: ref.tokenId, metadata }
        });
        return imported ? { ok: true, proposal: imported } : { ok: false, reason: 'import-failed' };
    }

    // Canton is privacy-first: proposals are visible ONLY to their ledger parties, and a non-party
    // read returns an EMPTY list (never a 403). So this reads the current identity's proposals and
    // matches by contract id; no identity, or the id absent, means the viewer is not a party →
    // reason 'canton-private' (the caller shows the "log in as a party" message). ref.tokenId is the
    // proposal contract id; ref.chainId is the Canton network. Reuses GET /canton/proposals?party=.
    async function loadCantonProposal(ref) {
        const cantonMode = global.CantonMode;
        const storage = global.proposalStorage;
        const base = (typeof global.getBackendBase === 'function') ? global.getBackendBase() : '';
        if (!cantonMode || typeof cantonMode.getParty !== 'function'
            || !storage || typeof storage.importOnChainProposal !== 'function'
            || typeof fetch !== 'function' || !base) {
            return { ok: false, reason: 'chain-unavailable' };
        }

        const party = cantonMode.getParty();
        if (!party) return { ok: false, reason: 'canton-private' }; // no identity → can't see private proposals

        let proposals;
        try {
            const url = `${base.replace(/\/$/, '')}/canton/proposals?party=${encodeURIComponent(party)}`;
            const resp = await fetch(url);
            if (!resp.ok) return { ok: false, reason: 'read-failed' };
            const data = await resp.json();
            proposals = Array.isArray(data && data.proposals) ? data.proposals : [];
        } catch (error) {
            return { ok: false, reason: 'read-failed', error };
        }

        const match = proposals.find(p => p && String(p.contractId) === String(ref.tokenId));
        if (!match) return { ok: false, reason: 'canton-private' }; // not a party to THIS proposal

        let metadata = null;
        const metaUrl = resolveMetadataUrl(match.imageUri || match.metadataUri);
        if (metaUrl && typeof fetch === 'function') {
            try {
                const r = await fetch(metaUrl);
                if (r.ok) metadata = await r.json();
            } catch (_) { /* reconstruct with what the ledger gave us */ }
        }

        const cantonChainId = `canton-${ref.chainId}`;
        let cadastreParcelIds;
        try {
            rejectLegacyGround(match, metadata?.properties, 'Canton proposal');
            cadastreParcelIds = canonicalCadastreIds(
                match.cadastreParcelIds
                || metadata?.properties?.cadastreParcelIds
                || []
            );
        } catch (error) {
            return { ok: false, reason: 'non-canonical-ground', error };
        }
        const imported = storage.importOnChainProposal({
            proposalId: ref.tokenId,
            cadastreParcelIds,
            imageURI: match.imageUri || match.metadataUri || '',
            metadata,
            offer: match.price,
            chainId: cantonChainId,
            contractAddress: ref.contract || 'canton',
            onchain: { chainType: 'canton', chainId: cantonChainId, contractAddress: ref.contract || 'canton', proposalId: ref.tokenId, metadata }
        });
        return imported ? { ok: true, proposal: imported } : { ok: false, reason: 'import-failed' };
    }

    // Dispatch by chain type → { ok, proposal?, reason? }.
    async function loadChainProposalFromRef(ref) {
        if (!ref || !ref.chainType) return { ok: false, reason: 'bad-ref' };
        switch (ref.chainType) {
            case 'evm':
                return loadEvmProposal(ref);
            case 'solana':
                return loadSolanaProposal(ref);
            case 'canton':
                return loadCantonProposal(ref);
            default:
                return { ok: false, reason: 'unknown-chain' };
        }
    }

    if (typeof window !== 'undefined') {
        window.ChainProposalLoader = { loadChainProposalFromRef, resolveMetadataUrl };
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { loadChainProposalFromRef, resolveMetadataUrl };
    }
})(typeof window !== 'undefined' ? window : globalThis);
