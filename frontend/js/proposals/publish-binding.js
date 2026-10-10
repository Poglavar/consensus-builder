// Publishing a proposal as the artifact the server prepares from it (projections.md §3,
// PARCEL-OPTIONAL.md rules 1 and 3): POST /proposals/prepare builds what the server derives (a
// corridor's land, from its lanes), binds the site and stores an immutable artifact; the record that
// is minted and published carries exactly that artifact's declaration, binding and land, not whatever
// the browser had loaded, selected or previewed. Parcel acts keep their declared parcels (the server
// verifies them). Also turns the server's binding refusals into a readable list with intrusion widths.
// Pure apart from the injected fetchers; UMD so backend/test/publish-binding.test.js runs it headlessly.
// (POST /proposals/binding stays as the live preview of a site being drawn, site-drawing.js.)
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__publishBinding = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    // The binding source the server stamps (backend/proposals/binding.js SERVER_CADASTRE_SOURCE
    // starts with this prefix): such a binding is authoritative and is published as is.
    const SERVER_SOURCE_PREFIX = 'server:';
    // POST /proposals refusals of a record that no longer matches its preparation
    // (backend/proposals/prepare.js PREPARE_CODES).
    const PREPARATION_CODES = Object.freeze(['preparation-required', 'preparation-unknown', 'preparation-mismatch', 'preparation-stale']);

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

    function publishError(code, message, extra) {
        const error = new Error(message);
        error.code = code;
        Object.assign(error, extra || {});
        return error;
    }

    function metricFrameApi() {
        if (global && global.__metricFrame) return global.__metricFrame;
        return typeof require === 'function' ? require('../metric-frame.js') : null;
    }

    function ringsOf(geometry) {
        const g = geometry && geometry.type === 'Feature' ? geometry.geometry : geometry;
        if (!g || !Array.isArray(g.coordinates)) return [];
        if (g.type === 'Polygon') return g.coordinates;
        if (g.type === 'MultiPolygon') return g.coordinates.reduce((all, rings) => all.concat(rings), []);
        return [];
    }

    function pointSegmentDistance(p, a, b) {
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const length2 = dx * dx + dy * dy;
        const t = length2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2)) : 0;
        return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
    }

    function directedShift(fromRings, toRings) {
        let worst = 0;
        for (const ring of fromRings) {
            for (const point of ring) {
                let best = Infinity;
                for (const other of toRings) {
                    for (let i = 0; i < other.length - 1; i += 1) {
                        const distance = pointSegmentDistance(point, other[i], other[i + 1]);
                        if (distance < best) best = distance;
                    }
                }
                if (best > worst) worst = best;
            }
        }
        return worst;
    }

    /**
     * How far apart two outlines are: the largest distance from a vertex of either to the other's
     * boundary, in metres, measured in the built land's own construction frame. null when there is
     * no preview to compare; Infinity when the preview lies outside that frame's domain.
     */
    function boundaryShiftM(preview, built, provenance) {
        const previewRings = ringsOf(preview);
        const builtRings = ringsOf(built);
        if (!previewRings.length || !builtRings.length) return null;
        const frameApi = metricFrameApi();
        if (!frameApi) throw publishError('frame-unavailable', 'Cannot compare the corridor land: the metric frame module is unavailable.');
        const frame = frameApi.frameFromProvenance(provenance);
        const metric = rings => rings.map(ring => ring.map(position => frame.toMetric(position)));
        let a;
        try {
            a = metric(previewRings);
        } catch (_) {
            return Infinity;
        }
        const b = metric(builtRings);
        return Math.max(directedShift(a, b), directedShift(b, a));
    }

    /**
     * Prepare a proposal for publishing (POST /proposals/prepare).
     * @param {object} proposal the stored record.
     * @param {{ fetchPrepare: (body: {proposal, city, toleranceM}) => Promise<{preparationId, digest, artifact}>,
     *   city?: string, acceptedParcelIds?: string[], t?: Function }} options
     * @returns {Promise<{ proposal, binding, artifact, preparation, parcelAct: boolean,
     *   smallIntrusions: object[], landShiftM: number|null }>}
     *   proposal: a shallow copy carrying the artifact's `binding`, `cadastreParcelIds` (coverage
     *   'unknown': the authored declaration, unverified, as the server stores it), `toleranceM`,
     *   `preparation`, and for a corridor the server-built land (roadProposal.definition.polygon and
     *   constructionFrame). `site` is never added: the artifact holds the site the server derived.
     *   landShiftM: for a corridor, how far the built land lies from the browser's own preview.
     */
    async function prepareForPublish(proposal, options) {
        const opts = options || {};
        if (!proposal || typeof proposal !== 'object') throw publishError('invalid-proposal', 'Invalid proposal.');
        const binding = siteBinding();
        if (!binding) throw publishError('site-binding-unavailable', 'Cannot publish: the site binding rule is unavailable.');
        if (typeof opts.fetchPrepare !== 'function') throw publishError('binding-unavailable', 'Cannot publish: the preparation service is unavailable.');
        const parcelAct = binding.isParcelAct(proposal);
        const toleranceM = binding.normalizeTolerance(proposal.toleranceM);
        const record = { ...proposal };
        // What the server prepares is the authored record; an earlier preparation and a binding
        // (the browser's preview, or the last artifact's) are outputs, not inputs.
        delete record.preparation;
        delete record.binding;
        if (toleranceM > 0) record.toleranceM = toleranceM;
        else delete record.toleranceM;

        const prepared = await opts.fetchPrepare({ proposal: record, city: opts.city || proposal.city || null, toleranceM });
        const artifact = prepared && prepared.artifact;
        if (!artifact || !artifact.binding || !prepared.preparationId || !prepared.digest) {
            throw publishError('binding-invalid', 'Cannot publish: the server returned no prepared artifact.');
        }
        const server = artifact.binding;
        const preparation = { id: prepared.preparationId, digest: prepared.digest };
        const out = {
            ...record,
            binding: server,
            cadastreParcelIds: (Array.isArray(artifact.cadastreParcelIds) ? artifact.cadastreParcelIds : []).map(String),
            preparation
        };
        let landShiftM = null;
        if (artifact.corridor) {
            const definition = { ...(proposal.roadProposal && proposal.roadProposal.definition) };
            landShiftM = boundaryShiftM(definition.polygon, artifact.corridor.polygon, artifact.corridor.constructionFrame);
            definition.polygon = artifact.corridor.polygon;
            definition.constructionFrame = artifact.corridor.constructionFrame;
            // the browser's cached ring of its own preview would be a second, stale copy of the land
            delete definition.latLngPairs;
            out.roadProposal = { ...proposal.roadProposal, definition };
        }
        // Claims recorded against the local declaration can only name parcels that are still
        // bound; acceptances on land the site no longer reaches are void, not carried along.
        const boundSet = new Set(out.cadastreParcelIds);
        if (Array.isArray(out.acceptedParcelIds)) out.acceptedParcelIds = out.acceptedParcelIds.filter(id => boundSet.has(String(id)));
        if (out.ownerAcceptances && typeof out.ownerAcceptances === 'object') {
            out.ownerAcceptances = Object.fromEntries(Object.entries(out.ownerAcceptances).filter(([id]) => boundSet.has(String(id))));
        }
        const draft = siteDraft();
        const smallIntrusions = draft && !parcelAct && server.coverage !== binding.COVERAGE.unknown
            ? draft.unconfirmedSmallIntrusions(server, opts.acceptedParcelIds || [])
            : [];
        return { proposal: out, binding: server, artifact, preparation, parcelAct, smallIntrusions, landShiftM };
    }

    // A failed answer of the binding/preparation services as an Error with the server's code.
    async function answerOf(response, what, t) {
        let payload = null;
        try { payload = await response.json(); } catch (_) { payload = null; }
        if (response.ok) return payload;
        if (payload?.code?.startsWith('parcel-source-') && global.ParcelSourceHealth) {
            const failure = Object.assign(new Error(payload.error), payload, { status: response.status });
            global.reportParcelFetchFailure?.(failure, `proposal ${what}`);
            throw publishError(payload.code, global.ParcelSourceHealth.describeFailure(failure, {
                offline: global.navigator?.onLine === false, translate: global.i18n?.t?.bind(global.i18n)
            }), { status: response.status, upstreamStatus: payload.upstreamStatus, retryAfterSeconds: payload.retryAfterSeconds });
        }
        const readable = payload ? refusalMessage(payload, t) : null;
        throw publishError(payload && payload.code ? payload.code : `${what}-failed`,
            readable || (payload && payload.error) || `The ${what} service answered ${response.status}.`,
            { status: response.status, ...(Array.isArray(payload?.unresolved) ? { unresolved: payload.unresolved } : {}) });
    }

    const parcelSourceOf = city => global.CityConfigManager?.getCityConfig?.(city)?.parcels?.sourceId ?? null;

    // POST /proposals/binding through `fetchImpl`: the live preview of a site being drawn.
    function createFetchBinding(fetchImpl, backendBase) {
        return async function fetchBinding(body) {
            const response = await fetchImpl(`${backendBase}/proposals/binding`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...body, parcelSourceId: parcelSourceOf(body.city) })
            });
            const payload = await answerOf(response, 'binding');
            if (!payload || !payload.binding) throw publishError('binding-invalid', 'The binding service returned no binding.');
            return payload.binding;
        };
    }

    // POST /proposals/prepare through `fetchImpl`. Resolves { preparationId, digest, artifact, proposal }.
    function createFetchPrepare(fetchImpl, backendBase, t) {
        return async function fetchPrepare(body) {
            const response = await fetchImpl(`${backendBase}/proposals/prepare`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...body, parcelSourceId: parcelSourceOf(body.city) })
            });
            const payload = await answerOf(response, 'preparation', t);
            if (!payload || !payload.artifact || !payload.preparationId) {
                throw publishError('binding-invalid', 'The preparation service returned no artifact.');
            }
            return payload;
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
        const known = ['undeclared-parcels', 'unbound-parcels', 'binding-unresolved'].concat(PREPARATION_CODES);
        if (!body || !known.includes(body.code)) return null;
        const translate = typeof t === 'function' ? t : ((key, fallback, params) => String(fallback)
            .replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name) => (params && name in params ? params[name] : m)));
        if (PREPARATION_CODES.includes(body.code)) {
            return translate('modal.createProposal.errors.preparationChanged',
                'This proposal changed after it was prepared for publishing ({{reason}}). Publish it again.',
                { reason: body.error || body.code });
        }
        if (body.code === 'binding-unresolved') {
            const unresolved = Array.isArray(body.unresolved) ? body.unresolved : [];
            return translate('modal.createProposal.errors.bindingUnresolved',
                'The site reaches into {{list}} by almost exactly the tolerance, so it cannot be decided whether it takes land there. Move the design a millimetre into or away from it.',
                { list: describeHits(unresolved) });
        }
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
        PREPARATION_CODES,
        isServerBinding,
        prepareForPublish,
        boundaryShiftM,
        createFetchBinding,
        createFetchPrepare,
        describeHits,
        refusalMessage
    };
});
