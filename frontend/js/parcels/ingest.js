(function (global) {
    'use strict';

    function buildHumanParcelId(props) {
        // Build HR-<maticni_broj_ko>-<broj_cestice> when available
        const cad = props.maticni_broj_ko ?? props.MATICNI_BROJ_KO;
        const num = props.broj_cestice ?? props.BROJ_CESTICE;
        if (cad !== undefined && cad !== null && num !== undefined && num !== null) {
            return `HR-${cad}-${num}`;
        }
        return null;
    }

    function normalizeFeatureParcelId(feature) {
        if (!feature || typeof feature !== 'object') return null;

        // Prefer ensureParcelId helper if present
        if (typeof global.ensureParcelId === 'function') {
            const ensured = global.ensureParcelId(feature);
            if (ensured) return ensured;
        }

        var props = feature.properties || {};

        // Explicit parcelId from source
        var id = props.parcelId ?? props.parcel_id ?? props.id;
        if (id !== undefined && id !== null) {
            props.parcelId = String(id);
            props.id = props.id || props.parcelId;
            feature.properties = props;
            return props.parcelId;
        }

        // OSS fallback: synthesize from cadastral + parcel number
        var synthesized = buildHumanParcelId(props);
        if (synthesized) {
            props.parcelId = synthesized;
            props.id = props.id || synthesized;
            feature.properties = props;
            return synthesized;
        }

        return null;
    }

    async function ingestParcelFeatures(rawFeatures, options) {
        if (!Array.isArray(rawFeatures) || rawFeatures.length === 0) {
            return [];
        }

        var tStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

        var shouldReplaceExisting = !!(options && options.replaceExisting === true);

        var tConvertStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        var convertedFeatures = rawFeatures;
        if (!options || !options.skipConversion) {
            var converted = global.convertGeoJSON({ type: 'FeatureCollection', features: rawFeatures });
            convertedFeatures = Array.isArray(converted && converted.features) ? converted.features : [];
        }
        var convertMs = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - tConvertStart;

        if (!convertedFeatures.length) {
            console.debug('[ingestParcelFeatures] timings: convert=' + (convertMs.toFixed ? convertMs.toFixed(1) : convertMs) + 'ms, nothing to ingest (' + rawFeatures.length + ' raw)');
            return [];
        }

        if (typeof global.ensureParcelLayerInitialized === 'function') {
            global.ensureParcelLayerInitialized();
        }

        var tPrepStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

        var renderableFeatures = [];
        var idsToReplace = new Set();
        var removedByProposalSkipped = [];
        var mapById = (global.parcelLayerById instanceof Map) ? global.parcelLayerById : null;
        var parcelStore = (global.ParcelsState && global.ParcelsState.getParcelCache)
            ? global.ParcelsState.getParcelCache()
            : global.parcelCache;
        var skippedExisting = 0;
        convertedFeatures.forEach(function (feature) {
            var parcelId = normalizeFeatureParcelId(feature);
            if (!parcelId) return;
            if (parcelStore && parcelStore.byId instanceof Map) {
                const existing = parcelStore.byId.get(parcelId.toString());
                if (existing && existing.properties) {
                    feature.properties = Object.assign({}, feature.properties, {
                        ownershipDetails: feature.properties.ownershipDetails || existing.properties.ownershipDetails,
                        ownershipList: feature.properties.ownershipList || existing.properties.ownershipList,
                        ownershipType: feature.properties.ownershipType || existing.properties.ownershipType
                    });
                }
                parcelStore.byId.set(parcelId.toString(), feature);
            }

            // If a proposal previously removed this parcel (replaced by children), keep it out of the map layer while retaining it in cache.
            try {
                const idString = parcelId.toString();
                const isReplaced = (typeof isParcelReplacedByChildren === 'function') ? isParcelReplacedByChildren(idString) : false;
                if (isReplaced) {
                    // Only keep the parent hidden when at least one replacement slice actually
                    // exists on the map. Slice ids drift between devices, so an applied proposal
                    // can claim a parent whose children were never (re)generated here — skipping
                    // the parent then leaves a permanent unclickable hole in the fabric.
                    const layerIndex = (typeof global !== 'undefined' && global.parcelLayerById instanceof Map)
                        ? global.parcelLayerById
                        : (typeof window !== 'undefined' && window.parcelLayerById instanceof Map ? window.parcelLayerById : null);
                    let hasLiveChild = !layerIndex; // cannot verify -> keep the old behaviour
                    if (layerIndex) {
                        const derivedPrefix = idString + '#p-';
                        const legacyPrefix = idString + '_';
                        for (const key of layerIndex.keys()) {
                            if (typeof key === 'string' && (key.startsWith(derivedPrefix) || key.startsWith(legacyPrefix))) {
                                hasLiveChild = true;
                                break;
                            }
                        }
                    }
                    if (hasLiveChild) {
                        removedByProposalSkipped.push(idString);
                        return;
                    }
                }
            } catch (_) { /* best-effort guard */ }

            if (!feature.geometry || !feature.geometry.coordinates) return;

            const existsInMap = mapById && mapById.has(parcelId.toString());
            if (existsInMap && !shouldReplaceExisting) {
                skippedExisting++;
                return;
            }

            if (shouldReplaceExisting) {
                idsToReplace.add(parcelId);
            }

            var isMultiPolygon = feature.geometry && feature.geometry.type === 'MultiPolygon';
            if (isMultiPolygon && Array.isArray(feature.geometry.coordinates)) {
                feature.geometry.coordinates.forEach(function (polygonCoords) {
                    renderableFeatures.push({
                        type: 'Feature',
                        properties: Object.assign({}, feature.properties),
                        geometry: { type: 'Polygon', coordinates: polygonCoords }
                    });
                });
            } else {
                renderableFeatures.push(feature);
            }
        });

        // Skip logging; best-effort skip of removed ancestors only.

        var prepMs = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - tPrepStart;

        var tRemoveStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        var removedExisting = 0;
        var removeMs = 0;
        if (shouldReplaceExisting && idsToReplace.size > 0) {
            if (typeof global.fastRemoveParcelLayersByIds === 'function') {
                removedExisting = global.fastRemoveParcelLayersByIds(idsToReplace);
            } else if (typeof global.removeParcelLayerById === 'function') {
                idsToReplace.forEach(function (id) {
                    global.removeParcelLayerById(id, { skipMapScan: true });
                    removedExisting++;
                });
            }
            removeMs = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - tRemoveStart;
        }

        var addedLayers = [];
        var tIngestStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

        var styleFeature = function (feature) {
            var parcelId = normalizeFeatureParcelId(feature);
            // Check if parcel is marked as road from feature properties or stored road parcels
            const propertyIsRoad = feature?.properties?.isRoad === true || feature?.properties?.isRoad === 'true';
            const storedIsRoad = parcelId && typeof global.isRoad === 'function' ? global.isRoad(parcelId) : false;
            const isRoad = propertyIsRoad || storedIsRoad;
            return global.getParcelBaseStyle(parcelId, { isRoad: isRoad });
        };

        var attachParcelEvents = function (feature, layer) {
            var events = {
                mouseover: typeof global.highlightFeature === 'function' ? global.highlightFeature : function () { },
                mouseout: typeof global.resetHighlight === 'function' ? global.resetHighlight : function () { }
            };

            // Always attach the click handler — onParcelClick itself ignores clicks while a
            // drawing tool is active (a CLICK-time decision). The old ingest-time gate baked the
            // flag into the layer forever: every parcel fetched or sliced DURING a drawing
            // session came out permanently unclickable (structures/blocks over such parcels
            // looked dead, since their visuals are interactive:false and rely on parcel clicks).
            if (global.onParcelClick) {
                events.click = global.onParcelClick;
            }

            layer.on(events);
            if (layer.options) layer.options.interactive = true;
        };

        try {
            var featureCollection = { type: 'FeatureCollection', features: renderableFeatures };
            var geoJsonLayer = L.geoJSON(featureCollection, {
                style: styleFeature,
                onEachFeature: attachParcelEvents
            });

            geoJsonLayer.eachLayer(function (layer) {
                if (!global.parcelLayer) return;

                var parcelId = normalizeFeatureParcelId(layer.feature);

                global.parcelLayer.addLayer(layer);

                if (typeof global.setParcelLayerById === 'function') {
                    try { global.setParcelLayerById(parcelId, layer); } catch (_) { }
                }

                if (typeof global.indexParcelLayer === 'function') {
                    global.indexParcelLayer(layer);
                }

                addedLayers.push(layer);
            });
        } catch (error) {
            console.error('[ingestParcelFeatures] Error during bulk add:', error);
        }

        var ingestMs = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - tIngestStart;

        if (addedLayers.length) {
            if (typeof global.addParcelLayerToMapIfAppropriate === 'function') {
                global.addParcelLayerToMapIfAppropriate();
            }

            if (global.ParcelsState && global.ParcelsState.bumpParcelCoverageVersion) {
                global.ParcelsState.bumpParcelCoverageVersion();
            }

            try {
                global.dispatchEvent(new CustomEvent('parcelCoverageUpdated', {
                    detail: { source: 'ingest', timestamp: Date.now() }
                }));
            } catch (_) { }

            try {
                var parcelIds = convertedFeatures.map(function (f) { return normalizeFeatureParcelId(f); }).filter(Boolean);
                global.dispatchEvent(new CustomEvent('parcelDataLoaded', {
                    detail: { features: convertedFeatures, parcelIds: parcelIds }
                }));
            } catch (_) { }

            if (typeof global.updateVisibleParcelsCount === 'function') {
                global.updateVisibleParcelsCount();
            }
        }

        var totalMs = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - tStart;
        if (typeof console !== 'undefined' && console.debug) {
            console.debug('[ingestParcelFeatures] timings: convert=' + (convertMs.toFixed ? convertMs.toFixed(1) : convertMs) + 'ms, prep=' + (prepMs.toFixed ? prepMs.toFixed(1) : prepMs) + 'ms, removeExisting=' + (removeMs.toFixed ? removeMs.toFixed(1) : removeMs) + 'ms, ingest=' + (ingestMs.toFixed ? ingestMs.toFixed(1) : ingestMs) + 'ms, total=' + (totalMs.toFixed ? totalMs.toFixed(1) : totalMs) + 'ms for ' + convertedFeatures.length + ' features (raw=' + rawFeatures.length + ', addedLayers=' + addedLayers.length + ', idsToReplace=' + idsToReplace.size + ', removedExisting=' + removedExisting + ', skippedExisting=' + skippedExisting + ', replaceExisting=' + shouldReplaceExisting + ')');
        }

        return addedLayers;
    }

    global.normalizeFeatureParcelId = normalizeFeatureParcelId;
    global.ingestParcelFeatures = ingestParcelFeatures;
})(typeof window !== 'undefined' ? window : globalThis);
