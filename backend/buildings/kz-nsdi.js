// Read the national building polygons and recorded storeys through UGT's shared WFS reader.
import * as turf from '@turf/turf';
import FootprintProvider from '../../frontend/js/footprint-provider.js';
import { createWfsParcelSource } from '../parcels/wfs-source.js';
import { withSourceCooldown } from '../parcels/sources.js';
import { readAdapterBox } from './building-cell-read.js';

export const kzNsdiBuildings = Object.freeze({
    id: 'kz-nsdi-buildings',
    endpoint: 'https://map.gov.kz/geoserver/ows',
    featureType: 'openmap:buildings_a',
    idField: 'id', idType: 'integer', idPrefix: 'KZ-NSDI-B-',
    geometryField: 'geom', requestProperties: true,
    outFields: ['id', 'levels'], levelsField: 'levels',
    pageSize: 250, maxFeatures: 5000, maxBboxKm2: 1,
    timeoutMs: 10000, maxResponseBytes: 8 * 1024 * 1024
});

export function createKzNsdiBuildingProvider(descriptor = kzNsdiBuildings, { fetchImpl } = {}) {
    const adapter = withSourceCooldown(createWfsParcelSource(descriptor, { fetchImpl }));
    return FootprintProvider.createFootprintProvider({
        turf,
        label: descriptor.id,
        async featuresIn(box) {
            const { features, complete } = await readAdapterBox(adapter, descriptor, box);
            return { features, partial: !complete };
        },
        sources: { near: descriptor.id, footprints: descriptor.id },
        log: message => console.warn(`[kz-nsdi-buildings] ${message}`)
    });
}
