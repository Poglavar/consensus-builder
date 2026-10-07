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
//   4. Schelling    — a parcel plan everyone can derive independently. One algorithm today,
//                     "Meridians and parallels" (schelling-grid.js); elevation contours planned.
//
// Options 2 and 4 become a parcel SOURCE for the city for this browser session: fetch.js asks
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
    //   { id, kind: 'schelling' | 'custom-url', label, fetchCell({ latLonBbox, bbox, city }),
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

    function markRoads(features) {
        if (typeof global.addRoadParcel !== 'function') return;
        features.forEach(feature => {
            const props = feature && feature.properties;
            if (props && props.isRoad === true && props.parcelId) {
                try { global.addRoadParcel(props.parcelId); } catch (_) { }
            }
        });
    }

    function schellingSource(params) {
        const grid = global.SchellingGrid;
        if (!grid) throw new Error('SchellingGrid is unavailable.');
        const plan = grid.planFor(params);
        return {
            id: `schelling:${plan.code}`,
            kind: 'schelling',
            algorithm: plan.algorithm,
            plan,
            label: t('groundFallback.schelling.sourceLabel', 'Schelling plan: meridians and parallels ({code})', { code: plan.code }),
            fetchCell(cell) {
                const box = parseLatLonBbox(cell && cell.latLonBbox);
                if (!box) throw new Error('Schelling source needs a lat/lng bbox.');
                const features = grid.featuresInBbox(plan, [box.west, box.south, box.east, box.north]);
                markRoads(features);
                return { features, returnsWGS84: true };
            },
            fetchByIds(ids) {
                const features = [];
                const absentIds = [];
                ids.forEach(id => {
                    const feature = grid.featureForId(plan, id);
                    if (feature) features.push(feature); else absentIds.push(id);
                });
                markRoads(features);
                return { features, absentIds };
            },
            describe() {
                return {
                    kind: 'schelling',
                    algorithm: plan.algorithm,
                    params: {
                        lat: plan.refLat,
                        arterialSpacingM: plan.arterialSpacingM,
                        arterialWidthM: plan.arterialWidthM,
                        streetWidthM: plan.streetWidthM,
                        targetBlockM: plan.targetBlockM
                    }
                };
            }
        };
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

    // A reload within the same tab keeps the plan: proposals drawn on Schelling parcels name those
    // ids, and a reload that forgot the plan would strand them. A NEW visit attempts the register.
    function restoreFromSession(cityId) {
        const city = String(cityId || currentCityId());
        if (!city || sources.has(city)) return activeSource(city);
        const raw = readSession(SESSION_KEY_PREFIX + city);
        if (!raw) return null;
        try {
            const descriptor = JSON.parse(raw);
            if (descriptor && descriptor.kind === 'schelling' && descriptor.params) {
                const source = schellingSource(descriptor.params);
                sources.set(city, source);
                return source;
            }
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

    function showDialog(context) {
        const { city, verdict } = context;
        const overlay = el('div', 'cb-confirm-overlay ground-fallback-overlay');
        const dialog = el('div', 'cb-confirm-dialog ground-fallback-dialog');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        overlay.appendChild(dialog);

        const header = el('div', 'ground-fallback-header');
        const title = el('h3', 'ground-fallback-title', t('groundFallback.title', 'No parcel register could be loaded here'));
        const closeBtn = el('button', 'close-circle-btn ground-fallback-close', '×');
        closeBtn.type = 'button';
        closeBtn.setAttribute('aria-label', t('modal.common.close', 'Close'));
        header.appendChild(title);
        header.appendChild(closeBtn);
        dialog.appendChild(header);

        const statusLine = el('p', `ground-fallback-status ground-fallback-status--${verdict.kind}`, context.message || describeVerdict(city, verdict));
        dialog.appendChild(statusLine);

        const body = el('div', 'ground-fallback-body');
        dialog.appendChild(body);

        function close() {
            document.removeEventListener('keydown', onKeydown, true);
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            if (openDialog === overlay) openDialog = null;
            document.body.classList.remove('ground-fallback-open');
        }

        function dismissAndClose() {
            dismiss(city);
            close();
            global.ParcelSourceSettings?.reportFailure?.(global, context.message || describeVerdict(city, verdict));
            status(t('groundFallback.status.dismissed', 'Parcel register unavailable. Open the parcel options to choose how to continue.'));
        }

        function onKeydown(event) {
            if (introVisible()) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                dismissAndClose();
                return;
            }
            // Drawing hotkeys listen on document; typing a URL must not start drawing a road.
            event.stopPropagation();
        }
        document.addEventListener('keydown', onKeydown, true);
        closeBtn.addEventListener('click', dismissAndClose);
        overlay.addEventListener('click', event => { if (event.target === overlay) dismissAndClose(); });

        function option(key, titleText, descriptionText, onClick, options = {}) {
            const button = el('button', `ground-fallback-option${options.disabled ? ' is-disabled' : ''}`);
            button.type = 'button';
            button.dataset.option = key;
            button.appendChild(el('span', 'ground-fallback-option-title', titleText));
            button.appendChild(el('span', 'ground-fallback-option-desc', descriptionText));
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
                list.appendChild(option('retry',
                    t('groundFallback.options.retry.title', 'Retry the official register'),
                    t('groundFallback.options.retry.desc', 'Ask the register again. Right for a network hiccup or a server that was briefly down.'),
                    async () => {
                        close();
                        status(t('groundFallback.status.retrying', 'Retrying the parcel register…'));
                        resetDismissal(city);
                        await refetchViewport();
                    }));
            }
            list.appendChild(option('url',
                t('groundFallback.options.url.title', 'Enter your own link to a register'),
                t('groundFallback.options.url.desc', 'A GeoJSON file, an OGC API Features collection, or an ArcGIS FeatureServer layer with parcel polygons.'),
                renderUrl));
            list.appendChild(option('ocr',
                t('groundFallback.options.ocr.title', 'Estimate parcel boundaries from satellite imagery'),
                t('groundFallback.options.ocr.desc', 'Infer likely boundaries from visible features. Best effort: results may be incomplete or wrong and do not establish legal boundaries.'),
                renderOcr));
            list.appendChild(option('schelling',
                t('groundFallback.options.schelling.title', 'Apply a Schelling point algorithm'),
                t('groundFallback.options.schelling.desc', 'A parcel plan anyone can derive on their own, so everyone arrives at the same one.'),
                renderSchelling));
            body.appendChild(list);
            const foot = el('div', 'ground-fallback-foot');
            const laterBtn = el('button', 'btn btn-secondary', t('groundFallback.options.later', 'Not now'));
            laterBtn.type = 'button';
            laterBtn.addEventListener('click', dismissAndClose);
            foot.appendChild(laterBtn);
            body.appendChild(foot);
        }

        function backButton() {
            const back = el('button', 'btn btn-secondary ground-fallback-back', t('groundFallback.back', '← Back to the options'));
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
            const check = el('button', 'btn btn-action', t('groundFallback.url.check', 'Check and use this link'));
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
                    setTimeout(() => { close(); refetchViewport(); }, 600);
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
                const start = el('button', 'btn btn-action', t('groundFallback.ocr.start', 'Start boundary recognition'));
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

        // -- option 4: Schelling --
        function renderSchelling() {
            body.replaceChildren();
            const grid = global.SchellingGrid;
            const section = el('div', 'ground-fallback-section');
            section.appendChild(el('h4', null, t('groundFallback.schelling.heading', 'A plan everyone can agree on')));
            section.appendChild(el('p', 'ground-fallback-help', t('groundFallback.schelling.intro', 'A Schelling point is a choice people make independently and still agree on, because every input is already common knowledge. The plan below needs only a GPS fix and arithmetic; two strangers get identical parcels.')));

            const picker = el('div', 'ground-fallback-algorithms');
            const meridians = el('label', 'ground-fallback-algorithm is-selected');
            const meridiansRadio = document.createElement('input');
            meridiansRadio.type = 'radio'; meridiansRadio.name = 'schelling-algorithm'; meridiansRadio.value = 'meridians-parallels'; meridiansRadio.checked = true;
            meridians.appendChild(meridiansRadio);
            const meridiansText = el('span');
            meridiansText.appendChild(el('strong', null, t('groundFallback.schelling.meridians.title', 'Meridians and parallels')));
            meridiansText.appendChild(el('small', null, t('groundFallback.schelling.meridians.desc', 'Arterial roads on the graticule about 1 km apart, blocks by integer division.')));
            meridians.appendChild(meridiansText);
            picker.appendChild(meridians);
            const contours = el('label', 'ground-fallback-algorithm is-disabled');
            const contoursRadio = document.createElement('input');
            contoursRadio.type = 'radio'; contoursRadio.name = 'schelling-algorithm'; contoursRadio.value = 'contours'; contoursRadio.disabled = true;
            contours.appendChild(contoursRadio);
            const contoursText = el('span');
            contoursText.appendChild(el('strong', null, t('groundFallback.schelling.contours.title', 'Elevation contours (isohypses)')));
            contoursText.appendChild(el('small', null, t('groundFallback.schelling.contours.desc', 'Streets along contour lines, blocks between them. Planned; needs a terrain source.')));
            contours.appendChild(contoursText);
            picker.appendChild(contours);
            section.appendChild(picker);

            if (!grid) {
                section.appendChild(el('p', 'ground-fallback-result is-error', 'SchellingGrid is unavailable.'));
                const actions = el('div', 'ground-fallback-actions');
                actions.appendChild(backButton());
                section.appendChild(actions);
                body.appendChild(section);
                return;
            }

            const center = mapCenter();
            const params = Object.assign({ lat: center.lat }, grid.DEFAULTS);
            const explainer = el('div', 'ground-fallback-explainer');
            const preview = el('div', 'ground-fallback-preview');
            const result = el('p', 'ground-fallback-result');

            const details = document.createElement('details');
            details.className = 'ground-fallback-params';
            const summary = el('summary', null, t('groundFallback.schelling.adjust', 'Adjust the assumptions'));
            details.appendChild(summary);
            const fields = [
                ['arterialSpacingM', t('groundFallback.schelling.params.arterialSpacing', 'Arterial spacing (m)')],
                ['arterialWidthM', t('groundFallback.schelling.params.arterialWidth', 'Arterial width (m)')],
                ['streetWidthM', t('groundFallback.schelling.params.streetWidth', 'Local street width (m)')],
                ['targetBlockM', t('groundFallback.schelling.params.targetBlock', 'Target block face (m)')]
            ];
            const inputs = {};
            fields.forEach(([name, labelText]) => {
                const row = el('label', 'ground-fallback-param');
                row.appendChild(el('span', null, labelText));
                const input = document.createElement('input');
                input.type = 'number'; input.min = '1'; input.step = '1'; input.value = String(params[name]);
                input.dataset.param = name;
                input.addEventListener('input', recompute);
                row.appendChild(input);
                inputs[name] = input;
                details.appendChild(row);
            });

            let plan = null;
            function recompute() {
                fields.forEach(([name]) => { params[name] = Number(inputs[name].value); });
                try {
                    plan = grid.planFor(params);
                    result.className = 'ground-fallback-result';
                    result.textContent = '';
                    renderExplainer(plan);
                    renderPreview(plan);
                    apply.disabled = false;
                } catch (error) {
                    plan = null;
                    apply.disabled = true;
                    result.className = 'ground-fallback-result is-error';
                    result.textContent = String(error && error.message || error);
                }
            }

            function renderExplainer(current) {
                const d = grid.describe(current, center);
                explainer.replaceChildren();
                const paragraphs = [
                    t('groundFallback.schelling.explain.angel', 'Shlomo Angel and colleagues (Making Room for a Planet of Cities, 2011) argue that a growing city should fix its arterial roads before the land is built on: about {arterialWidth} m wide and about {arterialSpacing} m apart, so that every point is within a ten-minute walk of a road that can carry public transport. Smaller streets are left to fill in the kilometre squares between them.', { arterialWidth: d.arterialWidthM, arterialSpacing: current.arterialSpacingM }),
                    t('groundFallback.schelling.explain.graticule', 'Here the arterials follow the graticule, counted from the Equator and Greenwich. At the {refLat}th parallel one second of latitude is {mLat} m and one second of longitude is {mLon} m, so the closest round steps are every {stepLat}″ of latitude ({spacingLat} m) and every {stepLon}″ of longitude ({spacingLon} m).', { refLat: d.refLat, mLat: d.metersPerArcsecondLat, mLon: d.metersPerArcsecondLon, stepLat: d.arterialStepLatSec, spacingLat: d.arterialSpacingLatM, stepLon: d.arterialStepLonSec, spacingLon: d.arterialSpacingLonM }),
                    t('groundFallback.schelling.explain.blocks', 'Each superblock is divided {nLon} × {nLat} by local streets {streetWidth} m wide, which gives cells of {cellLon} × {cellLat} m and an optimal block of {blockWidth} × {blockDepth} m ({blockArea} m², {blockHa} ha), {count} blocks to the superblock.', { nLon: d.nLon, nLat: d.nLat, streetWidth: d.streetWidthM, cellLon: d.cellLonM, cellLat: d.cellLatM, blockWidth: d.blockWidthM, blockDepth: d.blockDepthM, blockArea: d.blockAreaM2, blockHa: d.blockAreaHa, count: d.blocksPerSuperblock })
                ];
                if (d.nearest) {
                    paragraphs.push(t('groundFallback.schelling.explain.nearest', 'The arterials nearest the centre of this map lie on the parallel {latLine} ({latDistance} m away) and the meridian {lonLine} ({lonDistance} m away). Plan code {code}.', {
                        latLine: d.nearest.latText, latDistance: Math.round(d.nearest.latDistanceM),
                        lonLine: d.nearest.lonText, lonDistance: Math.round(d.nearest.lonDistanceM), code: d.code
                    }));
                }
                paragraphs.forEach(text => explainer.appendChild(el('p', null, text)));
            }

            // One superblock, to scale: arterials on the edge, local streets inside, blocks between.
            function renderPreview(current) {
                const nLon = current.subdivision.nLon;
                const nLat = current.subdivision.nLat;
                const widthM = current.arterial.spacingLonM;
                const heightM = current.arterial.spacingLatM;
                const scale = 220 / Math.max(widthM, heightM);
                const svgNs = 'http://www.w3.org/2000/svg';
                const svg = document.createElementNS(svgNs, 'svg');
                const W = widthM * scale, H = heightM * scale;
                svg.setAttribute('viewBox', `0 0 ${W.toFixed(1)} ${H.toFixed(1)}`);
                svg.setAttribute('width', W.toFixed(0));
                svg.setAttribute('height', H.toFixed(0));
                svg.setAttribute('role', 'img');
                svg.setAttribute('aria-label', t('groundFallback.schelling.previewAlt', 'One superblock of the plan, to scale'));
                const ground = document.createElementNS(svgNs, 'rect');
                ground.setAttribute('x', '0'); ground.setAttribute('y', '0'); ground.setAttribute('width', W); ground.setAttribute('height', H);
                ground.setAttribute('class', 'ground-fallback-preview-street');
                svg.appendChild(ground);
                const cellW = W / nLon, cellH = H / nLat;
                const halfArterial = current.arterialWidthM / 2 * scale;
                const halfStreet = current.streetWidthM / 2 * scale;
                for (let j = 0; j < nLat; j += 1) {
                    for (let i = 0; i < nLon; i += 1) {
                        const west = i * cellW + (i === 0 ? halfArterial : halfStreet);
                        const east = (i + 1) * cellW - (i + 1 === nLon ? halfArterial : halfStreet);
                        // SVG y grows downwards; row 0 is the southern row, drawn at the bottom.
                        const south = H - (j * cellH + (j === 0 ? halfArterial : halfStreet));
                        const north = H - ((j + 1) * cellH - (j + 1 === nLat ? halfArterial : halfStreet));
                        const block = document.createElementNS(svgNs, 'rect');
                        block.setAttribute('x', west.toFixed(2)); block.setAttribute('y', north.toFixed(2));
                        block.setAttribute('width', Math.max(0, east - west).toFixed(2)); block.setAttribute('height', Math.max(0, south - north).toFixed(2));
                        block.setAttribute('class', 'ground-fallback-preview-block');
                        svg.appendChild(block);
                    }
                }
                preview.replaceChildren(svg, el('small', null, t('groundFallback.schelling.previewCaption', 'One superblock, {width} × {height} m, to scale. Dark: streets. Light: blocks.', { width: Math.round(widthM), height: Math.round(heightM) })));
            }

            const actions = el('div', 'ground-fallback-actions');
            const apply = el('button', 'btn btn-action', t('groundFallback.schelling.apply', 'Draw this plan here'));
            apply.type = 'button';
            apply.addEventListener('click', async () => {
                if (!plan) return;
                apply.disabled = true;
                try {
                    const source = schellingSource(params);
                    installSource(city, source);
                    resetDismissal(city);
                    close();
                    status(t('groundFallback.status.schellingInstalled', 'Drawing the Schelling plan {code} in memory for this session.', { code: source.plan.code }));
                    await refetchViewport();
                } catch (error) {
                    apply.disabled = false;
                    result.className = 'ground-fallback-result is-error';
                    result.textContent = String(error && error.message || error);
                }
            });
            actions.appendChild(backButton());
            actions.appendChild(apply);

            section.appendChild(el('div', 'ground-fallback-schelling-grid')).append(explainer, preview);
            section.appendChild(details);
            section.appendChild(result);
            section.appendChild(el('p', 'ground-fallback-caveat', t('groundFallback.schelling.caveat', 'This is an estimate for planning, not a cadastre: the parcels live in this browser for this session and carry provenance “schelling-point”. Ownership and publishing need a real register.')));
            section.appendChild(actions);
            body.appendChild(section);
            recompute();
        }

        renderOptions();
        document.body.appendChild(overlay);
        document.body.classList.add('ground-fallback-open');
        openDialog = overlay;
        requestAnimationFrame(() => {
            const first = body.querySelector('button:not([disabled])');
            if (first) first.focus({ preventScroll: true });
        });
        return overlay;
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
        schellingSource,
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
