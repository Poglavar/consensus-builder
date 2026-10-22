// proposals/create-preview.js — the create dialog's preview helpers: the goal badge on its preview
// map, whether a goal gets a screenshot and the screenshot context of the selected parcels. They
// stayed behind when the upload modal (dialog-upload.js) was removed with M2's design publishing.

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
    const goalKey = ProposalDesignGoals.keyOf(proposal);
    return !!goalKey && PROPOSAL_SCREENSHOT_SKIP_GOALS.has(goalKey);
}

// Proposal thumbnails are rendered SERVER-SIDE at upload (backend/thumbnails/), not in the browser.
// The client-side capture pipeline that used to live here — reconstructProposalScreenshotDataUrl,
// captureAndPersistProposalScreenshot, the /assets/upload + PATCH /proposals/:id/screenshot dance and
// the click-to-generate placeholder — is gone: it only ever ran for whoever happened to have the
// proposal open in the right city with tiles loaded, which is why almost no proposal had a thumbnail.
//
// What remains below is the CREATE-modal preview context (buildProposalScreenshotContext), which
// feeds the live preview map in the create dialog and the image the mint flow puts on-chain.

function buildProposalScreenshotContext(parcelLayers = [], options = {}) {
    if (window?.__DEBUG_SCREENSHOT_CONTEXT__) {
        console.debug('[buildProposalScreenshotContext]', {
            parcelLayersCount: parcelLayers?.length,
            options: { goal: options.goal, hasRoadContext: !!options.roadContext }
        });
    }
    const goalKey = (typeof normalizeGoalKey === 'function') ? normalizeGoalKey(options.goal) : (options.goal || '');
    const roadContext = options.roadContext || null;
    const parcelIds = Array.isArray(parcelLayers)
        ? parcelLayers.map(layer => window.ParcelPresenter?.getIdForLayer?.(layer)).filter(Boolean).map(String)
        : [];
    const parcelFeatures = parcelIds.map(id => window.LiveParcelFabric?.get?.(id)).filter(Boolean);
    const hasParcels = parcelIds.length > 0 && parcelFeatures.length === parcelIds.length;
    if (!hasParcels && !roadContext) {
        return null;
    }

    const parcelPolygons = [];
    // Every source below is GeoJSON [lng, lat] (live fabric features, unions, road geometry), so the
    // order is stated, never guessed: the capture refuses a bbox it cannot trust.
    let polygonOrder = 'lnglat';
    let parcelPolygonOrder = 'lnglat';
    if (hasParcels) {
        parcelFeatures.forEach(feature => {
            const geom = feature.geometry;
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
    const geometry = hasParcels ? buildGeometryFromParcels(parcelIds) : null;
    if (geometry && Array.isArray(geometry.coordinates) && geometry.coordinates.length) {
        polygon = geometry.coordinates;
    } else if (parcelPolygons.length) {
        polygon = parcelPolygons[0];
    }

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
            parcelPolygonOrder = 'lnglat';

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

    // If the road/track flow did not seed parcel outlines, explicitly expand its cadastral anchors
    // through the committed live fabric. Leaflet remains a screenshot renderer, never a data source.
    if (goalKey === 'road-track' && roadContext && parcelPolygons.length === 0 && Array.isArray(roadContext.parcelIds) && roadContext.parcelIds.length) {
        const ids = roadContext.parcelIds
            .map(id => (id ? id.toString() : null))
            .filter(Boolean);

        const layers = window.ParcelPresenter?.resolveLiveLayers?.(ids, { includeCorridors: true }) || [];
        layers.forEach(layer => {
            try {
                const liveId = window.ParcelPresenter?.getIdForLayer?.(layer);
                const geom = liveId ? window.LiveParcelFabric?.get?.(liveId)?.geometry : null;
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

    const appendParcelsFromFabric = (target = [], targetBounds = null, limit = 150) => {
        const fabric = window.LiveParcelFabric;
        if (!fabric || !targetBounds || typeof fabric.queryBounds !== 'function') return target;
        const features = fabric.queryBounds(targetBounds, { includeCorridors: true });
        for (const feature of features) {
            if (target.length >= limit) break;
            const geom = feature?.geometry;
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
        appendParcelsFromFabric(parcelPolygons, bounds, 200);
    }

    if (!polygon) return null;

    // Compute neighbour polygons from the committed live fabric.
    let neighbours = [];
    if (hasParcels && typeof window.findNeighbourPolygonsFromLiveFabric === 'function') {
        const selectedIds = new Set(parcelIds);
        selectedIds.forEach(parcelId => {
            const found = window.findNeighbourPolygonsFromLiveFabric(parcelId);
            if (Array.isArray(found)) {
                found.forEach(ring => neighbours.push(ring));
            }
        });
    }

    // For road geometry we convert to [lat, lng] pairs; otherwise let downstream normalize
    return { polygon, parcelPolygons, neighbours, bounds, fitToPolygonOnly, polygonOrder, parcelPolygonOrder };
}
