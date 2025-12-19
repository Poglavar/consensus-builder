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

    function cloneCoordinates(coords) {
        if (!Array.isArray(coords)) {
            return coords;
        }
        return coords.map(item => Array.isArray(item) ? cloneCoordinates(item) : item);
    }

    const cityConfigManager = (typeof global.CityConfigManager !== 'undefined') ? global.CityConfigManager : null;
    const datasetToLatLng = cityConfigManager && typeof cityConfigManager.datasetToLatLng === 'function'
        ? cityConfigManager.datasetToLatLng
        : null;

    function convertDatasetCoordToLatLng(easting, northing) {
        if (!Number.isFinite(easting) || !Number.isFinite(northing)) {
            return null;
        }
        if (datasetToLatLng) {
            try {
                const [lat, lon] = datasetToLatLng(easting, northing);
                if (Number.isFinite(lat) && Number.isFinite(lon)) {
                    return [lon, lat]; // Leaflet expects [lon, lat]
                }
            } catch (_) { /* ignore and fall back */ }
        }
        return null;
    }

    function convertGeoJSON(geojson, options) {
        const baseType = geojson && typeof geojson.type === 'string' ? geojson.type : 'FeatureCollection';
        const sourceFeatures = Array.isArray(geojson?.features) ? geojson.features : [];
        const opts = options && typeof options === 'object' ? options : {};
        const sourceSrid = opts.sourceSrid;
        const suppressHTRSWarning = opts.suppressHTRSWarning === true;
        const assumeHTRS = sourceSrid === 3765 || sourceSrid === 'EPSG:3765' || sourceSrid === 'htrs96';
        let htrsWarningCount = 0;
        const converted = {
            type: baseType,
            features: []
        };

        sourceFeatures.forEach(originalFeature => {
            if (!originalFeature || typeof originalFeature !== 'object') {
                return;
            }

            const properties = Object.assign({}, originalFeature.properties || {});
            // If feature is marked as already in WGS84 (from PersistentStorage), skip conversion
            const alreadyInWGS84 = properties._storedInWGS84 === true;
            delete properties._storedInWGS84; // Remove marker property

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

                const parcelId = properties?.parcelId?.toString();
                const isMultiPolygon = geometry.type === 'MultiPolygon';
                const DEBUG_MULTIPOLYGON_ID = '21606957';
                const isDebugParcel = parcelId === DEBUG_MULTIPOLYGON_ID;

                polygons.forEach((polyCoords, polyIndex) => {
                    if (!Array.isArray(polyCoords) || polyCoords.length === 0) return;
                    const exterior = polyCoords[0];
                    if (!Array.isArray(exterior) || exterior.length === 0) return;

                    // Skip conversion if already marked as WGS84 (from PersistentStorage)
                    if (alreadyInWGS84) {
                        if (shouldComputeArea && !properties.calculatedArea) {
                            try {
                                const turfPoly = { type: 'Polygon', coordinates: polyCoords };
                                if (typeof global.turf !== 'undefined' && typeof global.turf.area === 'function') {
                                    computedArea += global.turf.area(turfPoly);
                                }
                            } catch (_) { /* ignore */ }
                        }
                        return; // Skip conversion for this polygon
                    }

                    // Check if coordinates look like WGS84 [lng, lat] format
                    // WGS84: lng is -180 to 180, lat is -90 to 90
                    // HTRS96 for Zagreb: easting is ~500000-600000, northing is ~5000000-6000000
                    // If any coordinate value is > 1000, it's definitely not WGS84 (likely HTRS96)
                    const first = exterior[0];
                    if (!Array.isArray(first) || first.length < 2) return;
                    const coord0 = Math.abs(first[0]);
                    const coord1 = Math.abs(first[1]);
                    const isDatasetCoord = coord0 > 1000 || coord1 > 1000;
                    // Simple check: if either coordinate is > 1000, it's dataset coordinates (HTRS96)
                    // Otherwise, if both are within WGS84 bounds, treat as WGS84
                    // NOTE: Backend already transforms to WGS84, so if we see HTRS96 values here,
                    // it means either: 1) backend transformation failed, or 2) data came from OSS WFS (not our backend)
                    const looksLikeLatLng = coord0 <= 1000 && coord1 <= 1000 &&
                        (coord0 <= 180 && coord1 <= 90);

                    // Log if we detect HTRS96 coordinates when we expect WGS84 (backend should have transformed)
                    if (!looksLikeLatLng && isDatasetCoord && !suppressHTRSWarning && !assumeHTRS && htrsWarningCount < 3) {
                        const geomType = geometry.type;
                        console.warn(`[convertGeoJSON] Detected HTRS96 coordinates for ${geomType} parcel ${parcelId} - backend transformation may have failed`, {
                            firstCoordinate: first,
                            coord0,
                            coord1,
                            polygonIndex: polyIndex
                        });
                        htrsWarningCount++;
                    }

                    if (!looksLikeLatLng) {
                        if (shouldComputeArea) {
                            try {
                                computedArea += calculateArea([exterior]);
                            } catch (_) { /* ignore */ }
                        }
                        let conversionFailed = false;
                        let conversionFailedCount = 0;
                        let conversionSuccessCount = 0;
                        for (let r = 0; r < polyCoords.length; r++) {
                            const ring = polyCoords[r];
                            if (!Array.isArray(ring) || ring.length === 0) continue;
                            polyCoords[r] = ring.map((coord, idx) => {
                                if (conversionFailed) return [0, 0]; // Fast-fail if we already know it's bad

                                const convertedCoord = convertDatasetCoordToLatLng(coord[0], coord[1]);
                                if (convertedCoord) {
                                    conversionSuccessCount++;
                                    return convertedCoord;
                                }

                                // Fallback to htrs96ToWGS84
                                if (typeof global.htrs96ToWGS84 === 'function') {
                                    try {
                                        const [lat, lon] = global.htrs96ToWGS84(coord[0], coord[1]);
                                        if (Number.isFinite(lat) && Number.isFinite(lon)) {
                                            conversionSuccessCount++;
                                            return [lon, lat];
                                        }
                                    } catch (_) { /* ignore */ }
                                }

                                // If conversion failed, mark as failed and return invalid coord
                                // The validation in ingestParcelFeatures will catch (0, 0) and skip this parcel
                                conversionFailed = true;
                                conversionFailedCount++;
                                const parcelId = properties?.parcelId;
                                if (isDebugParcel || conversionFailedCount <= 3) {
                                    console.warn(`[convertGeoJSON] Coordinate conversion failed for ${isMultiPolygon ? 'MultiPolygon' : 'Polygon'} parcel ${parcelId} polygon ${polyIndex} ring ${r} coord ${idx}:`, coord);
                                }
                                return [0, 0];
                            });
                        }

                    } else {
                        if (shouldComputeArea) {
                            let areaAdded = false;
                            // Prefer geodesic area in meters when Turf is available (handles EPSG:4326 inputs correctly).
                            if (typeof global.turf !== 'undefined' && typeof global.turf.area === 'function') {
                                try {
                                    const turfPoly = { type: 'Polygon', coordinates: polyCoords };
                                    const turfArea = global.turf.area(turfPoly);
                                    if (Number.isFinite(turfArea)) {
                                        computedArea += turfArea;
                                        areaAdded = true;
                                    }
                                } catch (_) { /* ignore and fall back */ }
                            }
                            if (!areaAdded) {
                                try {
                                    const htrsCoords = exterior.map(coord => global.wgs84ToHTRS96(coord[1], coord[0]));
                                    computedArea += calculateArea([htrsCoords]);
                                } catch (_) { /* ignore */ }
                            }
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
    global.cloneCoordinates = cloneCoordinates;
    global.convertGeoJSON = convertGeoJSON;
    global.cloneFeatureDeep = cloneFeatureDeep;
    global.yieldToMainThread = yieldToMainThread;

    global.ParcelsUtils = {
        calculateArea,
        cloneCoordinates,
        convertGeoJSON,
        cloneFeatureDeep,
        yieldToMainThread
    };
})(typeof window !== 'undefined' ? window : globalThis);

