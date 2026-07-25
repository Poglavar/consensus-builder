// Turns a clicked system-loaded road parcel into an ordinary local corridor proposal, then opens the
// existing cross-section editor. Pure geometry/data helpers are exported for fast Node tests.
(function (global, factory) {
    'use strict';

    const api = factory(global);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (global) {
        global.SystemRoadAdoption = api;
        global.adoptSelectedSystemRoad = api.adoptSelectedSystemRoad;
    }
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    const MAX_ADOPTED_ROAD_WIDTH = 80;
    const MIN_ADOPTED_ROAD_WIDTH = 2;
    let adoptionInFlight = false;

    function clone(value) {
        return value == null ? value : JSON.parse(JSON.stringify(value));
    }

    function isRoadProposal(proposal) {
        if (!proposal) return false;
        const goal = String(proposal.goal || '').trim().toLowerCase();
        return goal === 'road-track' || !!proposal.roadProposal;
    }

    function canOffer(feature, parcelId, proposals = []) {
        const properties = feature?.properties || {};
        const roadByRegistry = !!(parcelId && typeof global.isRoadParcel === 'function'
            && global.isRoadParcel(String(parcelId)));
        const isSystemRoad = roadByRegistry || properties.isRoad === true || properties.isRoad === 'true';
        const polygonal = feature?.geometry?.type === 'Polygon' || feature?.geometry?.type === 'MultiPolygon';
        const proposalDerived = properties.isProposed === true
            || properties.ancestorProposal != null
            || properties.proposalId != null;
        return !!(isSystemRoad && polygonal && !proposalDerived && !(proposals || []).some(isRoadProposal));
    }

    function pointInRing(point, ring) {
        if (!Array.isArray(point) || !Array.isArray(ring) || ring.length < 3) return false;
        const x = Number(point[0]);
        const y = Number(point[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = Number(ring[i]?.[0]);
            const yi = Number(ring[i]?.[1]);
            const xj = Number(ring[j]?.[0]);
            const yj = Number(ring[j]?.[1]);
            if (![xi, yi, xj, yj].every(Number.isFinite)) continue;
            const crosses = ((yi > y) !== (yj > y))
                && x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi;
            if (crosses) inside = !inside;
        }
        return inside;
    }

    function ringArea(ring) {
        if (!Array.isArray(ring)) return 0;
        let twiceArea = 0;
        for (let i = 0; i < ring.length; i += 1) {
            const a = ring[i];
            const b = ring[(i + 1) % ring.length];
            if (!a || !b) continue;
            twiceArea += Number(a[0]) * Number(b[1]) - Number(b[0]) * Number(a[1]);
        }
        return Math.abs(twiceArea) / 2;
    }

    // A system feature can occasionally be a MultiPolygon. Adopt the part the user clicked; without
    // a click coordinate, choose the largest part instead of silently joining disconnected roads.
    function clickedRoadGeometry(feature, clickLngLat = null) {
        const geometry = feature?.geometry;
        if (!geometry) return null;
        if (geometry.type === 'Polygon') return clone(geometry);
        if (geometry.type !== 'MultiPolygon' || !Array.isArray(geometry.coordinates)) return null;
        const polygons = geometry.coordinates.filter(poly => Array.isArray(poly?.[0]) && poly[0].length >= 4);
        if (!polygons.length) return null;
        const clicked = Array.isArray(clickLngLat)
            ? polygons.find(poly => pointInRing(clickLngLat, poly[0]))
            : null;
        const chosen = clicked || polygons.slice().sort((a, b) => ringArea(b[0]) - ringArea(a[0]))[0];
        return { type: 'Polygon', coordinates: clone(chosen) };
    }

    function pointSegmentDistanceSquared(point, a, b) {
        const px = Number(point?.[0]);
        const py = Number(point?.[1]);
        const ax = Number(a?.[0]);
        const ay = Number(a?.[1]);
        const bx = Number(b?.[0]);
        const by = Number(b?.[1]);
        if (![px, py, ax, ay, bx, by].every(Number.isFinite)) return Infinity;
        const dx = bx - ax;
        const dy = by - ay;
        const denom = dx * dx + dy * dy;
        const t = denom > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / denom)) : 0;
        const qx = ax + t * dx;
        const qy = ay + t * dy;
        return (px - qx) ** 2 + (py - qy) ** 2;
    }

    function cleanLine(line) {
        const result = [];
        (line || []).forEach(pair => {
            const lng = Number(pair?.[0]);
            const lat = Number(pair?.[1]);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
            const previous = result[result.length - 1];
            if (previous && previous[0] === lng && previous[1] === lat) return;
            result.push([lng, lat]);
        });
        return result.length >= 2 ? result : null;
    }

    function centerlineCandidates(metrics) {
        const candidates = [];
        (metrics?.segments || []).forEach(segment => {
            const line = cleanLine(segment?.centerline);
            if (line) candidates.push(line);
        });
        const geometry = metrics?.centerline?.geometry;
        if (geometry?.type === 'LineString') {
            const line = cleanLine(geometry.coordinates);
            if (line) candidates.push(line);
        } else if (geometry?.type === 'MultiLineString') {
            (geometry.coordinates || []).forEach(coords => {
                const line = cleanLine(coords);
                if (line) candidates.push(line);
            });
        }
        return candidates;
    }

    function centerlineFromMetrics(metrics, clickLngLat = null) {
        const candidates = centerlineCandidates(metrics);
        if (!candidates.length) return null;
        let selected = candidates[0];
        if (Array.isArray(clickLngLat) && candidates.length > 1) {
            selected = candidates.reduce((best, line) => {
                const distance = line.slice(1).reduce((minimum, point, index) => (
                    Math.min(minimum, pointSegmentDistanceSquared(clickLngLat, line[index], point))
                ), Infinity);
                return distance < best.distance ? { line, distance } : best;
            }, { line: selected, distance: Infinity }).line;
        }
        return selected.map(([lng, lat]) => ({ lat, lng }));
    }

    function measuredRoadWidth(metrics, properties = {}) {
        const candidates = [
            metrics?.widths?.average,
            properties.roadWidth,
            properties.width
        ].map(Number);
        const measured = candidates.find(value => Number.isFinite(value) && value > 0) || 7.5;
        return Math.max(MIN_ADOPTED_ROAD_WIDTH, Math.min(MAX_ADOPTED_ROAD_WIDTH, measured));
    }

    function buildDefinition(feature, metrics, options = {}) {
        const clickLngLat = options.clickLngLat || null;
        const geometry = clickedRoadGeometry(feature, clickLngLat);
        const centerline = centerlineFromMetrics(metrics, clickLngLat);
        if (!geometry || !centerline) return null;
        const width = measuredRoadWidth(metrics, feature?.properties);
        const makeProfile = options.profileFactory
            || (typeof global.corridorProfileFromLegacy === 'function'
                ? global.corridorProfileFromLegacy
                : null);
        const profile = makeProfile ? makeProfile(width, null, false) : null;
        if (!profile) return null;
        const sidewalks = (profile.strips || []).filter(strip => strip.type === 'sidewalk');
        const sidewalkWidth = sidewalks.length
            ? sidewalks.reduce((sum, strip) => sum + Number(strip.width || 0), 0) / sidewalks.length
            : 0;
        const sourceParcelId = options.parcelId != null ? String(options.parcelId) : null;
        return {
            points: [centerline],
            segments: [centerline],
            segmentIds: ['system-1'],
            segmentProfiles: {},
            profile: clone(profile),
            width,
            sidewalkWidth,
            tunnels: [],
            gradeSeparations: [],
            demolishedBuildings: [],
            polygon: geometry,
            metadata: {
                mode: 'adopt-system-road',
                type: 'road',
                isRoad: true,
                isTrack: false,
                isCorridor: true,
                source: 'system-road',
                sourceParcelId
            }
        };
    }

    function buildProposal(feature, metrics, options = {}) {
        const definition = buildDefinition(feature, metrics, options);
        if (!definition) return null;
        const properties = feature?.properties || {};
        const parcelId = String(options.parcelId || '');
        const roadName = String(properties.roadName || properties.name || '').trim();
        const title = roadName && roadName !== 'Unnamed Road'
            ? roadName
            : (options.defaultName || 'Existing road');
        const author = options.author || 'User';
        const geometry = {
            roadPlan: clone(definition),
            roadGeometry: { polygon: clone(definition.polygon) }
        };
        return {
            author,
            title,
            name: title,
            proposalName: title,
            description: options.description || `Road proposal formed from system road segment ${parcelId}`,
            city: options.city || null,
            goal: 'road-track',
            primaryType: 'Road',
            isCorridor: true,
            applied: false,
            createdAt: new Date().toISOString(),
            parentParcelIds: [parcelId],
            definition: clone(definition),
            geometry,
            roadProposal: {
                definition: clone(definition),
                parentParcelIds: [parcelId],
                childParcelIds: [],
                mode: 'adopt-system-road',
                isCorridor: true
            }
        };
    }

    function t(key, fallback) {
        try {
            const translated = global.i18n?.t?.(key);
            if (translated && translated !== key) return translated;
        } catch (_) { }
        return fallback;
    }

    function setBusy(busy) {
        const button = global.document?.getElementById('adopt-system-road-button');
        if (!button) return;
        button.disabled = busy;
        button.textContent = busy
            ? t('panel.parcel.actions.formRoadProposalLoading', 'Forming road proposal…')
            : t('panel.parcel.actions.formRoadProposal', 'Form road proposal and edit profile');
    }

    function notify(message, kind = 'info') {
        if (typeof global.showEphemeralMessage === 'function') {
            global.showEphemeralMessage(message, 6000, kind);
        }
        if (typeof global.updateStatus === 'function') global.updateStatus(message);
    }

    async function adoptSelectedSystemRoad() {
        if (adoptionInFlight) return null;
        const selection = global.currentParcel;
        const feature = selection?.layer?.feature;
        const parcelId = selection?.id != null ? String(selection.id) : null;
        const storage = global.proposalStorage;
        const manager = global.ProposalManager;
        const proposals = parcelId && storage?.getProposalsForParcel
            ? storage.getProposalsForParcel(parcelId, { hydrateRoadAssets: false })
            : [];
        if (!feature || !parcelId || !storage || !manager || !canOffer(feature, parcelId, proposals)) {
            notify(t('panel.parcel.actions.formRoadProposalUnavailable', 'This road segment cannot be formed into a proposal.'), 'error');
            return null;
        }

        adoptionInFlight = true;
        setBusy(true);
        let proposalId = null;
        try {
            const click = selection.clickedLatLng;
            const clickLngLat = click && Number.isFinite(click.lat) && Number.isFinite(click.lng)
                ? [click.lng, click.lat]
                : null;
            const selectedGeometry = clickedRoadGeometry(feature, clickLngLat);
            if (!selectedGeometry || typeof global.calculateRoadMetrics !== 'function') {
                throw new Error('Road centreline analysis is unavailable');
            }
            const analysisFeature = { ...feature, geometry: selectedGeometry };
            const metrics = global.calculateRoadMetrics(selectedGeometry.coordinates);
            const author = global.resolveProposalAuthorName?.()
                || global.getCurrentUsername?.()
                || global.getCurrentUserAgent?.()?.name
                || 'User';
            const defaultName = typeof global.generateDefaultProposalName === 'function'
                ? global.generateDefaultProposalName('Road')
                : 'Existing road';
            const proposal = buildProposal(analysisFeature, metrics, {
                parcelId,
                clickLngLat,
                author,
                defaultName,
                city: global.getProposalCityId?.() || global.getCurrentCityId?.() || null,
                profileFactory: global.corridorProfileFromLegacy
            });
            if (!proposal) throw new Error('Could not derive a usable road centreline');

            proposalId = storage.addProposal(proposal);
            if (!proposalId) throw new Error('An equivalent road proposal already exists');
            try { manager._linkProposalToAncestors?.(proposalId, [parcelId]); } catch (_) { }
            const applied = await manager.applyProposal(proposalId, {
                applyAnyway: true,
                suppressMissingParentAlerts: true
            });
            if (!applied) throw new Error('The road proposal could not be applied');

            try { global.hideParcelInfo?.(); } catch (_) { }
            try { global.hideParcelInfoPanel?.(); } catch (_) { }
            if (typeof global.openCorridorProfileEditor === 'function') {
                global.openCorridorProfileEditor(proposalId);
            } else if (typeof global.focusProposalDetails === 'function') {
                await global.focusProposalDetails(proposalId, { centerOnProposal: false });
            }
            notify(t('panel.parcel.actions.formRoadProposalSuccess', 'Road proposal formed. Edit its profile, then apply the changes.'));
            return proposalId;
        } catch (error) {
            console.error('[system-road-adoption] Could not form road proposal', error);
            if (proposalId && typeof storage?.removeProposal === 'function') {
                // applyProposal is transaction-wrapped, but explicitly unapply before removing the
                // record as a belt-and-braces cleanup if a future apply path gains an external side effect.
                try {
                    await manager?.unapplyProposal?.(proposalId, {
                        skipConfirm: true,
                        skipRestoreSource: true
                    });
                } catch (_) { }
                try { storage.removeProposal(proposalId); } catch (_) { }
            }
            notify(t('panel.parcel.actions.formRoadProposalError', 'Could not form a road proposal from this segment.'), 'error');
            return null;
        } finally {
            adoptionInFlight = false;
            setBusy(false);
        }
    }

    return {
        canOffer,
        clickedRoadGeometry,
        centerlineFromMetrics,
        measuredRoadWidth,
        buildDefinition,
        buildProposal,
        adoptSelectedSystemRoad
    };
});
