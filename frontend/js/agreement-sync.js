// agreement-sync.js — an agreement leaves the device and comes back (plan-design-agreement.md, M2
// "Browser"). Propose pins and indexes its designs (a parcel layout travels with its agreement), pins
// the agreement/v1 object, indexes it (POST /agreements) and marks the local record
// `published: { cid, publishedAt, apiBase, sponsor }`; an /agreements/<cid> link reads the agreement
// and its designs from the index, applies the designs, stores the agreement as a local record and
// opens its panel. Once minted (M3, solana/agreement-bridge.js), recordOnchain mirrors the chain
// account into the index (POST /agreements/<cid>/onchain) and keeps it on the local record as
// `onchain`. window.AgreementSync; the pure helpers are exported for node.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root.document !== 'undefined') {
        const { browser, ...pure } = api;
        root.AgreementSync = Object.freeze({ ...pure, ...browser(root) });
    }
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const cidApi = () => {
        const api = root.Cid || (typeof require === 'function' ? require('./cid.js') : null);
        if (!api) throw new Error('Cid (js/cid.js) is not loaded.');
        return api;
    };
    const recordApi = () => root.AgreementRecord || (typeof require === 'function' ? require('./agreement-record.js') : null);
    const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
    const idOf = value => (value === undefined || value === null ? '' : String(value).trim());

    // ---- pure ------------------------------------------------------------------------------------

    // The agreement CID an /agreements/<cid> path names, or null.
    function parseAgreementPath(pathname) {
        const match = /^\/agreements\/([^/?#]+)\/?$/.exec(String(pathname || ''));
        if (!match) return null;
        const cid = decodeURIComponent(match[1]).trim();
        return cidApi().isCid(cid) ? cid : null;
    }

    const agreementPath = cid => `/agreements/${cid}`;

    // "bafkreiabcd…wxyz": enough of a CID to recognise it; the full one is in the link and the title.
    function shortCid(cid) {
        const text = idOf(cid);
        return text.length > 20 ? `${text.slice(0, 12)}…${text.slice(-6)}` : text;
    }

    /**
     * The local agreement record of a published agreement/v1 object, for AgreementStore.save: the
     * designs by the local ids they were imported under (each keeps the published CID), the inputs
     * as published, and the outputs re-derived here when the pieces match the published hashes —
     * otherwise as published, by hash, with geometry null (the panel then reads them as stale).
     * @param row the index row ({ cid, content, createdAt })
     * @param options { id, apiBase, localIdOf(cid) → local proposal id, derived: { outputs } | null }
     */
    function recordFromPublished(row, { id, apiBase, localIdOf, derived = null } = {}) {
        if (!isObject(row) || !cidApi().isCid(row.cid) || !isObject(row.content)) throw new TypeError('recordFromPublished needs an agreement row.');
        if (typeof localIdOf !== 'function') throw new TypeError('recordFromPublished needs localIdOf(cid).');
        const content = row.content;
        const designs = content.designs.map(design => {
            const proposalId = localIdOf(design.cid);
            if (!proposalId) throw Object.assign(new Error(`Design ${design.cid} of the agreement is not held here.`), { code: 'design-missing' });
            return { proposalId, title: design.title, goal: design.goal, cid: design.cid };
        });
        const published = new Set(content.outputs.map(output => output.hash));
        const derivedOutputs = derived && Array.isArray(derived.outputs) ? derived.outputs : null;
        const matches = !!derivedOutputs && derivedOutputs.length === published.size
            && derivedOutputs.every(output => published.has(output.hash));
        const outputs = matches
            ? derivedOutputs
            : content.outputs.map(output => ({
                hash: output.hash,
                pieceId: output.hash,
                areaM2: output.areaM2,
                fromParcelIds: output.fromParcelIds,
                producedBy: output.producedBy ? localIdOf(output.producedBy) || null : null,
                role: output.role,
                holders: [],
                geometry: null
            }));
        return {
            schema: content.schema,
            id,
            title: content.title,
            author: content.author,
            sponsor: content.sponsor,
            city: content.city,
            createdAt: content.createdAt,
            designs,
            inputs: {
                parcels: content.inputs.parcels.map(parcel => ({ parcelId: parcel.parcelId, ...(parcel.parcelSourceId ? { parcelSourceId: parcel.parcelSourceId } : {}), areaM2: parcel.areaM2, holders: parcel.holders })),
                openGroundM2: content.inputs.openGroundM2
            },
            outputs,
            allocations: content.allocations,
            money: content.money,
            rule: content.rule,
            consultation: content.consultation,
            deadline: content.deadline,
            published: { cid: row.cid, publishedAt: row.createdAt || null, apiBase, sponsor: content.sponsor || null },
            // The index's record of the agreement's chain account, when it is minted (M3).
            onchain: isObject(row.onchain) ? row.onchain : null
        };
    }

    // ---- browser ---------------------------------------------------------------------------------

    function browser(win) {
        const log = (message, ...rest) => console.log(`[${new Date().toISOString()}] [AgreementSync] ${message}`, ...rest);

        function t(key, fallback, params = {}) {
            if (typeof win.getProposalI18nHelper === 'function') return win.getProposalI18nHelper()(key, fallback, params);
            return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (name in params ? params[name] : match));
        }
        const failure = (code, message, extra = {}) => Object.assign(new Error(message), { code }, extra);
        const backendBase = () => String(win.resolveBackendBaseUrl() || '').replace(/\/$/, '');
        const store = () => {
            if (!win.AgreementStore) throw new Error('AgreementStore is not loaded.');
            return win.AgreementStore;
        };
        const designOf = id => win.proposalStorage.getProposal(id) || null;

        // The user-facing sentence for a refusal of an agreement publish, by the server's code.
        function refusalMessage(status, body) {
            const code = body && body.code;
            if (code === 'cid-mismatch') return t('agreement.publish.errors.cidMismatch', 'The server computed a different identity for this agreement, so it was not proposed.');
            if (code === 'design-not-indexed') {
                return t('agreement.publish.errors.designNotIndexed', 'The server does not hold {{count}} of the agreement’s designs, so it was not proposed.',
                    { count: Array.isArray(body.missing) ? body.missing.length : 1 });
            }
            if (code === 'inputs-differ-from-binding') {
                const parcels = [...(body.missing || []), ...(body.extra || [])].join(', ');
                return t('agreement.publish.errors.inputsDifferFromBinding', 'The agreement’s land is not the land its designs take on the server ({{parcels}}). Edit the agreement on the current map and propose it again.', { parcels });
            }
            if (code === 'pinning-unconfigured') return t('agreement.publish.errors.pinningUnconfigured', 'This server cannot pin published agreements yet (pinning is not configured).');
            if (code === 'deadline-past') return t('agreement.publish.errors.deadlinePast', 'The agreement’s deadline has passed. Edit the deadline and propose it again.');
            const reason = (body && body.error) || `HTTP ${status}`;
            return t('agreement.publish.errors.refused', 'The server refused this agreement: {{reason}}', { reason });
        }

        // A read an agreement link waits on gives up at the parcel-load deadline (PARCEL_LOAD_TIMEOUT_MS,
        // 30 s by default), as a design link's reads do (design-sync.js): a hung index must not hold the
        // link, and the map's parcels, forever.
        function readDeadlineMs() {
            const configured = win.PARCEL_LOAD_TIMEOUT_MS;
            return typeof configured === 'number' && Number.isFinite(configured) && configured > 0 ? configured : 30000;
        }

        // One JSON request to the index. A network failure, or a `deadline` read that outlives the
        // deadline, throws code 'network-failed'.
        async function request(method, path, payload, { deadline = false } = {}) {
            const init = payload === undefined
                ? { method, headers: { Accept: 'application/json' }, cache: 'no-store' }
                : { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload) };
            const load = async signal => {
                const response = await win.fetch(`${backendBase()}${path}`, signal ? { ...init, signal } : init);
                let body = null;
                try { body = await response.json(); } catch (_) { body = null; }
                return { ok: response.ok, status: response.status, body };
            };
            try {
                return deadline && win.ParcelSourceHealth && typeof win.ParcelSourceHealth.withDeadline === 'function'
                    ? await win.ParcelSourceHealth.withDeadline(load, { timeoutMs: readDeadlineMs(), code: 'agreement-load-timeout' })
                    : await load(null);
            } catch (error) {
                throw failure('network-failed', t('proposals.share.errors.networkFailed', 'The server could not be reached. Check the connection and try again.'), { cause: error });
            }
        }

        // The name the agreement is proposed under, and the Solana wallet that sponsors it (M3 makes
        // it part of the agreement's chain address); null when no wallet is connected.
        function authorName() {
            const agent = typeof win.getCurrentUserAgent === 'function' ? win.getCurrentUserAgent() : null;
            return agent && typeof agent.name === 'string' && agent.name.trim() ? agent.name.trim() : null;
        }
        function sponsorKey() {
            const state = win.solanaWalletManager && typeof win.solanaWalletManager.getState === 'function' ? win.solanaWalletManager.getState() : null;
            return state && state.status === 'connected' && Array.isArray(state.accounts) && state.accounts.length ? String(state.accounts[0]) : null;
        }

        // The link a published agreement opens at, in its city and the current language.
        function agreementLink(cid, { city = null } = {}) {
            const cityParam = typeof win.buildCityQueryParam === 'function' ? win.buildCityQueryParam(city) : '';
            const lang = typeof win.shareLangParam === 'function' ? win.shareLangParam() : '';
            const query = cityParam ? `${cityParam}${lang}` : (lang ? `?${lang.slice(1)}` : '');
            return `${win.resolveFrontendBaseUrl()}${agreementPath(cid)}${query}`;
        }

        // GET /agreements/:cid → the row, its content checked against the CID it is filed under.
        async function fetchAgreement(cid) {
            if (!cidApi().isCid(cid)) throw failure('invalid-cid', t('agreement.publish.errors.notACid', 'This is not an agreement link.'));
            const response = await request('GET', `/agreements/${encodeURIComponent(cid)}`, undefined, { deadline: true });
            if (response.status === 404) throw failure('agreement-not-found', t('agreement.publish.errors.notFound', 'This agreement is not on the server.'));
            if (!response.ok || !response.body) throw failure((response.body && response.body.code) || `http-${response.status}`, refusalMessage(response.status, response.body));
            const row = response.body;
            if (!isObject(row.content) || cidApi().cidOfObject(row.content) !== cid) {
                throw failure('cid-mismatch', t('agreement.publish.errors.cidMismatch', 'The server computed a different identity for this agreement, so it was not proposed.'));
            }
            return row;
        }

        /**
         * Proposes a local agreement: publishes each design (a parcel layout is pinned and sent with the
         * agreement, which indexes it), pins the agreement/v1 object, indexes it and marks the record
         * published. The caller checks the agreement still matches the map (AgreementGround.check).
         * Throws an Error with `code` and a translated `message`; a guest without a name gets
         * `cancelled: true`.
         * @returns {Promise<{ cid, row, link }>}
         */
        async function publishAgreement(agreementId) {
            let agreement = store().get(agreementId);
            if (!agreement) throw failure('agreement-missing', t('agreement.publish.errors.missing', 'The agreement is no longer on this device.'));
            if (agreement.published) {
                return { cid: agreement.published.cid, row: null, link: agreementLink(agreement.published.cid, { city: agreement.city }) };
            }
            const checked = win.AgreementRecord.validate(agreement, { designOf, isApplied: win.isApplied });
            if (!checked.valid) throw failure('invalid-agreement', checked.errors[0].message);
            const nameNeeded = win.guestPolicyBlocks('publish');
            if (nameNeeded) throw failure('name-needed', nameNeeded, { cancelled: true });

            // Each design as it is published (an own draft carries the current profile's name first).
            const cids = new Map();
            const carried = [];
            const layouts = [];
            for (const design of agreement.designs) {
                const record = designOf(design.proposalId);
                if (!record) throw failure('design-missing', t('agreement.publish.errors.designMissing', 'A design of this agreement is no longer on this device.'));
                if (win.ProposalPublishTerms.publishRefusal(record)) {
                    const pinned = await win.DesignSync.pinDesign(record);
                    cids.set(design.proposalId, pinned.cid);
                    carried.push(pinned);
                    layouts.push({ record, cid: pinned.cid });
                } else {
                    cids.set(design.proposalId, (await win.DesignSync.publishDesign(record)).cid);
                }
            }
            // Stamping an author changes a design's CID: the record follows what was published.
            if (agreement.designs.some(design => design.cid !== cids.get(design.proposalId))) {
                agreement = store().save({ ...agreement, designs: agreement.designs.map(design => ({ ...design, cid: cids.get(design.proposalId) })) });
            }

            const parcelSourceId = win.DesignSync.parcelSourceIdOf(agreement.city);
            const content = win.AgreementRecord.published({
                ...agreement,
                author: authorName(),
                sponsor: sponsorKey(),
                inputs: {
                    ...agreement.inputs,
                    parcels: agreement.inputs.parcels.map(parcel => (parcelSourceId ? { ...parcel, parcelSourceId } : parcel))
                }
            }, proposalId => (cids.has(proposalId) ? cids.get(proposalId) : null));
            let cid;
            try {
                cid = (await win.DesignSync.pinObject('agreement', content)).cid;
            } catch (error) {
                // The courier's refusal, worded for an agreement.
                if (error && (error.body || error.code === 'cid-mismatch')) {
                    throw failure(error.code, refusalMessage(error.status || 0, error.body || { code: error.code }), { status: error.status, body: error.body });
                }
                throw error;
            }
            const response = await request('POST', '/agreements', carried.length ? { cid, content, designs: carried } : { cid, content });
            if (!response.ok && response.status !== 409) {
                const code = (response.body && response.body.code) || `http-${response.status}`;
                throw failure(code, refusalMessage(response.status, response.body), { status: response.status, body: response.body });
            }
            const row = response.body;
            if (!row || row.cid !== cid) throw failure('cid-mismatch', t('agreement.publish.errors.cidMismatch', 'The server computed a different identity for this agreement, so it was not proposed.'));
            const apiBase = win.DesignSync.apiBase();
            const publishedAt = row.createdAt || new Date().toISOString();
            // A parcel layout is published with its agreement.
            layouts.forEach(({ record, cid: layoutCid }) => win.DesignSync.markPublished(record, { cid: layoutCid, publishedAt, apiBase }));
            store().save({ ...agreement, published: { cid, publishedAt, apiBase, sponsor: content.sponsor } });
            log(`proposed ${agreementId} as ${cid} (${agreement.designs.length} design(s), ${carried.length} sent with it, sponsor ${content.sponsor || 'none'})`);
            return { cid, row, link: agreementLink(cid, { city: agreement.city }) };
        }

        /**
         * Proposes the agreement again as a new one sponsored by the connected Solana wallet: a copy of
         * the local record without its publication (a new local id and creation time), proposed as
         * Propose does. The sponsor is part of the published object, so this is a new CID; decisions
         * signed on the old one do not carry over, and the old record stays as it was.
         * @returns {Promise<{ id, cid, link }>}
         */
        async function proposeAgain(agreementId) {
            const agreement = store().get(agreementId);
            if (!agreement) throw failure('agreement-missing', t('agreement.publish.errors.missing', 'The agreement is no longer on this device.'));
            if (!sponsorKey()) throw failure('wallet-required', t('agreement.chain.errors.walletRequired', 'Connect a Solana wallet first.'));
            const copy = store().save({
                ...agreement,
                id: win.AgreementRecord.newId(),
                createdAt: new Date().toISOString(),
                published: null,
                onchain: null
            });
            log(`proposing ${agreementId} again as ${copy.id} with sponsor ${sponsorKey()}`);
            const { cid, link } = await publishAgreement(copy.id);
            return { id: copy.id, cid, link };
        }

        // The user-facing sentence for the index's refusal of a mint record, by the server's code.
        function onchainRefusalMessage(status, body) {
            const code = body && body.code;
            if (code === 'onchain-account-mismatch') {
                return t('agreement.chain.errors.accountMismatch', 'The server derives a different chain account for this agreement, so it did not record the mint.');
            }
            if (code === 'onchain-cid-mismatch') {
                return t('agreement.chain.errors.cidMismatch', 'The chain account holds a different agreement, so the server did not record the mint.');
            }
            if (code === 'onchain-account-missing') {
                return t('agreement.chain.errors.accountNotSeen', 'The server does not see the agreement’s account on chain yet. Open the agreement again later to send it.');
            }
            if (code === 'unsupported-cluster') {
                return t('agreement.chain.errors.clusterUnsupported', 'The server records agreements minted on Solana devnet only.');
            }
            const reason = (body && body.error) || `HTTP ${status}`;
            return t('agreement.chain.errors.indexRefused', 'The server did not record the mint: {{reason}}', { reason });
        }

        // Keeps the chain account on the local record (the chain is the truth, so it is kept even
        // when the index has not recorded it). Returns the saved record.
        function adoptOnchain(agreementId, onchain) {
            const agreement = store().get(agreementId);
            if (!agreement) throw failure('agreement-missing', t('agreement.publish.errors.missing', 'The agreement is no longer on this device.'));
            if (!isObject(onchain)) throw new TypeError('adoptOnchain needs an onchain object.');
            return store().save({ ...agreement, onchain });
        }

        /**
         * Mirrors a minted agreement's chain account into the index: POST /agreements/<cid>/onchain with
         * { chain, cluster, account, signature? }; the index answers the agreement row with `onchain`.
         * The local record keeps the index's `onchain` (ours when the index refused or could not be
         * reached), then a refusal throws with `code` ('onchain-account-mismatch',
         * 'onchain-cid-mismatch', …), a translated `message` and `kept: true`.
         * @returns {Promise<{ onchain, row }>}
         */
        async function recordOnchain(agreementId, { chain, cluster, account, signature = null } = {}) {
            const agreement = store().get(agreementId);
            if (!agreement) throw failure('agreement-missing', t('agreement.publish.errors.missing', 'The agreement is no longer on this device.'));
            if (!agreement.published) throw failure('not-proposed', t('agreement.chain.errors.notProposed', 'Propose the agreement before minting it.'));
            if (chain !== 'solana' || !idOf(cluster) || !idOf(account)) throw new TypeError('recordOnchain needs { chain: \'solana\', cluster, account }.');
            const cid = agreement.published.cid;
            const pointer = signature ? { chain, cluster, account, signature } : { chain, cluster, account };
            const post = async body => {
                const response = await request('POST', `/agreements/${encodeURIComponent(cid)}/onchain`, body);
                if (response.ok && response.body && isObject(response.body.onchain)) return { row: response.body, refusal: null };
                const code = (response.body && response.body.code) || `http-${response.status}`;
                return { row: null, refusal: failure(code, onchainRefusalMessage(response.status, response.body), { status: response.status, body: response.body }) };
            };
            let refusal = null;
            let row = null;
            try {
                ({ row, refusal } = await post(pointer));
                // The server's RPC may not see a just-confirmed transaction yet; the account alone is enough.
                if (refusal && refusal.code === 'onchain-signature-not-found') {
                    log(`the index does not see ${signature} yet; recording ${account} without it`);
                    ({ row, refusal } = await post({ chain, cluster, account }));
                }
            } catch (error) {
                refusal = error;
            }
            const saved = adoptOnchain(agreementId, row ? row.onchain : pointer);
            if (refusal) {
                console.warn(`[${new Date().toISOString()}] [AgreementSync] the index did not record the mint of ${cid} at ${account}`, refusal);
                throw Object.assign(refusal, { kept: true });
            }
            log(`recorded the mint of ${cid} at ${account} (${cluster}) in the index`);
            return { onchain: saved.onchain, row };
        }

        // The local agreement published as `cid`, or null.
        function localCopyOf(cid) {
            return store().list().find(agreement => agreement && agreement.published && agreement.published.cid === cid) || null;
        }

        // The land the agreement's designs shape here now (AgreementGround.derive), or null when it
        // cannot be read.
        async function deriveLand(records) {
            const fabric = win.LiveParcelFabric;
            const ground = win.AgreementGround;
            const ids = win.AgreementDialog.inputParcelIds(records, fabric);
            let features = [];
            if (ids.length && !win.ParcelGroundFallback?.isWithoutParcels?.()) {
                const result = await win.CadastralParcelRepository.ensureIds(ids, { retainOnly: true });
                features = Array.isArray(result && result.features) ? result.features : [];
            }
            return ground.derive({
                designs: records, fabric,
                originals: win.AgreementDialog.originalsById(features, fabric && fabric.featureId),
                ownerOf: ground.localHolders({ storage: win.PersistentStorage, agents: win.agentStorage }),
                area: ground.areaOf
            });
        }

        /**
         * Opens a proposed agreement from its /agreements/<cid> link (core.js handleProposalRouteFromUrl):
         * reads it, applies its designs (handleSharedDesignRoute), stores it as a local agreement with the
         * pieces re-derived on this ground when they match the published ones, and opens its panel.
         */
        async function handleAgreementRoute(rawCid) {
            const cid = idOf(rawCid);
            try {
                const row = await fetchAgreement(cid);
                log(`opening ${cid}: ${row.content.designs.length} design(s), status ${row.status}`);
                const cityManager = win.CityConfigManager;
                if (row.city && cityManager.foreignCityFor(row.city) && await win.promptCityMismatchForProposal(String(row.city))) {
                    log('the agreement belongs to another city; the link was dropped or reloads there');
                    return;
                }
                const designCids = row.content.designs.map(design => design.cid);
                if (win.__cbSecondaryTab === true) {
                    const fetched = await win.DesignSync.fetchDesigns(designCids);
                    const foreignDesign = [...fetched.rows.values()].find(design => cityManager.foreignCityFor(design.city));
                    if (foreignDesign && await win.promptCityMismatchForProposal(String(foreignDesign.city))) {
                        log('an agreement design belongs to another city; the link was dropped or reloads there');
                        return;
                    }
                    const designs = new Map();
                    fetched.rows.forEach((design, designCid) => {
                        const content = design.content || {};
                        designs.set(designCid, {
                            ...content,
                            proposalId: designCid,
                            title: content.title || '',
                            name: content.title || '',
                            createdAt: content.authoredAt || null,
                            published: { cid: designCid, publishedAt: design.createdAt || null, apiBase: win.DesignSync.apiBase() }
                        });
                    });
                    const agreement = recordFromPublished(row, {
                        id: `published-${cid}`,
                        apiBase: win.DesignSync.apiBase(),
                        localIdOf: designCid => designCid
                    });
                    await win.AgreementPanel.openReadOnly(agreement, { designs });
                    log(`opened ${cid} as a read-only published agreement`);
                    return;
                }
                const opened = await win.handleSharedDesignRoute(designCids, { openDetails: false, enter3D: false, summary: false });
                if (opened.blocked) return;
                if (opened.failed.length) {
                    const reasons = opened.failed.map(item => item.reason).filter(Boolean).join('; ');
                    win.showEphemeralMessage(t('agreement.publish.route.designsFailed', '{{count}} of the agreement’s designs could not be applied here: {{reasons}}',
                        { count: opened.failed.length, reasons }), 9000, 'warning');
                }
                const localIdOf = designCid => opened.localIds.get(designCid) || win.DesignSync.localCopyOf(designCid)?.proposalId || null;
                const records = designCids.map(localIdOf).map(id => (id ? designOf(id) : null));
                let derived = null;
                if (records.every(record => record && win.isApplied(record))) {
                    try {
                        derived = await deriveLand(records);
                    } catch (error) {
                        console.warn(`[${new Date().toISOString()}] [AgreementSync] the land of ${cid} could not be derived here`, error);
                    }
                }
                const existing = localCopyOf(cid);
                const record = recordFromPublished(row, {
                    id: existing ? existing.id : win.AgreementRecord.newId(),
                    apiBase: win.DesignSync.apiBase(),
                    localIdOf,
                    derived
                });
                // A mint this device made but the index has not recorded yet stays on the record.
                const saved = store().save(!record.onchain && existing && existing.onchain ? { ...record, onchain: existing.onchain } : record);
                log(`stored ${cid} as ${saved.id}${saved.outputs.every(output => output.geometry) ? '' : ' (its pieces differ here)'}`);
                await win.AgreementPanel.open(saved.id);
                const intent = win.ApprovalLink?.parse(win.location);
                if (intent?.target === cid) win.ApprovalLink.preselect(win.document, intent);
            } catch (error) {
                console.error(`[${new Date().toISOString()}] [AgreementSync] the agreement ${cid} could not be opened`, error);
                win.showEphemeralMessage((error && error.message) || t('agreement.publish.route.failed', 'The agreement could not be opened.'), 8000, 'error');
            }
        }

        // The agreements of a city the index lists as minted (GET /agreements?city=&minted=1), newest first.
        async function fetchMinted({ city = null, limit = 100 } = {}) {
            const params = new URLSearchParams({ minted: '1', limit: String(limit) });
            if (city) params.set('city', city);
            const response = await request('GET', `/agreements?${params}`, undefined, { deadline: true });
            if (!response.ok || !response.body || !Array.isArray(response.body.agreements)) {
                throw failure((response.body && response.body.code) || `http-${response.status}`, (response.body && response.body.error) || `HTTP ${response.status}`);
            }
            // The filter is the server's; a row without a chain account is not minted, whatever it says.
            return response.body.agreements.filter(row => row && cidApi().isCid(row.cid) && isObject(row.onchain));
        }

        return {
            publishAgreement, proposeAgain, fetchAgreement, fetchMinted, handleAgreementRoute, agreementLink, localCopyOf,
            refusalMessage, recordOnchain, adoptOnchain
        };
    }

    return { parseAgreementPath, agreementPath, shortCid, recordFromPublished, browser };
});
