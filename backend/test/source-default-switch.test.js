// A city provider upgrade preserves saved IDs through explicitly retained historical sources.
import { afterEach, describe, expect, it } from 'vitest';
import { clearParcelSourceRuntimeCache, parcelSourceCatalog, parcelSourceForCity, parcelSourceForIds } from '../parcels/sources.js';

const originalSources = [...parcelSourceCatalog.sources];
afterEach(() => {
    parcelSourceCatalog.sources.splice(0, parcelSourceCatalog.sources.length, ...originalSources);
    clearParcelSourceRuntimeCache();
});

describe('city default provider upgrades', () => {
    it('routes the released UK cities through shared ground and preserves their historical IDs', () => {
        for (const [city, sourceId, parcelId] of [
            ['london', 'gb-hmlr-city-of-london', 'GB-HMLR-LONDON-50654735'],
            ['manchester', 'gb-hmlr-manchester', 'GB-HMLR-MANCHESTER-49777956'],
            ['birmingham', 'gb-arcgis-geodom-land-registry-inspire-2021', 'GB-HMLR-123']
        ]) {
            expect(parcelSourceForCity(city).descriptor.id).toBe('gb-hmlr-browser-v1');
            expect(parcelSourceForIds([parcelId]).descriptor.id).toBe(sourceId);
        }
        expect(parcelSourceForCity('oxford').descriptor.id).toBe('gb-hmlr-browser-v1');
        expect(parcelSourceForCity('newcastle').descriptor.id).toBe('gb-hmlr-browser-v1');
        expect(parcelSourceForIds(['GB-HMLR-BROWSER-v1-50654735']).descriptor.id).toBe('gb-hmlr-browser-v1');
    });

    it('uses the new city default while retaining the exact old saved-reference namespace', () => {
        const old = originalSources.find(source => source.id === 'gb-hmlr-city-of-london');
        const historical = { ...old, defaultForCity: false, historicalForIds: true };
        const upgraded = { ...old, id: 'test-shared-provider', idPrefix: 'TEST-SHARED-', defaultForCity: true };
        parcelSourceCatalog.sources.splice(0, parcelSourceCatalog.sources.length, historical, upgraded);

        expect(parcelSourceForCity('london').descriptor.id).toBe(upgraded.id);
        const saved = 'GB-HMLR-LONDON-50654735';
        const resolved = parcelSourceForIds([saved]);
        expect(resolved.descriptor.id).toBe(old.id);
        expect(resolved.descriptor.idPrefix).toBe('GB-HMLR-LONDON-');
        expect(parcelSourceForIds(['TEST-SHARED-50654735']).descriptor.id).toBe(upgraded.id);
    });

    it('does not make unbound or opt-in descriptors available through an ID prefix alone', () => {
        const source = { ...originalSources.find(source => source.id === 'gb-hmlr-browser-v1'),
            cityIds: [], defaultForCity: false, historicalForIds: false };
        parcelSourceCatalog.sources.splice(0, parcelSourceCatalog.sources.length,
            ...originalSources.filter(item => item.id !== source.id), source);
        expect(parcelSourceForIds(['GB-HMLR-BROWSER-v1-50654735'])).toBeNull();
    });
});
