// proposals/geometry.js — geometry helpers: feature/parcel geometry assembly, bounds, area,
// lake zones, building-feature collection, thumbnails. Extracted from proposals.js (pure relocation).

function getFeatureCentroid(feature) {
    if (!feature || !feature.geometry) return null;
    try {
        if (typeof turf !== 'undefined' && typeof turf.centerOfMass === 'function') {
            const centroid = turf.centerOfMass(feature);
            const coords = centroid?.geometry?.coordinates;
            if (Array.isArray(coords) && coords.length >= 2) {
                const [lng, lat] = coords;
                if (Number.isFinite(lat) && Number.isFinite(lng)) {
                    return L.latLng(lat, lng);
                }
            }
        }
    } catch (_) { }

    try {
        const temp = L.geoJSON(feature);
        const bounds = temp.getBounds();
        if (bounds && bounds.isValid()) {
            return bounds.getCenter();
        }
    } catch (_) { }
    return null;
}

function collectProposalBuildingFeatures(proposal) {
    const features = [];
    if (!proposal) return features;

    const clone = (raw) => {
        try { return JSON.parse(JSON.stringify(raw)); } catch (_) { return null; }
    };

    const bp = proposal.buildingProposal || {};

    if (Array.isArray(proposal.geometry?.buildings) && proposal.geometry.buildings.length) {
        proposal.geometry.buildings.forEach(raw => {
            const cloned = clone(raw);
            if (cloned && cloned.geometry) features.push(cloned);
        });
        return features;
    }

    if (Array.isArray(bp.buildings) && bp.buildings.length) {
        proposal.geometry = proposal.geometry || {};
        proposal.geometry.buildings = bp.buildings
            .map(entry => clone(entry?.feature))
            .filter(f => f && f.geometry);
        return proposal.geometry.buildings;
    }

    return features;
}

function cloneGeoJSONFeature(feature) {
    try {
        return JSON.parse(JSON.stringify(feature));
    } catch (_) {
        return null;
    }
}

function normaliseToFeature(input, defaultProperties = {}) {
    if (!input) return null;

    if (input.type === 'Feature' && input.geometry) {
        const cloned = cloneGeoJSONFeature(input);
        if (cloned) {
            cloned.properties = { ...(cloned.properties || {}), ...defaultProperties };
        }
        return cloned;
    }

    if (input.type && input.coordinates) {
        const geometryClone = cloneGeoJSONFeature(input);
        if (!geometryClone) return null;
        return {
            type: 'Feature',
            geometry: geometryClone,
            properties: { ...defaultProperties }
        };
    }

    return null;
}

function forEachProposalParcelInViewport(proposalIdSet, callback) {
    if (!(proposalIdSet instanceof Set) || proposalIdSet.size === 0) return 0;
    if (typeof window === 'undefined' || !window.map) return 0;
    if (typeof callback !== 'function') return 0;
    let bounds;
    try {
        bounds = window.map.getBounds();
        if (bounds && typeof bounds.pad === 'function') {
            bounds = bounds.pad(0.1);
        }
    } catch (_) {
        return 0;
    }
    if (!bounds) return 0;

    let layers = [];
    if (typeof window.getParcelLayersWithinBounds === 'function') {
        try {
            layers = window.getParcelLayersWithinBounds(bounds) || [];
        } catch (_) {
            layers = [];
        }
    }
    if (!layers.length) return 0;

    let matched = 0;
    const seen = new Set();
    for (const layer of layers) {
        if (!layer || !layer.feature) continue;
        const idValue = (typeof getParcelIdFromFeature === 'function')
            ? getParcelIdFromFeature(layer.feature)
            : (layer.feature.properties && (layer.feature.properties.parcelId || layer.feature.properties.parcel_id || layer.feature.properties.id));
        if (idValue == null) continue;
        const idStr = String(idValue);
        if (!proposalIdSet.has(idStr) || seen.has(idStr)) continue;
        seen.add(idStr);
        try {
            callback(layer, idStr);
            matched++;
        } catch (_) { /* keep going */ }
    }
    return matched;
}

function collectProposalFeatureSets(proposal, options = {}) {
    const includeBuildingGeometry = options && Object.prototype.hasOwnProperty.call(options, 'includeBuildingGeometry')
        ? !!options.includeBuildingGeometry
        : true;
    const parcelFeatures = [];
    const primaryFeatures = [];
    const parcelIds = Array.isArray(proposal?.parentParcelIds) ? proposal.parentParcelIds : [];
    const cache = buildProposalFeatureCache(proposal) || {};

    // Parents and road descendants are now handled by the in-place setStyle path in
    // renderAppliedProposalHighlight — it walks the viewport spatial index directly and
    // mutates layers without going through Feature extraction. We deliberately do NOT
    // populate parcelFeatures for parents or road descendants here to avoid the
    // O(N) toGeoJSON clones that dominated collectProposalFeatureSets runtime.

    if (resolveProposalGoalKey(proposal, null) === 'road-track' && proposal.roadProposal) {
        if (proposal.roadProposal.definition) {
            // Always draw the road definition corridor — it is the proposal's primary geometry
            // and must remain visible regardless of viewport / zoom / descendant materialization.
            const definition = proposal.roadProposal.definition;
            let roadPolygon = null;
            let geometry = null;

            // First, check if definition already has a stored polygon (from road drawing)
            if (definition.polygon && definition.polygon.type === 'Polygon' && Array.isArray(definition.polygon.coordinates)) {
                geometry = definition.polygon;
            } else if (definition.polygon && Array.isArray(definition.polygon.coordinates)) {
                geometry = { type: 'Polygon', coordinates: definition.polygon.coordinates };
            }

            // If no stored polygon, try to calculate from points and width
            if (!geometry) {
                const points = Array.isArray(definition.points) ? definition.points : null;
                const width = typeof definition.width === 'number' ? definition.width : parseFloat(definition.width);

                if (points && points.length >= 2 && Number.isFinite(width) && width > 0) {
                    // Use the calculateRoadPolygon function from road-drawing.js if available
                    try {
                        if (typeof window !== 'undefined' && typeof window.calculateRoadPolygon === 'function') {
                            roadPolygon = window.calculateRoadPolygon(points, width);
                        } else if (typeof calculateRoadPolygon === 'function') {
                            roadPolygon = calculateRoadPolygon(points, width);
                        } else if (typeof ProposalManager !== 'undefined' && ProposalManager._calculateRoadPolygon && typeof ProposalManager._calculateRoadPolygon === 'function') {
                            roadPolygon = ProposalManager._calculateRoadPolygon(points, width);
                        } else if (typeof _calculateRoadPolygon === 'function') {
                            roadPolygon = _calculateRoadPolygon(points, width);
                        }
                    } catch (error) {
                        console.warn('[collectProposalFeatureSets] calculateRoadPolygon failed, using turf buffer fallback', error);
                    }

                    if (roadPolygon && Array.isArray(roadPolygon)) {
                        const isLatLng = (p) => p && typeof p.lat === 'number' && typeof p.lng === 'number';

                        const ensureClosedRing = (coords) => {
                            if (!Array.isArray(coords) || coords.length < 3) return null;
                            const first = coords[0];
                            const last = coords[coords.length - 1];
                            if (!first || !last) return null;
                            const closed = coords.slice();
                            if (first[0] !== last[0] || first[1] !== last[1]) {
                                closed.push([first[0], first[1]]);
                            }
                            return closed.length >= 4 ? closed : null;
                        };

                        const ringFromLatLngs = (ring) => {
                            const coords = (Array.isArray(ring) ? ring : [])
                                .map(pt => (isLatLng(pt) ? [pt.lng, pt.lat] : null))
                                .filter(Boolean);
                            return ensureClosedRing(coords);
                        };

                        const buildGeometry = (poly) => {
                            // LatLng[]
                            if (poly.length && isLatLng(poly[0])) {
                                const outer = ringFromLatLngs(poly);
                                return outer ? { type: 'Polygon', coordinates: [outer] } : null;
                            }
                            // LatLng[][] (polygon with holes)
                            if (poly.length && Array.isArray(poly[0]) && poly[0].length && isLatLng(poly[0][0])) {
                                const rings = poly.map(ringFromLatLngs).filter(Boolean);
                                return rings.length ? { type: 'Polygon', coordinates: rings } : null;
                            }
                            // LatLng[][][] (multipolygon)
                            if (poly.length && Array.isArray(poly[0]) && Array.isArray(poly[0][0]) && poly[0][0].length && isLatLng(poly[0][0][0])) {
                                const polys = poly
                                    .map(polyRings => (Array.isArray(polyRings) ? polyRings : []).map(ringFromLatLngs).filter(Boolean))
                                    .filter(rings => rings.length > 0);
                                return polys.length ? { type: 'MultiPolygon', coordinates: polys } : null;
                            }
                            return null;
                        };

                        geometry = buildGeometry(roadPolygon);
                    }
                }
            }

            // Fallback: buffer the centerline with turf when calculateRoadPolygon is unavailable
            if (!geometry && typeof turf !== 'undefined' && turf.lineString && turf.buffer) {
                try {
                    const rawPoints = Array.isArray(definition.latLngPairs) && definition.latLngPairs.length
                        ? definition.latLngPairs
                        : Array.isArray(definition.points)
                            ? definition.points
                            : null;
                    const widthMeters = Number.isFinite(definition.width)
                        ? definition.width
                        : Number.isFinite(definition?.metadata?.isTrack ? DEFAULT_CORRIDOR_WIDTHS.track : DEFAULT_CORRIDOR_WIDTHS.road)
                            ? (definition?.metadata?.isTrack ? DEFAULT_CORRIDOR_WIDTHS.track : DEFAULT_CORRIDOR_WIDTHS.road)
                            : parseFloat(definition.width);
                    if (rawPoints && rawPoints.length >= 2 && Number.isFinite(widthMeters) && widthMeters > 0) {
                        const toLngLat = (p) => {
                            if (p && typeof p.lat === 'number' && typeof p.lng === 'number') return [p.lng, p.lat];
                            if (Array.isArray(p) && p.length >= 2) {
                                const a = Number(p[0]);
                                const b = Number(p[1]);
                                return Math.abs(a) > 90 && Math.abs(b) <= 90 ? [a, b] : [b, a];
                            }
                            if (p && typeof p === 'object' && 'lat' in p && 'lng' in p) return [Number(p.lng), Number(p.lat)];
                            return null;
                        };
                        const linePoints = rawPoints.map(toLngLat).filter(pt => Array.isArray(pt) && Number.isFinite(pt[0]) && Number.isFinite(pt[1]));
                        if (linePoints.length >= 2) {
                            const line = turf.lineString(linePoints);
                            const buffered = turf.buffer(line, Math.max(widthMeters / 2, 1), { units: 'meters' });
                            if (buffered && buffered.geometry) {
                                geometry = buffered.geometry;
                            }
                        }
                    }
                } catch (e) {
                    console.warn('turf.buffer fallback for road/track geometry failed', e);
                }
            }

            if (geometry) {
                const roadFeature = {
                    type: 'Feature',
                    geometry: geometry,
                    properties: {
                        isRoad: true,
                        isTrack: corridorIsTrack(definition),
                        isProposed: true,
                        proposalId: proposal.proposalId || null,
                        source: 'road-definition'
                    }
                };

                const normalised = normaliseToFeature(roadFeature, { source: 'road-definition' });
                if (normalised) {
                    primaryFeatures.push(normalised);
                }
            }
        }
        // Also check for geometry.roadGeometry.polygon (from newly drawn roads)
        if (primaryFeatures.length === 0 && proposal.geometry?.roadGeometry?.polygon) {
            const storedPolygon = proposal.geometry.roadGeometry.polygon;
            let geometry = null;

            // polygon might be a GeoJSON Polygon object or raw coordinates
            if (storedPolygon.type === 'Polygon' && Array.isArray(storedPolygon.coordinates)) {
                geometry = storedPolygon;
            } else if (Array.isArray(storedPolygon.coordinates) && storedPolygon.coordinates.length > 0) {
                geometry = { type: 'Polygon', coordinates: storedPolygon.coordinates };
            } else if (Array.isArray(storedPolygon) && storedPolygon.length > 0) {
                // Raw coordinates array - assume it's already in GeoJSON [lng, lat] order
                const firstItem = storedPolygon[0];
                if (Array.isArray(firstItem) && Array.isArray(firstItem[0])) {
                    // Already rings: [[lng, lat], ...]
                    geometry = { type: 'Polygon', coordinates: storedPolygon };
                } else if (Array.isArray(firstItem) && firstItem.length >= 2 && typeof firstItem[0] === 'number') {
                    // Single ring: [[lng, lat], ...]
                    geometry = { type: 'Polygon', coordinates: [storedPolygon] };
                }
            }

            if (geometry) {
                const roadFeature = {
                    type: 'Feature',
                    geometry: geometry,
                    properties: {
                        isRoad: true,
                        isTrack: corridorIsTrack(proposal?.roadProposal?.definition),
                        isProposed: true,
                        proposalId: proposal.proposalId || null,
                        source: 'road-geometry-stored'
                    }
                };
                const normalised = normaliseToFeature(roadFeature, { source: 'road-geometry-stored' });
                if (normalised) {
                    primaryFeatures.push(normalised);
                }
            }
        }
    }
    if (includeBuildingGeometry) {
        const addBuildingGeometry = (input) => {
            if (!input) return;
            if (Array.isArray(input)) {
                input.forEach(item => addBuildingGeometry(item));
                return;
            }
            if (input.type === 'FeatureCollection' && Array.isArray(input.features)) {
                input.features.forEach(f => addBuildingGeometry(f));
                return;
            }
            const buildingFeature = normaliseToFeature(input, { source: 'building' });
            if (buildingFeature) {
                primaryFeatures.push(buildingFeature);
            }
        };

        if (proposal?.geometry?.buildings && Array.isArray(proposal.geometry.buildings) && proposal.geometry.buildings.length) {
            addBuildingGeometry(proposal.geometry.buildings);
        }
    }

    if (proposal?.structureProposal?.geometry) {
        const kind = (proposal.structureProposal.kind || '').toLowerCase();
        const structureFeature = normaliseToFeature(
            proposal.structureProposal.geometry,
            { source: `structure-${kind || 'generic'}` }
        );
        if (structureFeature) {
            primaryFeatures.push(structureFeature);
        }
    }

    if (Array.isArray(proposal?.reparcellization?.polygons)) {
        proposal.reparcellization.polygons.forEach(slice => {
            if (!slice || !slice.geometry) return;
            const featureInput = {
                type: 'Feature',
                geometry: slice.geometry,
                properties: {
                    ownerKey: slice.ownerKey || null,
                    displayName: slice.displayName || null,
                    color: slice.color || null,
                    percent: slice.percent || null
                }
            };
            const reparcelFeature = normaliseToFeature(featureInput, { source: 'reparcellization-slice' });
            if (reparcelFeature) {
                reparcelFeature.properties = {
                    ...(reparcelFeature.properties || {}),
                    ownerKey: slice.ownerKey || null,
                    displayName: slice.displayName || null,
                    color: slice.color || null,
                    percent: slice.percent || null
                };
                primaryFeatures.push(reparcelFeature);
            }
        });
    }

    if (primaryFeatures.length === 0 && parcelFeatures.length > 0) {
        primaryFeatures.push(...parcelFeatures);
    }

    return {
        parcelFeatures,
        primaryFeatures,
        parcelIds: parcelIds.map(id => (id !== undefined && id !== null) ? id.toString() : null).filter(Boolean)
    };
}

function computeBoundsFromFeatures(features) {
    if (!Array.isArray(features) || features.length === 0 || typeof L === 'undefined') {
        return null;
    }
    try {
        const combined = L.featureGroup(features.map(f => L.geoJSON(f)));
        const bounds = combined.getBounds();
        if (bounds && bounds.isValid()) {
            return bounds;
        }
    } catch (error) {
        console.warn('computeBoundsFromFeatures failed', error);
    }
    return null;
}

function tryBoundsFromRoadProposalDefinition(proposal) {
    const def = proposal && proposal.roadProposal && proposal.roadProposal.definition;
    if (!def) return null;
    const bounds = L.latLngBounds();
    let n = 0;
    const add = (lat, lng) => {
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
            // Reject corrupted coordinates (e.g. legacy turf.buffer-on-HTRS96 output) so they
            // do not blow up the camera bounds.
            if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
            bounds.extend(L.latLng(lat, lng));
            n++;
        }
    };
    const pts = def.points;
    if (Array.isArray(pts)) {
        const walk = (p) => {
            if (!p) return;
            if (typeof p.lat === 'number' && typeof p.lng === 'number') {
                add(p.lat, p.lng);
            } else if (Array.isArray(p)) {
                p.forEach(walk);
            }
        };
        pts.forEach(walk);
    }
    const poly = def.polygon;
    if (poly && poly.coordinates) {
        const walkRing = (ring) => {
            if (!Array.isArray(ring)) return;
            ring.forEach((c) => {
                if (Array.isArray(c) && c.length >= 2) {
                    const lng = Number(c[0]);
                    const lat = Number(c[1]);
                    add(lat, lng);
                }
            });
        };
        if (poly.type === 'Polygon' && Array.isArray(poly.coordinates)) {
            poly.coordinates.forEach(walkRing);
        } else if (poly.type === 'MultiPolygon' && Array.isArray(poly.coordinates)) {
            poly.coordinates.forEach((mp) => {
                if (Array.isArray(mp)) mp.forEach(walkRing);
            });
        }
    }
    if (n === 0 || !bounds.isValid()) return null;
    return bounds;
}

function resolveStandaloneProposalFocusBounds(proposal) {
    if (!proposal) return null;

    const roadDefBounds = tryBoundsFromRoadProposalDefinition(proposal);
    if (roadDefBounds && roadDefBounds.isValid()) {
        return roadDefBounds;
    }

    const storedBounds = buildLeafletBoundsFromArray(proposal.bounds)
        || buildLeafletBoundsFromArray(proposal.roadProposal && proposal.roadProposal.bounds);
    if (storedBounds && storedBounds.isValid()) {
        return storedBounds;
    }

    const geometryFeatures = [];
    if (proposal.buildingProposal && proposal.buildingProposal.buildingFeature) {
        geometryFeatures.push(proposal.buildingProposal.buildingFeature);
    }
    if (proposal.structureProposal && proposal.structureProposal.geometry) {
        geometryFeatures.push({ type: 'Feature', geometry: proposal.structureProposal.geometry });
    }
    if (proposal.reparcellization && Array.isArray(proposal.reparcellization.polygons)) {
        proposal.reparcellization.polygons.forEach(polygon => {
            if (polygon && polygon.geometry) {
                geometryFeatures.push({ type: 'Feature', geometry: polygon.geometry });
            }
        });
    }

    if (geometryFeatures.length > 0 && typeof computeBoundsFromGeoJSONFeatures === 'function') {
        const geoBounds = computeBoundsFromGeoJSONFeatures(geometryFeatures);
        if (geoBounds && geoBounds.isValid()) {
            return geoBounds;
        }
    }

    return null;
}

function computeLatLngBoundsFromGeoJsonPolygon(polygonCoords) {
    if (!polygonCoords || typeof L === 'undefined' || !L.latLngBounds) return null;
    const latLngs = [];
    const collectFromRing = (ring) => {
        if (!Array.isArray(ring)) return;
        ring.forEach(pt => {
            if (Array.isArray(pt) && pt.length >= 2 && Number.isFinite(pt[0]) && Number.isFinite(pt[1])) {
                latLngs.push(L.latLng(pt[1], pt[0])); // GeoJSON [lng, lat]
            }
        });
    };
    if (Array.isArray(polygonCoords[0]) && Array.isArray(polygonCoords[0][0])) {
        polygonCoords.forEach(collectFromRing);
    } else {
        collectFromRing(polygonCoords);
    }
    return latLngs.length ? L.latLngBounds(latLngs) : null;
}

function collectParcelPolygonsFromParcelLayer(parcelIds) {
    if (!Array.isArray(parcelIds) || !parcelIds.length) return [];
    const polygons = [];
    parcelIds.forEach(rawId => {
        if (!rawId) return;
        const id = String(rawId);
        const layer = (typeof window.resolveParcelLayerById === 'function') ? window.resolveParcelLayerById(id) : null;
        const geom = layer?.feature?.geometry;
        if (!geom || !geom.coordinates) return;
        if (geom.type === 'Polygon') polygons.push(geom.coordinates);
        else if (geom.type === 'MultiPolygon') geom.coordinates.forEach(p => polygons.push(p));
    });
    return polygons;
}

function collectNeighbourPolygonsByBounds(bounds, options = {}) {
    const limit = options.limit || 200;
    const excludeIds = options.excludeIds instanceof Set ? options.excludeIds : new Set((options.excludeIds || []).map(String));
    const layer = (typeof window !== 'undefined' && window.parcelLayer)
        || (window?.parcelState && typeof window.parcelState.getParcelLayer === 'function' && window.parcelState.getParcelLayer())
        || null;
    if (!layer || !bounds || typeof bounds.intersects !== 'function' || typeof layer.getLayers !== 'function') return [];
    const result = [];
    const layers = layer.getLayers();
    for (const lay of layers) {
        if (result.length >= limit) break;
        const lb = (lay && typeof lay.getBounds === 'function') ? lay.getBounds() : null;
        if (!lb || !bounds.intersects(lb)) continue;
        const id = (typeof getParcelIdFromFeature === 'function') ? getParcelIdFromFeature(lay?.feature) : null;
        if (id && excludeIds.has(String(id))) continue;
        const geom = lay?.feature?.geometry;
        if (!geom || !geom.coordinates) continue;
        if (geom.type === 'Polygon') result.push(geom.coordinates);
        else if (geom.type === 'MultiPolygon') geom.coordinates.forEach(p => result.push(p));
    }
    return result;
}

function setGeometryStatus(text, { submitted = false } = {}) {
    const statusEl = document.getElementById('proposalGeometryStatus');
    if (statusEl) {
        statusEl.textContent = text || '';
        statusEl.dataset.submitted = submitted ? 'true' : 'false';
    }
    proposalGeometrySubmitted = !!submitted;
    updateCreateProposalSubmitState();
}

function goalRequiresGeometry(goalKey) {
    if (!goalKey) return false;
    const key = goalKey.toString().toLowerCase();
    return key === 'single'
        || key === 'road-track'
        || key === 'urban-rule'
        || key === 'reparcellization';
}

function renderGeometrySection(goalKey) {
    const group = document.getElementById('proposalGeometryGroup');
    const buttonsRow = document.getElementById('proposalGeometryButtons');
    if (!group || !buttonsRow) return;

    const t = getProposalI18nHelper();
    const label = {
        geometry: t('modal.createProposal.geometry.label', 'Geometry'),
        edit: t('modal.createProposal.geometry.buttons.edit', 'Edit'),
        upload: t('modal.createProposal.geometry.buttons.upload', 'Upload'),
        noGeometry: t('modal.createProposal.geometry.status.noGeometry', 'No geometry: please define a geometry'),
        submitted: t('modal.createProposal.geometry.status.submitted', '✔️ geometry submitted'),
        auto: t('modal.createProposal.geometry.status.auto', 'Algorithmic geometry will be generated')
    };

    // Facet changes re-run this render for the same goal; that must not discard geometry the
    // user already drew or restored from a draft (only an actual goal switch resets it).
    const statusEl = document.getElementById('proposalGeometryStatus');
    const keepSubmitted = currentGeometryGoal === goalKey && proposalGeometrySubmitted;
    const keepStatusText = (keepSubmitted && statusEl && statusEl.textContent) || label.submitted;

    currentGeometryGoal = goalKey;
    proposalGeometrySubmitted = false;
    buttonsRow.innerHTML = '';
    buttonsRow.style.display = 'flex';
    buttonsRow.style.flexWrap = 'wrap';
    buttonsRow.style.gap = '8px';

    // Default hidden
    group.style.display = 'none';
    setGeometryStatus('', { submitted: false });

    const makeButton = (actionKey, text, { disabled = false, selected = false }) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-action';
        if (selected) btn.classList.add('selected');
        if (disabled) btn.setAttribute('disabled', 'disabled');
        btn.dataset.geometryAction = actionKey;
        btn.textContent = text;
        btn.addEventListener('click', () => handleGeometryAction(actionKey));
        return btn;
    };

    const showGroup = () => {
        group.style.display = '';
        const labelEl = group.querySelector('label');
        if (labelEl) labelEl.textContent = label.geometry;
    };

    if (goalKey === 'decide-later' || goalKey === 'ownership-transfer') {
        updateCreateProposalSubmitState();
        return; // No geometry section shown
    }

    if (goalKey === 'square' || goalKey === 'park' || goalKey === 'lake') {
        // Geometry is generated algorithmically and there are no actionable buttons,
        // so hide the whole section rather than showing two disabled buttons.
        group.style.display = 'none';
        setGeometryStatus(label.auto, { submitted: true });
        updateCreateProposalSubmitState();
        return;
    }

    if (goalKey === 'single') {
        showGroup();
        setGeometryStatus(keepSubmitted ? keepStatusText : label.noGeometry, { submitted: keepSubmitted });
        buttonsRow.appendChild(makeButton('edit', label.edit, { selected: false }));
        buttonsRow.appendChild(makeButton('upload', label.upload, { disabled: false }));
        buttonsRow.style.gridTemplateColumns = 'repeat(2, 1fr)';
        updateCreateProposalSubmitState();
        return;
    }

    if (goalKey === 'road-track') {
        showGroup();
        setGeometryStatus(keepSubmitted ? keepStatusText : label.noGeometry, { submitted: keepSubmitted });
        buttonsRow.appendChild(makeButton('edit', label.edit, { selected: false }));
        buttonsRow.appendChild(makeButton('upload', label.upload, { disabled: true }));
        buttonsRow.style.gridTemplateColumns = 'repeat(2, 1fr)';
        updateCreateProposalSubmitState();
        return;
    }

    if (goalKey === 'reparcellization') {
        showGroup();
        setGeometryStatus(keepSubmitted ? keepStatusText : label.noGeometry, { submitted: keepSubmitted });
        buttonsRow.appendChild(makeButton('edit', label.edit, { selected: false }));
        buttonsRow.appendChild(makeButton('upload', label.upload, { disabled: true }));
        buttonsRow.style.gridTemplateColumns = 'repeat(2, 1fr)';
        updateCreateProposalSubmitState();
        return;
    }

    if (goalKey === 'urban-rule') {
        showGroup();
        setGeometryStatus(keepSubmitted ? keepStatusText : label.noGeometry, { submitted: keepSubmitted });
        buttonsRow.appendChild(makeButton('edit', label.edit, { selected: false }));
        buttonsRow.appendChild(makeButton('upload', label.upload, { disabled: true }));
        buttonsRow.style.gridTemplateColumns = 'repeat(2, 1fr)';
        updateCreateProposalSubmitState();
        return;
    }

    updateCreateProposalSubmitState();
}

async function handleGeometryAction(actionKey) {
    const t = getProposalI18nHelper();
    const tCorridor = getRoadDesignationTranslator(t);
    const label = {
        submitted: t('modal.createProposal.geometry.status.submitted', '✔️ geometry submitted')
    };

    switch (actionKey) {
        case 'edit': {
            let opened = true;
            if (currentGeometryGoal === 'reparcellization') {
                opened = await handleReparcellizationAlgorithmClick('sweep-line');
            } else if (currentGeometryGoal === 'single') {
                opened = await launchSingleBuildingToolForSelection();
            } else if (currentGeometryGoal === 'road-track') {
                // The road-track goal's geometry step DESIGNATES the selected parcels as road land.
                // Designing a road (a centerline with a cross-section) is the corridor tool's job, on the
                // main map — not a second drawing surface inside a modal.
                if (typeof openRoadDesignationModal === 'function') {
                    openRoadDesignationModal();
                } else if (typeof updateStatus === 'function') {
                    updateStatus(tCorridor('statusUnavailable', 'Road designation is not available yet.'));
                    opened = false;
                }
            } else if (currentGeometryGoal === 'urban-rule') {
                opened = await openUrbanRuleGeometry();
            }
            // Accepting the whole-block suggestion deliberately stops this one-parcel launch.
            // Do not falsely mark geometry as submitted when no editor opened.
            if (opened !== false) setGeometryStatus(label.submitted, { submitted: true });
            break;
        }
        case 'upload':
            // Currently only the single-building goal supports uploading a 3D model.
            if (currentGeometryGoal === 'single') {
                if (typeof window.BuildingUpload === 'undefined' || typeof window.BuildingUpload.open !== 'function') {
                    if (typeof updateStatus === 'function') updateStatus('Upload tool is unavailable.');
                    break;
                }
                const selection = (typeof getCurrentParcelSelectionContext === 'function')
                    ? getCurrentParcelSelectionContext()
                    : { layers: [], ids: [] };
                if (!selection.layers || !selection.layers.length) {
                    if (typeof updateStatus === 'function') updateStatus('Select parcels before uploading a building.');
                    break;
                }
                if (typeof shouldStopFreshProposalForWholeBlock === 'function'
                    && await shouldStopFreshProposalForWholeBlock('single', selection)) break;
                window.BuildingUpload.open(
                    {
                        parcels: selection.layers,
                        blockName: (typeof formatParcelSelectionLabel === 'function')
                            ? formatParcelSelectionLabel(selection.ids)
                            : null
                    },
                    {
                        onConfirm: () => {
                            setGeometryStatus(label.submitted, { submitted: true });
                            updateCreateProposalSubmitState();
                        }
                    }
                );
            }
            break;
        default:
            break;
    }

    updateCreateProposalSubmitState();
}

function relocateProposalGeometryGroup(goalKey) {
    const geo = document.getElementById('proposalGeometryGroup');
    const typology = document.getElementById('proposalTypologyGroup');
    const landUse = document.querySelector('#proposalGoalGroup [data-goal-section="land-use"]');
    const parcels = document.querySelector('#proposalGoalGroup [data-goal-section="parcels"]');

    if (goalKey === 'urban-rule') {
        // Typology (block/row/parcel-based) then the geometry Edit, both inline under Land use.
        if (typology && landUse) landUse.insertAdjacentElement('afterend', typology);
        if (geo && typology) typology.insertAdjacentElement('afterend', geo);
        return;
    }
    if (goalKey === 'single' || goalKey === 'road-track') {
        if (geo && landUse) landUse.insertAdjacentElement('afterend', geo);
        return;
    }
    if (goalKey === 'reparcellization') {
        if (geo && parcels) parcels.insertAdjacentElement('afterend', geo);
        return;
    }
}

function buildGeometryFromParcels(parcelLayers = []) {
    if (!parcelLayers.length) return null;

    const parcelFeatures = parcelLayers
        .map(layer => {
            const feature = layer?.feature;
            if (!feature || !feature.geometry) return null;
            try {
                return JSON.parse(JSON.stringify(feature));
            } catch (_) {
                return feature;
            }
        })
        .filter(Boolean);

    let mergedFeature = null;

    // Prefer a plain turf union to avoid the small buffer used by robustUnion, which can seal holes.
    if (parcelFeatures.length && typeof turf !== 'undefined') {
        try {
            let merged = null;
            parcelFeatures.forEach(feature => {
                merged = merged ? (turf.union(merged, feature) || merged) : feature;
            });
            mergedFeature = merged;
        } catch (e) {
            console.warn('turf.union failed for parcel selection geometry, falling back to raw coordinates', e);
        }
    }

    // After union, detect any internal gaps (areas enclosed by the union but not covered by any parcel)
    // and carve them out as holes
    if (mergedFeature && mergedFeature.geometry && typeof turf !== 'undefined' && turf.difference) {
        try {
            // Get the outer shell of the merged geometry (no holes)
            const extractOuterShell = (geom) => {
                if (!geom || !geom.coordinates) return null;
                if (geom.type === 'Polygon') {
                    return { type: 'Polygon', coordinates: [geom.coordinates[0]] };
                }
                if (geom.type === 'MultiPolygon') {
                    return {
                        type: 'MultiPolygon',
                        coordinates: geom.coordinates.map(poly => [poly[0]])
                    };
                }
                return null;
            };

            const outerShell = extractOuterShell(mergedFeature.geometry);
            if (outerShell) {
                const shellFeature = { type: 'Feature', properties: {}, geometry: outerShell };

                // Subtract all original parcels from the shell to find gaps
                let gaps = shellFeature;
                for (const parcel of parcelFeatures) {
                    if (!gaps) break;
                    try {
                        gaps = turf.difference(gaps, parcel);
                    } catch (_) { /* ignore */ }
                }

                // If there are gaps, they represent internal holes that should be preserved
                if (gaps && gaps.geometry && gaps.geometry.coordinates) {
                    const gapGeom = gaps.geometry;
                    const holeRings = [];

                    const collectRings = (geom) => {
                        if (geom.type === 'Polygon' && Array.isArray(geom.coordinates[0])) {
                            holeRings.push(geom.coordinates[0]);
                        } else if (geom.type === 'MultiPolygon') {
                            geom.coordinates.forEach(poly => {
                                if (Array.isArray(poly[0])) holeRings.push(poly[0]);
                            });
                        }
                    };
                    collectRings(gapGeom);

                    // Add the gap rings as holes to the merged geometry
                    if (holeRings.length > 0) {
                        const addHolesToGeometry = (geom, holes) => {
                            if (geom.type === 'Polygon') {
                                return {
                                    type: 'Polygon',
                                    coordinates: [geom.coordinates[0], ...holes]
                                };
                            }
                            if (geom.type === 'MultiPolygon') {
                                // Add holes to the largest polygon
                                let largestIdx = 0;
                                let largestArea = -Infinity;
                                geom.coordinates.forEach((poly, idx) => {
                                    try {
                                        const area = turf.area(turf.polygon([poly[0]]));
                                        if (area > largestArea) {
                                            largestArea = area;
                                            largestIdx = idx;
                                        }
                                    } catch (_) { }
                                });
                                const newCoords = geom.coordinates.map((poly, idx) => {
                                    if (idx === largestIdx) {
                                        return [poly[0], ...holes];
                                    }
                                    return poly;
                                });
                                return { type: 'MultiPolygon', coordinates: newCoords };
                            }
                            return geom;
                        };

                        mergedFeature = {
                            type: 'Feature',
                            properties: mergedFeature.properties || {},
                            geometry: addHolesToGeometry(mergedFeature.geometry, holeRings)
                        };
                    }
                }
            }
        } catch (e) {
            console.warn('Failed to detect/preserve internal gaps in parcel selection', e);
        }
    }

    if (mergedFeature && mergedFeature.geometry) {
        if (mergedFeature.geometry.type === 'Polygon') {
            return { type: 'MultiPolygon', coordinates: [mergedFeature.geometry.coordinates] };
        }
        if (mergedFeature.geometry.type === 'MultiPolygon') {
            return { type: 'MultiPolygon', coordinates: mergedFeature.geometry.coordinates };
        }
    }

    const multiCoords = [];
    parcelLayers.forEach(layer => {
        const geom = layer?.feature?.geometry;
        if (!geom || !geom.coordinates) return;
        if (geom.type === 'Polygon') {
            multiCoords.push(geom.coordinates);
        } else if (geom.type === 'MultiPolygon') {
            geom.coordinates.forEach(rings => multiCoords.push(rings));
        }
    });
    return multiCoords.length ? { type: 'MultiPolygon', coordinates: multiCoords } : null;
}

function computeLakeZonesForGeometry(baseFeature, options = {}) {
    const targetRatio = typeof options.targetShoreRatio === 'number'
        ? Math.max(0.05, Math.min(0.45, options.targetShoreRatio))
        : LAKE_SHORE_TARGET_RATIO;
    const baseArea = Math.max(0, turf.area(baseFeature) || 0);
    if (!baseArea) return null;

    let bbox = null;
    try { bbox = turf.bbox(baseFeature); } catch (_) { bbox = null; }
    const [minLng, minLat, maxLng, maxLat] = Array.isArray(bbox) && bbox.length === 4 ? bbox : [0, 0, 0, 0];
    let widthMeters = 0;
    let heightMeters = 0;
    try { widthMeters = turf.distance([minLng, minLat], [maxLng, minLat], { units: 'meters' }); } catch (_) { widthMeters = 0; }
    try { heightMeters = turf.distance([minLng, minLat], [minLng, maxLat], { units: 'meters' }); } catch (_) { heightMeters = 0; }
    const minDim = Math.max(1, Math.min(Math.max(widthMeters, 0), Math.max(heightMeters, 0)));
    const minWidth = 0.5;
    const maxWidth = Math.max(minWidth, minDim * 0.45);
    const areaGuess = Math.sqrt(baseArea / Math.PI) * 0.105;
    const widthHint = Math.max(minWidth, Math.min(maxWidth, typeof options.widthHintMeters === 'number' ? options.widthHintMeters : areaGuess));
    let low = minWidth;
    let high = maxWidth;
    let best = null;
    let bestBelow = null;

    for (let i = 0; i < 7; i++) {
        const width = (i === 0) ? widthHint : (low + high) / 2;
        let water = null;
        try { water = turf.buffer(baseFeature, -width, { units: 'meters', steps: 32 }); } catch (_) { water = null; }
        if (!water || !water.geometry || !water.geometry.coordinates || !water.geometry.coordinates.length) {
            high = Math.max(minWidth, width * 0.8);
            continue;
        }
        const waterArea = Math.max(0, turf.area(water) || 0);
        if (!waterArea) {
            high = Math.max(minWidth, width * 0.8);
            continue;
        }
        let shore = null;
        try { shore = turf.difference(baseFeature, water); } catch (_) { shore = null; }
        if (!shore) shore = baseFeature;
        const ratio = Math.max(0, Math.min(1, (baseArea - waterArea) / baseArea));
        const delta = Math.abs(ratio - targetRatio);
        const current = { water, shore, width, ratio, delta };
        if (ratio <= targetRatio && (!bestBelow || ratio > bestBelow.ratio)) bestBelow = current;
        if (!best || delta < best.delta) best = current;
        if (ratio > targetRatio) {
            high = width;
        } else {
            low = width;
        }
    }

    const chosen = bestBelow || best;
    if (!chosen) return null;

    let transition = null;
    try {
        const outerWidth = Math.max(minWidth, chosen.width * 0.55);
        const outer = turf.buffer(baseFeature, -outerWidth, { units: 'meters', steps: 32 });
        if (outer && outer.geometry && chosen.water && chosen.water.geometry) {
            try { transition = turf.difference(outer, chosen.water); } catch (_) { transition = null; }
        }
    } catch (_) { transition = null; }

    return {
        water: chosen.water,
        shore: chosen.shore,
        transition,
        width: chosen.width,
        ratio: chosen.ratio
    };
}

function buildLakeGraphicsFromGeometry(geometry, options = {}) {
    if (!geometry || !geometry.type || !geometry.coordinates || typeof turf === 'undefined') return null;
    const polygons = [];
    try {
        if (geometry.type === 'Polygon') {
            polygons.push(turf.polygon(geometry.coordinates));
        } else if (geometry.type === 'MultiPolygon') {
            geometry.coordinates.forEach(rings => polygons.push(turf.polygon(rings)));
        }
    } catch (_) { }
    if (!polygons.length) return null;

    let merged = polygons[0];
    for (let i = 1; i < polygons.length; i++) {
        try {
            const next = turf.union(merged, polygons[i]);
            if (next && next.geometry) merged = next;
        } catch (_) { /* keep best-so-far */ }
    }
    const base = merged && merged.geometry ? merged : polygons[0];

    const zones = computeLakeZonesForGeometry(base, {
        targetShoreRatio: LAKE_SHORE_TARGET_RATIO,
        widthHintMeters: typeof options.shoreWidthMeters === 'number' ? Math.max(0.5, options.shoreWidthMeters) : null
    }) || null;
    const shore = zones && zones.shore ? zones.shore : base;
    const water = zones && zones.water ? zones.water : null;
    const transition = zones && zones.transition ? zones.transition : null;
    const shoreWidth = zones && zones.width ? zones.width : (typeof options.shoreWidthMeters === 'number' ? Math.max(0.5, options.shoreWidthMeters) : 6);

    const fish = [];
    const fishArea = water && water.geometry ? water : base;
    try {
        const bbox = turf.bbox(fishArea);
        const desired = Math.max(2, Math.min(8, Math.round((turf.area(fishArea) || 0) / 8000)));
        const candidates = turf.randomPoint(desired * 3, { bbox });
        candidates.features.forEach(pt => {
            try {
                if (turf.booleanPointInPolygon(pt, fishArea) && fish.length < desired) {
                    fish.push(pt.geometry.coordinates);
                }
            } catch (_) { /* skip invalid */ }
        });
    } catch (_) { }

    return {
        geometry: base.geometry || geometry,
        shore: shore && shore.geometry ? shore.geometry : (shore.geometry ? shore.geometry : shore),
        water: water && water.geometry ? water.geometry : null,
        transition: transition && transition.geometry ? transition.geometry : null,
        fish,
        version: LAKE_GRAPHICS_VERSION,
        shoreWidthMeters: shoreWidth,
        shoreRatio: zones && typeof zones.ratio === 'number' ? zones.ratio : null
    };
}

function calculateBoundsForLastAppliedProposal(proposalId) {
    if (!proposalId) return null;
    if (typeof proposalStorage === 'undefined' || !proposalStorage) return null;

    // Find the visible descendant - this is the proposal whose children are actually on the map
    const visibleDescendantId = findVisibleDescendant(proposalId);
    const proposal = getProposalByIdOrHash(visibleDescendantId);
    if (!proposal) return null;

    console.debug('[calculateBoundsForLastAppliedProposal] Using visible descendant:', visibleDescendantId);

    // Just get the child parcel IDs of this proposal directly
    let parcelIdsForBounds = [];
    const addAll = (list) => {
        (Array.isArray(list) ? list : []).forEach(id => {
            const val = id && id.toString ? id.toString() : String(id || '');
            if (val) parcelIdsForBounds.push(val);
        });
    };

    addAll(proposal.childParcelIds);
    addAll(proposal?.roadProposal?.childParcelIds);
    addAll(proposal?.reparcellization?.childParcelIds);
    addAll(proposal?.decideLaterProposal?.childParcelIds);
    addAll(proposal?.structureProposal?.childParcelIds);

    console.debug('[calculateBoundsForLastAppliedProposal] Child parcels:', parcelIdsForBounds.length);

    // If no children, fall back to parents
    if (!parcelIdsForBounds.length) {
        parcelIdsForBounds = ensureArrayOfStrings(proposal.parentParcelIds || []);
    }

    // First try parcel-based bounds (descendants preferred). Do not fall back to parents if descendants exist.
    if (parcelIdsForBounds.length > 0) {
        const bounds = calculateProposalBounds(parcelIdsForBounds, { proposal });
        if (bounds) {
            try {
                if (typeof L !== 'undefined' && L && typeof L.latLngBounds === 'function') {
                    return L.latLngBounds(
                        [bounds.south, bounds.west],
                        [bounds.north, bounds.east]
                    );
                }
            } catch (_) { /* ignore */ }
            return null;
        }
    }

    // If no parcels or they are unavailable, fall back to proposal geometries
    const geometryBounds = calculateProposalGeometryBounds(proposal);
    if (geometryBounds) return geometryBounds;

    return null;
}

function calculateProposalGeometryBounds(proposal) {
    if (!proposal) return null;

    const geometries = [];
    const addGeom = (geom) => {
        if (geom && geom.type && Array.isArray(geom.coordinates)) {
            geometries.push({ type: 'Feature', geometry: geom, properties: {} });
        }
    };
    const addFeatureGeom = (feature) => {
        if (feature && feature.geometry) addGeom(feature.geometry);
    };

    try {
        if (proposal.geometry) {
            addGeom(proposal.geometry.roadGeometry || proposal.geometry.roadPlan || proposal.geometry.structureGeometry || proposal.geometry.structure || proposal.geometry.parcelGeometry || proposal.geometry.parcel);
            if (Array.isArray(proposal.geometry.buildings)) {
                proposal.geometry.buildings.forEach(addFeatureGeom);
            }
        }
        if (proposal.roadProposal && proposal.roadProposal.geometry) {
            addGeom(proposal.roadProposal.geometry);
        }
        if (proposal.structureProposal && proposal.structureProposal.geometry) {
            addGeom(proposal.structureProposal.geometry);
        }
        if (proposal.decideLaterProposal && proposal.decideLaterProposal.geometry) {
            addGeom(proposal.decideLaterProposal.geometry);
        }
    } catch (_) { /* best-effort */ }

    if (!geometries.length) return null;

    try {
        if (typeof L !== 'undefined' && L && typeof L.geoJSON === 'function') {
            const bounds = L.geoJSON({ type: 'FeatureCollection', features: geometries }).getBounds();
            if (bounds && typeof bounds.isValid === 'function' && bounds.isValid()) {
                return bounds;
            }
        }
    } catch (_) { /* ignore */ }
    return null;
}

function calculateProposalBounds(parcelIds, options = {}) {
    if (!parcelIds || parcelIds.length === 0) return null;

    const proposal = options.proposal || null;
    const cache = proposal ? buildProposalFeatureCache(proposal) : null;

    const positions = [];
    const missingParcels = [];

    parcelIds.forEach(rawParcelId => {
        const parcelId = rawParcelId && rawParcelId.toString ? rawParcelId.toString() : (rawParcelId ? String(rawParcelId) : null);
        if (!parcelId) {
            return;
        }

        let center = null;

        if (cache && cache.parcelsById && cache.parcelsById.has(parcelId)) {
            const cachedFeature = cache.parcelsById.get(parcelId);
            if (cachedFeature && cachedFeature.geometry) {
                try {
                    const boundsFromFeature = L.geoJSON(cachedFeature).getBounds();
                    if (boundsFromFeature && typeof boundsFromFeature.getCenter === 'function' && boundsFromFeature.isValid && boundsFromFeature.isValid()) {
                        center = boundsFromFeature.getCenter();
                    }
                } catch (e) {
                    console.warn(`calculateProposalBounds: failed to compute bounds from cached feature for ${parcelId}`, e);
                }
            }
        }

        if (!center && typeof multiParcelSelection !== 'undefined' && multiParcelSelection && typeof multiParcelSelection.findParcelById === 'function') {
            const parcelLayer = multiParcelSelection.findParcelById(parcelId);
            if (parcelLayer && typeof parcelLayer.getBounds === 'function') {
                try {
                    const bounds = parcelLayer.getBounds();
                    if (bounds && typeof bounds.getCenter === 'function') {
                        const candidateCenter = bounds.getCenter();
                        if (candidateCenter && !isNaN(candidateCenter.lat) && !isNaN(candidateCenter.lng)) {
                            center = candidateCenter;
                        }
                    }
                } catch (e) {
                    console.warn(`Error getting bounds for parcel ${parcelId}:`, e);
                }
            }
        }

        if (center) {
            positions.push(center);
        } else {
            missingParcels.push(parcelId);
        }
    });

    if (positions.length === 0) {
        console.warn('Cannot calculate bounds - no valid parcel positions found');
        return null;
    }

    // Calculate bounding box
    let north = positions[0].lat;
    let south = positions[0].lat;
    let east = positions[0].lng;
    let west = positions[0].lng;

    positions.forEach(pos => {
        north = Math.max(north, pos.lat);
        south = Math.min(south, pos.lat);
        east = Math.max(east, pos.lng);
        west = Math.min(west, pos.lng);
    });

    // Calculate center
    const centerLat = (north + south) / 2;
    const centerLng = (east + west) / 2;

    const bounds = {
        center: { lat: centerLat, lng: centerLng },
        north: north,
        south: south,
        east: east,
        west: west,
        calculatedAt: new Date().toISOString(),
        parcelCount: positions.length,
        totalParcels: parcelIds.length
    };

    if (missingParcels.length > 0) {
        bounds.missingParcels = missingParcels;
        console.warn(`Bounds calculated from ${positions.length}/${parcelIds.length} parcels. Missing: ${missingParcels.join(', ')}`);
    }

    return bounds;
}

function computeProposalArea(proposal) {
    if (!proposal) return 0;

    if (Array.isArray(proposal.parentParcelIds) && proposal.parentParcelIds.length > 0) {
        return proposal.parentParcelIds.reduce((sum, id) => sum + getParcelAreaById(id), 0);
    }

    try {
        if (proposal.structureProposal?.geometry && typeof turf !== 'undefined' && typeof turf.area === 'function') {
            return turf.area(proposal.structureProposal.geometry);
        }
        if (proposal.buildingProposal?.buildingFeature && typeof turf !== 'undefined' && typeof turf.area === 'function') {
            return turf.area(proposal.buildingProposal.buildingFeature);
        }
    } catch (_) {
        // fall back silently when turf measurement fails
    }

    return 0;
}

function computeProposalMetrics(proposal) {
    const createdAt = Date.parse(proposal.createdAt) || 0;
    const executedAt = proposal.executedAt ? (Date.parse(proposal.executedAt) || 0) : 0;
    const parcelCount = Array.isArray(proposal.parentParcelIds) ? proposal.parentParcelIds.length : 0;
    const acceptedCount = Array.isArray(proposal.acceptedParcelIds) ? proposal.acceptedParcelIds.length : 0;
    const acceptanceRatio = parcelCount > 0 ? acceptedCount / parcelCount : 0;
    const offerValue = Number.isFinite(Number(proposal.offer)) ? Number(proposal.offer) : (Number.isFinite(Number(proposal.budget)) ? Number(proposal.budget) : 0);
    const area = computeProposalArea(proposal);
    const goalKey = resolveProposalGoalKey(proposal, null) || 'other';
    const typeKey = goalKey;
    const author = (proposal.author || '').trim();
    const title = (proposal.title || '').trim();

    return {
        createdAt,
        executedAt,
        parcelCount,
        acceptedCount,
        acceptanceRatio,
        acceptancePercent: acceptanceRatio * 100,
        offerValue,
        area,
        goalKey,
        typeKey,
        author,
        authorLower: author.toLowerCase(),
        titleLower: title.toLowerCase(),
        isApplied: isProposalApplied(proposal)
    };
}

function buildProposalThumbHtml(proposal) {
    if (!proposal) return '';
    if (typeof shouldSkipProposalScreenshot === 'function' && shouldSkipProposalScreenshot(proposal)) return '';
    const proposalId = (typeof getProposalKey === 'function') ? getProposalKey(proposal) : (proposal.proposalId || '');
    if (!proposalId) return '';

    // Server-tab summaries don't carry locally-stored data URLs. If a downloaded copy of this
    // proposal exists in proposalStorage, fall back to its screenshotDataUrl / screenshotUrl.
    let local = null;
    try {
        if (typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function') {
            const candidates = [
                proposal.proposalId,
                proposal.serverProposalId,
                proposal.id
            ].filter(Boolean);
            for (const key of candidates) {
                const found = proposalStorage.getProposal(key);
                if (found) { local = found; break; }
            }
        }
    } catch (_) { }

    const url = proposal.screenshotUrl
        || (proposal.onchain && proposal.onchain.imageUrl)
        || (proposal.onchainData && proposal.onchainData.imageUrl)
        || proposal.screenshotDataUrl
        || (local && (local.screenshotUrl
            || (local.onchain && local.onchain.imageUrl)
            || (local.onchainData && local.onchainData.imageUrl)
            || local.screenshotDataUrl))
        || '';
    const safeProposalId = escapeHtml(String(proposalId));

    if (url) {
        const safeUrl = escapeHtml(url);
        return `
            <div class="proposal-thumb proposal-thumb-has-image" data-proposal-id="${safeProposalId}">
                <img class="proposal-thumb-img" src="${safeUrl}" alt="" loading="lazy">
                <div class="proposal-thumb-large"><img src="${safeUrl}" alt=""></div>
            </div>
        `;
    }

    // No image: show the goal badge and nothing else. Thumbnails are rendered server-side when a
    // proposal is uploaded, so there is no "generate" action left for the user to take here — a
    // proposal without one is either purely local or one the backfill has yet to reach.
    const goalKey = (typeof normalizeGoalKey === 'function')
        ? normalizeGoalKey(proposal.goal || proposal.proposalType || '')
        : '';
    const badge = (typeof getProposalGoalBadge === 'function') ? getProposalGoalBadge(goalKey) : null;
    const icon = badge ? badge.text : '🖼';
    return `
        <div class="proposal-thumb proposal-thumb-empty" data-proposal-id="${safeProposalId}"
             ${badge ? `title="${escapeHtml(badge.label)}"` : ''}>
            <span class="proposal-thumb-icon" aria-hidden="true">${escapeHtml(icon)}</span>
        </div>
    `;
}

function computeBoundsFromGeoJSONFeatures(features) {
    if (typeof L === 'undefined' || !Array.isArray(features) || features.length === 0) {
        return null;
    }
    let combined = null;
    features.forEach(feature => {
        if (!feature) return;
        try {
            const layer = L.geoJSON(feature);
            if (layer && typeof layer.getBounds === 'function') {
                const bounds = layer.getBounds();
                if (bounds && bounds.isValid()) {
                    combined = combined ? combined.extend(bounds) : bounds;
                }
            }
        } catch (error) {
            console.warn('computeBoundsFromGeoJSONFeatures skipped feature', error);
        }
    });
    return combined;
}

function buildLeafletBoundsFromArray(bboxArray) {
    if (!Array.isArray(bboxArray) || bboxArray.length !== 4 || typeof L === 'undefined') {
        return null;
    }
    const [minX, minY, maxX, maxY] = bboxArray.map(Number);
    if (![minX, minY, maxX, maxY].every(v => Number.isFinite(v))) {
        return null;
    }
    try {
        return L.latLngBounds([minY, minX], [maxY, maxX]);
    } catch (error) {
        console.warn('buildLeafletBoundsFromArray failed', error, bboxArray);
        return null;
    }
}

function collectCoordinatesFromGeometry(geometry, visitor) {
    if (!geometry || typeof visitor !== 'function') return;
    const { type, coordinates } = geometry;
    if (!type) return;

    switch (type) {
        case 'Point':
            if (Array.isArray(coordinates)) {
                visitor(coordinates[0], coordinates[1]);
            }
            break;
        case 'MultiPoint':
        case 'LineString':
            if (Array.isArray(coordinates)) {
                coordinates.forEach(coord => {
                    if (Array.isArray(coord)) visitor(coord[0], coord[1]);
                });
            }
            break;
        case 'MultiLineString':
        case 'Polygon':
            if (Array.isArray(coordinates)) {
                coordinates.forEach(ring => {
                    if (Array.isArray(ring)) {
                        ring.forEach(coord => {
                            if (Array.isArray(coord)) visitor(coord[0], coord[1]);
                        });
                    }
                });
            }
            break;
        case 'MultiPolygon':
            if (Array.isArray(coordinates)) {
                coordinates.forEach(polygon => {
                    if (Array.isArray(polygon)) {
                        polygon.forEach(ring => {
                            if (Array.isArray(ring)) {
                                ring.forEach(coord => {
                                    if (Array.isArray(coord)) visitor(coord[0], coord[1]);
                                });
                            }
                        });
                    }
                });
            }
            break;
        case 'GeometryCollection':
            if (Array.isArray(geometry.geometries)) {
                geometry.geometries.forEach(inner => collectCoordinatesFromGeometry(inner, visitor));
            }
            break;
        default:
            break;
    }
}

function buildBoundsFromSharedPayload(payload) {
    try {
        if (payload && payload.bbox && typeof L !== 'undefined' && L && typeof L.latLngBounds === 'function') {
            const { south, west, north, east } = payload.bbox;
            if ([south, west, north, east].every(value => Number.isFinite(value))) {
                return L.latLngBounds([
                    [south, west],
                    [north, east]
                ]);
            }
        }
    } catch (_) { }
    return null;
}
