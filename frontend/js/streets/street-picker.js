// The street picker (docs/vocabulary.md: Street, Segment, Side): "Street here" in the click stack
// opens a small dialog naming the street at the click, its segments ("Between A Road and B Road")
// and the whole street, and the sides by compass. "Select parcels" puts the parcels whose boundary
// runs along the chosen part on the chosen side into the ordinary parcel selection, the same path the
// chat agent uses (ChatNavigation.apply), so the plan, agreement and street-vote flows take them
// unchanged. The last pick is kept for the street vote to name (lastPick); its street reference lists
// the corner plots selected (plots also along another road at a part's end). Geometry is the pure
// streets/street-segments.js; the street comes from GET /streets/segments.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root.document !== 'undefined') root.StreetPicker = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const streets = () => root.StreetSegments || (typeof require === 'function' ? require('./street-segments.js') : null);
    const log = (...args) => console.info(`[${new Date().toISOString()}] [StreetPicker]`, ...args);
    const t = (key, fallback, params) => {
        const value = root.i18n?.t?.(key, params || {});
        if (typeof value === 'string' && value && value !== key) return value;
        return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (params && name in params ? params[name] : match));
    };

    let last = null;

    // ── words (pure, for tests) ────────────────────────────────────────────────────────────────

    // Literal keys, so the locale coverage check sees each one.
    function endLabel(end, translate = t) {
        switch (end.kind) {
            case 'branch':
                if (end.names && end.names.length) return end.names.join(' / ');
                return end.own ? translate('streets.end.fork', 'the fork') : translate('streets.end.sideRoad', 'a side road');
            case 'end': return end.loop ? translate('streets.end.loop', 'the loop') : translate('streets.end.end', 'its end');
            case 'bend': return translate('streets.end.bend', 'the bend');
            case 'bridge-start':
            case 'bridge-end': return translate('streets.end.bridge', 'the bridge');
            case 'overpass': return end.railway ? translate('streets.end.railwayBridge', 'the railway bridge') : end.name || translate('streets.end.overpass', 'the bridge over it');
            case 'gap-start':
            case 'gap-end': return translate('streets.end.gap', 'the gap in the buildings');
            case 'number': return translate('streets.end.number', 'No. {{number}}', { number: end.houseNumber });
            default: return end.kind;
        }
    }
    function segmentLabel(segment, translate = t) {
        return translate('streets.picker.between', 'Between {{from}} and {{to}}', { from: endLabel(segment.from, translate), to: endLabel(segment.to, translate) });
    }
    const COMPASS_KEYS = {
        north: () => t('streets.side.north', 'North side'), northeast: () => t('streets.side.northeast', 'Northeast side'),
        east: () => t('streets.side.east', 'East side'), southeast: () => t('streets.side.southeast', 'Southeast side'),
        south: () => t('streets.side.south', 'South side'), southwest: () => t('streets.side.southwest', 'Southwest side'),
        west: () => t('streets.side.west', 'West side'), northwest: () => t('streets.side.northwest', 'Northwest side')
    };
    // A recorded street reference in words: "Hughes Road · Between A Road and B Road · North side".
    function referenceLabel(reference, translate = t) {
        const parts = [reference.name];
        if (reference.part === 'segment' && reference.from && reference.to) parts.push(segmentLabel(reference, translate));
        if (reference.side === 'both') parts.push(translate('streets.side.both', 'Both sides'));
        else if (reference.part === 'segment' && reference.from && reference.to) {
            const compass = streets().sideCompass([reference.from.point, reference.to.point])[reference.side];
            parts.push(COMPASS_KEYS[compass]());
        } else parts.push(reference.side === 'left' ? translate('streets.side.left', 'Left side') : translate('streets.side.right', 'Right side'));
        return parts.join(' · ');
    }
    // The segment a click is nearest to (vertex distance in degrees, scaled for latitude).
    function nearestSegment(segments, point) {
        const k = Math.cos(point[1] * Math.PI / 180);
        let best = 0, bestD = Infinity;
        segments.forEach((segment, index) => {
            for (const [lng, lat] of segment.coordinates) {
                const d = Math.hypot((lng - point[0]) * k, lat - point[1]);
                if (d < bestD) { bestD = d; best = index; }
            }
        });
        return best;
    }

    // ── browser ────────────────────────────────────────────────────────────────────────────────

    function backendBase() {
        return typeof root.getBackendBase === 'function' ? String(root.getBackendBase() || '').replace(/\/$/, '') : '';
    }
    function city() { return root.CityConfigManager?.getCurrentCityId?.() || root.currentCityId || null; }

    async function readStreet(point) {
        const response = await fetch(`${backendBase()}/streets/segments?point=${point[0].toFixed(7)},${point[1].toFixed(7)}`);
        const body = await response.json().catch(() => ({}));
        if (response.status === 404) throw Object.assign(new Error(t('streets.picker.notFound', 'No named street runs here. Click on the street itself.')), { expected: true });
        if (!response.ok) throw new Error(body.error || t('streets.picker.failed', 'The street could not be read.'));
        return body;
    }

    function html(strings, ...values) {
        const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        return strings.reduce((out, part, i) => out + part + (i < values.length ? esc(values[i]) : ''), '');
    }

    // The plots along `parts` on `side` from the live parcels: loads the ground around them first.
    // `corners`: the plots whose boundary also runs along another road at a part's end, with its names.
    async function plotsAlong(parts, side) {
        const all = parts.flatMap(part => part.coordinates);
        const pad = 0.0006;
        const lngs = all.map(c => c[0]), lats = all.map(c => c[1]);
        const bounds = root.L.latLngBounds([Math.min(...lats) - pad, Math.min(...lngs) - pad], [Math.max(...lats) + pad, Math.max(...lngs) + pad]);
        const repository = root.CadastralParcelRepository, ownCity = city();
        const [loaded, roads] = await Promise.all([
            repository.ensureBounds(bounds, { city: ownCity }),
            typeof repository.ensureRoadIds === 'function' ? repository.ensureRoadIds(bounds, { city: ownCity }) : { status: 'unsupported', ids: [] }
        ]);
        if (city() !== ownCity) throw new Error(t('streets.picker.cityChanged', 'The city changed.'));
        const fabric = root.LiveParcelFabric;
        const parcels = (fabric.peekBounds(bounds) || []).map(feature => ({ id: String(fabric.featureId(feature) ?? ''), geometry: feature.geometry })).filter(row => row.id && row.geometry);
        const transparent = new Set([...(roads.ids || []).map(String), ...parcels.map(row => row.id).filter(id => typeof root.isRoadParcel === 'function' && root.isRoadParcel(id))]);
        const ids = [], corners = new Map();
        for (const part of parts) {
            for (const plot of streets().plotsAlong({ coordinates: part.coordinates, parcels, side, transparent, arms: streets().armsOf(part) })) {
                if (!ids.includes(plot.id)) ids.push(plot.id);
                if (plot.corner) corners.set(plot.id, [...new Set([...(corners.get(plot.id) || []), ...plot.corner.streets])]);
            }
        }
        log(`${ids.length} parcels along ${parts.length} part(s), side ${side}, ${corners.size} on a corner; ${parcels.length} parcels read (${loaded.status})`);
        return { ids, corners, complete: loaded.status === 'ready' };
    }

    /** Opens the picker for the street at a click: { lat, lng }. `control` shows the busy spinner. */
    async function open(latlng, { control = null } = {}) {
        const point = [Number(latlng.lng), Number(latlng.lat)];
        const busy = control && root.BusyControl ? root.BusyControl.track(control, () => readStreet(point)) : readStreet(point);
        let found;
        try { found = await busy; } catch (error) {
            if (!error.expected) console.error(`[${new Date().toISOString()}] [StreetPicker] reading the street failed`, error);
            root.showEphemeralMessage?.(error.message, 6000, error.expected ? 'warning' : 'error');
            return null;
        }
        const S = streets();
        const segments = found.segments;
        if (!segments.length) { root.showEphemeralMessage?.(t('streets.picker.notFound', 'No named street runs here. Click on the street itself.'), 6000, 'warning'); return null; }
        const chosen = nearestSegment(segments, point);
        const fmt = metres => (root.CbFormat ? root.CbFormat.formatLength(metres, { maxFractionDigits: 0 }) : `${Math.round(metres)} m`);
        const official = found.street.official;
        const facts = [fmt(found.street.lengthM),
            official ? t('streets.picker.official', 'Official id {{id}}', { id: official.id }) : t('streets.picker.osmOnly', 'Source: OpenStreetMap'),
            ...(found.street.complete ? [] : [t('streets.picker.partial', 'Only the part near here was read')])].join(' · ');
        const partRows = segments.map((segment, index) => html`<label class="street-picker__choice"><input type="radio" name="street-part" value="${index}"${index === chosen ? ' checked' : ''}><span class="street-picker__choice-text">${segmentLabel(segment)}</span><span class="street-picker__meta">${fmt(segment.lengthM)}</span></label>`).join('');
        const body = root.document.createElement('div');
        body.className = 'street-picker';
        body.innerHTML = html`<p class="street-picker__facts">${facts}</p>`
            + html`<fieldset class="street-picker__group"><legend>${t('streets.picker.part', 'Part of the street')}</legend>` + partRows
            + html`<label class="street-picker__choice"><input type="radio" name="street-part" value="whole"><span class="street-picker__choice-text">${t('streets.picker.whole', 'The whole street')}</span><span class="street-picker__meta">${fmt(found.street.lengthM)}</span></label></fieldset>`
            + html`<fieldset class="street-picker__group"><legend>${t('streets.picker.side', 'Side')}</legend><div class="cb-segmented" data-street-sides></div></fieldset>`
            + '<p class="street-picker__status" role="status" aria-live="polite"></p>';
        const status = body.querySelector('.street-picker__status');
        const partOf = () => body.querySelector('input[name="street-part"]:checked')?.value;
        const partsOf = value => (value === 'whole' ? segments : [segments[Number(value)]]);
        // The sides by compass, for the chosen part (for the whole street, its longest segment).
        function renderSides() {
            const value = partOf();
            const parts = partsOf(value);
            const guide = parts.reduce((a, b) => (b.lengthM > a.lengthM ? b : a));
            const compass = S.sideCompass(guide.coordinates);
            const previous = body.querySelector('input[name="street-side"]:checked')?.value || 'both';
            body.querySelector('[data-street-sides]').innerHTML = [['left', COMPASS_KEYS[compass.left]()], ['right', COMPASS_KEYS[compass.right]()], ['both', t('streets.side.both', 'Both sides')]]
                .map(([side, label]) => html`<label class="cb-segmented__option"><input type="radio" name="street-side" value="${side}"${side === previous ? ' checked' : ''}><span>${label}</span></label>`).join('');
            root.highlightFeaturesForInspection?.(parts.map(part => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: part.coordinates } })),
                { weight: 7, className: 'street-picker-highlight' });
        }
        body.addEventListener('change', event => { if (event.target.name === 'street-part') renderSides(); status.textContent = ''; });
        renderSides();

        const dialog = root.CbDialog.open({
            title: found.street.name, size: 'sm', body, overlayClassName: 'street-picker-overlay',
            initialFocus: body.querySelector('input[name="street-part"]:checked'),
            onClose: () => root.highlightFeaturesForInspection?.([]),
            actions: [
                { id: 'cancel', label: t('common.cancel', 'Cancel') },
                { id: 'select', label: t('streets.picker.select', 'Select parcels'), primary: true, keepOpen: true, onClick: (api, event) => select(event.currentTarget) }
            ]
        });

        async function select(button) {
            if (root.BusyControl?.isBusy(button)) return;
            const value = partOf(), side = body.querySelector('input[name="street-side"]:checked')?.value || 'both';
            const parts = partsOf(value);
            status.textContent = t('streets.picker.selecting', 'Finding the parcels along it…');
            try {
                // One busy span: reading the parcels, loading the selection applier and applying it.
                const { ids, corners, complete } = await root.BusyControl.track(button, async () => {
                    const found = await plotsAlong(parts, side);
                    if (!found.ids.length) return found;
                    if (!root.ChatNavigation) await root.ensureOptionalTool('mapSelection');
                    const parcelSourceId = root.ChatNavigation.mapContext().parcelSourceId;
                    await root.ChatNavigation.apply({ selection: { parcelSourceId, focusParcelId: found.ids[0], parcelIds: found.ids, active: false } });
                    return found;
                });
                if (!ids.length) { status.textContent = t('streets.picker.none', 'No parcel boundary runs along this part on that side.'); return; }
                const segment = value === 'whole' ? null : parts[0];
                const where = segment ? segmentLabel(segment) : t('streets.picker.whole', 'The whole street');
                const sideText = side === 'both' ? t('streets.side.both', 'Both sides') : body.querySelector(`input[name="street-side"][value="${side}"]`)?.closest('label')?.textContent || side;
                // The cadastral parcels behind the selected pieces, to recognise the plan's land later.
                const fabric = root.LiveParcelFabric;
                const cadastreOf = id => { const feature = fabric.get(id); const bases = feature ? fabric.explicitCadastreIds(feature) : []; return bases.length ? bases.map(String) : [id]; };
                const cadastreIds = [...new Set(ids.flatMap(cadastreOf))];
                // Corner plots are recorded by their cadastral parcels too, as the vote's land is.
                const cornerRows = new Map();
                for (const [id, names] of corners) for (const parcelId of cadastreOf(id)) cornerRows.set(parcelId, [...new Set([...(cornerRows.get(parcelId) || []), ...names])]);
                const reference = S.reference(found.street, segment, side, (segment && segment.official) || official || null,
                    [...cornerRows].map(([parcelId, names]) => ({ parcelId, streets: names })));
                last = { city: city(), reference, parcelIds: ids, cadastreIds, label: `${found.street.name} · ${where} · ${sideText}` };
                const message = t('streets.picker.selected', 'Selected {{count}} parcels along {{street}}: {{where}}, {{side}}.', { count: ids.length, street: found.street.name, where, side: sideText.toLowerCase() })
                    + (complete ? '' : ` ${t('streets.picker.incomplete', 'Some parcels here have not loaded; check the map.')}`);
                dialog.close('select');
                root.showEphemeralMessage?.(message, 6000, complete ? 'success' : 'warning');
                root.document.dispatchEvent(new CustomEvent('street-picked', { detail: last }));
            } catch (error) {
                console.error(`[${new Date().toISOString()}] [StreetPicker] selecting the parcels failed`, error);
                status.textContent = t('streets.picker.selectFailed', 'The parcels could not be selected: {{error}}', { error: error.message });
            }
        }
        return dialog;
    }

    // The last street picked in this tab, while its parcels are still what a plan was made from.
    function lastPick() { return last && last.city === city() ? last : null; }

    return Object.freeze({ open, lastPick, endLabel, segmentLabel, referenceLabel, nearestSegment });
});
