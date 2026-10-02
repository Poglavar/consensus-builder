// Resolves executable parcel descriptors and adapters for routes and authoritative proposal binding.
import { readFileSync } from 'node:fs';
import { createArcgisParcelSource } from './arcgis-source.js';

export const parcelSourceCatalog = JSON.parse(readFileSync(new URL('./source-catalog.json', import.meta.url), 'utf8'));

export function createParcelSource(descriptor, options = {}) {
    if (descriptor.adapter !== 'arcgis') throw new Error(`Unsupported parcel adapter: ${descriptor.adapter}`);
    return createArcgisParcelSource(descriptor, options);
}

export function parcelSourceForCity(city) {
    const descriptor = parcelSourceCatalog.sources.find(source => source.cityId === city);
    return descriptor ? { descriptor, adapter: createParcelSource(descriptor) } : null;
}

export function parcelSourceForIds(ids) {
    const descriptor = parcelSourceCatalog.sources.find(source => ids.some(id => String(id).startsWith(source.idPrefix)));
    return descriptor ? { descriptor, adapter: createParcelSource(descriptor) } : null;
}
