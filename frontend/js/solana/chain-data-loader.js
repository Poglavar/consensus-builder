/**
 * Solana Chain Data Loader
 * Fetches parcels and proposals from Solana programs (PDA accounts)
 */
(function () {
    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    if (!globalScope) return;

    const connectionCache = new Map();
    const parcelMintStatusCache = new Map();
    const PARCEL_MINT_STATUS_CACHE_TTL_MS = 30 * 1000;
    const MAX_MULTIPLE_ACCOUNTS_BATCH = 100;

    function proposalStatusFromCode(statusCode) {
        const codec = globalScope.ProposalChainStatus;
        return codec && typeof codec.decodeProposalStatus === 'function'
            ? codec.decodeProposalStatus(statusCode)
            : 'Unknown';
    }

    function normalizeCluster(cluster) {
        const raw = typeof cluster === 'string' ? cluster.trim() : '';
        return raw || 'devnet';
    }

    function getParcelMintStatusCacheKey(parcelId, parcelProgramId, cluster) {
        return `${normalizeCluster(cluster)}:${String(parcelProgramId || '')}:${String(parcelId || '')}`;
    }

    function readCachedParcelMintStatus(cacheKey, options = {}) {
        if (!cacheKey || options.forceRefresh === true) return null;
        const entry = parcelMintStatusCache.get(cacheKey);
        if (!entry) return null;
        const ttlMs = Number.isFinite(options.cacheTtlMs) ? Math.max(0, options.cacheTtlMs) : PARCEL_MINT_STATUS_CACHE_TTL_MS;
        if (ttlMs > 0 && (Date.now() - entry.timestamp) > ttlMs) {
            parcelMintStatusCache.delete(cacheKey);
            return null;
        }
        return entry.value || null;
    }

    function writeCachedParcelMintStatus(cacheKey, value) {
        if (!cacheKey) return value;
        parcelMintStatusCache.set(cacheKey, {
            value,
            timestamp: Date.now()
        });
        return value;
    }

    function setParcelMintStatusCache(parcelId, parcelProgramId, cluster, value) {
        const cacheKey = getParcelMintStatusCacheKey(parcelId, parcelProgramId, cluster);
        return writeCachedParcelMintStatus(cacheKey, value);
    }

    function clearParcelMintStatusCache(parcelId, parcelProgramId, cluster) {
        if (!parcelId && !parcelProgramId && !cluster) {
            parcelMintStatusCache.clear();
            return;
        }
        const cacheKey = getParcelMintStatusCacheKey(parcelId, parcelProgramId, cluster);
        parcelMintStatusCache.delete(cacheKey);
    }

    function getConnection(cluster) {
        const clusters = {
            'mainnet-beta': 'https://api.mainnet-beta.solana.com',
            devnet: 'https://api.devnet.solana.com',
            testnet: 'https://api.testnet.solana.com'
        };
        const clusterKey = normalizeCluster(cluster);
        if (connectionCache.has(clusterKey)) {
            return connectionCache.get(clusterKey);
        }
        const rpc = clusters[clusterKey] || clusters.devnet;
        if (!globalScope.solanaWeb3) throw new Error('Solana web3.js not loaded');
        const connection = new globalScope.solanaWeb3.Connection(rpc, 'confirmed');
        connectionCache.set(clusterKey, connection);
        return connection;
    }

    function getParcelPda(programId, parcelId) {
        if (!globalScope.solanaWeb3) throw new Error('Solana web3.js not loaded');
        const enc = new TextEncoder();
        const [pda] = globalScope.solanaWeb3.PublicKey.findProgramAddressSync(
            [enc.encode('parcel'), enc.encode(parcelId)],
            new globalScope.solanaWeb3.PublicKey(programId)
        );
        return pda;
    }

    function parseParcelAccount(data) {
        if (!data || data.length < 8) return null;
        try {
            const body = new Uint8Array(data);
            let offset = 8;

            const readString = () => {
                if (offset + 4 > body.length) return '';
                const len = new DataView(body.buffer, body.byteOffset + offset, 4).getUint32(0, true);
                offset += 4;
                const str = new TextDecoder().decode(body.slice(offset, offset + len));
                offset += len;
                return str;
            };

            const parcelId = readString();
            const metadataUri = readString();
            const ownerBytes = body.slice(offset, offset + 32);
            offset += 32;
            const owner = ownerBytes.length >= 32 ? new globalScope.solanaWeb3.PublicKey(ownerBytes).toString() : null;

            return { parcelId, metadataUri, owner };
        } catch (_) {
            return null;
        }
    }

    function parseProposalAccount(data, address) {
        if (!data || data.length < 8) return null;
        try {
            const body = new Uint8Array(data);
            let offset = 8;

            const readU64 = () => {
                if (offset + 8 > body.length) return 0n;
                const val = new DataView(body.buffer, body.byteOffset + offset, 8).getBigUint64(0, true);
                offset += 8;
                return val;
            };
            const readPubkey = () => {
                if (offset + 32 > body.length) return null;
                const pk = new globalScope.solanaWeb3.PublicKey(body.slice(offset, offset + 32));
                offset += 32;
                return pk.toString();
            };
            const readVecString = () => {
                if (offset + 4 > body.length) return [];
                const len = new DataView(body.buffer, body.byteOffset + offset, 4).getUint32(0, true);
                offset += 4;
                const arr = [];
                for (let i = 0; i < len && offset < body.length; i++) {
                    const sLen = new DataView(body.buffer, body.byteOffset + offset, 4).getUint32(0, true);
                    offset += 4;
                    arr.push(new TextDecoder().decode(body.slice(offset, offset + sLen)));
                    offset += sLen;
                }
                return arr;
            };

            const proposalId = readU64();
            const owner = readPubkey();
            const parcelIds = readVecString();
            const isConditional = body[offset] !== 0;
            offset += 1;
            const imageUriLen = offset + 4 <= body.length ? new DataView(body.buffer, body.byteOffset + offset, 4).getUint32(0, true) : 0;
            offset += 4;
            const imageURI = imageUriLen > 0 ? new TextDecoder().decode(body.slice(offset, offset + imageUriLen)) : '';
            offset += imageUriLen;
            const acceptancePossible = body[offset] !== 0;
            offset += 1;
            const status = body[offset];
            offset += 1;
            const solBalance = offset + 8 <= body.length ? new DataView(body.buffer, body.byteOffset + offset, 8).getBigUint64(0, true) : 0n;
            offset += 8;
            const tokenBalance = offset + 8 <= body.length ? new DataView(body.buffer, body.byteOffset + offset, 8).getBigUint64(0, true) : 0n;
            offset += 8;
            const acceptanceCount = offset + 8 <= body.length ? new DataView(body.buffer, body.byteOffset + offset, 8).getBigUint64(0, true) : 0n;
            offset += 8;
            const acceptedParcels = readVecString();

            return {
                proposalId: address,
                proposalIdNum: proposalId.toString(),
                parentParcelIds: parcelIds,
                isConditional,
                imageURI,
                acceptancePossible,
                status: proposalStatusFromCode(status),
                statusCode: status,
                solBalance: solBalance.toString(),
                ethBalance: solBalance.toString(), // compat alias — shared proposal schema uses ethBalance
                tokenBalance: tokenBalance.toString(),
                acceptanceCount: acceptanceCount.toString(),
                expiryTimestamp: '0',
                expiringPercentage: '0',
                owner,
                acceptedParcels: acceptedParcels || []
            };
        } catch (_) {
            return null;
        }
    }

    async function getParcelMintStatuses(parcelIds, parcelProgramId, cluster, options = {}) {
        const normalizedParcelIds = Array.isArray(parcelIds)
            ? parcelIds
                .map(parcelId => (parcelId && parcelId.toString ? parcelId.toString() : String(parcelId || '')).trim())
                .filter(Boolean)
            : [];

        if (!normalizedParcelIds.length) {
            return [];
        }

        const connection = getConnection(cluster);
        const resultsByParcelId = new Map();
        const pendingLookups = [];

        normalizedParcelIds.forEach(parcelId => {
            const cacheKey = getParcelMintStatusCacheKey(parcelId, parcelProgramId, cluster);
            const cached = readCachedParcelMintStatus(cacheKey, options);
            if (cached) {
                resultsByParcelId.set(parcelId, cached);
                return;
            }
            pendingLookups.push({
                parcelId,
                cacheKey,
                pda: getParcelPda(parcelProgramId, parcelId)
            });
        });

        for (let i = 0; i < pendingLookups.length; i += MAX_MULTIPLE_ACCOUNTS_BATCH) {
            const batch = pendingLookups.slice(i, i + MAX_MULTIPLE_ACCOUNTS_BATCH);
            const accountInfos = await connection.getMultipleAccountsInfo(batch.map(entry => entry.pda));
            batch.forEach((entry, index) => {
                const accountInfo = Array.isArray(accountInfos) ? accountInfos[index] : null;
                let value = { minted: false };
                if (accountInfo && accountInfo.data) {
                    const parsed = parseParcelAccount(accountInfo.data);
                    if (parsed) {
                        value = {
                            minted: true,
                            tokenId: entry.pda.toString(),
                            owner: parsed.owner,
                            metadataURI: parsed.metadataUri
                        };
                    }
                }
                resultsByParcelId.set(entry.parcelId, writeCachedParcelMintStatus(entry.cacheKey, value));
            });
        }

        return normalizedParcelIds.map(parcelId => {
            const cached = resultsByParcelId.get(parcelId);
            return cached || { minted: false };
        });
    }

    async function getParcelMintStatus(parcelId, parcelProgramId, cluster, options = {}) {
        const statuses = await getParcelMintStatuses([parcelId], parcelProgramId, cluster, options);
        return Array.isArray(statuses) && statuses[0] ? statuses[0] : { minted: false };
    }

    async function getParcelsFromChain(walletAddress, cluster, parcelProgramId) {
        const connection = getConnection(cluster);
        const programId = new globalScope.solanaWeb3.PublicKey(parcelProgramId);
        const accounts = await connection.getProgramAccounts(programId);

        const parcels = [];
        const walletLower = walletAddress.toLowerCase();
        for (const { pubkey, account } of accounts) {
            const parsed = parseParcelAccount(account.data);
            if (parsed && parsed.parcelId && parsed.owner && parsed.owner.toLowerCase() === walletLower) {
                parcels.push({
                    tokenId: pubkey.toString(),
                    parcelId: parsed.parcelId,
                    metadataURI: parsed.metadataUri
                });
            }
        }
        return parcels;
    }

    async function getProposalsFromChain(walletAddress, cluster, proposalProgramId, opts = {}) {
        const connection = getConnection(cluster);
        const programId = new globalScope.solanaWeb3.PublicKey(proposalProgramId);
        const allAccounts = await connection.getProgramAccounts(programId);
        const proposals = [];
        for (const { pubkey, account } of allAccounts) {
            if (account.data.length < 20) continue;
            const parsed = parseProposalAccount(account.data, pubkey.toString());
            if (parsed && parsed.owner === walletAddress) {
                proposals.push({ ...parsed, lens: [] });
            }
        }
        return proposals;
    }

    async function getProposalsByParcelFromChain(cluster, proposalProgramId, parcelId) {
        const allProposals = await getAllProposals(cluster, proposalProgramId);
        return allProposals
            .filter(p => (p.parentParcelIds || []).includes(parcelId))
            .map(p => p.proposalId);
    }

    async function getAllProposals(cluster, proposalProgramId) {
        const connection = getConnection(cluster);
        const programId = new globalScope.solanaWeb3.PublicKey(proposalProgramId);
        const accounts = await connection.getProgramAccounts(programId);
        const proposals = [];
        for (const { pubkey, account } of accounts) {
            if (account.data.length < 20) continue;
            const parsed = parseProposalAccount(account.data, pubkey.toString());
            if (parsed) proposals.push(parsed);
        }
        return proposals;
    }

    async function hasParcelAcceptedProposal(cluster, _proposalProgramId, proposalAddress, parcelId) {
        const connection = getConnection(cluster);
        const accountInfo = await connection.getAccountInfo(new globalScope.solanaWeb3.PublicKey(proposalAddress));
        if (!accountInfo || !accountInfo.data) return false;
        const parsed = parseProposalAccount(accountInfo.data, proposalAddress);
        if (!parsed) return false;
        const accepted = parsed.acceptedParcels || [];
        return accepted.includes(parcelId);
    }

    async function resolveProgramAddress(chainKey, contractName) {
        const normalizeChainKey = key => {
            const raw = typeof key === 'string' ? key.trim().toLowerCase() : '';
            if (!raw || raw === 'solana') return 'solana';
            if (raw === 'devnet') return 'solana-devnet';
            if (raw === 'testnet') return 'solana-testnet';
            if (raw === 'mainnet' || raw === 'mainnet-beta' || raw === 'solana-mainnet') return 'solana-mainnet-beta';
            return raw.startsWith('solana-') ? raw : `solana-${raw}`;
        };

        try {
            const normalizedChainKey = normalizeChainKey(chainKey);
            const resp = await fetch('/contracts/addresses.json');
            if (resp?.ok) {
                const data = await resp.json();
                if (data[normalizedChainKey] && data[normalizedChainKey][contractName]) {
                    return data[normalizedChainKey][contractName];
                }
                if (normalizedChainKey === 'solana' || normalizedChainKey === 'solana-devnet') {
                    const solana = data.solana || data['solana-devnet'];
                    if (solana && solana[contractName]) return solana[contractName];
                }
            }
        } catch (_) {}
        return null;
    }

    async function getAllMintedParcelIds(cluster, parcelProgramId) {
        const connection = getConnection(cluster);
        const programId = new globalScope.solanaWeb3.PublicKey(parcelProgramId);
        const accounts = await connection.getProgramAccounts(programId);
        const parcelIds = [];
        for (const { account } of accounts) {
            const parsed = parseParcelAccount(account.data);
            if (parsed && parsed.parcelId) {
                parcelIds.push(parsed.parcelId);
            }
        }
        return parcelIds;
    }

    globalScope.SolanaChainDataLoader = {
        getConnection,
        getParcelPda,
        getParcelMintStatus,
        getParcelMintStatuses,
        setParcelMintStatusCache,
        clearParcelMintStatusCache,
        getParcelsFromChain,
        getAllMintedParcelIds,
        getProposalsFromChain,
        getProposalsByParcelFromChain,
        getAllProposals,
        hasParcelAcceptedProposal,
        resolveProgramAddress,
        parseParcelAccount,
        parseProposalAccount
    };
})();
