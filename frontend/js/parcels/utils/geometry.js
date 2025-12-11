(function (global) {
    'use strict';

    function calculateArea(coordinates) {
        const ring = coordinates[0];
        let area = 0;
        for (let i = 0; i < ring.length - 1; i++) {
            area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
        }
        area += ring[ring.length - 1][0] * ring[0][1] - ring[0][0] * ring[ring.length - 1][1];
        return Math.abs(area / 2);
    }

    function yieldToMainThread() {
        return new Promise(resolve => {
            if (typeof global.requestIdleCallback === 'function') {
                global.requestIdleCallback(() => resolve());
                return;
            }
            if (typeof global.requestAnimationFrame === 'function') {
                global.requestAnimationFrame(() => resolve());
                return;
            }
            setTimeout(resolve, 0);
        });
    }

    function ensureRingIsWGS(ring) {
        if (!Array.isArray(ring) || ring.length === 0) return ring;
        const first = ring[0];
        if (!Array.isArray(first) || first.length < 2) return ring;
        const looksLikeHTRS = Math.abs(first[0]) > 1000 || Math.abs(first[1]) > 1000;
        if (!looksLikeHTRS) return ring;
        return ring.map(coord => {
            const [lat, lon] = global.htrs96ToWGS84(coord[0], coord[1]);
            return [lon, lat];
        });
    }

    function cloneCoordinates(coords) {
        if (!Array.isArray(coords)) {
            return coords;
        }
        return coords.map(item => Array.isArray(item) ? cloneCoordinates(item) : item);
    }

    function convertGeoJSON(geojson) {
        const baseType = geojson && typeof geojson.type === 'string' ? geojson.type : 'FeatureCollection';
        const sourceFeatures = Array.isArray(geojson?.features) ? geojson.features : [];
        const converted = {
            type: baseType,
            features: []
        };

        sourceFeatures.forEach(originalFeature => {
            if (!originalFeature || typeof originalFeature !== 'object') {
                return;
            }

            const properties = Object.assign({}, originalFeature.properties || {});
            let geometry = null;
            if (originalFeature.geometry && typeof originalFeature.geometry === 'object') {
                geometry = {
                    type: originalFeature.geometry.type,
                    coordinates: cloneCoordinates(originalFeature.geometry.coordinates)
                };
            }

            if (geometry && geometry.coordinates && (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon')) {
                const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
                const shouldComputeArea = properties.calculatedArea === undefined;
                let computedArea = shouldComputeArea ? 0 : properties.calculatedArea;

                polygons.forEach(polyCoords => {
                    if (!Array.isArray(polyCoords) || polyCoords.length === 0) return;
                    const exterior = polyCoords[0];
                    if (!Array.isArray(exterior) || exterior.length === 0) return;
                    const looksLikeHTRS = Math.abs(exterior[0][0]) > 1000 || Math.abs(exterior[0][1]) > 1000;

                    if (looksLikeHTRS) {
                        if (shouldComputeArea) {
                            try {
                                computedArea += calculateArea([exterior]);
                            } catch (_) { }
                        }
                        for (let r = 0; r < polyCoords.length; r++) {
                            const ring = polyCoords[r];
                            if (!Array.isArray(ring) || ring.length === 0) continue;
                            polyCoords[r] = ring.map(coord => {
                                const [lat, lon] = global.htrs96ToWGS84(coord[0], coord[1]);
                                return [lon, lat];
                            });
                        }
                    } else {
                        if (shouldComputeArea) {
                            try {
                                const htrsCoords = exterior.map(coord => global.wgs84ToHTRS96(coord[1], coord[0]));
                                computedArea += calculateArea([htrsCoords]);
                            } catch (_) { }
                        }
                    }
                });

                if (shouldComputeArea) {
                    properties.calculatedArea = computedArea;
                }
            }

            converted.features.push({
                type: 'Feature',
                properties,
                geometry
            });
        });

        return converted;
    }

    function cloneFeatureDeep(feature) {
        if (!feature || typeof feature !== 'object') {
            return null;
        }
        const clone = {
            type: feature.type || 'Feature',
            properties: Object.assign({}, feature.properties || {})
        };
        if (feature.geometry && typeof feature.geometry === 'object') {
            clone.geometry = {
                type: feature.geometry.type,
                coordinates: cloneCoordinates(feature.geometry.coordinates)
            };
        } else {
            clone.geometry = null;
        }
        return clone;
    }

    global.calculateArea = calculateArea;
    global.ensureRingIsWGS = ensureRingIsWGS;
    global.cloneCoordinates = cloneCoordinates;
    global.convertGeoJSON = convertGeoJSON;
    global.cloneFeatureDeep = cloneFeatureDeep;
    global.yieldToMainThread = yieldToMainThread;

    global.ParcelsUtils = {
        calculateArea,
        ensureRingIsWGS,
        cloneCoordinates,
        convertGeoJSON,
        cloneFeatureDeep,
        yieldToMainThread
    };
})(typeof window !== 'undefined' ? window : globalThis);

