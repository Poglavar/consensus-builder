/* global importScripts */
importScripts('https://unpkg.com/@turf/turf@6/turf.min.js');

const MIN_AREA_THRESHOLD = 0.01;

self.onmessage = event => {
    const data = event.data || {};
    const requestId = data.requestId;
    if (!requestId) {
        return;
    }
    try {
        if (data.type === 'process-plan') {
            const result = processPlanRequest(data);
            self.postMessage({ requestId, success: true, result });
        } else {
            self.postMessage({ requestId, success: false, error: new Error('Unsupported worker request type.') });
        }
    } catch (err) {
        self.postMessage({ requestId, success: false, error: serializeError(err) });
    }
};

function processPlanRequest(data) {
    if (typeof turf === 'undefined') {
        throw new Error('Turf.js is not available inside the government plan worker.');
    }

    const planPolygon = data.planPolygon;
    const parcels = Array.isArray(data.parcels) ? data.parcels : [];
    if (!planPolygon || !planPolygon.type) {
        return { parcels: [], stats: {} };
    }

    const stats = {
        booleanBBoxSkips: 0,
        booleanChecks: 0,
        booleanHits: 0,
        differenceAttempts: 0,
        differenceSuccess: 0,
        differenceFailed: 0,
        differenceNull: 0,
        differenceEmpty: 0,
        intersectionErrors: 0,
        differenceErrors: 0
    };

    const planFeature = normalizeFeature(planPolygon);
    const planBbox = computeFeatureBbox(planFeature);
    const outputs = [];

    parcels.forEach((parcel, index) => {
        const feature = normalizeFeature(parcel);
        if (!feature) {
            return;
        }

        const parcelId = parcel.id !== undefined && parcel.id !== null ? parcel.id.toString() : null;
        const parcelNumber = parcel.number !== undefined && parcel.number !== null ? parcel.number.toString() : null;
        const parcelIsRoad = parcel.isRoad === true || parcel.isRoad === 'true';

        const parcelBbox = computeFeatureBbox(feature);
        if (planBbox && parcelBbox && !bboxesOverlap(planBbox, parcelBbox)) {
            stats.booleanBBoxSkips += 1;
            return;
        }

        let intersects = false;
        try {
            stats.booleanChecks += 1;
            intersects = turf.booleanIntersects(feature, planFeature);
            if (intersects) {
                stats.booleanHits += 1;
            }
        } catch (err) {
            stats.intersectionErrors += 1;
            intersects = false;
        }

        if (!intersects) {
            return;
        }

        let intersection = null;
        try {
            intersection = turf.intersect(feature, planFeature);
        } catch (err) {
            stats.intersectionErrors += 1;
            intersection = null;
        }

        const roadPieces = [];
        let roadAreaTotal = 0;
        if (intersection && intersection.geometry) {
            const polygons = extractPolygonsWithHoles(intersection.geometry);
            polygons.forEach(poly => {
                const closedOuter = ensurePolygonIsClosed(poly.outer);
                if (!closedOuter || closedOuter.length < 4) {
                    return;
                }
                const closedHoles = (Array.isArray(poly.holes) ? poly.holes : [])
                    .map(hole => ensurePolygonIsClosed(hole))
                    .filter(ring => Array.isArray(ring) && ring.length >= 4);
                const coords = [closedOuter, ...closedHoles];
                const polygon = turf.polygon(coords);
                const area = safeArea(polygon);
                if (!Number.isFinite(area) || area <= MIN_AREA_THRESHOLD) {
                    return;
                }
                roadAreaTotal += area;
                roadPieces.push({ coords, area });
            });
        }

        if (!roadPieces.length) {
            return;
        }

        const parcelArea = safeArea(feature);
        let remainder = null;
        let remainderStatus = 'difference-success';
        try {
            stats.differenceAttempts += 1;
            remainder = turf.difference(feature, intersection);
        } catch (err) {
            stats.differenceFailed += 1;
            stats.differenceErrors += 1;
            remainderStatus = 'difference-error';
            remainder = null;
        }

        const remainderPieces = [];
        let remainderAreaTotal = 0;
        if (!remainder || !remainder.geometry) {
            stats.differenceNull += 1;
            if (remainderStatus !== 'difference-error') {
                remainderStatus = 'difference-null';
            }
        } else {
            const remPolygons = extractPolygonsWithHoles(remainder.geometry);
            if (!remPolygons.length) {
                stats.differenceEmpty += 1;
                remainderStatus = remainderStatus === 'difference-error' ? remainderStatus : 'difference-empty';
            } else {
                stats.differenceSuccess += 1;
                remPolygons.forEach(poly => {
                    const closedOuter = ensurePolygonIsClosed(poly.outer);
                    if (!closedOuter || closedOuter.length < 4) {
                        return;
                    }
                    const closedHoles = (Array.isArray(poly.holes) ? poly.holes : [])
                        .map(hole => ensurePolygonIsClosed(hole))
                        .filter(ring => Array.isArray(ring) && ring.length >= 4);
                    const coords = [closedOuter, ...closedHoles];
                    const polygon = turf.polygon(coords);
                    const area = safeArea(polygon);
                    if (!Number.isFinite(area) || area <= MIN_AREA_THRESHOLD) {
                        return;
                    }
                    remainderPieces.push({ coords, area });
                    remainderAreaTotal += area;
                });
                if (!remainderPieces.length && remainderStatus !== 'difference-error') {
                    remainderStatus = 'difference-empty';
                }
            }
        }

        const coverageRatio = parcelArea > 0 ? roadAreaTotal / parcelArea : null;
        let note;
        if (remainderStatus === 'difference-null') {
            note = 'turf.difference returned null; the plan slice may touch the parcel boundary or the geometry became invalid.';
        } else if (remainderStatus === 'difference-empty') {
            note = 'difference succeeded but yielded only slivers below the tolerance or the plan slice was clipped by the current view bounds.';
        } else if (remainderStatus === 'difference-error') {
            note = 'turf.difference threw an error while computing the parcel remainder.';
        } else {
            note = 'Remainder geometry computed successfully.';
        }

        outputs.push({
            parcelId,
            parcelNumber,
            isRoad: parcelIsRoad,
            parcelArea,
            roadPieces,
            roadArea: roadAreaTotal,
            remainderPieces,
            remainderArea: remainderAreaTotal,
            remainderStatus,
            coverageRatio,
            note,
            remainderPolygonCount: remainderPieces.length
        });

    });

    return { parcels: outputs, stats };
}

function normalizeFeature(input) {
    if (!input) return null;
    if (input.type === 'Feature') {
        return input;
    }
    if (input.geometry) {
        return { type: 'Feature', geometry: input.geometry, properties: Object.assign({}, input.properties || {}) };
    }
    if (input.coordinates && input.type) {
        return { type: 'Feature', geometry: { type: input.type, coordinates: input.coordinates }, properties: {} };
    }
    return null;
}

function extractPolygonOuterRings(geometry) {
    if (!geometry) return [];
    if (geometry.type === 'Polygon') {
        return Array.isArray(geometry.coordinates) && geometry.coordinates.length ? [geometry.coordinates[0]] : [];
    }
    if (geometry.type === 'MultiPolygon') {
        const rings = [];
        geometry.coordinates.forEach(poly => {
            if (Array.isArray(poly) && poly.length) {
                rings.push(poly[0]);
            }
        });
        return rings;
    }
    return [];
}

function extractPolygonsWithHoles(geometry) {
    if (!geometry) return [];
    if (geometry.type === 'Polygon') {
        const coords = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
        return coords.length ? [{ outer: coords[0], holes: coords.slice(1) }] : [];
    }
    if (geometry.type === 'MultiPolygon') {
        const polys = [];
        geometry.coordinates.forEach(poly => {
            if (Array.isArray(poly) && poly.length) {
                polys.push({ outer: poly[0], holes: poly.slice(1) });
            }
        });
        return polys;
    }
    return [];
}

function ensurePolygonIsClosed(coords) {
    if (!Array.isArray(coords) || coords.length < 3) {
        return null;
    }
    const first = coords[0];
    const last = coords[coords.length - 1];
    if (!Array.isArray(first) || !Array.isArray(last) || first.length !== 2 || last.length !== 2) {
        return null;
    }
    if (first[0] === last[0] && first[1] === last[1]) {
        return coords.slice();
    }
    const closed = coords.slice();
    closed.push([first[0], first[1]]);
    return closed;
}

function computeFeatureBbox(feature) {
    try {
        return turf.bbox(feature);
    } catch (_) {
        return null;
    }
}

function bboxesOverlap(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 4 || b.length !== 4) {
        return true;
    }
    return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

function safeArea(feature) {
    try {
        return turf.area(feature);
    } catch (_) {
        return 0;
    }
}

function serializeError(err) {
    if (!err) {
        return { message: 'Unknown worker error.' };
    }
    if (err instanceof Error) {
        return { message: err.message, stack: err.stack };
    }
    if (typeof err === 'object') {
        const clone = {};
        Object.keys(err).forEach(key => {
            clone[key] = err[key];
        });
        if (!clone.message) {
            clone.message = 'Unknown worker error.';
        }
        return clone;
    }
    return { message: String(err) };
}
