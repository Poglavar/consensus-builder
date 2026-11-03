// Apply hosted-chat map navigation through the app's current map, cadastral, and parcel-presentation owners.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root.document !== 'undefined') root.ChatNavigation = api.create(root);
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const VIEW_DURATION = 0.65;
    const CAMERA_DURATION_MS = 650;
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const idOf = value => typeof value === 'string' && value.trim() ? value.trim() : null;

    function create(root) {
        let cursorParcelId = null;
        let cursorCity = null;
        let ownInspectionId = null;
        let applyingSelection = false;

        const city = () => root.CityConfigManager?.getCurrentCityId?.() || root.currentCityId || root.currentCity || null;
        const multi = () => root.multiParcelSelection;
        const fabric = () => root.LiveParcelFabric;
        const presenter = () => root.ParcelPresenter;
        const sourceId = () => {
            const cityId = city();
            const local = root.ParcelGroundFallback?.activeSource?.(cityId);
            if (local?.id) return String(local.id);
            const configured = root.DesignSync?.parcelSourceIdOf?.(cityId)
                ?? root.CityConfigManager?.getDataContext?.(null, cityId)?.parcelSourceId;
            return configured == null || configured === '' ? null : String(configured);
        };
        const reducedMotion = () => root.__reducedMotion === true
            || root.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true
            || root.document?.hidden === true;

        function capture() {
            const selection = multi();
            const ids = selection?.selectedParcels ? [...selection.selectedParcels].map(String) : [];
            const single = idOf(root.selectedParcelId == null ? null : String(root.selectedParcelId));
            const focus = single
                || (cursorCity === city() ? cursorParcelId : null)
                || (selection?.lastSelectedParcelId && ids.includes(String(selection.lastSelectedParcelId)) ? String(selection.lastSelectedParcelId) : null)
                || ids.at(-1)
                || null;
            const parcelIds = ids.length ? ids : (single ? [single] : []);
            return { focusParcelId: focus, parcelIds, active: selection?.isActive === true };
        }

        function mapContext() {
            const map = root.map;
            const bounds = map?.getBounds?.() || null;
            const numbersToggle = root.document?.getElementById?.('showParcelNumbers');
            const viewBounds = bounds && ['getWest', 'getSouth', 'getEast', 'getNorth'].every(key => typeof bounds[key] === 'function')
                ? [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]
                : null;
            const visibleParcels = [];
            let visibleParcelsTruncated = false;
            const validViewBounds = viewBounds?.every(finite)
                && viewBounds[0] >= -180 && viewBounds[0] <= 180 && viewBounds[2] >= -180 && viewBounds[2] <= 180
                && viewBounds[1] >= -85 && viewBounds[1] <= 85 && viewBounds[3] >= -85 && viewBounds[3] <= 85
                && viewBounds[0] <= viewBounds[2] && viewBounds[1] <= viewBounds[3];
            if (bounds && validViewBounds && typeof bounds.contains === 'function'
                && typeof root.getParcelsInBounds === 'function' && root.ParcelPresenter?.getIdForLayer
                && root.LiveParcelFabric?.get && root.ParcelLabelModel?.position && root.ParcelLabelModel?.isEligible
                && root.getParcelDisplayNumberFromFeature) {
                for (const layer of root.getParcelsInBounds(bounds) || []) {
                    const parcelId = idOf(root.ParcelPresenter.getIdForLayer(layer));
                    if (!parcelId || parcelId.length > 250 || !root.ParcelLabelModel.isEligible(parcelId)) continue;
                    const feature = root.LiveParcelFabric.get(parcelId);
                    if (!feature) continue;
                    const label = root.getParcelDisplayNumberFromFeature(feature, '');
                    if (typeof label !== 'string' || !label.trim() || label.trim().length > 250) continue;
                    const position = root.ParcelLabelModel.position(feature, layer, parcelId);
                    if (!position || !finite(position.lng) || !finite(position.lat) || !bounds.contains(position)) continue;
                    if (visibleParcels.length >= 500) {
                        visibleParcelsTruncated = true;
                        break;
                    }
                    visibleParcels.push({ parcelId, label: label.trim(), point: [position.lng, position.lat] });
                }
            }
            return {
                parcelSourceId: sourceId(),
                display: { parcelIds: numbersToggle?.checked === true, roadTracks: root.RoadTrackLayer?.isEnabled() === true },
                visibleParcels,
                visibleParcelsTruncated,
                viewBounds: validViewBounds ? viewBounds : null
            };
        }

        function parseAt(value) {
            const parts = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : null;
            if (!parts || (parts.length !== 2 && parts.length !== 3)) return null;
            const numbers = parts.map(part => typeof part === 'number' ? part : Number(String(part).trim()));
            if (!numbers.every(Number.isFinite) || Math.abs(numbers[0]) > 90 || Math.abs(numbers[1]) > 180) return null;
            if (numbers.length === 3 && (numbers[2] < 0 || numbers[2] > 25)) return null;
            return { lat: numbers[0], lng: numbers[1], zoom: numbers.length === 3 ? numbers[2] : null };
        }

        function cameraOf(value, at, current = null) {
            const camera = value && typeof value === 'object' ? value : null;
            const next = {
                targetLat: camera?.targetLat ?? at?.lat ?? current?.targetLat,
                targetLng: camera?.targetLng ?? at?.lng ?? current?.targetLng,
                headingDeg: camera?.headingDeg ?? current?.headingDeg ?? 0,
                pitchRad: camera?.pitchRad ?? current?.pitchRad ?? -0.65,
                range: camera?.range ?? current?.range
            };
            if (![next.targetLat, next.targetLng, next.headingDeg, next.pitchRad, next.range].every(finite)
                || Math.abs(next.targetLat) > 85.0511 || Math.abs(next.targetLng) > 180
                || next.pitchRad < -Math.PI / 2 || next.pitchRad > 0 || next.range < 1) return null;
            return next;
        }

        function sameCamera(a, b) {
            return a && b && ['targetLat', 'targetLng', 'headingDeg', 'pitchRad', 'range']
                .every(key => Math.abs(a[key] - b[key]) < 1e-7);
        }

        function interpolateAngle(from, to, fraction) {
            const delta = ((to - from + 540) % 360) - 180;
            return from + delta * fraction;
        }

        function applyCamera(target) {
            const apply = root.applyThree3DGeoView;
            if (typeof apply !== 'function') throw new Error('The 3D camera is unavailable.');
            const current = root.getThree3DGeoView?.();
            if (sameCamera(current, target)) return Promise.resolve(true);
            if (reducedMotion() || !current || typeof root.requestAnimationFrame !== 'function') {
                if (!apply(target)) throw new Error('The 3D camera could not move to that view.');
                return Promise.resolve(true);
            }
            return new Promise((resolve, reject) => {
                const started = root.performance?.now?.() ?? Date.now();
                const frame = now => {
                    const progress = Math.max(0, Math.min(1, ((now ?? Date.now()) - started) / CAMERA_DURATION_MS));
                    const eased = progress * (2 - progress);
                    const next = {
                        targetLat: current.targetLat + (target.targetLat - current.targetLat) * eased,
                        targetLng: current.targetLng + (target.targetLng - current.targetLng) * eased,
                        headingDeg: interpolateAngle(current.headingDeg, target.headingDeg, eased),
                        pitchRad: current.pitchRad + (target.pitchRad - current.pitchRad) * eased,
                        range: current.range + (target.range - current.range) * eased
                    };
                    if (!apply(next)) { reject(new Error('The 3D camera could not move to that view.')); return; }
                    if (progress >= 1) resolve(true);
                    else root.requestAnimationFrame(frame);
                };
                root.requestAnimationFrame(frame);
            });
        }

        async function setParcelIdsVisible(visible) {
            const numberToggle = root.document?.getElementById?.('showParcelNumbers');
            if (!numberToggle) throw new Error('Parcel ID display controls are unavailable.');
            const toggleNumbers = root.Parcels?.uiLabels?.toggleParcelNumbers || root.toggleParcelNumbers;
            if (typeof toggleNumbers !== 'function') throw new Error('Parcel ID display controls are unavailable.');
            if (!visible) {
                numberToggle.checked = false;
                toggleNumbers();
                return true;
            }
            if (typeof root.isZoomWithinParcelRange === 'function' && !root.isZoomWithinParcelRange()) {
                throw new Error('Zoom in to show parcel IDs.');
            }
            const bounds = root.map?.getBounds?.();
            if (!bounds || typeof root.fetchParcelDataReported !== 'function') {
                throw new Error('Parcel data could not be loaded for this map view.');
            }
            // Parcel loading is normally started by map controls and reported asynchronously.
            // Chat must wait for the current viewport before it tells the agent that IDs are shown.
            const fetched = await root.fetchParcelDataReported(bounds, 'chat parcel IDs');
            if (!fetched || !Array.isArray(fetched.features) || fetched.features.length === 0) {
                throw new Error('No parcels with displayable IDs were loaded for this map view.');
            }
            const parcelsToggle = root.document?.getElementById?.('parcelsCheckbox');
            if (parcelsToggle && !parcelsToggle.checked) {
                if (typeof root.toggleAccordion !== 'function') throw new Error('Parcel display controls are unavailable.');
                parcelsToggle.checked = true;
                root.toggleAccordion(parcelsToggle);
            }
            if (!root.parcelLayer) throw new Error('Parcel data is not loaded, so parcel IDs cannot be shown.');
            numberToggle.checked = true;
            toggleNumbers();
            if (mapContext().visibleParcels.length === 0) {
                numberToggle.checked = false;
                toggleNumbers();
                throw new Error('No parcel IDs are visible in this map view.');
            }
            return true;
        }

        async function applyView(event) {
            const view = event?.view || event;
            const at = parseAt(view?.at);
            if (!at) throw new Error('The map view did not contain a valid center and zoom.');
            const map = root.map;
            if (!map) throw new Error('The map is not ready.');
            const active3D = root.isThreeModeActive?.() === true;
            if (active3D) {
                const target = cameraOf(view?.camera, at, root.getThree3DGeoView?.());
                if (!target) throw new Error('The 3D map view did not contain a valid camera.');
                await applyCamera(target);
            } else {
                const current = map.getCenter?.();
                const zoom = at.zoom ?? map.getZoom?.();
                const unchanged = current && Math.abs(current.lat - at.lat) < 1e-7 && Math.abs(current.lng - at.lng) < 1e-7
                    && Math.abs((map.getZoom?.() ?? zoom) - zoom) < 1e-7;
                if (!unchanged) {
                    if (reducedMotion() || typeof map.flyTo !== 'function') {
                        map.setView([at.lat, at.lng], zoom, { animate: false });
                    } else {
                        await new Promise((resolve, reject) => {
                            let settled = false;
                            const finish = () => { if (settled) return; settled = true; root.clearTimeout(timer); resolve(true); };
                            const timer = root.setTimeout(finish, VIEW_DURATION * 1000 + 250);
                            try {
                                map.once?.('moveend', finish);
                                map.flyTo([at.lat, at.lng], zoom, { animate: true, duration: VIEW_DURATION, easeLinearity: 0.25 });
                                if (!map.once) finish();
                            } catch (error) {
                                if (!settled) { settled = true; root.clearTimeout(timer); }
                                reject(error);
                            }
                        });
                    }
                }
            }
            if (Object.prototype.hasOwnProperty.call(event, 'roadTracksVisible')) {
                if (typeof event.roadTracksVisible !== 'boolean') throw new Error('The Road/track display state is invalid.');
                if (!root.RoadTrackLayer) throw new Error('The Road/track layer is unavailable.');
                if (!await root.RoadTrackLayer.setEnabled(event.roadTracksVisible)) {
                    throw new Error(root.document.getElementById('road-track-layer-status')?.textContent || 'Road/track could not be shown.');
                }
            }
            if (Object.prototype.hasOwnProperty.call(event, 'parcelIdsVisible')) {
                if (typeof event.parcelIdsVisible !== 'boolean') throw new Error('The parcel ID display state is invalid.');
                await setParcelIdsVisible(event.parcelIdsVisible);
            }
            return true;
        }

        function normalizeSelection(selection) {
            if (!selection || typeof selection !== 'object') throw new Error('The parcel selection is missing.');
            const parcelSourceId = idOf(selection.parcelSourceId);
            if (!parcelSourceId) throw new Error('The parcel source is missing.');
            if (typeof selection.active !== 'boolean') throw new Error('The parcel selection active state is missing.');
            if (!Array.isArray(selection.parcelIds)) throw new Error('The parcel selection IDs are missing.');
            const ids = [];
            for (const raw of selection.parcelIds) {
                const id = idOf(raw);
                if (!id) throw new Error('The parcel selection contains an invalid ID.');
                if (!ids.includes(id)) ids.push(id);
            }
            const focusParcelId = selection.focusParcelId == null ? null : idOf(selection.focusParcelId);
            if (selection.focusParcelId != null && !focusParcelId) throw new Error('The parcel focus ID is invalid.');
            return { parcelSourceId, focusParcelId, parcelIds: ids, active: selection.active };
        }

        async function loadAndResolve(ids, expectedSource, expectedCity) {
            if (expectedSource !== sourceId()) throw new Error('The parcel source changed. Reload the chat map context and try again.');
            const repository = root.CadastralParcelRepository;
            const live = fabric();
            const draw = presenter();
            if (!repository?.ensureIds || !live?.get || !draw?.getLayer) throw new Error('The parcel data is not ready.');
            const absentFromFabric = ids.filter(id => !live.get(id));
            if (absentFromFabric.length) {
                const sourceIdFor = id => live.cadastralPartOf?.(id)?.cadastreId || id;
                const requestedSourceIds = [...new Set(absentFromFabric.map(sourceIdFor))];
                const result = await repository.ensureIds(requestedSourceIds, { city: expectedCity });
                const unavailable = absentFromFabric.filter(id => !result.foundIds?.includes(sourceIdFor(id)));
                if (unavailable.length) throw new Error(`Parcel IDs are unavailable from the active source: ${unavailable.join(', ')}`);
            }
            if (expectedCity !== city() || expectedSource !== sourceId()) throw new Error('The active city or parcel source changed while loading parcels.');
            const features = new Map();
            const layers = new Map();
            for (const id of ids) {
                const feature = live.get(id);
                const layer = feature && draw.getLayer(id);
                if (!feature?.geometry || !layer) throw new Error(`Parcel ${id} is not available in the live map fabric.`);
                features.set(id, feature);
                layers.set(id, layer);
            }
            return { features, layers };
        }

        function setSelection(next, layers) {
            const selection = multi();
            if (!selection) throw new Error('The parcel selection controls are unavailable.');
            const previousIds = [...(selection.selectedParcels || [])].map(String);
            const previousActive = selection.isActive === true;
            const previousFocus = cursorParcelId;
            const previousCursorCity = cursorCity;
            const previousLastSelected = selection.lastSelectedParcelId == null ? null : String(selection.lastSelectedParcelId);
            const previousInspectionId = ownInspectionId;
            const previousSingle = root.selectedParcelId == null ? null : String(root.selectedParcelId);
            const previousCurrent = root.currentParcel || null;
            const wantedIds = new Set(next.parcelIds);
            const changed = previousActive !== next.active || previousIds.length !== next.parcelIds.length
                || previousIds.some(id => !wantedIds.has(id));

            if (ownInspectionId !== next.focusParcelId) {
                if (next.focusParcelId) root.highlightFeaturesForInspection?.([layers.get(next.focusParcelId) ? fabric().get(next.focusParcelId) : null].filter(Boolean), { className: 'chat-map-focus' });
                else root.highlightFeaturesForInspection?.([]);
                ownInspectionId = next.focusParcelId;
            }
            if (!changed) {
                cursorParcelId = next.focusParcelId;
                cursorCity = city();
                return false;
            }

            applyingSelection = true;
            try {
                selection.clearInfoListHighlight?.();
                for (const id of previousIds) {
                    const layer = presenter()?.getLayer?.(id);
                    if (layer) selection.removeParcelHighlight?.(layer);
                }
                selection.clearSingleParcelSelection?.({ preservePanel: true });
                selection.selectedParcels.clear();
                for (const id of next.parcelIds) {
                    const layer = layers.get(id);
                    selection.selectedParcels.add(id);
                    selection.addParcelHighlight?.(layer);
                }
                selection.lastSelectedParcelId = next.focusParcelId && next.parcelIds.includes(next.focusParcelId)
                    ? next.focusParcelId : next.parcelIds.at(-1) || null;
                selection.isActive = next.active;
                cursorParcelId = next.focusParcelId;
                cursorCity = city();
                selection.updateUI?.();
                return true;
            } catch (error) {
                // Restore the previous selection if presentation failed part way through the replacement.
                try {
                    selection.clearInfoListHighlight?.();
                    for (const id of [...selection.selectedParcels]) {
                        const layer = presenter()?.getLayer?.(id);
                        if (layer) selection.removeParcelHighlight?.(layer);
                    }
                    selection.selectedParcels.clear();
                    previousIds.forEach(id => {
                        const layer = presenter()?.getLayer?.(id);
                        if (layer) { selection.selectedParcels.add(id); selection.addParcelHighlight?.(layer); }
                    });
                    selection.isActive = previousActive;
                    selection.lastSelectedParcelId = previousLastSelected;
                    root.selectedParcelId = previousSingle;
                    root.currentParcel = previousCurrent;
                    cursorParcelId = previousFocus;
                    cursorCity = previousCursorCity;
                    ownInspectionId = previousInspectionId;
                    if (previousInspectionId) root.highlightFeaturesForInspection?.([fabric()?.get?.(previousInspectionId)].filter(Boolean), { className: 'chat-map-focus' });
                    else if (next.focusParcelId) root.highlightFeaturesForInspection?.([]);
                    selection.updateUI?.();
                } catch (_) { /* retain the original presentation failure */ }
                throw error;
            } finally { applyingSelection = false; }
        }

        async function applySelection(event) {
            const next = normalizeSelection(event?.selection || event);
            const currentCity = city();
            if (!currentCity) throw new Error('The current city is unavailable.');
            if (next.parcelSourceId !== sourceId()) throw new Error('The parcel source does not match the active map source.');
            const ids = [...new Set([...next.parcelIds, ...(next.focusParcelId ? [next.focusParcelId] : [])])];
            const { layers } = await loadAndResolve(ids, next.parcelSourceId, currentCity);
            return setSelection(next, layers);
        }

        async function apply(event) {
            if (!event || typeof event !== 'object') throw new Error('The chat navigation event is invalid.');
            const kind = event.name || event.type;
            if (kind === 'view' || event.view) return applyView(event);
            if (kind === 'selection' || event.selection) return applySelection(event);
            throw new Error(`Unsupported chat navigation event: ${kind || 'unknown'}`);
        }

        root.addEventListener?.('cityChanged', () => {
            cursorParcelId = null;
            cursorCity = null;
            if (ownInspectionId) root.highlightFeaturesForInspection?.([]);
            ownInspectionId = null;
        });
        root.document?.addEventListener?.('multi-parcel-selection-change', () => {
            if (applyingSelection) return;
            const selection = multi();
            const last = selection?.lastSelectedParcelId;
            if (last && selection?.selectedParcels?.has?.(String(last))) {
                cursorParcelId = String(last);
                cursorCity = city();
            }
        });

        return Object.freeze({ capture, mapContext, apply });
    }

    return Object.freeze({ create });
});
