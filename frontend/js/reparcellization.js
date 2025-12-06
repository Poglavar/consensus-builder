(function () {
    const COLOR_PALETTE = [
        '#2E86AB', '#F18F01', '#C73E1D', '#137547', '#7A1CAC',
        '#CC3363', '#3D5A80', '#EE6C4D', '#5C946E', '#8A508F',
        '#FF7F11', '#1B998B', '#ED254E', '#3772FF', '#78290F'
    ];

    const state = {
        modal: null,
        map: null,
        baseLayer: null,
        previewLayer: null,
        boundaryLayer: null,
        legendListEl: null,
        statusEl: null,
        algorithm: 'sweep-line',
        selection: null,
        superParcel: null,
        totalArea: 0,
        ownerShares: [],
        slices: [],
        hasFitBounds: false,
        resizeHandler: null,
        escHandler: null,
        commitBtns: []
    };

    function hashToColorIndex(value) {
        if (!value) return 0;
        let hash = 0;
        for (let i = 0; i < value.length; i++) {
            hash = ((hash << 5) - hash) + value.charCodeAt(i);
            hash |= 0;
        }
        return Math.abs(hash) % COLOR_PALETTE.length;
    }

    function pickOwnerColor(ownerKey, index) {
        if (COLOR_PALETTE.length === 0) return '#888';
        const paletteIndex = ownerKey ? hashToColorIndex(ownerKey) : (index % COLOR_PALETTE.length);
        return COLOR_PALETTE[paletteIndex];
    }

    function formatPercent(value) {
        if (!isFinite(value) || value <= 0) {
            return '0%';
        }
        return `${(value * 100).toFixed(1)}%`;
    }

    function setStatus(message, type = 'info') {
        if (!state.statusEl) return;
        state.statusEl.textContent = message || '';
        state.statusEl.setAttribute('data-status-type', type);
    }

    function destroyMap() {
        if (state.previewLayer) {
            state.previewLayer.remove();
            state.previewLayer = null;
        }
        if (state.boundaryLayer) {
            state.boundaryLayer.remove();
            state.boundaryLayer = null;
        }
        if (state.baseLayer) {
            state.baseLayer.remove();
            state.baseLayer = null;
        }
        if (state.map) {
            state.map.remove();
            state.map = null;
        }
        state.hasFitBounds = false;
    }

    function closeModal() {
        destroyMap();
        if (state.modal) {
            state.modal.remove();
            state.modal = null;
        }
        if (state.resizeHandler) {
            window.removeEventListener('resize', state.resizeHandler);
            state.resizeHandler = null;
        }
        if (state.escHandler) {
            window.removeEventListener('keydown', state.escHandler);
            state.escHandler = null;
        }
        if (typeof setProposalModalDimmed === 'function') {
            setProposalModalDimmed(false);
        }
        state.ownerShares = [];
        state.slices = [];
        state.selection = null;
        state.superParcel = null;
        state.totalArea = 0;
        state.commitBtns = [];
    }

    function buildModalStructure() {
        const overlay = document.createElement('div');
        overlay.className = 'reparcel-modal-overlay';
        overlay.innerHTML = `
            <div class="reparcel-modal" role="dialog" aria-modal="true">
                <div class="reparcel-modal-header">
                    <div>
                        <h2>Reparcellization</h2>
                        <p class="reparcel-subtitle">Sweep line algorithm · ${state.selection.ids.length} parcel${state.selection.ids.length === 1 ? '' : 's'}</p>
                    </div>
                    <button type="button" class="reparcel-close-btn close-circle-btn close-circle-btn--lg" aria-label="Close">&times;</button>
                </div>
                <div class="reparcel-modal-body">
                    <div class="reparcel-preview-panel">
                        <div class="reparcel-map-wrapper">
                            <div id="reparcel-map" class="reparcel-map" aria-live="polite"></div>
                        </div>
                        <div class="reparcel-preview-actions">
                            <button type="button" class="btn btn-proposal" data-reparcel-commit disabled style="width: 100%;">Done</button>
                        </div>
                    </div>
                    <div class="reparcel-legend-panel">
                        <h3>Owner Legend</h3>
                        <div class="reparcel-legend-list"></div>
                        <div class="reparcel-status" data-status-type="info"></div>
                    </div>
                    <div class="reparcel-mobile-actions">
                        <button type="button" class="btn btn-proposal" data-reparcel-commit disabled>Done</button>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        state.modal = overlay;
        state.legendListEl = overlay.querySelector('.reparcel-legend-list');
        state.statusEl = overlay.querySelector('.reparcel-status');

        const closeBtn = overlay.querySelector('.reparcel-close-btn');
        const commitBtns = Array.from(overlay.querySelectorAll('[data-reparcel-commit]'));
        state.commitBtns = commitBtns;

        closeBtn.addEventListener('click', closeModal);
        commitBtns.forEach((btn) => {
            btn.addEventListener('click', () => {
                if (btn.disabled) return;
                persistResult();
                ensureProposalDefaults();
                closeModal();
                if (typeof showEphemeralMessage === 'function') {
                    showEphemeralMessage('Saved reparcellization layout to the proposal.', 4000, 'success');
                }
            });
        });

        state.resizeHandler = () => {
            if (state.map) {
                state.map.invalidateSize();
            }
        };
        window.addEventListener('resize', state.resizeHandler);

        state.escHandler = (event) => {
            if (event.key === 'Escape') {
                closeModal();
            }
        };
        window.addEventListener('keydown', state.escHandler);

        if (typeof setProposalModalDimmed === 'function') {
            setProposalModalDimmed(true);
        }

        return overlay;
    }

    function initMap() {
        const mapContainer = state.modal.querySelector('#reparcel-map');
        const map = L.map(mapContainer, {
            zoomControl: false,
            attributionControl: false
        });
        const baseLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 22,
            minZoom: 3
        });
        baseLayer.addTo(map);
        state.baseLayer = baseLayer;
        state.map = map;
        setTimeout(() => map.invalidateSize(), 150);
    }

    function updateLegend(ownerShares) {
        if (!state.legendListEl) return;
        state.legendListEl.innerHTML = '';
        ownerShares.forEach((entry, index) => {
            const color = entry.color || pickOwnerColor(entry.ownerKey, index);
            entry.color = color;
            const row = document.createElement('div');
            row.className = 'reparcel-legend-item';
            row.innerHTML = `
                <span class="legend-color" style="background:${color}"></span>
                <div class="legend-text">
                    <div class="legend-name">${entry.displayName}</div>
                    <div class="legend-meta">${formatPercent(entry.percent)} · ${entry.parcelIds.length} parcel${entry.parcelIds.length === 1 ? '' : 's'}</div>
                </div>`;
            state.legendListEl.appendChild(row);
        });
    }

    function ensureProposalDefaults() {
        if (typeof setProposalMainType === 'function') {
            setProposalMainType('Reparcellization');
        }
        if (typeof setProposalType === 'function') {
            setProposalType('Reparcellization');
        }
        if (typeof updateProposalDescription === 'function') {
            updateProposalDescription('Reparcellization', true);
        }
        const descriptionInput = document.getElementById('proposalDescription');
        if (descriptionInput) {
            const label = (typeof formatParcelSelectionLabel === 'function' && state.selection?.ids)
                ? formatParcelSelectionLabel(state.selection.ids)
                : 'selected parcels';
            descriptionInput.value = `Reparcellization proposal for ${label}`;
        }
    }

    function drawPreview() {
        if (!state.map) return;
        if (state.previewLayer) {
            state.previewLayer.remove();
            state.previewLayer = null;
        }
        if (state.boundaryLayer) {
            state.boundaryLayer.remove();
            state.boundaryLayer = null;
        }

        if (state.slices.length) {
            const collection = {
                type: 'FeatureCollection',
                features: state.slices.map(slice => ({
                    type: 'Feature',
                    properties: {
                        ownerKey: slice.ownerKey,
                        color: slice.color,
                        displayName: slice.displayName,
                        percent: slice.percent
                    },
                    geometry: slice.geometry
                }))
            };
            state.previewLayer = L.geoJSON(collection, {
                style: feature => ({
                    color: '#333',
                    weight: 1,
                    fillOpacity: 0.55,
                    fillColor: feature.properties?.color || '#888'
                })
            }).addTo(state.map);
        }

        state.boundaryLayer = L.geoJSON(state.superParcel, {
            style: {
                color: '#111',
                weight: 2,
                fillOpacity: 0
            }
        }).addTo(state.map);

        if (!state.hasFitBounds && state.boundaryLayer) {
            try {
                state.map.fitBounds(state.boundaryLayer.getBounds(), { padding: [20, 20] });
                state.hasFitBounds = true;
            } catch (err) {
                console.warn('Failed to fit bounds for reparcellization preview', err);
            }
        }
    }

    function persistResult() {
        if (!state.slices.length) return;
        const payload = {
            algorithm: state.algorithm,
            generatedAt: new Date().toISOString(),
            parcelIds: state.selection.ids.slice(),
            totalArea: state.totalArea,
            ownerShares: state.ownerShares.map(entry => ({
                ownerKey: entry.ownerKey,
                displayName: entry.displayName,
                percent: entry.percent,
                color: entry.color,
                parcelIds: entry.parcelIds.slice()
            })),
            polygons: state.slices.map(slice => ({
                ownerKey: slice.ownerKey,
                displayName: slice.displayName,
                percent: slice.percent,
                color: slice.color,
                geometry: slice.geometry
            }))
        };
        window.pendingReparcellizationPlan = payload;
        if (state.commitBtns && state.commitBtns.length) {
            state.commitBtns.forEach(btn => { btn.disabled = false; });
        }
    }

    function ensureCommitAvailability(canCommit) {
        if (state.commitBtns && state.commitBtns.length) {
            state.commitBtns.forEach(btn => { btn.disabled = !canCommit; });
        }
    }

    function computeFeatureArea(feature) {
        if (typeof turf === 'undefined' || !feature) return 0;
        try {
            return turf.area(feature);
        } catch (error) {
            console.warn('Failed to compute feature area', error);
            return 0;
        }
    }

    function parseShareValue(rawValue) {
        if (!rawValue && rawValue !== 0) return NaN;
        const value = String(rawValue).trim();
        if (!value) return NaN;
        const percentMatch = value.match(/^(\d+(?:\.\d+)?)\s*%$/);
        if (percentMatch) {
            const pct = parseFloat(percentMatch[1]);
            return Number.isFinite(pct) ? pct / 100 : NaN;
        }
        const fractionMatch = value.match(/^(\d+)\s*\/\s*(\d+)$/);
        if (fractionMatch) {
            const numerator = parseFloat(fractionMatch[1]);
            const denominator = parseFloat(fractionMatch[2]);
            if (denominator === 0) return NaN;
            return numerator / denominator;
        }
        const asNumber = parseFloat(value);
        if (Number.isFinite(asNumber)) {
            if (asNumber > 1) {
                return asNumber;
            }
            if (asNumber >= 0 && asNumber <= 1) {
                return asNumber;
            }
        }
        return NaN;
    }

    function normalizeOwnerSlots(slots) {
        if (!Array.isArray(slots) || !slots.length) return [];
        const parsed = slots.map(slot => {
            const fromText = parseShareValue(slot.shareText);
            const fromDetail = parseShareValue(slot.shareDetail);
            let value = Number.isFinite(fromDetail) ? fromDetail : fromText;
            if (!Number.isFinite(value) || value <= 0) {
                value = 0;
            }
            return { slot, value };
        });
        let total = parsed.reduce((sum, entry) => sum + entry.value, 0);
        if (total <= 0) {
            const equalShare = 1 / parsed.length;
            return parsed.map(entry => ({ slot: entry.slot, fraction: equalShare }));
        }
        return parsed.map(entry => ({ slot: entry.slot, fraction: entry.value / total }));
    }

    async function buildOwnerShares(selection) {
        const result = new Map();
        const parcelLayers = selection.layers || [];
        let totalArea = 0;

        for (const layer of parcelLayers) {
            const feature = layer?.feature;
            if (!feature || !feature.properties) continue;
            const parcelId = feature.properties.CESTICA_ID;
            const area = Number(feature.properties.calculatedArea) || computeFeatureArea(feature);
            if (!area || !Number.isFinite(area)) continue;
            totalArea += area;

            let slots = [];
            if (typeof ensureParcelOwnerSlots === 'function') {
                try {
                    slots = await ensureParcelOwnerSlots(parcelId);
                } catch (error) {
                    console.warn('Failed to fetch owner slots for parcel', parcelId, error);
                }
            }
            if (!Array.isArray(slots) || !slots.length) {
                slots = [{
                    key: `parcel:${parcelId}:synthetic-owner`,
                    displayName: `Owner of ${feature.properties.BROJ_CESTICE || parcelId}`,
                    shareText: '1/1'
                }];
            }

            const normalizedSlots = normalizeOwnerSlots(slots);
            normalizedSlots.forEach(({ slot, fraction }) => {
                const ownerKey = slot.key || `${parcelId}:${slot.displayName}`;
                const existing = result.get(ownerKey) || {
                    ownerKey,
                    displayName: slot.displayName || 'Owner',
                    parcelIds: new Set(),
                    totalArea: 0
                };
                existing.totalArea += area * fraction;
                if (parcelId) existing.parcelIds.add(parcelId);
                result.set(ownerKey, existing);
            });
        }

        if (!totalArea) {
            return [];
        }

        return Array.from(result.values()).map((entry, index) => ({
            ownerKey: entry.ownerKey,
            displayName: entry.displayName,
            parcelIds: Array.from(entry.parcelIds),
            area: entry.totalArea,
            percent: entry.totalArea / totalArea,
            color: pickOwnerColor(entry.ownerKey, index)
        })).filter(entry => entry.percent > 0).sort((a, b) => b.percent - a.percent);
    }

    function buildSlicePolygon(minLng, maxLng, minLat, maxLat, cutLng) {
        if (!isFinite(cutLng) || cutLng <= minLng) return null;
        const epsilon = 1e-6;
        const constrainedCut = Math.min(Math.max(cutLng, minLng + epsilon), maxLng - epsilon);
        const latMargin = Math.max((maxLat - minLat) * 0.05, 0.0005);
        const coords = [
            [minLng, minLat - latMargin],
            [constrainedCut, minLat - latMargin],
            [constrainedCut, maxLat + latMargin],
            [minLng, maxLat + latMargin],
            [minLng, minLat - latMargin]
        ];
        return turf.polygon([coords]);
    }

    function sliceWithSweepLine(superParcel, owners) {
        if (typeof turf === 'undefined') {
            console.warn('turf is required for reparcellization.');
            return [];
        }
        if (!owners.length) return [];

        const baseFeature = JSON.parse(JSON.stringify(superParcel));
        let workingFeature = baseFeature;
        const totalArea = computeFeatureArea(baseFeature);
        const slices = [];
        const bbox = turf.bbox(baseFeature);
        const minLng = bbox[0];
        const minLat = bbox[1];
        const maxLng = bbox[2];
        const maxLat = bbox[3];

        owners.forEach((owner, index) => {
            const isLast = index === owners.length - 1;
            if (isLast || !owner.percent || !workingFeature) {
                slices.push({
                    ownerKey: owner.ownerKey,
                    displayName: owner.displayName,
                    percent: owner.percent,
                    color: owner.color,
                    geometry: workingFeature ? JSON.parse(JSON.stringify(workingFeature.geometry)) : null
                });
                workingFeature = null;
                return;
            }

            const targetArea = totalArea * owner.percent;
            const slice = extractSliceByArea(workingFeature, targetArea, { minLng, maxLng, minLat, maxLat });
            if (!slice || !slice.feature) {
                console.warn('Failed to find slice for owner, assigning remaining area.', owner);
                slices.push({
                    ownerKey: owner.ownerKey,
                    displayName: owner.displayName,
                    percent: owner.percent,
                    color: owner.color,
                    geometry: workingFeature ? JSON.parse(JSON.stringify(workingFeature.geometry)) : null
                });
                workingFeature = null;
                return;
            }

            slices.push({
                ownerKey: owner.ownerKey,
                displayName: owner.displayName,
                percent: owner.percent,
                color: owner.color,
                geometry: slice.feature.geometry
            });
            workingFeature = slice.remainder;
        });

        return slices.filter(slice => slice.geometry);
    }

    function extractSliceByArea(feature, targetArea, bounds) {
        if (!feature || !feature.geometry || !targetArea || targetArea <= 0) {
            return null;
        }
        const maxIterations = 24;
        let lower = bounds.minLng;
        let upper = bounds.maxLng;
        let best = null;
        let bestDiff = Infinity;

        for (let i = 0; i < maxIterations; i++) {
            const candidate = (lower + upper) / 2;
            const sliceRect = buildSlicePolygon(bounds.minLng, bounds.maxLng, bounds.minLat, bounds.maxLat, candidate);
            if (!sliceRect) break;
            let sliceFeature = null;
            try {
                sliceFeature = turf.intersect(feature, sliceRect);
            } catch (error) {
                console.warn('intersect failed during reparcellization', error);
            }
            const area = sliceFeature ? computeFeatureArea(sliceFeature) : 0;
            const diff = Math.abs(area - targetArea);
            if (area > 0 && diff < bestDiff) {
                const remainder = turf.difference(feature, sliceFeature);
                bestDiff = diff;
                best = {
                    feature: sliceFeature,
                    remainder: remainder || null
                };
            }

            if (!sliceFeature || area === 0) {
                lower = candidate;
                continue;
            }

            if (Math.abs(diff / targetArea) <= 0.01) {
                break;
            }

            if (area < targetArea) {
                lower = candidate;
            } else {
                upper = candidate;
            }
        }

        return best;
    }

    async function refreshPreview() {
        setStatus('Preparing repartition preview...', 'info');
        ensureCommitAvailability(false);
        state.ownerShares = await buildOwnerShares(state.selection);
        if (!state.ownerShares.length) {
            setStatus('Could not determine owners for reparcellization.', 'error');
            state.slices = [];
            drawPreview();
            return;
        }
        updateLegend(state.ownerShares);

        if (state.algorithm !== 'sweep-line') {
            setStatus('Selected algorithm is not available yet.', 'warning');
            return;
        }

        if (!state.totalArea) {
            state.totalArea = computeFeatureArea(state.superParcel);
        }
        state.slices = sliceWithSweepLine(state.superParcel, state.ownerShares);
        if (!state.slices.length) {
            setStatus('Failed to split the parcel geometry.', 'error');
            ensureCommitAvailability(false);
            drawPreview();
            return;
        }
        setStatus('Sweep line applied successfully. Review and click Done to save.', 'success');
        ensureCommitAvailability(true);
        drawPreview();
    }

    function validateSelection(selection) {
        if (!selection || !Array.isArray(selection.layers) || !selection.layers.length) {
            return false;
        }
        return true;
    }

    function buildSuperParcel(selection) {
        if (typeof buildGeometryFromParcels !== 'function') {
            return null;
        }
        const geometry = buildGeometryFromParcels(selection.layers);
        if (!geometry) return null;
        return {
            type: 'Feature',
            properties: {
                parcelIds: selection.ids.slice()
            },
            geometry
        };
    }

    async function openReparcellizationModal(options = {}) {
        const selection = (typeof getCurrentParcelSelectionContext === 'function')
            ? getCurrentParcelSelectionContext()
            : null;
        if (!validateSelection(selection)) {
            if (typeof updateStatus === 'function') {
                updateStatus('Select at least one parcel before running reparcellization.');
            }
            return false;
        }
        const superParcel = buildSuperParcel(selection);
        if (!superParcel) {
            if (typeof updateStatus === 'function') {
                updateStatus('Unable to build geometry for reparcellization.');
            }
            return false;
        }
        state.selection = selection;
        state.superParcel = superParcel;
        state.algorithm = options.algorithm || 'sweep-line';
        state.totalArea = computeFeatureArea(superParcel);
        buildModalStructure();
        initMap();
        await refreshPreview();
        return true;
    }

    if (typeof window.pendingReparcellizationPlan === 'undefined') {
        window.pendingReparcellizationPlan = null;
    }
    window.openReparcellizationModal = openReparcellizationModal;
})();
