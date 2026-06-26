// proposals/dialog-upload.js — extracted from proposals.js (behavior-preserving relocation).

function updateProposalScreenshotGoalIcon(toolKey) {
    const container = document.querySelector('#proposalScreenshotContainer .map-screenshot-container');
    if (!container) return;

    const iconConfig = getProposalGoalBadge(toolKey);

    let badge = container.querySelector('.proposal-goal-badge');
    if (!iconConfig) {
        if (badge) {
            badge.style.display = 'none';
            badge.textContent = '';
            badge.removeAttribute('aria-label');
            badge.removeAttribute('title');
        }
        return;
    }

    if (!badge) {
        badge = document.createElement('div');
        badge.className = 'proposal-goal-badge';
        container.appendChild(badge);
    }

    badge.style.display = 'flex';
    badge.textContent = iconConfig.text;
    badge.setAttribute('aria-label', iconConfig.label);
    badge.setAttribute('title', iconConfig.label);
}

function shouldSkipProposalScreenshot(proposal) {
    if (!proposal) return true;
    const goalKey = normalizeGoalKey(proposal.goal || proposal.proposalType || proposal.type || '');
    return PROPOSAL_SCREENSHOT_SKIP_GOALS.has(goalKey);
}

async function uploadProposalScreenshotDataUrl(proposal, dataUrl) {
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null;
    const proposalId = proposal?.proposalId || proposal?.id || `unknown-${Date.now()}`;
    const fileNameBase = `proposal-thumb-${proposalId}-${Date.now()}`;
    const metadataPayload = {
        name: proposal?.title || proposal?.name || `Proposal ${proposalId}`,
        description: 'Proposal map thumbnail',
        properties: { proposalId: String(proposalId), kind: 'thumbnail' }
    };
    try {
        const base = getBackendBaseUrl();
        const response = await fetch(`${base}/assets/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                imageData: dataUrl,
                metadata: metadataPayload,
                fileName: fileNameBase
            })
        });
        if (!response.ok) {
            console.warn('[proposal screenshot] backend upload returned', response.status);
            return null;
        }
        const result = await response.json();
        return result?.imageGatewayUrl || result?.imageUrl || result?.uploadedImageUrl || null;
    } catch (err) {
        console.warn('[proposal screenshot] Upload failed:', err);
        return null;
    }
}

async function patchProposalScreenshotOnServer(proposal, screenshotUrl) {
    const serialId = (typeof getSerialProposalId === 'function') ? getSerialProposalId(proposal) : null;
    if (!serialId) return false;
    try {
        const base = getBackendBaseUrl();
        const response = await fetch(`${base}/proposals/${encodeURIComponent(serialId)}/screenshot`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ screenshotUrl })
        });
        if (!response.ok) {
            console.warn('[proposal screenshot] PATCH returned', response.status);
            return false;
        }
        return true;
    } catch (err) {
        console.warn('[proposal screenshot] PATCH failed:', err);
        return false;
    }
}

function persistProposalScreenshotUrl(proposalId, url) {
    if (!proposalId || !url) return false;
    const stored = getStoredProposalById(proposalId);
    if (!stored) return false;
    stored.screenshotUrl = url;
    stored.updatedAt = new Date().toISOString();
    try {
        if (typeof proposalStorage.save === 'function') proposalStorage.save();
    } catch (_) { }
    try {
        if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
            document.dispatchEvent(new CustomEvent('proposalScreenshotUpdated', {
                detail: { proposalId, screenshotUrl: url }
            }));
        }
    } catch (_) { }
    return true;
}

function persistProposalScreenshotDataUrl(proposalId, dataUrl) {
    if (!proposalId || !dataUrl) return false;
    const stored = getStoredProposalById(proposalId);
    if (!stored) return false;
    stored.screenshotDataUrl = dataUrl;
    stored.updatedAt = new Date().toISOString();
    try {
        if (typeof proposalStorage.save === 'function') proposalStorage.save();
    } catch (err) {
        // localStorage quota exceeded or similar — drop the data URL so we don't keep failing.
        console.warn('[proposal screenshot] Failed to save data URL locally (likely quota):', err);
        delete stored.screenshotDataUrl;
        return false;
    }
    try {
        if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
            document.dispatchEvent(new CustomEvent('proposalScreenshotUpdated', {
                detail: { proposalId, screenshotDataUrl: dataUrl }
            }));
        }
    } catch (_) { }
    return true;
}

async function captureAndPersistProposalScreenshot(proposalId, options = {}) {
    if (!proposalId) return null;
    const proposal = getStoredProposalById(proposalId);
    if (!proposal) return null;
    if (shouldSkipProposalScreenshot(proposal)) return null;

    const force = !!options.force;
    if (!force && (proposal.screenshotUrl || proposal.screenshotDataUrl)) {
        return proposal.screenshotUrl || proposal.screenshotDataUrl;
    }

    // If the proposal was just minted, copy the on-chain image url onto the proposal
    // so list rendering uses the canonical URL.
    if (!force) {
        const onchainImage = proposal.onchain?.imageUrl || proposal.onchainData?.imageUrl;
        if (onchainImage) {
            persistProposalScreenshotUrl(proposalId, onchainImage);
            patchProposalScreenshotOnServer(proposal, onchainImage);
            return onchainImage;
        }
    }

    let dataUrl = options.screenshotDataUrl || null;

    // Prefer a cached modal preview if the modal is still open / just closed.
    if (!dataUrl && options.allowModalCache !== false) {
        if (proposalModalScreenshotDataUrl) {
            dataUrl = proposalModalScreenshotDataUrl;
        } else if (options.modalPromise) {
            try { dataUrl = await options.modalPromise; } catch (_) { dataUrl = null; }
        } else if (proposalModalScreenshotPromise) {
            try { dataUrl = await proposalModalScreenshotPromise; } catch (_) { dataUrl = null; }
        }
    }

    if (!dataUrl && typeof reconstructProposalScreenshotDataUrl === 'function') {
        try {
            dataUrl = await reconstructProposalScreenshotDataUrl(proposal);
        } catch (err) {
            console.warn('[proposal screenshot] Reconstruction failed:', err);
            dataUrl = null;
        }
    }

    if (!dataUrl) return null;

    persistProposalScreenshotDataUrl(proposalId, dataUrl);

    // Optional upload path — used by mint flow when a permanent URL is needed.
    if (options.uploadToServer) {
        const url = await uploadProposalScreenshotDataUrl(proposal, dataUrl);
        if (url) {
            persistProposalScreenshotUrl(proposalId, url);
            patchProposalScreenshotOnServer(proposal, url);
            return url;
        }
    }

    return dataUrl;
}

function resolveProposalPolygonForScreenshot(proposal) {
    if (!proposal) return { polygon: null };
    const goalKey = normalizeGoalKey(proposal.goal || proposal.proposalType || '');

    const fromGeometry = (geom) => {
        if (!geom || !geom.coordinates) return null;
        if (geom.type === 'Polygon') return { polygon: geom.coordinates, polygonOrder: 'lnglat' };
        if (geom.type === 'MultiPolygon') return { polygon: geom.coordinates[0], polygonOrder: 'lnglat' };
        return null;
    };

    if (goalKey === 'road-track') {
        const rp = proposal.roadProposal || {};
        const def = rp.definition || proposal.definition || {};
        const candidates = [
            rp.polygon,
            rp.superGeometry,
            rp.geometry,
            def.polygon,
            proposal.geometry && proposal.geometry.roadGeometry && proposal.geometry.roadGeometry.polygon
        ];
        for (const candidate of candidates) {
            const resolved = fromGeometry(candidate);
            if (resolved) return { ...resolved, fitToPolygonOnly: true };
        }

        // Last resort: buffer the centerline by half the road width to synthesise a polygon.
        const points = Array.isArray(def.points) ? def.points : [];
        const width = Number.isFinite(Number(def.width)) ? Number(def.width) : 0;
        if (points.length >= 2 && width > 0 && typeof turf !== 'undefined' && typeof turf.lineString === 'function' && typeof turf.buffer === 'function') {
            try {
                const coords = points
                    .map(p => {
                        const lng = Number(p && (p.lng ?? p.lon ?? p.longitude ?? p[0]));
                        const lat = Number(p && (p.lat ?? p.latitude ?? p[1]));
                        return Number.isFinite(lat) && Number.isFinite(lng) ? [lng, lat] : null;
                    })
                    .filter(Boolean);
                if (coords.length >= 2) {
                    const line = turf.lineString(coords);
                    const buffered = turf.buffer(line, width / 2, { units: 'meters' });
                    const resolved = fromGeometry(buffered && buffered.geometry);
                    if (resolved) return { ...resolved, fitToPolygonOnly: true };
                }
            } catch (err) {
                console.warn('[proposal screenshot] Failed to buffer road centerline:', err);
            }
        }
    }

    if (proposal.buildingGeometry) {
        const resolved = fromGeometry(proposal.buildingGeometry);
        if (resolved) return resolved;
    }

    if (proposal.structureProposal && proposal.structureProposal.geometry) {
        const resolved = fromGeometry(proposal.structureProposal.geometry);
        if (resolved) return resolved;
    }

    // Reparcellization: union the slice geometries so the screenshot frames the whole carve-up.
    if (proposal.reparcellization && Array.isArray(proposal.reparcellization.polygons) && proposal.reparcellization.polygons.length) {
        const slices = proposal.reparcellization.polygons
            .map(s => s && s.geometry)
            .filter(g => g && g.coordinates && (g.type === 'Polygon' || g.type === 'MultiPolygon'));
        if (slices.length === 1) {
            const resolved = fromGeometry(slices[0]);
            if (resolved) return resolved;
        } else if (slices.length > 1 && typeof turf !== 'undefined' && typeof turf.union === 'function') {
            try {
                let merged = null;
                slices.forEach(geom => {
                    const feature = { type: 'Feature', properties: {}, geometry: geom };
                    merged = merged ? (turf.union(merged, feature) || merged) : feature;
                });
                if (merged && merged.geometry) {
                    const resolved = fromGeometry(merged.geometry);
                    if (resolved) return resolved;
                }
            } catch (err) {
                console.warn('[proposal screenshot] turf.union failed for reparcellization slices:', err);
                const resolved = fromGeometry(slices[0]);
                if (resolved) return resolved;
            }
        }
    }

    if (proposal.geometry && (proposal.geometry.type === 'Polygon' || proposal.geometry.type === 'MultiPolygon')) {
        const resolved = fromGeometry(proposal.geometry);
        if (resolved) return resolved;
    }

    // Generic geometry collection fallback (e.g. parcel-only or reparcellization proposals)
    if (proposal.geometry && proposal.geometry.buildings && Array.isArray(proposal.geometry.buildings)) {
        for (const f of proposal.geometry.buildings) {
            const resolved = fromGeometry(f && f.geometry);
            if (resolved) return resolved;
        }
    }

    return { polygon: null };
}

async function reconstructProposalScreenshotDataUrl(proposal) {
    if (!proposal) return null;
    if (!window.MapScreenshot || typeof window.MapScreenshot.captureViaTileStitch !== 'function') return null;

    const goalKey = normalizeGoalKey(proposal.goal || proposal.proposalType || '');

    // Best-effort: load parent parcel *features only* — without ingesting them into the map layer.
    // This avoids any side effects on the map view while we generate the thumbnail.
    const parentParcelIds = Array.isArray(proposal.parentParcelIds)
        ? proposal.parentParcelIds.map(String).filter(Boolean)
        : (Array.isArray(proposal.roadProposal?.parentParcelIds)
            ? proposal.roadProposal.parentParcelIds.map(String).filter(Boolean)
            : []);

    let parentFeatures = [];
    if (parentParcelIds.length && typeof window.fetchParcelFeaturesByIds === 'function') {
        try { parentFeatures = await window.fetchParcelFeaturesByIds(parentParcelIds); } catch (_) { }
    }

    const parentPolygonsFromFeatures = (() => {
        const polys = [];
        for (const f of parentFeatures || []) {
            const geom = f && f.geometry;
            if (!geom || !geom.coordinates) continue;
            if (geom.type === 'Polygon') polys.push(geom.coordinates);
            else if (geom.type === 'MultiPolygon') geom.coordinates.forEach(p => polys.push(p));
        }
        return polys;
    })();

    let { polygon, polygonOrder, fitToPolygonOnly } = resolveProposalPolygonForScreenshot(proposal);

    // For plain parcel-only proposals (no building/structure/road), use the union of parent parcels
    // as the highlighted polygon so the screenshot frames them.
    if (!polygon && parentParcelIds.length) {
        const parentPolys = parentPolygonsFromFeatures.length
            ? parentPolygonsFromFeatures
            : collectParcelPolygonsFromParcelLayer(parentParcelIds);
        if (parentPolys.length === 1) {
            polygon = parentPolys[0];
            polygonOrder = 'lnglat';
        } else if (parentPolys.length > 1 && typeof turf !== 'undefined' && typeof turf.union === 'function') {
            try {
                let merged = null;
                parentPolys.forEach(coords => {
                    const feature = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: coords } };
                    merged = merged ? (turf.union(merged, feature) || merged) : feature;
                });
                if (merged && merged.geometry) {
                    if (merged.geometry.type === 'Polygon') polygon = merged.geometry.coordinates;
                    else if (merged.geometry.type === 'MultiPolygon') polygon = merged.geometry.coordinates[0];
                    polygonOrder = 'lnglat';
                }
            } catch (err) {
                console.warn('[proposal screenshot] turf.union failed for parent parcels:', err);
                polygon = parentPolys[0];
                polygonOrder = 'lnglat';
            }
        }
    }

    if (!polygon) {
        console.warn('[proposal screenshot] No polygon could be resolved for proposal', proposal.proposalId);
        return null;
    }

    const bounds = computeLatLngBoundsFromGeoJsonPolygon(polygon);
    if (!bounds || (typeof bounds.isValid === 'function' && !bounds.isValid())) {
        console.warn('[proposal screenshot] Could not derive bounds for proposal', proposal.proposalId);
        return null;
    }

    // Decide what goes into parcelPolygons (these expand the bbox so they're fully framed) vs neighbours
    // (drawn as outlines only, never expand bbox):
    //   - Building proposals: parent parcel(s) go in parcelPolygons so the parcel stays in view.
    //     The building footprint is the highlighted `polygon`.
    //   - Other proposals: don't add parent parcels to parcelPolygons (they're already in `polygon` or
    //     are the road corridor's context). Just pull surrounding parcels in as neighbours.
    const isBuildingProposal = !!(proposal.buildingGeometry || proposal.buildingProposal);
    let parcelPolygons = [];
    if (isBuildingProposal) {
        parcelPolygons = parentPolygonsFromFeatures.length
            ? parentPolygonsFromFeatures
            : collectParcelPolygonsFromParcelLayer(parentParcelIds);
    }

    // For road proposals where parent parcels weren't pre-loaded, surrounding parcels still help
    // to give borders. Don't expand the bounds — they're context only via the neighbours channel.
    const boundsForContext = (() => {
        if (!bounds || typeof bounds.pad !== 'function') return bounds;
        try { return bounds.pad(0.5); } catch (_) { return bounds; }
    })();
    const neighbours = collectNeighbourPolygonsByBounds(boundsForContext || bounds, {
        limit: 200,
        excludeIds: new Set(parentParcelIds)
    });

    const badge = getProposalGoalBadge(goalKey);

    try {
        return await window.MapScreenshot.captureViaTileStitch({
            polygon,
            parcelPolygons,
            neighbours,
            bounds,
            padding: 0.12,
            zoom: 19,
            badge,
            polygonOrder: polygonOrder || 'auto',
            parcelPolygonOrder: 'auto',
            fitToPolygonOnly: !!fitToPolygonOnly
        });
    } catch (err) {
        console.warn('[proposal screenshot] captureViaTileStitch failed:', err);
        return null;
    }
}

async function triggerProposalScreenshotRegeneration(proposalId) {
    if (!proposalId) return null;
    if (_proposalScreenshotInFlight.has(proposalId)) return null;
    _proposalScreenshotInFlight.add(proposalId);

    // Mark placeholders as busy
    document.querySelectorAll(`.proposal-thumb[data-proposal-id="${CSS.escape(String(proposalId))}"]`)
        .forEach(node => node.classList.add('proposal-thumb-loading'));

    try {
        return await captureAndPersistProposalScreenshot(proposalId, {
            force: true,
            allowModalCache: false
        });
    } finally {
        _proposalScreenshotInFlight.delete(proposalId);
        document.querySelectorAll(`.proposal-thumb[data-proposal-id="${CSS.escape(String(proposalId))}"]`)
            .forEach(node => node.classList.remove('proposal-thumb-loading'));
    }
}

function buildProposalScreenshotContext(parcelLayers = [], options = {}) {
    if (window?.__DEBUG_SCREENSHOT_CONTEXT__) {
        console.debug('[buildProposalScreenshotContext]', {
            parcelLayersCount: parcelLayers?.length,
            options: { goal: options.goal, hasRoadContext: !!options.roadContext }
        });
    }
    const goalKey = (typeof normalizeGoalKey === 'function') ? normalizeGoalKey(options.goal) : (options.goal || '');
    const roadContext = options.roadContext || null;
    const hasParcels = Array.isArray(parcelLayers) && parcelLayers.length > 0;
    if (!hasParcels && !roadContext) {
        return null;
    }

    const parcelPolygons = [];
    let polygonOrder = 'auto';
    let parcelPolygonOrder = 'auto';
    if (hasParcels) {
        parcelLayers.forEach(layer => {
            const geom = layer?.feature?.geometry;
            if (!geom || !geom.coordinates) return;
            if (geom.type === 'Polygon' && Array.isArray(geom.coordinates)) {
                parcelPolygons.push(geom.coordinates);
            } else if (geom.type === 'MultiPolygon' && Array.isArray(geom.coordinates)) {
                geom.coordinates.forEach(poly => {
                    if (Array.isArray(poly)) {
                        parcelPolygons.push(poly);
                    }
                });
            }
        });
    }

    let polygon = null;
    const geometry = hasParcels ? buildGeometryFromParcels(parcelLayers) : null;
    if (geometry && Array.isArray(geometry.coordinates) && geometry.coordinates.length) {
        polygon = geometry.coordinates;
    } else if (parcelPolygons.length) {
        polygon = parcelPolygons[0];
    }

    const buildBoundsFromCoords = (coords) => {
        if (!coords || typeof L === 'undefined' || !L.latLngBounds) return null;
        const latLngs = [];
        const collect = (node) => {
            if (!Array.isArray(node) || !node.length) return;
            if (node.length >= 2 && Number.isFinite(node[0]) && Number.isFinite(node[1])) {
                const lat = Math.abs(node[0]) <= 90 ? node[0] : node[1];
                const lng = Math.abs(node[0]) <= 90 ? node[1] : node[0];
                latLngs.push(L.latLng(lat, lng));
                return;
            }
            node.forEach(collect);
        };
        collect(coords);
        return latLngs.length ? L.latLngBounds(latLngs) : null;
    };

    let bounds = null;
    if (hasParcels && typeof L !== 'undefined' && L.latLngBounds) {
        parcelLayers.forEach(layer => {
            try {
                if (layer && typeof layer.getBounds === 'function') {
                    const layerBounds = layer.getBounds();
                    if (layerBounds && typeof layerBounds.isValid === 'function' && layerBounds.isValid()) {
                        if (!bounds) {
                            bounds = layerBounds.clone ? layerBounds.clone() : L.latLngBounds(layerBounds);
                        } else {
                            bounds.extend(layerBounds);
                        }
                    }
                }
            } catch (err) {
                console.warn('Failed to extend screenshot bounds from parcel layer', err);
            }
        });
    }

    let fitToPolygonOnly = false;

    if (goalKey === 'road-track' && roadContext) {
        // roadContext.polygon is a GeoJSON object with coordinates in [lng, lat] order
        // Use it directly - no conversion needed
        const roadPolygon = roadContext.polygon || roadContext.superGeometry || roadContext.geometry || null;

        if (roadPolygon && roadPolygon.coordinates) {
            // GeoJSON polygon - coordinates are already in [lng, lat] order
            polygon = roadPolygon.coordinates;
            // Use explicit order from roadContext if provided, otherwise assume GeoJSON standard
            polygonOrder = roadContext.polygonOrder || 'lnglat';
            fitToPolygonOnly = true;

            // Build bounds from GeoJSON coordinates [lng, lat]
            const flatCoords = Array.isArray(roadPolygon.coordinates[0]) && Array.isArray(roadPolygon.coordinates[0][0])
                ? roadPolygon.coordinates[0] // Polygon: [[ring]]
                : roadPolygon.coordinates;   // Simple array
            if (Array.isArray(flatCoords) && flatCoords.length > 0) {
                let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
                flatCoords.forEach(coord => {
                    if (Array.isArray(coord) && coord.length >= 2) {
                        // GeoJSON order: [lng, lat]
                        const lng = coord[0], lat = coord[1];
                        if (Number.isFinite(lng) && Number.isFinite(lat)) {
                            if (lng < minLng) minLng = lng;
                            if (lng > maxLng) maxLng = lng;
                            if (lat < minLat) minLat = lat;
                            if (lat > maxLat) maxLat = lat;
                        }
                    }
                });
                if (Number.isFinite(minLat) && Number.isFinite(maxLat) && Number.isFinite(minLng) && Number.isFinite(maxLng)) {
                    bounds = L.latLngBounds([[minLat, minLng], [maxLat, maxLng]]);
                }
            }
            parcelPolygonOrder = 'auto';

            if (window?.__DEBUG_SCREENSHOT_CONTEXT__) {
                console.debug('[buildProposalScreenshotContext] road polygon resolved', {
                    type: roadPolygon.type,
                    coordsLength: roadPolygon.coordinates?.[0]?.length,
                    firstCoord: roadPolygon.coordinates?.[0]?.[0],
                    polygonOrder,
                    expectedForZagreb: 'firstCoord should be [lng ~15.97, lat ~45.80]',
                    bounds: bounds ? { sw: bounds.getSouthWest(), ne: bounds.getNorthEast() } : null
                });
            }
        }
    }

    // Fallback: if the road/track flow did not seed parcel selection, derive parcel outlines from the parent parcel ids
    if (goalKey === 'road-track' && roadContext && parcelPolygons.length === 0 && Array.isArray(roadContext.parentParcelIds) && roadContext.parentParcelIds.length) {
        const ids = roadContext.parentParcelIds
            .map(id => (id ? id.toString() : null))
            .filter(Boolean);

        const findLayerById = (parcelId) => {
            if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection && typeof multiParcelSelection.findParcelById === 'function') {
                const layer = multiParcelSelection.findParcelById(parcelId);
                if (layer) return layer;
            }
            if (typeof parcelLayer !== 'undefined' && parcelLayer && typeof parcelLayer.getLayers === 'function') {
                const layers = parcelLayer.getLayers();
                for (const layer of layers) {
                    const id = getParcelIdFromFeature(layer?.feature);
                    if (id && id.toString() === parcelId) {
                        return layer;
                    }
                }
            }
            return null;
        };

        ids.forEach(id => {
            const layer = findLayerById(id);
            if (!layer) return;
            try {
                const geom = layer?.feature?.geometry;
                if (geom?.type === 'Polygon' && Array.isArray(geom.coordinates)) {
                    parcelPolygons.push(geom.coordinates);
                } else if (geom?.type === 'MultiPolygon' && Array.isArray(geom.coordinates)) {
                    geom.coordinates.forEach(coords => {
                        if (Array.isArray(coords)) parcelPolygons.push(coords);
                    });
                }

                if (!bounds && typeof layer.getBounds === 'function') {
                    const b = layer.getBounds();
                    if (b && typeof b.isValid === 'function' && b.isValid()) {
                        bounds = b.clone ? b.clone() : b;
                    }
                }
            } catch (err) {
                console.warn('Failed to derive parcel outline for road/track screenshot', err);
            }
        });
    }
    if (window?.__DEBUG_SCREENSHOT_CONTEXT__) {
        console.debug('[buildProposalScreenshotContext] summary', {
            hasPolygon: !!polygon,
            polygonLength: polygon?.length || polygon?.[0]?.length,
            parcelPolygonsCount: parcelPolygons.length,
            hasBounds: !!bounds,
            polygonOrder,
            parcelPolygonOrder,
            fitToPolygonOnly
        });
    }

    const appendParcelsFromLayer = (target = [], targetBounds = null, limit = 150) => {
        const parcelLayer = (typeof window !== 'undefined' && window.parcelLayer)
            || (typeof window !== 'undefined' && window.parcelState && typeof window.parcelState.getParcelLayer === 'function' && window.parcelState.getParcelLayer())
            || null;
        if (!parcelLayer || !targetBounds || typeof targetBounds.intersects !== 'function' || typeof parcelLayer.getLayers !== 'function') return target;
        const layers = parcelLayer.getLayers();
        for (const layer of layers) {
            if (target.length >= limit) break;
            const lb = (layer && typeof layer.getBounds === 'function') ? layer.getBounds() : null;
            if (!lb || !targetBounds.intersects(lb)) continue;
            const geom = layer?.feature?.geometry;
            if (!geom || !geom.coordinates) continue;
            if (geom.type === 'Polygon' && Array.isArray(geom.coordinates)) {
                target.push(geom.coordinates);
            } else if (geom.type === 'MultiPolygon' && Array.isArray(geom.coordinates)) {
                geom.coordinates.forEach(poly => {
                    if (Array.isArray(poly)) target.push(poly);
                });
            }
        }
        return target;
    };

    // If we have a road geometry but no parcel outlines yet, pull nearby parcels from the current layer so borders are visible.
    if (fitToPolygonOnly && parcelPolygons.length === 0 && bounds && typeof bounds.isValid === 'function' && bounds.isValid()) {
        appendParcelsFromLayer(parcelPolygons, bounds, 200);
    }

    if (!polygon) return null;

    // Compute neighbour polygons from the client-side parcel cache
    let neighbours = [];
    if (hasParcels && typeof window.findNeighbourPolygonsFromCache === 'function') {
        const selectedIds = new Set();
        parcelLayers.forEach(layer => {
            const id = getParcelIdFromFeature(layer?.feature);
            if (id) selectedIds.add(id.toString());
        });
        selectedIds.forEach(parcelId => {
            const found = window.findNeighbourPolygonsFromCache(parcelId);
            if (Array.isArray(found)) {
                found.forEach(ring => neighbours.push(ring));
            }
        });
    }

    // For road geometry we convert to [lat, lng] pairs; otherwise let downstream normalize
    return { polygon, parcelPolygons, neighbours, bounds, fitToPolygonOnly, polygonOrder, parcelPolygonOrder };
}

async function showMissingParcelsModal(missingParcels, chainName) {
    return new Promise((resolve) => {
        const t = getProposalI18nHelper();
        setProposalModalDimmed(true);

        const overlay = document.createElement('div');
        overlay.className = 'cb-confirm-overlay';
        // Must sit above create-proposal-modal (z-index 11000)
        overlay.style.position = 'fixed';
        overlay.style.inset = '0';
        overlay.style.zIndex = '50000';
        overlay.style.background = 'rgba(15, 23, 42, 0.45)';
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';

        const dialog = document.createElement('div');
        dialog.className = 'cb-confirm-dialog';
        dialog.style.maxWidth = '600px';
        dialog.style.position = 'relative';
        dialog.style.zIndex = '50001';

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'close-circle-btn close-circle-btn--lg';
        closeBtn.setAttribute('aria-label', t('modal.createProposal.walletNotConnected.cancel', 'Cancel'));
        closeBtn.innerHTML = '&times;';
        closeBtn.style.position = 'absolute';
        closeBtn.style.top = '8px';
        closeBtn.style.right = '8px';

        const message = document.createElement('div');
        message.className = 'cb-confirm-message';
        message.style.marginBottom = '20px';

        const chainDisplay = chainName || t('modal.createProposal.missingParcels.defaultChain', 'the blockchain');
        const overflowLabel = missingParcels.length > 10
            ? t('modal.createProposal.missingParcels.more', ', and {{count}} more...', {
                count: missingParcels.length - 10
            })
            : '';
        const parcelList = missingParcels.length > 10
            ? `${missingParcels.slice(0, 10).join(', ')}${overflowLabel}`
            : missingParcels.join(', ');
        const messageKey = missingParcels.length === 1 ? 'messageSingle' : 'messagePlural';
        const introMessage = t(
            `modal.createProposal.missingParcels.${messageKey}`,
            missingParcels.length === 1
                ? 'The following parcel is not represented as an NFT on <strong>{{chain}}</strong>, so a proposal for it cannot be minted on-chain:'
                : 'The following parcels are not represented as NFTs on <strong>{{chain}}</strong>, so a proposal for them cannot be minted on-chain:',
            { chain: chainDisplay }
        );
        const proceedPrompt = t(
            'modal.createProposal.missingParcels.proceedQuestion',
            'Proceed to create an in-memory proposal?'
        );
        const explainerText = t(
            'modal.createProposal.missingParcels.explainer',
            "You can create an in-memory proposal or proceed to mint the prerequisite parcels. Minting does not confer ownership, it only creates an on-chain representation. Anyone can mint any parcel to onboard it onto the platform. You can also mint them from the Parcel Info panel's Tools tab."
        );

        message.innerHTML = `
            <p style="margin-bottom: 12px;">${introMessage}</p>
            <div style="background: #f5f5f5; padding: 12px; border-radius: 6px; margin: 12px 0; max-height: 200px; overflow-y: auto; font-family: monospace; font-size: 12px;">
                ${parcelList}
            </div>
            <p style="margin-top: 12px; margin-bottom: 12px; padding: 12px; background: #e3f2fd; border-left: 4px solid #2196f3; border-radius: 4px; color: #1565c0;">
                ${explainerText}
            </p>
            <p style="margin-top: 12px;">${proceedPrompt}</p>
        `;

        const buttons = document.createElement('div');
        buttons.className = 'cb-confirm-buttons';
        buttons.style.display = 'flex';
        buttons.style.gap = '10px';
        buttons.style.justifyContent = 'flex-end';

        const createInMemoryBtn = document.createElement('button');
        createInMemoryBtn.type = 'button';
        createInMemoryBtn.className = 'btn btn-secondary';
        createInMemoryBtn.textContent = t('modal.createProposal.missingParcels.createInMemory', 'Create in memory');

        const mintPrereqBtn = document.createElement('button');
        mintPrereqBtn.type = 'button';
        mintPrereqBtn.className = 'btn btn-action';
        mintPrereqBtn.textContent = t('modal.createProposal.missingParcels.mintPrerequisites', 'Mint the prerequisites');

        function cleanup(result) {
            if (overlay && overlay.parentNode) {
                overlay.parentNode.removeChild(overlay);
            }
            setProposalModalDimmed(false);
            resolve(result);
        }

        createInMemoryBtn.addEventListener('click', () => cleanup('memory'));
        mintPrereqBtn.addEventListener('click', () => cleanup('mint'));
        closeBtn.addEventListener('click', () => cleanup('cancel'));
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                cleanup('cancel');
            }
        });

        buttons.appendChild(createInMemoryBtn);
        buttons.appendChild(mintPrereqBtn);
        dialog.appendChild(closeBtn);
        dialog.appendChild(message);
        dialog.appendChild(buttons);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    });
}

function showUploadProposalModal(proposal) {
    if (typeof document === 'undefined' || !proposal) return;

    const t = getProposalI18nHelper();
    const tShare = getShareI18nHelper();

    // Get frontend base URL (urbangametheory.xyz or localhost)
    const fragment = document.createDocumentFragment();

    const uploadSuccessText = tShare('uploadSuccess', 'Proposal uploaded! You can now share it with others');
    const uploadButtonLabel = tShare('uploadButton', 'Upload');
    const connectWalletLabel = tShare('connectWalletButton', 'Connect Wallet');
    const mintActionLabel = tShare('mintButton', 'Mint');
    const downloadButtonLabel = tShare('downloadButton', 'Download');

    // Rows container for stable layout
    const rowsContainer = document.createElement('div');
    rowsContainer.style.display = 'flex';
    rowsContainer.style.flexDirection = 'column';
    rowsContainer.style.gap = '0.75rem';
    rowsContainer.style.marginBottom = '1.25rem';

    // Upload row
    const uploadRow = document.createElement('div');
    uploadRow.style.display = 'flex';
    uploadRow.style.gap = '0.5rem';
    uploadRow.style.alignItems = 'center';
    uploadRow.style.width = '100%';

    const uploadButton = document.createElement('button');
    uploadButton.type = 'button';
    uploadButton.className = 'btn share-modal-primary';
    uploadButton.textContent = uploadButtonLabel;
    uploadButton.style.flex = '1';
    uploadButton.style.display = 'flex';
    uploadButton.style.justifyContent = 'center';
    uploadButton.style.alignItems = 'center';
    uploadButton.style.textAlign = 'center';
    uploadRow.appendChild(uploadButton);

    const uploadLinkGroup = document.createElement('div');
    uploadLinkGroup.style.display = 'none';
    uploadLinkGroup.style.flex = '1';
    uploadLinkGroup.style.gap = '0.5rem';
    uploadLinkGroup.style.alignItems = 'center';
    uploadLinkGroup.style.minWidth = '0';
    uploadLinkGroup.style.width = '100%';

    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.readOnly = true;
    urlInput.className = 'share-modal-link';
    urlInput.style.flex = '1';
    urlInput.style.padding = '0.5rem 0.75rem';
    urlInput.style.border = '1px solid #d8ddf0';
    urlInput.style.borderRadius = '8px';
    urlInput.style.height = 'auto';
    urlInput.style.lineHeight = '1.5';
    urlInput.style.minHeight = '38px';
    urlInput.style.maxHeight = '38px';
    urlInput.style.fontSize = '13px';
    urlInput.style.fontFamily = 'inherit';
    urlInput.style.background = '#f7f8fb';
    urlInput.style.color = '#212744';
    urlInput.style.boxSizing = 'border-box';

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'btn share-modal-secondary';
    copyButton.textContent = tShare('copyUrlButton', 'Copy URL');
    copyButton.style.height = '38px';
    copyButton.style.minHeight = '38px';
    copyButton.style.maxHeight = '38px';
    copyButton.style.padding = '0.5rem 1rem';
    copyButton.style.lineHeight = '1.5';
    copyButton.style.whiteSpace = 'nowrap';
    copyButton.style.textAlign = 'center';
    copyButton.addEventListener('click', () => {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(urlInput.value).then(() => {
                if (typeof showEphemeralMessage === 'function') {
                    showEphemeralMessage(tShare('copySuccess', 'Share link copied to clipboard!'));
                }
            }).catch(() => {
                urlInput.focus();
                urlInput.select();
            });
        } else {
            urlInput.focus();
            urlInput.select();
        }
    });

    uploadLinkGroup.appendChild(urlInput);
    uploadLinkGroup.appendChild(copyButton);
    uploadRow.appendChild(uploadLinkGroup);
    rowsContainer.appendChild(uploadRow);

    // Mint row
    const mintRow = document.createElement('div');
    mintRow.style.display = 'flex';
    mintRow.style.gap = '0.5rem';
    mintRow.style.alignItems = 'center';
    mintRow.style.width = '100%';

    const mintButton = document.createElement('button');
    mintButton.type = 'button';
    mintButton.className = 'btn share-modal-primary';
    mintButton.style.flex = '1';
    mintButton.style.display = 'flex';
    mintButton.style.justifyContent = 'center';
    mintButton.style.alignItems = 'center';
    mintButton.style.textAlign = 'center';
    mintRow.appendChild(mintButton);

    const mintedLinkGroup = document.createElement('div');
    mintedLinkGroup.style.display = 'none';
    mintedLinkGroup.style.flex = '1';
    mintedLinkGroup.style.gap = '0.5rem';
    mintedLinkGroup.style.alignItems = 'center';
    mintedLinkGroup.style.minWidth = '0';
    mintedLinkGroup.style.width = '100%';

    const mintedLinkInput = document.createElement('input');
    mintedLinkInput.type = 'text';
    mintedLinkInput.readOnly = true;
    mintedLinkInput.className = 'share-modal-link';
    mintedLinkInput.style.flex = '1';
    mintedLinkInput.style.padding = '0.5rem 0.75rem';
    mintedLinkInput.style.border = '1px solid #d8ddf0';
    mintedLinkInput.style.borderRadius = '8px';
    mintedLinkInput.style.height = 'auto';
    mintedLinkInput.style.lineHeight = '1.5';
    mintedLinkInput.style.minHeight = '38px';
    mintedLinkInput.style.maxHeight = '38px';
    mintedLinkInput.style.fontSize = '13px';
    mintedLinkInput.style.fontFamily = 'inherit';
    mintedLinkInput.style.background = '#f7f8fb';
    mintedLinkInput.style.color = '#212744';
    mintedLinkInput.style.boxSizing = 'border-box';

    const mintedCopyButton = document.createElement('button');
    mintedCopyButton.type = 'button';
    mintedCopyButton.className = 'btn share-modal-secondary';
    mintedCopyButton.textContent = tShare('copyUrlButton', 'Copy URL');
    mintedCopyButton.style.height = '38px';
    mintedCopyButton.style.minHeight = '38px';
    mintedCopyButton.style.maxHeight = '38px';
    mintedCopyButton.style.padding = '0.5rem 1rem';
    mintedCopyButton.style.lineHeight = '1.5';
    mintedCopyButton.style.whiteSpace = 'nowrap';
    mintedCopyButton.style.textAlign = 'center';
    mintedCopyButton.addEventListener('click', () => {
        if (!mintedLinkInput.value) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(mintedLinkInput.value).then(() => {
                if (typeof showEphemeralMessage === 'function') {
                    showEphemeralMessage(tShare('copySuccess', 'Share link copied to clipboard!'));
                }
            }).catch(() => {
                mintedLinkInput.focus();
                mintedLinkInput.select();
            });
        } else {
            mintedLinkInput.focus();
            mintedLinkInput.select();
        }
    });

    mintedLinkGroup.appendChild(mintedLinkInput);
    mintedLinkGroup.appendChild(mintedCopyButton);
    mintRow.appendChild(mintedLinkGroup);
    rowsContainer.appendChild(mintRow);

    // Download row
    const downloadRow = document.createElement('div');
    downloadRow.style.display = 'flex';
    downloadRow.style.alignItems = 'center';
    downloadRow.style.width = '100%';

    const downloadButton = document.createElement('button');
    downloadButton.type = 'button';
    downloadButton.className = 'btn share-modal-secondary';
    downloadButton.textContent = downloadButtonLabel;
    downloadButton.style.flex = '1';
    downloadButton.style.textAlign = 'center';
    downloadRow.appendChild(downloadButton);

    rowsContainer.appendChild(downloadRow);
    fragment.appendChild(rowsContainer);

    // Status message container
    const uploadStatus = document.createElement('div');
    uploadStatus.style.marginBottom = '0.75rem';
    uploadStatus.style.fontSize = '12px';
    uploadStatus.style.color = '#b3261e';
    uploadStatus.style.lineHeight = '1.4';
    fragment.appendChild(uploadStatus);

    const shareActionsContainer = document.createElement('div');
    shareActionsContainer.className = 'share-modal-share-actions';
    shareActionsContainer.style.display = 'none';
    shareActionsContainer.style.marginTop = '1rem';
    shareActionsContainer.style.width = '100%';

    const shareLabel = document.createElement('div');
    shareLabel.textContent = tShare('shareViaLabel', 'Share via');
    shareLabel.style.fontWeight = '600';
    shareLabel.style.marginBottom = '0.5rem';
    shareActionsContainer.appendChild(shareLabel);

    const shareButtonsRow = document.createElement('div');
    shareButtonsRow.style.display = 'flex';
    shareButtonsRow.style.gap = '0.5rem';
    shareButtonsRow.style.flexWrap = 'wrap';
    shareButtonsRow.style.width = '100%';

    const tweetButton = document.createElement('button');
    tweetButton.type = 'button';
    tweetButton.className = 'btn share-modal-secondary';
    tweetButton.textContent = tShare('tweetButton', 'Tweet this proposal');
    tweetButton.style.flex = '1 1 0';
    tweetButton.style.minWidth = '0';
    tweetButton.style.textAlign = 'center';
    tweetButton.addEventListener('click', () => {
        const urlToShare = urlInput.value || '';
        if (!urlToShare) return;
        const tweetText = tShare('tweetText', 'I have created a new urban proposal!');
        const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}&url=${encodeURIComponent(urlToShare)}`;
        window.open(tweetUrl, '_blank', 'noopener,noreferrer');
    });
    shareButtonsRow.appendChild(tweetButton);

    const nativeShareButton = document.createElement('button');
    nativeShareButton.type = 'button';
    nativeShareButton.className = 'btn share-modal-secondary';
    nativeShareButton.textContent = tShare('nativeShareButton', 'Share...');
    nativeShareButton.style.flex = '1 1 0';
    nativeShareButton.style.minWidth = '0';
    nativeShareButton.style.textAlign = 'center';
    nativeShareButton.addEventListener('click', async () => {
        const urlToShare = urlInput.value || '';
        const shareText = tShare('tweetText', 'I have created a new urban proposal!');
        if (navigator.share && urlToShare) {
            try {
                await navigator.share({
                    title: tShare('title', 'Share Proposal'),
                    text: shareText,
                    url: urlToShare
                });
            } catch (err) {
                console.warn('Native share failed', err);
            }
            return;
        }

        if (navigator.clipboard && navigator.clipboard.writeText && urlToShare) {
            navigator.clipboard.writeText(urlToShare).then(() => {
                if (typeof showEphemeralMessage === 'function') {
                    showEphemeralMessage(tShare('copySuccess', 'Share link copied to clipboard!'));
                }
            }).catch(() => {
                urlInput.focus();
                urlInput.select();
            });
        } else {
            urlInput.focus();
            urlInput.select();
        }
    });
    shareButtonsRow.appendChild(nativeShareButton);

    shareActionsContainer.appendChild(shareButtonsRow);
    fragment.appendChild(shareActionsContainer);

    const cityQueryParam = buildCityQueryParam();
    let uploadedId = null;
    let shareUrl = null;
    let mintedExplorerUrl = null;

    const isWalletConnected = () => {
        if (!window.walletManager || typeof window.walletManager.getState !== 'function') return false;
        const walletState = window.walletManager.getState();
        return walletState && walletState.status === 'connected'
            && Array.isArray(walletState.accounts) && walletState.accounts.length > 0;
    };

    const computeShareUrlFromProposal = () => {
        try {
            const serverId = typeof getServerProposalId === 'function'
                ? getServerProposalId(proposal)
                : (proposal && (proposal.serverProposalId || proposal.id));
            if (serverId && /^\d+$/.test(String(serverId))) {
                return `${resolveFrontendBaseUrl()}/proposals/${serverId}${cityQueryParam}`;
            }
            return null;
        } catch (err) {
            console.warn('Failed to compute share URL', err);
            return null;
        }
    };

    const updateUploadRowUi = () => {
        shareUrl = computeShareUrlFromProposal() || shareUrl;
        const hasShareUrl = !!shareUrl;
        uploadButton.style.display = hasShareUrl ? 'none' : 'inline-flex';
        uploadLinkGroup.style.display = hasShareUrl ? 'flex' : 'none';
        urlInput.value = shareUrl || '';
        shareActionsContainer.style.display = hasShareUrl ? 'block' : 'none';
    };

    const refreshMintRowUi = () => {
        const existingNft = typeof getProposalNftInfo === 'function' ? getProposalNftInfo(proposal) : null;
        const hasMinted = existingNft && existingNft.tokenId;
        if (hasMinted) {
            mintedExplorerUrl = typeof buildProposalNftExplorerUrl === 'function' ? buildProposalNftExplorerUrl(proposal) : '';
            const fallbackLink = existingNft && existingNft.tokenId ? String(existingNft.tokenId) : '';
            mintedLinkInput.value = mintedExplorerUrl || fallbackLink;
            mintButton.style.display = 'none';
            mintedLinkGroup.style.display = 'flex';
            mintButton.disabled = true;
            return;
        }

        mintedExplorerUrl = null;
        mintedLinkInput.value = '';
        mintButton.style.display = 'inline-flex';
        mintedLinkGroup.style.display = 'none';
        mintButton.disabled = false;

        const connected = isWalletConnected();
        mintButton.textContent = connected
            ? tShare('mintButton', 'Mint')
            : tShare('connectWalletButton', 'Connect Wallet');
    };

    refreshMintRowUi();
    updateUploadRowUi();

    // Keep mint button label in sync with wallet state (only if not minted)
    let detachWalletStateListener = null;
    let lastWalletConnected = isWalletConnected();
    const handleWalletStateChange = () => {
        const connected = isWalletConnected();
        const justConnected = connected && !lastWalletConnected;
        lastWalletConnected = connected;
        refreshMintRowUi();
        if (justConnected && uploadStatus) {
            uploadStatus.style.color = '#2b3954';
            uploadStatus.textContent = tShare('walletConnectedStatus', 'Wallet connected. You can proceed to mint the proposal');
        }
    };
    if (window.walletManager && typeof window.walletManager.on === 'function') {
        detachWalletStateListener = window.walletManager.on('stateChanged', () => handleWalletStateChange());
    }

    async function enforceUploadAncestryGate() {
        try {
            const gate = await ensureAncestorProposalsUploaded(proposal);
            if (!gate.ok) {
                const ancestorList = gate.missing.map(item => item.id || (item.hash ? item.hash.slice(0, 8) : '?')).filter(Boolean);
                const suffix = ancestorList.length === 1 ? '' : 's';
                uploadButton.disabled = true;
                uploadButton.classList.add('disabled');
                uploadButton.title = tShare('uploadAncestorsMissingTitle', 'Upload ancestor proposals first.');
                uploadStatus.textContent = tShare('uploadAncestorsMissing', 'Upload ancestor proposal{{suffix}} first: {{list}}', {
                    suffix,
                    list: ancestorList.join(', ')
                });
            } else {
                uploadButton.disabled = false;
                uploadButton.classList.remove('disabled');
                uploadButton.title = '';
                uploadStatus.textContent = '';
            }
        } catch (error) {
            console.warn('Failed to enforce upload ancestor gate', error);
            uploadButton.disabled = true;
            uploadButton.classList.add('disabled');
            uploadStatus.textContent = tShare('uploadAncestorsCheckFailed', 'Could not verify ancestor uploads. Please retry.');
        }
    }

    enforceUploadAncestryGate();

    // Upload handler
    uploadButton.addEventListener('click', async () => {
        if (uploadButton.disabled) return;

        uploadButton.disabled = true;
        uploadButton.textContent = tShare('uploading', 'Uploading...');
        uploadButton.style.opacity = '0.7';
        uploadButton.style.cursor = 'not-allowed';

        try {
            const uploadProposal = buildUploadReadyProposal(proposal);

            console.log('[showUploadProposalModal] Proposal before upload:', {
                hasRoadProposal: !!uploadProposal?.roadProposal,
                proposalId: uploadProposal?.proposalId,
                city: uploadProposal?.city
            });

            const uploadResult = await uploadProposalToServer(uploadProposal);

            if (!uploadResult.ok) {
                throw new Error(uploadResult.message || tShare('uploadError', 'Failed to upload proposal. Please try again.'));
            }

            // Always use the serial ID (numeric) from the server response, never a hash
            uploadedId = uploadResult.id ? String(uploadResult.id) : (uploadResult.proposalId ? String(uploadResult.proposalId) : null);
            if (!uploadedId || !/^\d+$/.test(uploadedId)) {
                throw new Error(tShare('uploadError', 'Server did not return a valid serial ID. Please try again.'));
            }
            uploadStatus.textContent = uploadSuccessText;
            uploadStatus.style.color = '#2b3954'; // Success: dark text instead of red
            shareUrl = `${resolveFrontendBaseUrl()}/proposals/${uploadedId}${cityQueryParam}`;
            proposal.serverProposalId = uploadedId;

            if (typeof proposalStorage !== 'undefined') {
                const localKey = proposal && (proposal.proposalId || (typeof getProposalKey === 'function' ? getProposalKey(proposal) : null));
                const storedProposal = localKey ? proposalStorage.getProposal(localKey) : null;
                if (storedProposal) {
                    storedProposal.serverProposalId = uploadedId;
                    if (typeof proposalStorage.save === 'function') {
                        proposalStorage.save();
                    }
                }
            }

            urlInput.value = shareUrl;
            updateUploadRowUi();

            // --- NEW: Update details panel and state after upload ---
            // Do not select by numeric server id here (it can collide with on-chain token ids).
            if (typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function') {
                const localKey = proposal && (proposal.proposalId || (typeof getProposalKey === 'function' ? getProposalKey(proposal) : null));
                const newProposal = localKey ? proposalStorage.getProposal(localKey) : null;
                if (newProposal) {
                    // Use the first parent parcel for context; no child fallback
                    const firstParcelId = Array.isArray(newProposal.parentParcelIds) && newProposal.parentParcelIds.length > 0
                        ? newProposal.parentParcelIds[0]
                        : null;
                    const proposalKey = (typeof getProposalKey === 'function' ? getProposalKey(newProposal) : null) || newProposal.proposalId || localKey;
                    if (typeof selectAndHighlightProposal === 'function') {
                        selectAndHighlightProposal(proposalKey, firstParcelId, false, true);
                    } else if (typeof showProposalInfo === 'function') {
                        showProposalInfo(newProposal, firstParcelId);
                    }
                }
            }
            // --- END NEW ---

        } catch (error) {
            console.error('Upload failed:', error);
            uploadButton.disabled = false;
            uploadButton.textContent = uploadButtonLabel;
            uploadButton.style.opacity = '1';
            uploadButton.style.cursor = 'pointer';

            enforceUploadAncestryGate();

            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(error.message || tShare('uploadError', 'Failed to upload proposal. Please try again.'), 5000, 'error');
            }
        }
    });

    // Download JSON handler
    downloadButton.addEventListener('click', () => {
        try {
            const proposalData = buildUploadReadyProposal(proposal);
            if (!proposalData) {
                throw new Error(tShare('downloadError', 'Failed to download proposal'));
            }

            const jsonString = JSON.stringify(proposalData, null, 2);
            const blob = new Blob([jsonString], { type: 'application/json' });
            const url = URL.createObjectURL(blob);

            const downloadLink = document.createElement('a');
            downloadLink.href = url;

            // Generate filename
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const proposalId = proposal.proposalId || 'proposal';
            downloadLink.download = `proposal-${proposalId}-${timestamp}.json`;

            document.body.appendChild(downloadLink);
            downloadLink.click();
            document.body.removeChild(downloadLink);
            URL.revokeObjectURL(url);

            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(tShare('downloadSuccess', 'Proposal downloaded as JSON'), 3000, 'success');
            }
        } catch (error) {
            console.error('Download failed:', error);
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(error.message || tShare('downloadError', 'Failed to download proposal'), 5000, 'error');
            }
        }
    });

    // Mint / Connect wallet handler
    mintButton.addEventListener('click', async () => {
        try {
            // If already minted, block re-mint and surface link
            const existingNft = typeof getProposalNftInfo === 'function' ? getProposalNftInfo(proposal) : null;
            if (existingNft && existingNft.tokenId) {
                refreshMintRowUi();
                mintButton.disabled = true;
                mintButton.textContent = tShare('alreadyMinted', 'Already minted');
                const explorerUrl = typeof buildProposalNftExplorerUrl === 'function' ? buildProposalNftExplorerUrl(proposal) : null;
                if (uploadStatus) {
                    uploadStatus.style.color = '#2b3954';
                    uploadStatus.innerHTML = explorerUrl
                        ? `${tShare('alreadyMinted', 'Already minted')}. <a href="${explorerUrl}" target="_blank" rel="noopener noreferrer">${tShare('viewOnExplorer', 'View on explorer')}</a>`
                        : tShare('alreadyMinted', 'Already minted');
                }
                return;
            }

            const setMintStatus = (message, opts = {}) => {
                if (!uploadStatus) return;
                const { isError = false, html = false } = opts;
                uploadStatus.style.color = isError ? '#b3261e' : '#2b3954';
                if (html) {
                    uploadStatus.innerHTML = message;
                } else {
                    uploadStatus.textContent = message;
                }
            };

            const walletManager = window.walletManager;

            // Check wallet connection
            const walletConnected = isWalletConnected();

            if (!walletConnected) {
                // Show wallet selector modal (same flow as Agent Details)
                if (window.walletManager && typeof window.walletManager.openConnectorModal === 'function') {
                    window.walletManager.openConnectorModal();
                } else if (typeof showWalletConnectModal === 'function') {
                    showWalletConnectModal();
                } else if (window.walletManager && typeof window.walletManager.connect === 'function') {
                    await window.walletManager.connect();
                } else {
                    throw new Error('Wallet connection functionality not available');
                }
                return;
            }

            // Resolve lens list for minting; rely solely on the current proposal's lens data
            const lensEntries = getProposalLensEntries(proposal, { fallbackToGlobal: false });
            const lensAddresses = lensEntries.map(e => e && e.address).filter(addr => typeof addr === 'string' && addr.trim().length > 0);
            if (!lensAddresses.length) {
                throw new Error('Lens list is required for minting proposals on-chain.');
            }

            // Persist lens on proposal and storage copy
            proposal.lens = lensEntries;
            proposal.lensAddresses = lensAddresses;
            if (typeof proposalStorage !== 'undefined') {
                const key = proposal.proposalId || (typeof getProposalKey === 'function' ? getProposalKey(proposal) : null);
                const stored = key ? proposalStorage.getProposal(key) : null;
                if (stored) {
                    stored.lens = lensEntries;
                    stored.lensAddresses = lensAddresses;
                    if (typeof proposalStorage.save === 'function') {
                        proposalStorage.save();
                    }
                }
            }

            // Trigger the same mint flow as "Create Proposal" button
            // We need to get the parcel IDs from the proposal
            const parcelIds = proposal.parentParcelIds || [];
            if (parcelIds.length === 0) {
                throw new Error('No parcels associated with this proposal');
            }

            // Build a feature map for parcels (used when minting prerequisites to get parcel names)
            const parcelFeatureById = new Map();
            for (const parcelId of parcelIds) {
                const idStr = parcelId && parcelId.toString ? parcelId.toString() : String(parcelId);
                let parcelLayer = null;
                if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection.findParcelById) {
                    parcelLayer = multiParcelSelection.findParcelById(idStr);
                }
                if (!parcelLayer && typeof resolveParcelLayerById === 'function') {
                    parcelLayer = resolveParcelLayerById(idStr);
                }
                if (parcelLayer && parcelLayer.feature) {
                    parcelFeatureById.set(idStr, parcelLayer.feature);
                }
            }

            // Check prerequisite parcel NFTs before minting (mirrors Create Proposal flow)
            if (typeof window.ProposalChainBridge !== 'undefined' && window.ProposalChainBridge.isSupported()) {
                let chainId = null;
                if (walletManager && typeof walletManager.getState === 'function') {
                    const walletState = walletManager.getState();
                    chainId = walletState?.chainId || null;
                }

                if (!chainId) {
                    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
                    if (globalScope && globalScope.DEFAULT_CHAIN_ID !== undefined && globalScope.DEFAULT_CHAIN_ID !== null) {
                        chainId = globalScope.DEFAULT_CHAIN_ID;
                    } else {
                        const env = globalScope?.current_environment || 'production';
                        chainId = env === 'development' ? '31337' : '84532';
                    }
                }

                try {
                    setMintStatus(tShare('checkingPrereqParcels', 'Checking prerequisite parcels on-chain...'));
                    const parcelCheckResult = await checkParcelsHaveNFTs(parcelIds, chainId);

                    if (!parcelCheckResult.allHaveNFTs && parcelCheckResult.missingParcels.length > 0) {
                        const chainDisplay = parcelCheckResult.chainName || parcelCheckResult.chainId || 'the blockchain';
                        const action = await showMissingParcelsModal(parcelCheckResult.missingParcels, chainDisplay);

                        if (action === 'mint') {
                            const mintableParcels = parcelCheckResult.missingParcels.map((parcelId) => {
                                const idStr = parcelId && parcelId.toString ? parcelId.toString() : String(parcelId);
                                const feature = parcelFeatureById.get(idStr) || null;
                                const props = feature && feature.properties ? feature.properties : {};
                                const parcelName = props.name || props.parcel_name || props.parcel || props.BROJ_CESTICE || `Parcel ${idStr}`;
                                return { parcelId: idStr, parcelName, feature };
                            });

                            try {
                                await openParcelMintModal({
                                    parcels: mintableParcels,
                                    onExit: () => {
                                        setMintStatus(tShare('mintPrereqReminder', 'Mint the prerequisite parcel NFTs, then mint the proposal.'));
                                    }
                                });
                                setMintStatus(tShare('mintPrereqReminder', 'Mint the prerequisite parcel NFTs, then mint the proposal.'));
                            } catch (mintModalError) {
                                console.error('Unable to open mint modal for missing parcels', mintModalError);
                                setMintStatus(tShare('mintPrereqModalFailed', 'Could not open parcel minting. Please mint prerequisites first.'), { isError: true });
                            }
                        } else if (action === 'memory') {
                            setMintStatus(tShare('mintSkippedInMemory', 'Mint skipped. Proposal remains in memory.'), { isError: true });
                        } else {
                            setMintStatus(tShare('mintCancelled', 'Mint cancelled.'), { isError: true });
                        }
                        return;
                    }
                } catch (checkError) {
                    console.error('Failed to verify prerequisite parcel NFTs', checkError);
                    setMintStatus(tShare('mintPrereqCheckFailed', 'Could not verify parcel NFTs. Mint cancelled.'), { isError: true });
                    return;
                }
            }

            // Call the blockchain minting function
            if (typeof window.ProposalChainBridge !== 'undefined' && window.ProposalChainBridge.isSupported()) {
                // Set up the proposal for minting - full flow like Create Proposal
                const blockchainSupported = window.ProposalChainBridge.isSupported();

                if (blockchainSupported) {
                    try {
                        // Step 1: Capture screenshot for the proposal
                        setMintStatus(tShare('mintCapturingImage', 'Capturing proposal image...'));
                        console.log('[shareMint] Starting screenshot capture for proposal:', proposal.proposalId);

                        let screenshotDataUrl = null;

                        // Check if we have a cached screenshot on the proposal
                        if (proposal.screenshotDataUrl && proposal.screenshotDataUrl.startsWith('data:image/')) {
                            screenshotDataUrl = proposal.screenshotDataUrl;
                            console.log('[shareMint] Using cached screenshot from proposal, size:', screenshotDataUrl.length);
                        }

                        // If no cached screenshot, try to capture one
                        if (!screenshotDataUrl) {
                            // Build polygon from parent features or fetch them
                            let parentFeatures = proposal.parentFeatures || [];
                            console.log('[shareMint] Initial parentFeatures count:', parentFeatures.length, 'parcelIds:', parcelIds);

                            if (!parentFeatures.length && Array.isArray(parcelIds) && parcelIds.length > 0) {
                                // Try to get features from parcel layer index
                                for (const pid of parcelIds) {
                                    let layer = null;
                                    // Try findParcelLayerById first (local function)
                                    if (typeof findParcelLayerById === 'function') {
                                        layer = findParcelLayerById(pid);
                                    }
                                    // Fallback to resolveParcelLayerById (global)
                                    if (!layer && typeof resolveParcelLayerById === 'function') {
                                        layer = resolveParcelLayerById(pid);
                                    }
                                    if (layer && layer.feature && layer.feature.geometry) {
                                        parentFeatures.push(layer.feature);
                                        console.log('[shareMint] Found feature for parcel:', pid);
                                    } else {
                                        console.log('[shareMint] No feature found for parcel:', pid);
                                    }
                                }
                            }

                            console.log('[shareMint] Final parentFeatures count:', parentFeatures.length);

                            if (parentFeatures.length > 0 && window.MapScreenshot?.captureViaTileStitch) {
                                // Build combined polygon for screenshot
                                let combinedPolygon = null;
                                const parcelPolygons = [];
                                for (const feature of parentFeatures) {
                                    if (feature && feature.geometry && feature.geometry.coordinates) {
                                        const coords = feature.geometry.coordinates;
                                        if (feature.geometry.type === 'Polygon' && coords[0]) {
                                            parcelPolygons.push(coords[0].map(c => [c[1], c[0]])); // [lat, lng]
                                        } else if (feature.geometry.type === 'MultiPolygon') {
                                            for (const poly of coords) {
                                                if (poly[0]) {
                                                    parcelPolygons.push(poly[0].map(c => [c[1], c[0]]));
                                                }
                                            }
                                        }
                                    }
                                }
                                if (parcelPolygons.length > 0) {
                                    combinedPolygon = parcelPolygons.flat();
                                }

                                if (combinedPolygon && combinedPolygon.length > 0) {
                                    const goalKey = resolveProposalGoalKey(proposal, null) || 'proposal';
                                    const goalBadge = goalKey.replace(/-/g, ' ');
                                    try {
                                        screenshotDataUrl = await window.MapScreenshot.captureViaTileStitch({
                                            polygon: combinedPolygon,
                                            parcelPolygons: parcelPolygons,
                                            padding: 0.12,
                                            zoom: 19,
                                            badge: goalBadge
                                        });
                                        console.log('[shareMint] Screenshot captured, size:', screenshotDataUrl?.length || 0);
                                    } catch (captureErr) {
                                        console.warn('[shareMint] Screenshot capture failed:', captureErr);
                                    }
                                }
                            }
                        } // end of: if (!screenshotDataUrl)

                        // Step 2: Build metadata and upload to the configured storage backend
                        const shareStorageLabel = (typeof window.getStorageProviderLabel === 'function') ? window.getStorageProviderLabel() : 'decentralized storage';
                        setMintStatus(tShare('mintUploadingStorage', `Uploading to ${shareStorageLabel}...`));
                        console.log(`[shareMint] Building metadata for ${shareStorageLabel} upload`);

                        const createdAtIso = proposal.createdAt || new Date().toISOString();
                        const goalKey = resolveProposalGoalKey(proposal, null) || 'proposal';
                        const goalLabel = goalKey.replace(/-/g, ' ');
                        const proposalName = proposal.name || proposal.title || `${goalLabel} Proposal`;
                        const proposalDescription = proposal.description || '';
                        const proposalAuthor = proposal.author || '';
                        const isConditional = Boolean(proposal.conditional || proposal.isConditional);

                        const metadataPayload = {
                            name: proposalName,
                            title: proposalName,
                            description: proposalDescription,
                            image: '', // populated after image upload
                            attributes: [
                                { trait_type: 'Goal', value: goalLabel },
                                { trait_type: 'Conditional', value: isConditional ? 'Yes' : 'No' },
                                { trait_type: 'Parcel Count', value: parcelIds.length },
                                { trait_type: 'Author', value: proposalAuthor }
                            ],
                            properties: {
                                proposalId: proposal.proposalId || '',
                                goal: goalKey,
                                title: proposalName,
                                parcelIds: parcelIds,
                                conditional: isConditional,
                                lens: lensAddresses,
                                createdAt: createdAtIso,
                                author: proposalAuthor,
                                description: proposalDescription
                            }
                        };

                        let metadataUri = '';
                        let assetUploadResult = null;

                        // Only attempt IPFS upload if we have a screenshot
                        if (screenshotDataUrl && window.AssetService && typeof window.AssetService.uploadProposalAssets === 'function') {
                            const fileNameBase = `proposal-${Date.now()}`;
                            const uploadChainId = (window.walletManager && typeof window.walletManager.getState === 'function')
                                ? window.walletManager.getState()?.chainId
                                : null;

                            try {
                                assetUploadResult = await window.AssetService.uploadProposalAssets({
                                    imageData: screenshotDataUrl,
                                    metadata: metadataPayload,
                                    fileName: fileNameBase,
                                    chainId: uploadChainId,
                                    target: 'auto'
                                });
                                metadataUri = assetUploadResult?.metadataUri || assetUploadResult?.metadataUrl || '';
                                console.log('[shareMint] IPFS upload result:', { metadataUri, imageUri: assetUploadResult?.imageUri });
                            } catch (ipfsErr) {
                                console.warn('[shareMint] IPFS upload failed, minting without metadata:', ipfsErr);
                            }
                        } else if (!screenshotDataUrl) {
                            console.warn('[shareMint] No screenshot available, minting without IPFS metadata');
                        } else {
                            console.warn('[shareMint] AssetService not available, minting without IPFS metadata');
                        }

                        // Step 3: Mint on blockchain
                        setMintStatus(tShare('mintWaitingSignature', 'Waiting for wallet signature...'));
                        console.log('[shareMint] Calling mintProposal with metadataUri:', metadataUri);

                        const mintResult = await window.ProposalChainBridge.mintProposal({
                            parcelIds: parcelIds,
                            isConditional: isConditional,
                            ethAmount: 0,
                            tokenAmount: 0n,
                            imageURI: metadataUri,
                            lens: lensAddresses,
                            onSubmitted: (tx) => {
                                const baseUrl = typeof getExplorerBaseUrlForChain === 'function' ? getExplorerBaseUrlForChain(tx?.chainId) : null;
                                const txUrl = baseUrl && tx?.hash ? `${baseUrl}/tx/${tx.hash}` : null;
                                setMintStatus(txUrl
                                    ? `${tShare('mintingOnChain', 'Minting on chain...')} <a href="${txUrl}" target="_blank" rel="noopener noreferrer">${tShare('viewTransaction', 'Transaction')}</a>`
                                    : tShare('mintingOnChain', 'Minting on chain...'), { html: true });
                            }
                        });

                        const txHash = mintResult && mintResult.transactionHash ? mintResult.transactionHash : null;
                        const chainId = mintResult && mintResult.chainId ? mintResult.chainId : null;
                        const contractAddress = mintResult && mintResult.contractAddress ? mintResult.contractAddress : null;
                        const tokenId = mintResult && mintResult.proposalId != null ? String(mintResult.proposalId) : null;

                        // Update proposal with on-chain data including IPFS metadata URIs
                        proposal.onchain = proposal.onchain || {};
                        proposal.onchain.transactionHash = txHash || proposal.onchain.transactionHash || null;
                        proposal.onchain.proposalId = tokenId || proposal.onchain.proposalId || null;
                        proposal.onchain.chainId = chainId || proposal.onchain.chainId || null;
                        proposal.onchain.contractAddress = contractAddress || proposal.onchain.contractAddress || null;
                        proposal.onchain.metadataUri = metadataUri || proposal.onchain.metadataUri || null;
                        proposal.onchain.metadataUrl = assetUploadResult?.metadataGatewayUrl || proposal.onchain.metadataUrl || null;
                        proposal.onchain.imageUri = assetUploadResult?.imageUri || proposal.onchain.imageUri || null;
                        proposal.onchain.imageUrl = assetUploadResult?.imageGatewayUrl || proposal.onchain.imageUrl || null;

                        proposal.nft = {
                            chain: chainId || null,
                            contract: contractAddress || null,
                            tokenId: tokenId || null
                        };

                        const chainProposalIdValue = (typeof buildChainProposalId === 'function')
                            ? buildChainProposalId(chainId, contractAddress, tokenId)
                            : null;
                        proposal.chainProposalId = chainProposalIdValue || proposal.chainProposalId || null;
                        if (proposal.onchain) {
                            proposal.onchain.chainProposalId = proposal.onchain.chainProposalId || chainProposalIdValue || null;
                        }

                        if (typeof proposalStorage !== 'undefined') {
                            const localKey = proposal.proposalId || (typeof getProposalKey === 'function' ? getProposalKey(proposal) : null);
                            const storedProposal = localKey ? proposalStorage.getProposal(localKey) : null;
                            if (storedProposal) {
                                storedProposal.onchain = { ...proposal.onchain };
                                storedProposal.nft = { ...proposal.nft };
                                storedProposal.chainProposalId = chainProposalIdValue || storedProposal.chainProposalId || null;
                                storedProposal.tokenId = storedProposal.tokenId || tokenId;
                                if (typeof proposalStorage._indexProposal === 'function') {
                                    proposalStorage._indexProposal(storedProposal);
                                }
                                if (typeof proposalStorage.save === 'function') {
                                    proposalStorage.save();
                                }
                            }
                        }

                        // Persist the minted proposal to the server so its ENS name
                        // (the on-chain tokenId) resolves through the gateway, which
                        // reads Postgres. The server keys the row on proposalId, so
                        // upload it under the tokenId; otherwise the /proposals/<tokenId>
                        // link the ENS name points at would 404. Minting only writes
                        // to chain + localStorage, so without this step the name is a
                        // dead link until the proposal is uploaded separately.
                        if (tokenId) {
                            try {
                                setMintStatus(tShare('mintSavingServer', 'Saving proposal to server...'));
                                const persistResult = await uploadProposalToServer({ ...proposal, proposalId: tokenId });
                                if (!persistResult || !persistResult.ok) {
                                    throw new Error((persistResult && persistResult.message) || 'server save failed');
                                }
                            } catch (persistErr) {
                                console.error('[shareMint] Server persist after mint failed:', persistErr);
                                if (typeof showEphemeralMessage === 'function') {
                                    showEphemeralMessage(tShare('mintSavedChainOnly', 'Minted on-chain, but saving to the server failed — the ENS link may not resolve until you retry.'), 8000, 'error');
                                }
                            }
                        }

                        // Status updates in modal
                        const explorerUrl = typeof buildProposalNftExplorerUrl === 'function' ? buildProposalNftExplorerUrl(proposal) : null;
                        if (txHash) {
                            const baseUrl = typeof getExplorerBaseUrlForChain === 'function' ? getExplorerBaseUrlForChain(chainId) : null;
                            const txUrl = baseUrl && txHash ? `${baseUrl}/tx/${txHash}` : null;
                            setMintStatus(txUrl
                                ? `${tShare('minting', 'Minting...')} <a href="${txUrl}" target="_blank" rel="noopener noreferrer">${tShare('viewTransaction', 'Transaction')}</a>`
                                : tShare('minting', 'Minting...'), { html: true });
                        }

                        setMintStatus(explorerUrl
                            ? `${tShare('mintSuccess', 'Success! You can see the proposal minted')} <a href="${explorerUrl}" target="_blank" rel="noopener noreferrer">${tShare('here', 'here')}</a>`
                            : tShare('mintSuccess', 'Success! Proposal minted.'), { html: true });

                        mintedExplorerUrl = explorerUrl || mintedExplorerUrl;
                        mintedLinkInput.value = mintedExplorerUrl || '';
                        refreshMintRowUi();

                        mintButton.disabled = true;
                        mintButton.textContent = tShare('alreadyMinted', 'Already minted');
                        if (typeof showEphemeralMessage === 'function') {
                            showEphemeralMessage(tShare('mintSuccess', 'Proposal minted successfully!'), 5000, 'success');
                        }

                        // Update currentProposalDetailsContext so Share button uses updated NFT data
                        if (typeof currentProposalDetailsContext !== 'undefined' && currentProposalDetailsContext) {
                            currentProposalDetailsContext.nft = { ...proposal.nft };
                            currentProposalDetailsContext.onchain = { ...proposal.onchain };
                            currentProposalDetailsContext.chainProposalId = proposal.chainProposalId;
                        }
                    } catch (mintError) {
                        console.error('Minting failed:', mintError);
                        throw mintError;
                    }
                }
            } else {
                throw new Error('Blockchain functionality not available');
            }
        } catch (error) {
            console.error('Mint action failed:', error);
            if (uploadStatus) {
                uploadStatus.textContent = error.message || tShare('mintError', 'Failed to mint proposal');
                uploadStatus.style.color = '#b3261e';
            }
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(error.message || tShare('mintError', 'Failed to mint proposal'), 5000, 'error');
            }
        }
    });

    const modal = showSimpleShareModal({
        title: tShare('shareModalTitle', 'Share one proposal'),
        body: fragment,
        actions: [],
        closeOnOverlay: false,
        closeOnEscape: false,
        autoCloseActions: false
    });
}

function promptMissingParentParcelsModal(missing, author, problem) {
    return new Promise(resolve => {
        const limited = missing.slice(0, 8);
        const listHtml = limited.length > 0
            ? `<ul>${limited.map(id => `<li>${id}</li>`).join('')}${missing.length > limited.length ? '<li>…</li>' : ''}</ul>`
            : '';
        const modal = showSimpleShareModal({
            title: 'Missing Parent Parcels',
            body: `<p>We could not find ${missing.length} parent parcel${missing.length === 1 ? '' : 's'} required to apply the shared proposals${author ? ` from ${author}` : ''}.</p>${problem ? `<p><strong>Problem proposal:</strong> ${problem.title ? escapeHtml(problem.title) : '(Untitled)'}${problem.proposalId ? ` (ID #${escapeHtml(String(problem.proposalId))})` : ''}</p>` : ''}<p>You can cancel loading or refresh parcel data (this will clear local work) and try again.</p>${listHtml}`,
            actions: [
                {
                    label: 'Cancel load',
                    onClick: () => resolve('cancel')
                },
                {
                    label: 'Lose local work, refresh & apply',
                    primary: true,
                    onClick: () => resolve('refresh')
                }
            ]
        });

        if (!modal) {
            const confirmRefresh = confirm('Missing parent parcels are required to load shared proposals. Refresh parcel data (clears local work)?');
            resolve(confirmRefresh ? 'refresh' : 'cancel');
        }
    });
}
