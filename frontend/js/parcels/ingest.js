(function (global) {
    'use strict';

    // One renderer for every parcel ever ingested, created on first use. Two canvases would be two
    // surfaces to composite; a per-batch renderer would be dozens.
    let _parcelCanvas = null;
    function parcelCanvasRenderer() {
        if (_parcelCanvas) return _parcelCanvas;
        if (typeof L === 'undefined' || typeof L.canvas !== 'function') return undefined;
        _parcelCanvas = L.canvas({ padding: 0.5 });
        return _parcelCanvas;
    }
    if (typeof window !== 'undefined') window.parcelCanvasRenderer = parcelCanvasRenderer;

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
        var hiddenBaseIds = new Set();
        var mapById = (global.parcelLayerById instanceof Map) ? global.parcelLayerById : null;
        var parcelStore = (global.ParcelsState && global.ParcelsState.getParcelCache)
            ? global.ParcelsState.getParcelCache()
            : global.parcelCache;
        var skippedExisting = 0;
        var orphanSlicesSkipped = [];
        convertedFeatures.forEach(function (feature) {
            var parcelId = normalizeFeatureParcelId(feature);
            if (!parcelId) return;

            // Orphan-slice sweep: a DERIVED parcel whose minting proposal is known here and NOT
            // applied is stale bookkeeping — typically debris from an older session that
            // un-applied by a different id generation and left the slices behind. It must not
            // reach the map, the cache, or persistence again. New-style ids carry their minting
            // proposal literally (`…#c-<proposalId>-N`); old-style tokens (`…#p-<token>-N`) do
            // not resolve to a proposal and are conservatively kept — never destroy what we
            // cannot attribute.
            try {
                var idString = parcelId.toString();
                var hashAt = idString.lastIndexOf('#');
                if (hashAt > 0) {
                    var mintId = idString.slice(hashAt + 1).replace(/-\d+$/, '');
                    var storage = global.proposalStorage;
                    var minting = (storage && typeof storage.getProposal === 'function') ? storage.getProposal(mintId) : null;
                    if (minting) {
                        var mintingApplied = (typeof global.isProposalApplied === 'function')
                            ? global.isProposalApplied(minting)
                            : minting.applied === true;
                        if (!mintingApplied) {
                            orphanSlicesSkipped.push(idString);
                            try { if (typeof global.clearPersistedParcelRecord === 'function') global.clearPersistedParcelRecord(idString); } catch (_) { }
                            try { if (parcelStore && parcelStore.byId instanceof Map) parcelStore.byId.delete(idString); } catch (_) { }
                            return;
                        }
                    }
                }
            } catch (_) { /* best-effort guard — never blocks a legitimate parcel */ }

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

            // A standing formation's current derivation replaces this cadastral layer. Still
            // instantiate and index the immutable base so the next cadastre-first replay has its
            // ground fact; hide it after registration instead of dropping it at tile-ingest time.
            try {
                const idString = parcelId.toString();
                const isReplaced = (typeof isParcelReplacedByChildren === 'function') ? isParcelReplacedByChildren(idString) : false;
                if (isReplaced) {
                    hiddenBaseIds.add(idString);
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
        if (orphanSlicesSkipped.length) {
            console.warn('[ingestParcelFeatures] dropped ' + orphanSlicesSkipped.length
                + ' orphan slice(s) whose minting proposal is not applied', orphanSlicesSkipped);
        }

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
            // getParcelStyle, NOT getParcelBaseStyle: the base style knows nothing about ownership
            // highlighting. Ingest is the last painter after any pan, zoom or camera-moving
            // selection, so painting the base style here quietly undid the highlighting a moment
            // after every one of them. The feature is wrapped as a pseudo-layer because that is
            // what the style path reads flags and ownership from.
            const styleFn = typeof global.getParcelStyle === 'function' ? global.getParcelStyle : global.getParcelBaseStyle;
            return styleFn(parcelId, { feature: feature }, { isRoad: isRoad });
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
            // In BATCHES, with a frame handed back between them.
            //
            // Panning into ground you have not visited lands a fetch of a few thousand parcels, and
            // building every layer in one go is one long synchronous block — which is exactly when
            // the drag stutters, and why it stops once an area has been visited and the answer is
            // cached. Same layers, same order; only the browser's chance to draw is new.
            var INGEST_BATCH = 250;
            for (var batchStart = 0; batchStart < renderableFeatures.length; batchStart += INGEST_BATCH) {
            var featureCollection = { type: 'FeatureCollection', features: renderableFeatures.slice(batchStart, batchStart + INGEST_BATCH) };
            var geoJsonLayer = L.geoJSON(featureCollection, {
                // ONE canvas for every parcel, instead of one SVG <path> each.
                //
                // Measured on a real Šibenik session: 42,144 paths in the overlay, and a drag
                // transforms and re-rasterises the whole SVG every frame — which is the choppy pan.
                // Parcels are the bulk of that, and they are the layer that can move cheapest: plain
                // geometry with a style function and click handlers, no CSS classes, no pattern
                // fills, nothing that reads layer._path except diagnostics.
                //
                // Same shared-renderer pattern the government plan overlay already uses. The padding
                // draws half a viewport beyond the edge so a short pan needs no redraw at all.
                renderer: parcelCanvasRenderer(),
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

                if (hiddenBaseIds.has(String(parcelId)) && typeof global.hideParcelLayerById === 'function') {
                    global.hideParcelLayerById(String(parcelId));
                }

                addedLayers.push(layer);
            });
            if (batchStart + INGEST_BATCH < renderableFeatures.length
                && typeof global.yieldToBrowser === 'function') {
                await global.yieldToBrowser();
            }
            }
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
