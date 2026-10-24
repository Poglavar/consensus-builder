// proposals/design-sync.js — designs leave the device as content-addressed objects and come back
// (plan-design-agreement.md, M2 "Browser"). Publishing pins a local design's design/v1 object through
// the courier (POST /pins), indexes it (POST /designs) and marks the local record
// `published: { cid, publishedAt, apiBase }`; a published design is read back by CID (GET /designs/:cid,
// POST /designs/batch) and imported as a local record; the proposal list's Server tab lists the index
// (GET /designs). window.DesignSync is the browser API; the list's cache functions stay globals for the
// list (list-ui.js, dialog-share.js). The pure helpers are exported for node.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root.document !== 'undefined') {
        const { browser, ...pure } = api;
        // browser() also installs the list's globals on the window it is given.
        const live = browser(root);
        root.DesignSync = Object.freeze({ ...pure, ...live.api });
    }
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const designRecord = () => {
        const api = root.DesignRecord || (typeof require === 'function' ? require('../design-record.js') : null);
        if (!api) throw new Error('DesignRecord (js/design-record.js) is not loaded.');
        return api;
    };
    const cidApi = () => {
        const api = root.Cid || (typeof require === 'function' ? require('../cid.js') : null);
        if (!api) throw new Error('Cid (js/cid.js) is not loaded.');
        return api;
    };
    const originApi = () => root.ProposalOrigin || (typeof require === 'function' ? require('./origin.js') : null);

    const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
    const textOf = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
    const apiBaseOf = value => originApi().apiBase(value);

    // ---- pure ------------------------------------------------------------------------------------

    // Hashing a design costs milliseconds (its canonical JSON, then sha256: ~3 ms for 87 KB measured
    // 2026-10-21), and lists ask for every row on every render. So the CID is kept per record object
    // for as long as the record's JSON text is unchanged; any edit in place is a different text.
    const cidMemo = new WeakMap();
    function contentCid(record) {
        let text = null;
        // A record that is not JSON text (a cycle, a BigInt somewhere) is hashed without the memo.
        try { text = JSON.stringify(record); } catch (_) { text = null; }
        const hit = text === null ? null : cidMemo.get(record);
        if (hit && hit.text === text) return hit.cid;
        let cid;
        try {
            cid = designRecord().cidOf(record);
        } catch (error) {
            if (!error || error.code !== 'invalid-cid-input') throw error;
            cid = null;
        }
        if (text !== null) cidMemo.set(record, { text, cid });
        return cid;
    }

    // The CID this record is published under at `apiBase`, or null. Content addressing makes the test
    // exact: the record must still hash to the CID it was published as, so an edit made in place after
    // publishing (or a copy that carried the mark over) is not mistaken for the published design.
    function publishedCid(record, apiBase) {
        const published = isObject(record) ? record.published : null;
        if (!isObject(published) || !cidApi().isCid(published.cid)) return null;
        const base = apiBaseOf(apiBase);
        if (!base || apiBaseOf(published.apiBase) !== base) return null;
        const cid = contentCid(record);
        return cid && cid === published.cid ? cid : null;
    }

    // Distinct CIDs sorted by code unit, never by locale: a link names its designs in one order everywhere.
    function sortedCids(list) {
        const values = Array.from(new Set((Array.isArray(list) ? list : []).map(String)));
        values.forEach(value => {
            if (!cidApi().isCid(value)) throw Object.assign(new Error(`Not a design CID: ${value}`), { code: 'invalid-cid' });
        });
        return values.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }

    // The path a set of designs is shared at.
    const designsPath = cids => `/designs/${sortedCids(cids).join(',')}`;

    // The CIDs a /designs/<cid>,<cid> path names, or null for any other path (or a malformed one).
    function parseDesignsPath(pathname) {
        const match = /^\/designs\/([^/?#]+)\/?$/.exec(String(pathname || ''));
        if (!match) return null;
        const parts = decodeURIComponent(match[1]).split(',').map(part => part.trim()).filter(Boolean);
        if (!parts.length || !parts.every(part => cidApi().isCid(part))) return null;
        return Array.from(new Set(parts));
    }

    // The cadastral parcels the index found under the design's site (its binding), sorted.
    function bindingParcelIds(binding) {
        const parcels = isObject(binding) && Array.isArray(binding.parcels) ? binding.parcels : [];
        return Array.from(new Set(parcels.map(hit => (hit && hit.parcelId != null ? String(hit.parcelId) : '')).filter(Boolean)))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    }

    // A local design record rebuilt from an index row: the design/v1 content as the record fields
    // DesignRecord.published reads (so the record hashes back to the row's CID), the parcels the index
    // bound as its cadastral declaration, and the publication mark. Throws (code 'cid-mismatch') when
    // the row's content is not the CID it is filed under, and (code 'invalid-design') for content that
    // is not a design/v1 object.
    function localDesignFromRow(row, { apiBase, proposalId } = {}) {
        if (!isObject(row) || !cidApi().isCid(row.cid) || !isObject(row.content)) {
            throw Object.assign(new Error('The index answered with something that is not a design.'), { code: 'invalid-design' });
        }
        const content = row.content;
        const checked = designRecord().validate(content);
        if (!checked.valid) {
            throw Object.assign(new Error(`Design ${row.cid} is not a ${designRecord().SCHEMA} object: ${checked.errors[0].message}`), { code: 'invalid-design' });
        }
        const computed = cidApi().cidOfObject(content);
        if (computed !== row.cid) {
            throw Object.assign(new Error(`Design ${row.cid} arrived as ${computed}: its content is not the published one.`), { code: 'cid-mismatch' });
        }
        const base = apiBaseOf(apiBase);
        if (!base) throw new Error('localDesignFromRow needs the API base the row was read from.');
        const record = {
            proposalId: proposalId || `design-${row.cid}`,
            goal: content.goal,
            title: content.title || '',
            name: content.title || '',
            description: content.description || '',
            author: content.author || '',
            city: content.city,
            site: content.site,
            toleranceM: content.toleranceM,
            geometry: content.geometry,
            // The design object hashes authoredAt as the record's createdAt (DesignRecord.published),
            // so it is taken from the object alone: never the index's arrival time, never the clock.
            createdAt: content.authoredAt ?? null,
            cadastreParcelIds: bindingParcelIds(row.binding),
            published: { cid: row.cid, publishedAt: row.createdAt || null, apiBase: base }
        };
        if (content.origin) record.origin = { cid: content.origin.cid };
        if (row.screenshotUrl) record.screenshotUrl = row.screenshotUrl;
        designRecord().PAYLOAD_KEYS.forEach(key => {
            if (content[key]) record[key] = content[key];
        });
        return record;
    }

    // An index row as the proposal list's Server tab lists it (the summary its rows render).
    // `indexed` says it is the index's row, published by definition (DesignSync.publishedCid).
    function designSummary(row) {
        if (!isObject(row) || !cidApi().isCid(row.cid)) return null;
        return {
            id: row.cid,
            cid: row.cid,
            indexed: true,
            proposalId: row.cid,
            city: row.city || null,
            title: row.title || '',
            name: row.title || null,
            author: row.author || '',
            goal: row.goal || null,
            createdAt: row.createdAt || null,
            updatedAt: row.createdAt || null,
            screenshotUrl: row.screenshotUrl || null,
            cadastreParcelIds: bindingParcelIds(row.binding)
        };
    }

    function base64OfBytes(bytes) {
        let binary = '';
        for (let index = 0; index < bytes.length; index += 0x8000) {
            binary += String.fromCharCode.apply(null, bytes.subarray(index, Math.min(index + 0x8000, bytes.length)));
        }
        return root.btoa(binary);
    }

    // ---- browser ---------------------------------------------------------------------------------

    function browser(win) {
        const log = (message, ...rest) => console.log(`[${new Date().toISOString()}] [DesignSync] ${message}`, ...rest);
        const warn = (message, ...rest) => console.warn(`[${new Date().toISOString()}] [DesignSync] ${message}`, ...rest);
        const preparedMapPreviews = new Map();

        function t(key, fallback, params = {}) {
            if (typeof win.getProposalI18nHelper === 'function') return win.getProposalI18nHelper()(key, fallback, params);
            return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (name in params ? params[name] : match));
        }

        function backendBase() {
            const base = typeof win.resolveBackendBaseUrl === 'function' ? win.resolveBackendBaseUrl() : win.getBackendBase();
            return String(base || '').replace(/\/$/, '');
        }
        const currentApiBase = () => apiBaseOf(backendBase());
        const storage = () => {
            if (!win.proposalStorage) throw new Error('proposalStorage is not loaded.');
            return win.proposalStorage;
        };

        function failure(code, message, extra = {}) {
            return Object.assign(new Error(message), { code }, extra);
        }

        // The user-facing sentence for a refusal of a design publish, by the server's code.
        function refusalMessage(status, body) {
            const code = body && body.code;
            if (code === 'cid-mismatch') return t('proposals.share.errors.cidMismatch', 'The server computed a different identity for this design, so nothing was published.');
            if (code === 'pinning-unconfigured') return t('proposals.share.errors.pinningUnconfigured', 'This server cannot pin published designs yet (pinning is not configured).');
            if (code === 'layout-needs-agreement') return t('proposals.share.errors.layoutNeedsAgreement', 'A parcel layout is published with the agreement that settles its land.');
            if (code === 'too-large') return t('proposals.share.errors.tooLarge', 'This design exceeds the 10 MiB publication limit. Reduce its extent or detail before sharing; it is saved locally.');
            if (status === 429) {
                const seconds = Number(body && body.retryAfterSeconds);
                return Number.isFinite(seconds) && seconds > 0
                    ? t('proposals.share.errors.rateLimitedFor', 'Too many publications for now. Try again in about {{minutes}} min.', { minutes: Math.max(1, Math.ceil(seconds / 60)) })
                    : t('proposals.share.errors.rateLimited', 'Too many publications for now. Wait a few minutes and try again.');
            }
            if (typeof code === 'string' && code.startsWith('parcel-source-') && win.ParcelSourceHealth) {
                const problem = Object.assign(new Error(body.error), body, { status });
                if (typeof win.reportParcelFetchFailure === 'function') win.reportParcelFetchFailure(problem, 'design publish');
                return win.ParcelSourceHealth.describeFailure(problem, { offline: win.navigator?.onLine === false, translate: win.i18n?.t?.bind(win.i18n) });
            }
            const reason = (body && body.error) || `HTTP ${status}`;
            return t('proposals.share.errors.refused', 'The server refused this design: {{reason}}', { reason });
        }

        // A read a design link waits on gives up at the parcel-load deadline (PARCEL_LOAD_TIMEOUT_MS,
        // 30 s by default): a hung index must not hold the link, and the map's parcels, forever.
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
                    ? await win.ParcelSourceHealth.withDeadline(load, { timeoutMs: readDeadlineMs(), code: 'design-load-timeout' })
                    : await load(null);
            } catch (error) {
                throw failure('network-failed', t('proposals.share.errors.networkFailed', 'The server could not be reached. Check the connection and try again.'), { cause: error });
            }
        }

        // Pins one published object through the courier and checks the answer names the same CID.
        // Returns { cid, pinnedAt, bytes }.
        async function pinObject(kind, object) {
            const bytes = cidApi().canonicalBytes(object);
            if (bytes.byteLength > designRecord().MAX_PUBLISHED_OBJECT_BYTES) {
                throw failure('too-large', refusalMessage(413, { code: 'too-large' }), {
                    bytes: bytes.byteLength, maxBytes: designRecord().MAX_PUBLISHED_OBJECT_BYTES
                });
            }
            const cid = cidApi().cidOf(bytes);
            const response = await request('POST', '/pins', { kind, cid, bytes: base64OfBytes(bytes) });
            if (!response.ok) {
                const code = (response.body && response.body.code) || `http-${response.status}`;
                throw failure(code, refusalMessage(response.status, response.body), { status: response.status, body: response.body });
            }
            if (!response.body || response.body.cid !== cid) {
                throw failure('cid-mismatch', t('proposals.share.errors.cidMismatch', 'The server computed a different identity for this design, so nothing was published.'),
                    { expected: cid, received: response.body && response.body.cid });
            }
            return { cid, pinnedAt: response.body.pinnedAt || null, bytes };
        }

        // The consumer selects the exact parcel dataset; the backend has no city default.
        // `city` is a city id or its short code (an agreement records the code it was made under, ?city=zg).
        function parcelSourceIdOf(city, geometry = null) {
            const manager = win.CityConfigManager;
            if (manager?.getDataContext) return manager.getDataContext(geometry, city).parcelSourceId;
            const id = manager && typeof manager.resolveCityId === 'function' ? manager.resolveCityId(city) || city : city;
            const config = manager && typeof manager.getCityConfig === 'function' ? manager.getCityConfig(id) : null;
            return config?.parcels?.sourceId || config?.parcels?.source || null;
        }

        // Marks the local record (and the stored one, when it is another object) published.
        function markPublished(localDesign, published) {
            const store = storage();
            const stored = localDesign.proposalId ? store.getProposal(localDesign.proposalId) : null;
            [localDesign, stored].filter(Boolean).forEach(record => { record.published = { ...published }; });
            if (stored) {
                store._indexProposal(stored);
                store.save();
            }
            return stored || localDesign;
        }

        /**
         * Publishes one local design: pins its design/v1 object, indexes it and marks the record.
         * A design already published here (it still hashes to its published CID) is not sent again.
         * Throws an Error with `code` and a translated `message`: a parcel layout ('layout-needs-agreement'
         * or the refusal's code), a guest without a name ('name-needed', `cancelled: true`), and the
         * courier's and index's refusals ('cid-mismatch', 'pinning-unconfigured', 'network-failed', …).
         * @returns {Promise<{ cid: string, row: object | null, alreadyPublished: boolean }>}
         */
        async function publishDesign(localDesign) {
            if (!isObject(localDesign)) throw new TypeError('publishDesign needs a local design record.');
            const apiBase = currentApiBase();
            if (!apiBase) throw new Error('The design index has no API base.');
            const already = publishedCid(localDesign, apiBase);
            if (already) return { cid: already, row: null, alreadyPublished: true };
            const refusal = win.ProposalPublishTerms.publishRefusal(localDesign);
            if (refusal) throw failure(refusal.code || 'layout-needs-agreement', refusal.message);
            // Publishing leaves the device and the design carries its author (GuestPolicy 'publish').
            const nameNeeded = win.guestPolicyBlocks('publish');
            if (nameNeeded) throw failure('name-needed', nameNeeded, { cancelled: true });
            // The author is content: it is stamped before the CID is taken.
            win.stampCurrentAuthor(localDesign);
            const content = designRecord().published(localDesign);
            const { cid } = await pinObject('design', content);
            const response = await request('POST', '/designs', { cid, content, parcelSourceId: parcelSourceIdOf(content.city) });
            if (!response.ok && response.status !== 409) {
                const code = (response.body && response.body.code) || `http-${response.status}`;
                throw failure(code, refusalMessage(response.status, response.body), { status: response.status, body: response.body });
            }
            const row = response.body;
            if (!row || row.cid !== cid) throw failure('cid-mismatch', t('proposals.share.errors.cidMismatch', 'The server computed a different identity for this design, so nothing was published.'));
            markPublished(localDesign, { cid, publishedAt: row.createdAt || new Date().toISOString(), apiBase });
            log(`published ${localDesign.proposalId} as ${cid}${response.status === 409 ? ' (already indexed)' : ''}`);
            return { cid, row, alreadyPublished: false };
        }

        /** Pins a design for an agreement publish without indexing it (a parcel layout is indexed with its
         *  agreement): { cid, content }. The author is stamped first, as for publishDesign. */
        async function pinDesign(localDesign) {
            if (!isObject(localDesign)) throw new TypeError('pinDesign needs a local design record.');
            win.stampCurrentAuthor(localDesign);
            const content = designRecord().published(localDesign);
            const { cid } = await pinObject('design', content);
            return { cid, content };
        }

        // GET /designs/:cid → the row; a missing design throws code 'design-not-found'.
        async function fetchDesign(cid) {
            if (!cidApi().isCid(cid)) throw failure('invalid-cid', `Not a design CID: ${cid}`);
            const response = await request('GET', `/designs/${encodeURIComponent(cid)}`, undefined, { deadline: true });
            if (response.status === 404) throw failure('design-not-found', t('proposals.share.errors.notFound', 'This design is not on the server.'), { cid });
            if (!response.ok || !response.body) throw failure((response.body && response.body.code) || `http-${response.status}`, refusalMessage(response.status, response.body));
            return response.body;
        }

        // POST /designs/batch in chunks of the index's limit → { rows: Map(cid → row), missing: cid[] }.
        async function fetchDesigns(cids) {
            const wanted = sortedCids(cids);
            const rows = new Map();
            for (let start = 0; start < wanted.length; start += 1000) {
                const chunk = wanted.slice(start, start + 1000);
                const response = await request('POST', '/designs/batch', { cids: chunk }, { deadline: true });
                if (!response.ok || !response.body || !Array.isArray(response.body.items)) {
                    throw failure((response.body && response.body.code) || `http-${response.status}`, refusalMessage(response.status, response.body));
                }
                response.body.items.forEach(item => {
                    if (item && item.design && item.design.cid === item.cid) rows.set(item.cid, item.design);
                });
            }
            return { rows, missing: wanted.filter(cid => !rows.has(cid)) };
        }

        // Starts the lazy map-image render before a shared link is opened. A successful CID set is
        // remembered for this page; concurrent/repeated selections share one request. Failures are
        // evicted so a later selection can try again.
        async function prepareMapPreview(cids) {
            const wanted = sortedCids(cids);
            if (!wanted.length) return null;
            const key = wanted.join(',');
            if (preparedMapPreviews.has(key)) return preparedMapPreviews.get(key);
            const pending = request('POST', '/map-previews', { cids: wanted }).then(response => {
                if (!response.ok || !response.body || typeof response.body.imageUrl !== 'string') {
                    throw failure((response.body && response.body.code) || `http-${response.status}`, 'The map preview could not be prepared.');
                }
                return response.body.imageUrl;
            }).catch(error => {
                preparedMapPreviews.delete(key);
                throw error;
            });
            preparedMapPreviews.set(key, pending);
            if (preparedMapPreviews.size > 100) preparedMapPreviews.delete(preparedMapPreviews.keys().next().value);
            return pending;
        }

        // The local record published as `cid` at the current index, or null. A record applied on the
        // map wins over a parked copy of the same design.
        function localCopyOf(cid, { store = storage() } = {}) {
            if (!cidApi().isCid(cid)) return null;
            const apiBase = currentApiBase();
            const copies = store.getAllProposals().filter(record => record && record.published && record.published.cid === cid
                && publishedCid(record, apiBase) === cid);
            return copies.find(record => typeof win.isProposalCurrentlyApplied === 'function' && win.isProposalCurrentlyApplied(record)) || copies[0] || null;
        }

        /**
         * Imports an index row as a local design (parked: importing never applies). A local copy of
         * the same CID is returned as it is. Throws like localDesignFromRow, and code
         * 'proposal-in-other-city' for another city's design (proposalStorage.importProposal).
         * Imports share the map mutation queue so an older background snapshot cannot erase them.
         * @returns a promise for the stored local record
         */
        async function importDesign(row, options = {}) {
            if (!options._parcelMutation) {
                return win.ProposalManager.runParcelMutation('import-design', row?.cid, transactionOptions =>
                    importDesign(row, transactionOptions), { _mapMutation: false });
            }
            const store = options._parcelMutation.proposals;
            const existing = localCopyOf(row && row.cid, { store });
            if (existing) return existing;
            const record = localDesignFromRow(row, { apiBase: currentApiBase() });
            const stored = store.importProposal(record, { overwrite: true, deferSave: true });
            if (!stored) throw new Error(`Design ${row.cid} could not be stored locally.`);
            let cid = null;
            try { cid = designRecord().cidOf(stored); } catch (error) { warn(`imported ${row.cid} cannot be hashed again`, error); }
            if (cid !== row.cid) warn(`imported ${row.cid} hashes to ${cid} here: its local form differs from the published object`);
            log(`imported ${row.cid} as ${stored.proposalId}`);
            return stored;
        }

        // A private fragment preview becomes an ordinary local draft, with no publication mark.
        async function importDraft(row, options = {}) {
            if (!options._parcelMutation) {
                return win.ProposalManager.runParcelMutation('import-draft', row?.cid, transactionOptions =>
                    importDraft(row, transactionOptions), { _mapMutation: false });
            }
            const record = localDesignFromRow(row, { apiBase: currentApiBase(), proposalId: `draft-${row.cid}` });
            delete record.published;
            record.lifecycleStatus = 'draft';
            record.applied = false;
            const stored = options._parcelMutation.proposals.importProposal(record, { overwrite: true, deferSave: true });
            if (!stored) throw new Error('The draft could not be imported.');
            return stored;
        }

        // The link a set of published designs opens at: /designs/<cid>,<cid> in the city they belong to,
        // in 3D, in the current language.
        function designLink(cids, { city = null } = {}) {
            const cityParam = typeof win.buildCityQueryParam === 'function' ? win.buildCityQueryParam(city) : '';
            const joiner = cityParam ? '&' : '?';
            return `${win.resolveFrontendBaseUrl()}${designsPath(cids)}${cityParam}${joiner}3d${shareLangParam()}`;
        }

        // Copies a link; resolves whether the clipboard took it.
        async function copyLink(url) {
            try {
                if (!win.navigator.clipboard || typeof win.navigator.clipboard.writeText !== 'function') return false;
                await win.navigator.clipboard.writeText(url);
                return true;
            } catch (error) {
                warn('the clipboard refused the link', error);
                return false;
            }
        }

        // ---- the proposal list's Server tab: the design index ------------------------------------

        // The current city's short code (?city=zg), else its id, for API queries and links.
        function resolveCurrentCityCode() {
            const manager = win.CityConfigManager;
            if (manager && typeof manager.getCurrentCityConfig === 'function' && typeof manager.getCityCodeForCityId === 'function') {
                const config = manager.getCurrentCityConfig();
                const code = config && config.id ? manager.getCityCodeForCityId(config.id) : null;
                if (code) return code;
            }
            if (typeof win.getCurrentCityId === 'function') {
                const id = win.getCurrentCityId();
                if (id) return id;
            }
            return 'city';
        }

        // `?city=` for a link: the design's own city when given, else the current one. The short code
        // where a city has one (?city=zg), else its id; the boot reads both (city-config.js resolveCityParam).
        function buildCityQueryParam(cityId) {
            const manager = win.CityConfigManager;
            if (!manager) return '';
            const id = (cityId && manager.resolveCityId(cityId)) || manager.getCurrentCityId();
            if (!id) return '';
            return `?city=${encodeURIComponent(manager.getCityCodeForCityId(id) || id)}`;
        }

        // `&lang=<l>` for a link: the language the page is shown in (a returning visitor who chose
        // another one keeps theirs, i18n.js). Appended after another query parameter.
        function shareLangParam() {
            const api = win.i18n;
            const lang = api && typeof api.getLanguage === 'function' ? api.getLanguage() : null;
            return lang ? `&lang=${encodeURIComponent(lang)}` : '';
        }

        // The list's cache and window are classic-script globals of proposals/data.js (top-level
        // consts, so not window properties): read by name when the list asks.
        const cache = () => serverProposalCache; // eslint-disable-line no-undef
        const listLimit = () => SERVER_PROPOSAL_SUMMARY_LIMIT; // eslint-disable-line no-undef

        function resetServerProposalCache(cityCode) {
            const state = cache();
            // A late answer for the previous area must not repaint the new one.
            state.summaryRequestId = (state.summaryRequestId || 0) + 1;
            state.proposals = [];
            state.count = null;
            state.error = null;
            state.loading = false;
            state.lastCity = cityCode || null;
            state.lastFetchedAt = 0;
            state.lastQuery = null;
            state.countRefreshedAt = 0;
            state.countLoading = false;
            state.countAreaKey = null;
        }

        function listArea(cityCode) {
            const area = typeof win.getProposalCountAreaContext === 'function' ? win.getProposalCountAreaContext() : null;
            const city = area && area.explore ? '' : win.normalizeCityCodeForApi(cityCode || (area && area.city) || resolveCurrentCityCode());
            return { area, city, key: (area && area.key) || city };
        }

        // GET /designs for the list's area: the city, or the view in explore. Newest first, as many as
        // the list shows (SERVER_PROPOSAL_SUMMARY_LIMIT); the count is the rows that came back (the
        // index has no count route).
        async function fetchServerProposalSummaries(cityCode) {
            const state = cache();
            const { area, city, key } = listArea(cityCode);
            state.loading = true;
            state.error = null;
            state.lastCity = key;
            state.countAreaKey = key;
            const requestId = state.summaryRequestId = (state.summaryRequestId || 0) + 1;
            if (typeof win.renderProposalListModal === 'function') win.renderProposalListModal();
            const params = new URLSearchParams({ limit: String(listLimit()) });
            if (city) params.set('city', city);
            if (area && area.explore && area.bbox) params.set('bbox', area.bbox.join(','));
            try {
                const response = await request('GET', `/designs?${params}`);
                if (!response.ok || !response.body || !Array.isArray(response.body.designs)) {
                    throw new Error((response.body && response.body.error) || `HTTP ${response.status}`);
                }
                if (state.summaryRequestId === requestId) {
                    state.proposals = response.body.designs.map(designSummary).filter(Boolean);
                    state.count = state.proposals.length;
                    state.countRefreshedAt = Date.now();
                }
            } catch (error) {
                if (state.summaryRequestId === requestId) {
                    warn('the design index could not be listed', error);
                    state.error = (error && error.message) || 'Unable to load published designs';
                }
            } finally {
                if (state.summaryRequestId === requestId) {
                    state.loading = false;
                    // The attempt is recorded, not only a success: the render below calls back into
                    // ensureServerProposals, which must not take an empty answer for "never asked".
                    state.lastFetchedAt = Date.now();
                    if (typeof win.renderProposalListModal === 'function') win.renderProposalListModal();
                    if (typeof win.updateShowProposalsButton === 'function') win.updateShowProposalsButton();
                }
            }
        }

        // Lists the index once per area; an explicit Retry passes { force: true }.
        function ensureServerProposals(cityCode, { force = false } = {}) {
            const state = cache();
            const { city, key } = listArea(cityCode);
            const changed = state.lastCity && state.lastCity !== key;
            if (changed) resetServerProposalCache(key);
            if (state.loading) return undefined;
            if (force || changed || !(state.lastFetchedAt > 0)) return fetchServerProposalSummaries(city);
            return undefined;
        }

        // The sidebar's server count: the area's listing, asked at most every 15 s.
        async function refreshServerProposalCount(cityCode) {
            const state = cache();
            const { city, key } = listArea(cityCode);
            if (state.countAreaKey && state.countAreaKey !== key) resetServerProposalCache(key);
            const fresh = state.countAreaKey === key && Date.now() - (state.countRefreshedAt || 0) < 15000;
            if (state.loading || fresh) return state.count;
            await fetchServerProposalSummaries(city);
            return state.count;
        }

        const findLocalCopyOfServerProposal = summary => localCopyOf(summary && summary.cid);
        const isServerProposalDownloaded = summary => !!findLocalCopyOfServerProposal(summary);

        // The list's functions stay window globals for list-ui.js and dialog-share.js. They are
        // assigned from a named object literal so the static scan of frontend names
        // (frontend-undeclared-globals.test.js) can see where each one is declared.
        const globals = {
            resolveCurrentCityCode, buildCityQueryParam, shareLangParam, resetServerProposalCache, fetchServerProposalSummaries,
            ensureServerProposals, refreshServerProposalCount, findLocalCopyOfServerProposal, isServerProposalDownloaded
        };
        Object.assign(win, globals);

        return {
            api: {
                publishDesign, pinDesign, pinObject, markPublished, fetchDesign, fetchDesigns, importDesign, importDraft, localCopyOf,
                designLink, copyLink, prepareMapPreview, parcelSourceIdOf, refusalMessage,
                // A local record's exact CID at the current index, or an index summary's own.
                publishedCid: record => (isObject(record) && record.indexed === true && cidApi().isCid(record.cid)
                    ? record.cid
                    : publishedCid(record, currentApiBase())),
                apiBase: currentApiBase
            },
            globals
        };
    }

    return { publishedCid, sortedCids, designsPath, parseDesignsPath, bindingParcelIds, localDesignFromRow, designSummary, browser };
});
