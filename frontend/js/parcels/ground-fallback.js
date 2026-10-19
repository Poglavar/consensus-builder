// What happens when the official parcel register cannot be loaded.
//
// A visitor arriving somewhere first sees the official register attempted (fetch.js). When that
// attempt fails, or the city has no register on record at all, this module offers four ways on:
//
//   1. Retry        — only for a failure that reads as temporary (network, 5xx, timeout).
//   2. Own link     — a GeoJSON / OGC API Features / ArcGIS FeatureServer URL the visitor knows,
//                     validated on a bounded sample before it is trusted for the viewport.
//   3. Imagery      — best-effort inference of parcel boundaries from satellite imagery. The
//                     pipeline is being built elsewhere; this entry point reports availability.
//                     OCR is only the working name retained in the integration contract.
//   4. Schelling    — shows the Schelling plan layer (js/schelling/): streets, blocks and plots
//                     everyone can derive independently, drawn over whatever ground is here. It is
//                     not a parcel source; what is proposed from it stands on open ground.
//
// Option 2 becomes a parcel SOURCE for the city for this browser session: fetch.js asks
// `activeSource(city)` before it talks to the network, so the repository, fabric and presenter see
// these parcels the way they see cadastral ones. Nothing here is persisted beyond sessionStorage,
// and nothing here is ever labelled a cadastre: every feature carries its provenance.
//
// A failed fetch and "no register" are kept apart on purpose (see unsurveyed-ground.md): the dialog
// states which one happened, and only a temporary failure gets a Retry button.
(function attachGroundFallback(global) {
    'use strict';

    const SESSION_KEY_PREFIX = 'cb_ground_source:';
    const DISMISSED_KEY_PREFIX = 'cb_ground_fallback_dismissed:';
    const SAMPLE_FEATURE_LIMIT = 2000;

    const sources = new Map();          // cityId -> source
    const failures = new Map();         // cityId -> latest recovery context, retained for reopening
    let openDialog = null;
    let pendingDialog = null;

    // ---- small helpers ------------------------------------------------------------------------

    function t(key, fallback, params) {
        try {
            if (global.i18n && typeof global.i18n.t === 'function') {
                const translated = global.i18n.t(key, params || {});
                if (translated && translated !== key) return translated;
            }
        } catch (_) { }
        let text = String(fallback == null ? '' : fallback);
        if (params) {
            Object.keys(params).forEach(name => {
                text = text.replace(new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}|\\{${name}\\}`, 'g'), String(params[name]));
            });
        }
        return text;
    }

    function session() {
        try { return global.sessionStorage || null; } catch (_) { return null; }
    }

    function readSession(key) {
        const store = session();
        if (!store) return null;
        try { return store.getItem(key); } catch (_) { return null; }
    }

    function writeSession(key, value) {
        const store = session();
        if (!store) return;
        try {
            if (value === null || value === undefined) store.removeItem(key);
            else store.setItem(key, String(value));
        } catch (_) { }
    }

    function currentCityId() {
        try {
            const manager = global.CityConfigManager;
            const id = manager && typeof manager.getCurrentCityId === 'function' ? manager.getCurrentCityId() : '';
            return String(id || '');
        } catch (_) {
            return '';
        }
    }

    function cityLabel(cityId) {
        try {
            const manager = global.CityConfigManager;
            if (manager && typeof manager.getCityLabel === 'function') return manager.getCityLabel(cityId) || cityId;
        } catch (_) { }
        return cityId;
    }

    function cityParcelSettings(cityId) {
        try {
            const manager = global.CityConfigManager;
            const configs = manager && typeof manager.getAvailableCities === 'function' ? manager.getAvailableCities() : [];
            const config = configs.find(entry => String(entry && entry.id || '') === String(cityId || ''));
            return config && config.parcels || null;
        } catch (_) {
            return null;
        }
    }

    function status(message) {
        try { if (typeof global.updateStatus === 'function') global.updateStatus(message); } catch (_) { }
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    // ---- what went wrong --------------------------------------------------------------------

    // Decides what the dialog may honestly say, and whether Retry is on the table.
    //   no-register  the city has no parcel register on record (config says so, or the transport
    //                raised code 'no-register'); retry is pointless.
    //   temporary    network, 5xx, 408/429, aborted: a retry can plausibly succeed.
    //   refused      401/403/404: the register answered and said no; retry rarely helps.
    //   broken       the register answered with something that is not parcel data.
    //   unknown      anything else; retry allowed.
    function classify(error, context = {}) {
        const settings = context.parcelSettings || null;
        const strategy = settings && String(settings.strategy || '').toLowerCase();
        const source = settings && String(settings.source || '').toLowerCase();
        if ((error && error.code === 'no-register') || strategy === 'none' || source === 'none') {
            return { kind: 'no-register', retryable: false, detail: '' };
        }
        const message = String(error && error.message || error || '');
        const httpStatus = Number(error && (error.upstreamStatus ?? error.status));
        if (Number.isFinite(httpStatus) && httpStatus > 0) {
            if (httpStatus >= 500 || httpStatus === 408 || httpStatus === 429) {
                return { kind: 'temporary', retryable: true, detail: `HTTP ${httpStatus}` };
            }
            if (httpStatus === 401 || httpStatus === 403 || httpStatus === 404) {
                return { kind: 'refused', retryable: false, detail: `HTTP ${httpStatus}` };
            }
            return { kind: 'unknown', retryable: true, detail: `HTTP ${httpStatus}` };
        }
        if (/not JSON|no features array|coordinate conversion|without parcelId|no polygon geometry/i.test(message)) {
            return { kind: 'broken', retryable: true, detail: message };
        }
        if ((error && error.name === 'TypeError') || /Failed to fetch|NetworkError|network|timed? ?out|aborted|ECONN|load failed/i.test(message)) {
            return { kind: 'temporary', retryable: true, detail: message };
        }
        return { kind: 'unknown', retryable: true, detail: message };
    }

    // ---- sources --------------------------------------------------------------------------------

    // A source is what fetch.js consults instead of the network:
    //   { id, kind: 'custom-url', label, fetchCell({ latLonBbox, bbox, city }),
    //     fetchByIds(ids) -> { features, absentIds }, describe() -> persisted descriptor }
    function activeSource(cityId) {
        return sources.get(String(cityId || currentCityId())) || null;
    }

    function installSource(cityId, source) {
        const city = String(cityId || currentCityId());
        if (!source || typeof source.fetchCell !== 'function') throw new TypeError('A ground source needs fetchCell().');
        sources.set(city, source);
        const descriptor = typeof source.describe === 'function' ? source.describe() : null;
        writeSession(SESSION_KEY_PREFIX + city, descriptor ? JSON.stringify(descriptor) : null);
        try { global.dispatchEvent(new CustomEvent('groundSourceChanged', { detail: { city, source: descriptor } })); } catch (_) { }
        return source;
    }

    function clearSource(cityId) {
        const city = String(cityId || currentCityId());
        sources.delete(city);
        writeSession(SESSION_KEY_PREFIX + city, null);
    }

    // latLonBbox arrives as "minLng,minLat,maxLng,maxLat" — west,south,east,north — which is how
    // fetch.js builds it for the backend's bbox parameter.
    function parseLatLonBbox(text) {
        const parts = String(text || '').split(',').map(Number);
        if (parts.length < 4 || parts.some(value => !Number.isFinite(value))) return null;
        return { west: parts[0], south: parts[1], east: parts[2], north: parts[3] };
    }

    // ---- a register the visitor knows of ------------------------------------------------------

    // Three documented shapes and nothing else: an ArcGIS FeatureServer/MapServer layer, an OGC API
    // Features items URL, or a plain GeoJSON FeatureCollection (optionally with a {bbox} slot).
    function detectUrlKind(url) {
        const text = String(url || '').trim();
        if (/\/(FeatureServer|MapServer)\/\d+\/?(\?|$)/i.test(text)) return 'arcgis';
        if (/\/collections\/[^/]+\/items\/?(\?|$)/i.test(text)) return 'ogc';
        if (text.includes('{bbox}')) return 'bbox-template';
        return 'geojson';
    }

    function urlForBox(url, kind, box) {
        const bbox = `${box.west},${box.south},${box.east},${box.north}`;
        if (kind === 'bbox-template') return url.replace(/\{bbox\}/g, bbox);
        if (kind === 'arcgis') {
            const base = url.replace(/\/+$/, '').split('?')[0];
            const params = new URLSearchParams({
                where: '1=1',
                geometry: JSON.stringify({ xmin: box.west, ymin: box.south, xmax: box.east, ymax: box.north, spatialReference: { wkid: 4326 } }),
                geometryType: 'esriGeometryEnvelope',
                inSR: '4326',
                spatialRel: 'esriSpatialRelIntersects',
                outFields: '*',
                outSR: '4326',
                returnGeometry: 'true',
                resultRecordCount: String(SAMPLE_FEATURE_LIMIT),
                f: 'geojson'
            });
            return `${base}/query?${params}`;
        }
        if (kind === 'ogc') {
            const parsed = new URL(url);
            parsed.searchParams.set('bbox', bbox);
            parsed.searchParams.set('limit', String(Math.min(SAMPLE_FEATURE_LIMIT, 1000)));
            if (!parsed.searchParams.has('f')) parsed.searchParams.set('f', 'json');
            return parsed.toString();
        }
        return url;
    }

    function ringIsPlausible(ring) {
        if (!Array.isArray(ring) || ring.length < 4) return false;
        return ring.every(point => Array.isArray(point) && point.length >= 2
            && Number.isFinite(point[0]) && Number.isFinite(point[1])
            && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90);
    }

    function geometryIsPlausible(geometry) {
        if (!geometry) return false;
        if (geometry.type === 'Polygon') return Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0 && geometry.coordinates.every(ringIsPlausible);
        if (geometry.type === 'MultiPolygon') return Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0
            && geometry.coordinates.every(polygon => Array.isArray(polygon) && polygon.length > 0 && polygon.every(ringIsPlausible));
        return false;
    }

    function geometryBbox(geometry) {
        let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
        const visit = ring => ring.forEach(([x, y]) => {
            if (x < west) west = x; if (x > east) east = x;
            if (y < south) south = y; if (y > north) north = y;
        });
        if (geometry.type === 'Polygon') geometry.coordinates.forEach(visit);
        else geometry.coordinates.forEach(polygon => polygon.forEach(visit));
        return { west, south, east, north };
    }

    function boxesTouch(a, b) {
        return !(a.east < b.west || a.west > b.east || a.north < b.south || a.south > b.north);
    }

    function hashString(text) {
        let hash = 2166136261;
        for (let i = 0; i < text.length; i += 1) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(16).padStart(8, '0');
    }

    // The register's own id when it has one; otherwise a digest of the geometry, which is stable
    // for as long as the geometry is — the only kind of stability an anonymous feature can offer.
    function externalFeatureId(feature) {
        const props = feature.properties || {};
        const candidates = [props.parcelId, props.parcel_id, props.PARCEL_ID, props.id, props.ID, props.OBJECTID, props.FID, props.gml_id, feature.id];
        const found = candidates.find(value => value !== undefined && value !== null && String(value).trim() !== '');
        if (found !== undefined) return `URL:${String(found).trim()}`;
        return `URL:g${hashString(JSON.stringify(feature.geometry.coordinates))}`;
    }

    // Reads a reply and keeps only what the repository could accept. Rejects rather than repairs:
    // a register that returns points, open rings or coordinates in metres is reported, not guessed at.
    function validateFeatureCollection(payload, viewBox) {
        const features = payload && Array.isArray(payload.features) ? payload.features : null;
        if (!features) throw new Error(t('groundFallback.url.notCollection', 'The reply is not a GeoJSON FeatureCollection.'));
        const seen = new Map();
        let overlapping = 0;
        let rejected = 0;
        features.forEach(raw => {
            if (!raw || raw.type !== 'Feature' || !geometryIsPlausible(raw.geometry)) { rejected += 1; return; }
            const id = externalFeatureId(raw);
            const previous = seen.get(id);
            if (previous) {
                if (JSON.stringify(previous.geometry) !== JSON.stringify(raw.geometry)) {
                    throw new Error(t('groundFallback.url.unstableIds', 'Two different parcels share the id {id}; the register’s ids are not usable.', { id }));
                }
                return;
            }
            const props = Object.assign({}, raw.properties || {}, { parcelId: id, id, parcel_id: id, provenance: 'user-url', estimated: false });
            const feature = { type: 'Feature', properties: props, geometry: raw.geometry };
            if (viewBox && boxesTouch(geometryBbox(raw.geometry), viewBox)) overlapping += 1;
            seen.set(id, feature);
        });
        return { features: Array.from(seen.values()), overlapping, rejected, total: features.length };
    }

    async function fetchJson(url) {
        let response;
        try {
            response = await fetch(url, { headers: { Accept: 'application/geo+json, application/json' } });
        } catch (error) {
            throw new Error(t('groundFallback.url.unreachable', 'The link could not be fetched from this browser ({detail}). The server may block cross-origin requests.', { detail: error && error.message || error }));
        }
        if (!response.ok) {
            const error = new Error(t('groundFallback.url.httpError', 'The link answered HTTP {status}.', { status: response.status }));
            error.status = response.status;
            throw error;
        }
        try {
            return await response.json();
        } catch (_) {
            throw new Error(t('groundFallback.url.notJson', 'The link did not return JSON.'));
        }
    }

    // Fetches a bounded sample for the current view and judges it. Resolves with a source when the
    // sample holds closed polygons that overlap the view; rejects with a sentence otherwise.
    async function probeCustomUrl(rawUrl, viewBox) {
        const url = String(rawUrl || '').trim();
        let parsed;
        try { parsed = new URL(url); } catch (_) { throw new Error(t('groundFallback.url.invalid', 'That is not a complete URL.')); }
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error(t('groundFallback.url.invalid', 'That is not a complete URL.'));
        const kind = detectUrlKind(url);
        const payload = await fetchJson(urlForBox(url, kind, viewBox));
        const sample = validateFeatureCollection(payload, viewBox);
        if (!sample.features.length) {
            throw new Error(sample.rejected
                ? t('groundFallback.url.noPolygons', 'The reply holds {count} feature(s) but none is a closed polygon in longitude/latitude.', { count: sample.rejected })
                : t('groundFallback.url.empty', 'The reply holds no features for this area.'));
        }
        if (!sample.overlapping) {
            throw new Error(t('groundFallback.url.farAway', 'The reply has {count} polygon(s) but none of them is near this map view.', { count: sample.features.length }));
        }
        return customUrlSource(url, kind, kind === 'geojson' ? sample.features : null, sample);
    }

    function customUrlSource(url, kind, wholeCollection, sample) {
        const known = new Map();
        const remember = features => features.forEach(feature => known.set(feature.properties.parcelId, feature));
        if (wholeCollection) remember(wholeCollection);
        return {
            id: `custom-url:${hashString(url)}`,
            kind: 'custom-url',
            url,
            urlKind: kind,
            sample: { total: sample.total, overlapping: sample.overlapping, rejected: sample.rejected },
            label: t('groundFallback.url.sourceLabel', 'Your register link ({host})', { host: (() => { try { return new URL(url).host; } catch (_) { return url; } })() }),
            async fetchCell(cell) {
                const box = parseLatLonBbox(cell && cell.latLonBbox);
                if (!box) throw new Error('Custom register source needs a lat/lng bbox.');
                let features;
                if (wholeCollection) {
                    features = wholeCollection.filter(feature => boxesTouch(geometryBbox(feature.geometry), box));
                } else {
                    const payload = await fetchJson(urlForBox(url, kind, box));
                    features = validateFeatureCollection(payload, null).features;
                    remember(features);
                }
                return { features, returnsWGS84: true };
            },
            fetchByIds(ids) {
                const features = [];
                const absentIds = [];
                ids.forEach(id => {
                    const feature = known.get(id);
                    if (feature) features.push(feature); else absentIds.push(id);
                });
                return { features, absentIds };
            },
            describe() {
                return { kind: 'custom-url', url };
            }
        };
    }

    // ---- restoring a session's choice ----------------------------------------------------------

    // A reload within the same tab keeps the visitor's own register link. A NEW visit attempts the
    // official register.
    function restoreFromSession(cityId) {
        const city = String(cityId || currentCityId());
        if (!city || sources.has(city)) return activeSource(city);
        const raw = readSession(SESSION_KEY_PREFIX + city);
        if (!raw) return null;
        try {
            const descriptor = JSON.parse(raw);
            if (descriptor && descriptor.kind === 'custom-url' && descriptor.url) {
                // The URL was validated when it was entered; trusting it again for the same session
                // is the same trust. A viewport fetch re-validates every reply anyway.
                const kind = detectUrlKind(descriptor.url);
                const source = customUrlSource(descriptor.url, kind, null, { total: 0, overlapping: 0, rejected: 0 });
                sources.set(city, source);
                return source;
            }
        } catch (_) { }
        writeSession(SESSION_KEY_PREFIX + city, null);
        return null;
    }

    // ---- the offer --------------------------------------------------------------------------------

    function isDismissed(city) { return readSession(DISMISSED_KEY_PREFIX + city) === '1'; }
    function dismiss(city) { writeSession(DISMISSED_KEY_PREFIX + city, '1'); }
    function resetDismissal(city) { writeSession(DISMISSED_KEY_PREFIX + String(city || currentCityId()), null); }

    function introVisible() {
        const intro = global.document?.getElementById('site-intro-modal');
        return Boolean(intro && !intro.hidden);
    }

    function presentDialog(context) {
        // Parcel recovery is optional context while analysing OSM blocks. Keep the failure in
        // failures for explicit recovery later, without covering a parcel-independent tool.
        if (global.UrbanBlocksView?.isEnabled() && !context.explicit) {
            pendingDialog = null;
            return null;
        }
        if (introVisible()) {
            pendingDialog = context;
            return null;
        }
        pendingDialog = null;
        return showDialog(context);
    }

    // Called by fetch.js when a viewport request fails. Shows the dialog once per city per session
    // unless the visitor asked again (the refresh button resets the dismissal).
    function onGroundUnavailable(detail = {}) {
        const city = String(detail.city || currentCityId());
        const verdict = classify(detail.error, { parcelSettings: cityParcelSettings(city) });
        const context = { ...detail, city, verdict, explicit: detail.explicit === true };
        failures.set(city, context);
        if (!city || sources.has(city) || openDialog || isDismissed(city)) return false;
        presentDialog(context);
        return true;
    }

    function mapCenter() {
        try {
            const center = global.map && typeof global.map.getCenter === 'function' ? global.map.getCenter() : null;
            if (center && Number.isFinite(center.lat) && Number.isFinite(center.lng)) return { lat: center.lat, lng: center.lng };
        } catch (_) { }
        try {
            const config = global.CityConfigManager && global.CityConfigManager.getCurrentCityConfig
                ? global.CityConfigManager.getCurrentCityConfig() : null;
            const center = config && config.map && config.map.defaultCenter;
            if (Array.isArray(center)) return { lat: Number(center[0]), lng: Number(center[1]) };
        } catch (_) { }
        return { lat: 0, lng: 0 };
    }

    function viewBox() {
        try {
            const bounds = global.map && typeof global.map.getBounds === 'function' ? global.map.getBounds() : null;
            if (bounds) return { west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth() };
        } catch (_) { }
        const center = mapCenter();
        return { west: center.lng - 0.01, south: center.lat - 0.01, east: center.lng + 0.01, north: center.lat + 0.01 };
    }

    // A new parcel source for the city reloads the page, as a city or register change does
    // (parcel-source-settings.js): the parcel repository keys cells and requests in flight by city and
    // cell, so switching in place kept the cells of the source before — the register's, an earlier
    // plan's — and joined its late answers, mixing two parcel sets in one fabric. The choice is in
    // sessionStorage (installSource) and the boot restores it before the first viewport fetch;
    // ?at= keeps the view.
    function reloadWithSource() {
        const url = new URL(global.location.href);
        const center = global.map && typeof global.map.getCenter === 'function' ? global.map.getCenter() : null;
        const zoom = global.map && typeof global.map.getZoom === 'function' ? global.map.getZoom() : null;
        if (center && global.WorldEntryModel) {
            url.searchParams.set('at', global.WorldEntryModel.formatAt({ lat: center.lat, lon: center.lng, zoom: Math.round(zoom) }));
        }
        global.location.replace(url.href);
    }

    async function refetchViewport() {
        if (typeof global.fetchParcelData !== 'function') return;
        try {
            const bounds = global.map && typeof global.map.getBounds === 'function' ? global.map.getBounds() : undefined;
            await global.fetchParcelData(bounds);
            try { global.ParcelPresenter && global.ParcelPresenter.restoreSelectionStyles && global.ParcelPresenter.restoreSelectionStyles(); } catch (_) { }
        } catch (error) {
            console.error('[GroundFallback] parcels still unavailable after the visitor’s choice', error);
        }
    }

    function describeVerdict(city, verdict) {
        const label = cityLabel(city);
        switch (verdict.kind) {
            case 'no-register':
                return t('groundFallback.status.noRegister', 'There is no parcel register on record for {city}.', { city: label });
            case 'temporary':
                return t('groundFallback.status.temporary', 'The parcel register for {city} could not be reached ({detail}). This looks temporary.', { city: label, detail: verdict.detail || '—' });
            case 'refused':
                return t('groundFallback.status.refused', 'The parcel register for {city} refused the request ({detail}).', { city: label, detail: verdict.detail || '—' });
            case 'broken':
                return t('groundFallback.status.broken', 'The parcel register for {city} answered, but not with parcel data ({detail}).', { city: label, detail: verdict.detail || '—' });
            default:
                return t('groundFallback.status.unknown', 'The parcel register for {city} could not be loaded ({detail}).', { city: label, detail: verdict.detail || '—' });
        }
    }

    // ---- the dialog -------------------------------------------------------------------------------

    // The recovery dialog: the shared one (js/ui/dialogs.js) with `ground-fallback-dialog` as its
    // identity class, on the ordinary dialog rung (the introduction sits above it). The close
    // button, Escape (the modal router) and the backdrop all dismiss the offer for the session;
    // choosing an option closes it without dismissing.
    function showDialog(context) {
        const { city, verdict } = context;
        const statusLine = el('p', `ground-fallback-status ground-fallback-status--${verdict.kind}`, context.message || describeVerdict(city, verdict));
        const body = el('div', 'ground-fallback-body');
        const CHOSEN = 'chosen';

        const dialogApi = global.CbDialog.open({
            title: t('groundFallback.title', 'No parcel register could be loaded here'),
            size: 'md',
            className: 'ground-fallback-dialog',
            overlayClassName: 'ground-fallback-overlay',
            closeLabel: t('modal.common.close', 'Close'),
            autofocus: false,
            onClose: result => {
                document.removeEventListener('keydown', onKeydown, true);
                if (openDialog === dialogApi.overlay) openDialog = null;
                document.body.classList.remove('ground-fallback-open');
                if (result !== CHOSEN) {
                    dismiss(city);
                    global.ParcelSourceSettings?.reportFailure?.(global, context.message || describeVerdict(city, verdict));
                    status(t('groundFallback.status.dismissed', 'Parcel register unavailable. Open the parcel options to choose how to continue.'));
                }
            }
        });
        if (!dialogApi) return null;
        dialogApi.body.appendChild(statusLine);
        dialogApi.body.appendChild(body);
        const closeBtn = dialogApi.header && dialogApi.header.querySelector('.close-circle-btn');
        if (closeBtn) closeBtn.classList.add('ground-fallback-close');

        // A choice was made: close without dismissing the offer.
        function close() { dialogApi.close(CHOSEN); }
        // Not now / the close button / Escape / the backdrop: the offer is dismissed for the session.
        function dismissAndClose() { dialogApi.close(null); }

        function onKeydown(event) {
            if (introVisible()) return;
            // Escape belongs to the modal router (it closes the dialog); Tab stays inside it.
            if (event.key === 'Escape' || event.key === 'Tab') return;
            // Drawing hotkeys listen on document; typing a URL must not start drawing a road.
            event.stopPropagation();
        }
        document.addEventListener('keydown', onKeydown, true);

        // One choice: a cb-option row (css/primitives.css) with its icon, title and description.
        function option(key, icon, titleText, descriptionText, onClick, options = {}) {
            const button = el('button', 'cb-option ground-fallback-option');
            button.type = 'button';
            button.dataset.option = key;
            const glyph = el('i', `cb-option__icon fa-solid ${icon}`);
            glyph.setAttribute('aria-hidden', 'true');
            const text = el('span', 'cb-option__text');
            text.appendChild(el('span', 'cb-option__title', titleText));
            text.appendChild(el('span', 'cb-option__desc', descriptionText));
            button.appendChild(glyph);
            button.appendChild(text);
            if (options.disabled) {
                button.disabled = true;
            } else {
                button.addEventListener('click', onClick);
            }
            return button;
        }

        function renderOptions() {
            body.replaceChildren();
            const list = el('div', 'ground-fallback-options');
            if (verdict.retryable) {
                list.appendChild(option('retry', 'fa-rotate-right',
                    t('groundFallback.options.retry.title', 'Retry the official register'),
                    t('groundFallback.options.retry.desc', 'Ask the register again. Right for a network hiccup or a server that was briefly down.'),
                    async () => {
                        close();
                        status(t('groundFallback.status.retrying', 'Retrying the parcel register…'));
                        resetDismissal(city);
                        await refetchViewport();
                    }));
            }
            list.appendChild(option('url', 'fa-link',
                t('groundFallback.options.url.title', 'Enter your own link to a register'),
                t('groundFallback.options.url.desc', 'A GeoJSON file, an OGC API Features collection, or an ArcGIS FeatureServer layer with parcel polygons.'),
                renderUrl));
            list.appendChild(option('ocr', 'fa-satellite',
                t('groundFallback.options.ocr.title', 'Estimate parcel boundaries from satellite imagery'),
                t('groundFallback.options.ocr.desc', 'Infer likely boundaries from visible features. Best effort: results may be incomplete or wrong and do not establish legal boundaries.'),
                renderOcr));
            // The Schelling plan is not ground: it is a layer drawn over whatever ground is here, and
            // what is proposed from it stands on open ground where there is no register.
            list.appendChild(option('schelling', 'fa-border-all',
                t('groundFallback.options.schelling.title', 'Use the Schelling plan'),
                t('groundFallback.options.schelling.desc', 'Streets, blocks and plots anyone can derive on their own, drawn over the map. Its roads can be proposed here on open ground.'),
                () => {
                    close();
                    global.SchellingLayer.setEnabled(true);
                    status(t('groundFallback.status.schellingShown', 'The Schelling plan is drawn over the map. Its settings and Propose are in its panel on the map.'));
                }));
            body.appendChild(list);
            const foot = el('div', 'ground-fallback-foot');
            const laterBtn = el('button', 'btn', t('groundFallback.options.later', 'Not now'));
            laterBtn.type = 'button';
            laterBtn.addEventListener('click', dismissAndClose);
            foot.appendChild(laterBtn);
            body.appendChild(foot);
        }

        function backButton() {
            const back = el('button', 'btn ground-fallback-back', t('groundFallback.back', '← Back to the options'));
            back.type = 'button';
            back.addEventListener('click', renderOptions);
            return back;
        }

        // -- option 2: a link --
        function renderUrl() {
            body.replaceChildren();
            const section = el('div', 'ground-fallback-section');
            section.appendChild(el('h4', null, t('groundFallback.url.heading', 'Your link to a parcel register')));
            section.appendChild(el('p', 'ground-fallback-help', t('groundFallback.url.help', 'Paste a URL that returns parcel polygons as GeoJSON. Accepted shapes: a GeoJSON FeatureCollection (optionally with a {bbox} placeholder for west,south,east,north), an OGC API Features …/collections/{id}/items URL, or an ArcGIS …/FeatureServer/{n} layer. A bounded sample for the current view is fetched and checked before anything is drawn.')));
            const input = el('input', 'ground-fallback-input');
            input.type = 'url';
            input.placeholder = 'https://…/parcels.geojson';
            input.setAttribute('aria-label', t('groundFallback.url.heading', 'Your link to a parcel register'));
            const existing = activeSource(city);
            if (existing && existing.kind === 'custom-url') input.value = existing.url;
            section.appendChild(input);
            const result = el('p', 'ground-fallback-result');
            section.appendChild(result);
            const actions = el('div', 'ground-fallback-actions');
            const check = el('button', 'btn btn-primary btn-block', t('groundFallback.url.check', 'Check and use this link'));
            check.type = 'button';
            actions.appendChild(backButton());
            actions.appendChild(check);
            section.appendChild(actions);
            body.appendChild(section);

            async function submit() {
                const url = input.value.trim();
                if (!url) { result.textContent = t('groundFallback.url.invalid', 'That is not a complete URL.'); return; }
                check.disabled = true;
                result.className = 'ground-fallback-result';
                result.textContent = t('groundFallback.url.checking', 'Fetching a sample for this view…');
                try {
                    const source = await probeCustomUrl(url, viewBox());
                    result.className = 'ground-fallback-result is-ok';
                    result.textContent = t('groundFallback.url.accepted', 'Accepted: {overlapping} of {total} polygons in the sample overlap this view{rejected}.', {
                        overlapping: source.sample.overlapping,
                        total: source.sample.total,
                        rejected: source.sample.rejected ? t('groundFallback.url.rejectedSuffix', '; {count} feature(s) were not closed polygons and were skipped', { count: source.sample.rejected }) : ''
                    });
                    installSource(city, source);
                    resetDismissal(city);
                    status(t('groundFallback.status.urlInstalled', 'Loading parcels from your register link for this session.'));
                    close();
                    reloadWithSource();
                } catch (error) {
                    result.className = 'ground-fallback-result is-error';
                    result.textContent = String(error && error.message || error);
                    check.disabled = false;
                }
            }
            check.addEventListener('click', submit);
            input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); submit(); } });
            requestAnimationFrame(() => input.focus({ preventScroll: true }));
        }

        // -- option 3: satellite boundary recognition (OCR working name) --
        function renderOcr() {
            body.replaceChildren();
            const section = el('div', 'ground-fallback-section');
            section.appendChild(el('h4', null, t('groundFallback.options.ocr.title', 'Estimate parcel boundaries from satellite imagery')));
            const jobs = global.ParcelOcrJobs;
            if (jobs && typeof jobs.start === 'function') {
                section.appendChild(el('p', 'ground-fallback-help', t('groundFallback.ocr.help', 'Estimate likely parcel boundaries from satellite imagery of this area. The job runs in the background. Results may be incomplete or wrong and need review; imagery does not establish legal boundaries.')));
                const actions = el('div', 'ground-fallback-actions');
                const start = el('button', 'btn btn-primary btn-block', t('groundFallback.ocr.start', 'Start boundary recognition'));
                start.type = 'button';
                start.addEventListener('click', async () => {
                    start.disabled = true;
                    try {
                        await jobs.start({ city, bounds: viewBox(), onReady: () => refetchViewport() });
                        close();
                    } catch (error) {
                        start.disabled = false;
                        section.appendChild(el('p', 'ground-fallback-result is-error', String(error && error.message || error)));
                    }
                });
                actions.appendChild(backButton());
                actions.appendChild(start);
                section.appendChild(actions);
            } else {
                section.appendChild(el('p', 'ground-fallback-help', t('groundFallback.ocr.unavailable', 'Parcel-boundary recognition from satellite imagery is not available from this screen yet. Any estimates will be best effort and need review; imagery does not establish legal boundaries.')));
                const actions = el('div', 'ground-fallback-actions');
                actions.appendChild(backButton());
                section.appendChild(actions);
            }
            body.appendChild(section);
        }

        renderOptions();
        document.body.classList.add('ground-fallback-open');
        openDialog = dialogApi.overlay;
        requestAnimationFrame(() => {
            const first = body.querySelector('button:not([disabled])');
            if (first) first.focus({ preventScroll: true });
        });
        return dialogApi.overlay;
    }

    // Lets the visitor reopen the screen on purpose (sidebar/refresh), bypassing the dismissal.
    function openOptions(detail = {}) {
        const city = String(detail.city || currentCityId());
        if (openDialog) return openDialog;
        resetDismissal(city);
        const context = { ...failures.get(city), ...detail, city, explicit: true };
        context.verdict = detail.verdict || classify(context.error || null, { parcelSettings: cityParcelSettings(city) });
        return presentDialog(context);
    }

    const api = {
        classify,
        detectUrlKind,
        urlForBox,
        validateFeatureCollection,
        externalFeatureId,
        activeSource,
        installSource,
        clearSource,
        probeCustomUrl,
        restoreFromSession,
        onGroundUnavailable,
        openOptions,
        resetDismissal,
        isOpen: () => Boolean(openDialog)
    };

    global.ParcelGroundFallback = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;

    // A reload within the tab keeps whatever the visitor chose, before the first viewport fetch.
    try { restoreFromSession(currentCityId()); } catch (_) { }
    if (global && typeof global.addEventListener === 'function') {
        global.addEventListener('siteintro:closed', () => {
            if (pendingDialog && pendingDialog.city === currentCityId() && !sources.has(pendingDialog.city)) {
                presentDialog(pendingDialog);
            }
        });
        global.addEventListener('cityChanged', () => { try { restoreFromSession(currentCityId()); } catch (_) { } });
    }
})(typeof window !== 'undefined' ? window : globalThis);
