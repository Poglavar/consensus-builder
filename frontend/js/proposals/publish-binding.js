// Publishing a proposal with its server binding (PARCEL-OPTIONAL.md rules 1 and 3): the declaration
// a material proposal publishes is exactly the binding the server computes for its site
// (POST /proposals/binding), not whatever the browser had loaded or selected. Parcel acts keep their
// declared parcels (the server verifies those). Also turns the server's `undeclared-parcels` /
// `unbound-parcels` refusals into a readable list with intrusion widths. Pure apart from the
// injected `fetchBinding`; UMD so backend/test/publish-binding.test.js runs it headlessly.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__publishBinding = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    // The binding source the server stamps (backend/proposals/binding.js SERVER_CADASTRE_SOURCE
    // starts with this prefix): such a binding is authoritative and is published as is.
    const SERVER_SOURCE_PREFIX = 'server:';

    function siteBinding() {
        if (global && global.__siteBinding) return global.__siteBinding;
        return typeof require === 'function' ? require('./site-binding.js') : null;
    }

    function siteDraft() {
        if (global && global.__siteDraft) return global.__siteDraft;
        return typeof require === 'function' ? require('./site-draft.js') : null;
    }

    function isServerBinding(binding) {
        return !!(binding && typeof binding.source === 'string' && binding.source.indexOf(SERVER_SOURCE_PREFIX) === 0);
    }

    function declaredIds(proposal) {
        return Array.from(new Set((Array.isArray(proposal && proposal.cadastreParcelIds) ? proposal.cadastreParcelIds : [])
            .map(value => String(value === undefined || value === null ? '' : value).trim())
            .filter(Boolean)));
    }

    function publishError(code, message, extra) {
        const error = new Error(message);
        error.code = code;
        Object.assign(error, extra || {});
        return error;
    }

    /**
     * Bind a proposal for publishing.
     * @param {object} proposal the stored record.
     * @param {{ fetchBinding: ({site, toleranceM, city}) => Promise<object>, city?: string }} options
     * @returns {Promise<{ proposal, binding, parcelAct: boolean, smallIntrusions: object[] }>}
     *   proposal: a shallow copy with `site`, `toleranceM`, `binding` and `cadastreParcelIds` = the
     *   server binding's parcels (coverage 'unknown': the server cannot check here, so the authored
     *   declaration stays and is published unverified, as the server stores it).
     */
    async function bindForPublish(proposal, options) {
        const opts = options || {};
        if (!proposal || typeof proposal !== 'object') throw publishError('invalid-proposal', 'Invalid proposal.');
        const binding = siteBinding();
        if (!binding) throw publishError('site-binding-unavailable', 'Cannot publish: the site binding rule is unavailable.');
        if (binding.isParcelAct(proposal)) {
            return { proposal: { ...proposal }, binding: null, parcelAct: true, smallIntrusions: [] };
        }
        const site = binding.siteOf(proposal);
        if (!site) {
            throw publishError('proposal-site-missing', 'Cannot publish: the proposal has no site and no geometry of its own.');
        }
        if (typeof opts.fetchBinding !== 'function') throw publishError('binding-unavailable', 'Cannot publish: the binding service is unavailable.');
        const toleranceM = binding.normalizeTolerance(proposal.toleranceM);
        const server = await opts.fetchBinding({ site, toleranceM, city: opts.city || proposal.city || null });
        if (!server || !Array.isArray(server.parcels)) {
            throw publishError('binding-invalid', 'Cannot publish: the server returned no binding for this site.');
        }
        const out = { ...proposal, site, binding: server };
        if (toleranceM > 0) out.toleranceM = toleranceM;
        else delete out.toleranceM;
        out.cadastreParcelIds = server.coverage === binding.COVERAGE.unknown
            ? declaredIds(proposal)
            : binding.boundParcelIds(server);
        // Claims recorded against the local declaration can only name parcels that are still
        // bound; acceptances on land the site no longer reaches are void, not carried along.
        const boundSet = new Set(out.cadastreParcelIds);
        if (Array.isArray(out.acceptedParcelIds)) out.acceptedParcelIds = out.acceptedParcelIds.filter(id => boundSet.has(String(id)));
        if (out.ownerAcceptances && typeof out.ownerAcceptances === 'object') {
            out.ownerAcceptances = Object.fromEntries(Object.entries(out.ownerAcceptances).filter(([id]) => boundSet.has(String(id))));
        }
        const draft = siteDraft();
        const smallIntrusions = draft && server.coverage !== binding.COVERAGE.unknown
            ? draft.unconfirmedSmallIntrusions(server, opts.acceptedParcelIds || [])
            : [];
        return { proposal: out, binding: server, parcelAct: false, smallIntrusions };
    }

    // POST /proposals/binding through `fetchImpl`. Throws with the server's message and code.
    function createFetchBinding(fetchImpl, backendBase) {
        return async function fetchBinding(body) {
            const response = await fetchImpl(`${backendBase}/proposals/binding`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...body,
                    parcelSourceId: global.CityConfigManager?.getCityConfig?.(body.city)?.parcels?.sourceId ?? null })
            });
            let payload = null;
            try { payload = await response.json(); } catch (_) { payload = null; }
            if (!response.ok) {
                if (payload?.code?.startsWith('parcel-source-') && global.ParcelSourceHealth) {
                    const failure = Object.assign(new Error(payload.error), payload, { status: response.status });
                    global.reportParcelFetchFailure?.(failure, 'proposal binding');
                    throw publishError(payload.code, global.ParcelSourceHealth.describeFailure(failure, {
                        offline: global.navigator?.onLine === false, translate: global.i18n?.t?.bind(global.i18n)
                    }), { status: response.status, upstreamStatus: payload.upstreamStatus, retryAfterSeconds: payload.retryAfterSeconds });
                }
                throw publishError(payload && payload.code ? payload.code : 'binding-failed',
                    (payload && payload.error) || `The binding service answered ${response.status}.`,
                    { status: response.status });
            }
            if (!payload || !payload.binding) throw publishError('binding-invalid', 'The binding service returned no binding.');
            return payload.binding;
        };
    }

    function widthOf(meters) {
        const draft = siteDraft();
        return draft ? draft.formatWidth(meters) : `${meters} m`;
    }

    // "1234/5 (reaches 4 cm), 1234/6 (reaches 1.2 m)" from a refusal's missing/extra hits.
    function describeHits(hits) {
        return (Array.isArray(hits) ? hits : [])
            .map(hit => {
                if (!hit || hit.id === undefined || hit.id === null) return null;
                const width = typeof hit.intrusionM === 'number' && Number.isFinite(hit.intrusionM) && hit.intrusionM > 0
                    ? widthOf(hit.intrusionM) : '';
                return width ? `${hit.id} (${width})` : String(hit.id);
            })
            .filter(Boolean)
            .join(', ');
    }

    /**
     * A refusal of POST /proposals as a translated sentence, or null when it is not a binding
     * refusal. `t(key, fallback, params)` translates.
     */
    function refusalMessage(body, t) {
        if (!body || (body.code !== 'undeclared-parcels' && body.code !== 'unbound-parcels')) return null;
        const translate = typeof t === 'function' ? t : ((key, fallback, params) => String(fallback)
            .replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name) => (params && name in params ? params[name] : m)));
        const missing = Array.isArray(body.missing) ? body.missing
            : (Array.isArray(body.parcels) ? body.parcels : []);
        const extra = Array.isArray(body.extra) ? body.extra : [];
        const parts = [];
        if (missing.length) {
            parts.push(translate('modal.createProposal.errors.bindingMissing',
                'The site reaches into parcels the proposal does not name ({{count}}): {{list}}.',
                { count: missing.length, list: describeHits(missing) }));
        }
        if (extra.length) {
            parts.push(translate('modal.createProposal.errors.bindingExtra',
                'The proposal names parcels its site does not reach ({{count}}): {{list}}.',
                { count: extra.length, list: describeHits(extra) }));
        }
        parts.push(translate('modal.createProposal.errors.bindingFix',
            'Include those parcels in the site, or change the design so it stays inside it.'));
        return parts.join(' ');
    }

    return {
        SERVER_SOURCE_PREFIX,
        isServerBinding,
        bindForPublish,
        createFetchBinding,
        describeHits,
        refusalMessage
    };
});
