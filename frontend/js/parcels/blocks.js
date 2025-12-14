(function (global) {
    'use strict';

    /**
     * Select all parcels in a Buenos Aires block by parsing parcel ID and fetching from API if needed
     * @param {string} parcelId - The canonical parcelId of a parcel in the block
     */
    const parcelIdFromFeature = (feature) => {
        if (!feature || !feature.properties) return null;
        if (typeof global.ensureParcelId === 'function') return global.ensureParcelId(feature);
        const props = feature.properties;
        return props.parcelId ?? props.parcel_id ?? props.id ?? null;
    };

    async function selectBuenosAiresBlock(parcelId) {
        if (!parcelId || !global.parcelLayer) {
            if (typeof global.updateStatus === 'function') {
                global.updateStatus('Unable to find block: parcel data not available');
            }
            return;
        }

        let sourceParcel = null;
        global.parcelLayer.eachLayer(layer => {
            if (!layer?.feature) return;
            const id = parcelIdFromFeature(layer.feature);
            if (id && id.toString() === parcelId.toString()) {
                sourceParcel = layer.feature;
                return false;
            }
        });
        if (!sourceParcel || !sourceParcel.properties) {
            if (typeof global.updateStatus === 'function') {
                global.updateStatus('Unable to find source parcel');
            }
            return;
        }

        const smp = sourceParcel.properties.smp || sourceParcel.properties.SMP;
        if (!smp) {
            if (typeof global.updateStatus === 'function') {
                global.updateStatus('Parcel does not have section/block information');
            }
            return;
        }
        const parts = String(smp).split('-');
        if (parts.length < 2) {
            if (typeof global.updateStatus === 'function') {
                global.updateStatus('Invalid parcel ID format');
            }
            return;
        }

        const section = parts[0].padStart(3, '0');
        const block = parts[1].padStart(3, '0');

        if (typeof global.updateStatus === 'function') {
            global.updateStatus(`Loading parcels for section ${section}, block ${block}...`);
        }

        const localParcelIds = new Set();
        const localParcelLayers = [];
        global.parcelLayer.eachLayer(layer => {
            if (layer.feature && layer.feature.properties) {
                const layerSmp = layer.feature.properties.smp || layer.feature.properties.SMP;
                if (layerSmp) {
                    const layerParts = String(layerSmp).split('-');
                    if (layerParts.length >= 2) {
                        const layerSection = layerParts[0].padStart(3, '0');
                        const layerBlock = layerParts[1].padStart(3, '0');
                        if (layerSection === section && layerBlock === block) {
                            const id = parcelIdFromFeature(layer.feature);
                            if (id) {
                                localParcelIds.add(id.toString());
                                localParcelLayers.push(layer);
                            }
                        }
                    }
                }
            }
        });

        let apiSmpValues = [];
        try {
            const apiUrl = `https://datosabiertos-catastro-apis.buenosaires.gob.ar/catastro/smp/${section}/${block}`;
            const response = await fetch(apiUrl, { headers: { 'Accept': 'application/json' } });
            if (response.ok) {
                const data = await response.json();
                if (Array.isArray(data)) {
                    apiSmpValues = data.filter(smp => smp && typeof smp === 'string');
                } else if (data && Array.isArray(data.features)) {
                    data.features.forEach(feature => {
                        if (feature && feature.properties) {
                            const smpVal = feature.properties.smp || feature.properties.SMP;
                            if (smpVal) apiSmpValues.push(String(smpVal));
                        }
                    });
                } else if (data && Array.isArray(data.parcels)) {
                    apiSmpValues = data.parcels.filter(smpVal => smpVal && typeof smpVal === 'string');
                } else if (data && typeof data === 'object') {
                    Object.values(data).forEach(value => {
                        if (Array.isArray(value)) {
                            value.forEach(item => {
                                if (typeof item === 'string' && item.includes('-')) {
                                    apiSmpValues.push(item);
                                } else if (item && typeof item === 'object' && (item.smp || item.SMP)) {
                                    apiSmpValues.push(String(item.smp || item.SMP));
                                }
                            });
                        }
                    });
                }
            }
        } catch (error) {
            console.warn('Failed to fetch parcels from API:', error);
        }

        const missingSmpValues = apiSmpValues.filter(smpVal => {
            let found = false;
            global.parcelLayer.eachLayer(layer => {
                if (layer.feature && layer.feature.properties) {
                    const layerSmp = layer.feature.properties.smp || layer.feature.properties.SMP;
                    if (layerSmp && String(layerSmp) === String(smpVal)) {
                        found = true;
                        return false;
                    }
                }
            });
            return !found;
        });

        const missingParcelIds = missingSmpValues;
        if (missingParcelIds.length > 0) {
            if (typeof global.updateStatus === 'function') {
                global.updateStatus(`Fetching ${missingParcelIds.length} missing parcels...`);
            }
            try {
                const fetchedFeatures = await global.requestParcelBatchForCurrentCity(missingParcelIds);
                if (fetchedFeatures && fetchedFeatures.length > 0) {
                    if (typeof global.ingestParcelFeatures === 'function') {
                        await global.ingestParcelFeatures(fetchedFeatures);
                    }
                }
            } catch (error) {
                console.warn('Failed to fetch missing parcels:', error);
            }
        }

        await new Promise(resolve => setTimeout(resolve, 100));

        const allBlockLayers = [];
        global.parcelLayer.eachLayer(layer => {
            if (layer.feature && layer.feature.properties) {
                const id = parcelIdFromFeature(layer.feature);
                if (!id) return;
                const layerSmp = layer.feature.properties.smp || layer.feature.properties.SMP;
                if (layerSmp) {
                    const layerParts = String(layerSmp).split('-');
                    if (layerParts.length >= 2) {
                        const layerSection = layerParts[0].padStart(3, '0');
                        const layerBlock = layerParts[1].padStart(3, '0');
                        if (layerSection === section && layerBlock === block) {
                            allBlockLayers.push(layer);
                        }
                    }
                }
            }
        });

        if (allBlockLayers.length === 0) {
            if (typeof global.updateStatus === 'function') {
                global.updateStatus('No parcels found for this block.');
            }
            return;
        }

        if (typeof global.multiParcelSelection !== 'undefined' && global.multiParcelSelection && typeof global.multiParcelSelection.selectBlockLayers === 'function') {
            global.multiParcelSelection.selectBlockLayers(allBlockLayers);
        }
        if (typeof global.updateStatus === 'function') {
            global.updateStatus(`Selected ${allBlockLayers.length} parcels in block ${section}-${block}`);
        }
    }

    global.selectBuenosAiresBlock = selectBuenosAiresBlock;
    if (typeof window !== 'undefined') {
        window.selectBuenosAiresBlock = selectBuenosAiresBlock;
    }
})(typeof window !== 'undefined' ? window : globalThis);

