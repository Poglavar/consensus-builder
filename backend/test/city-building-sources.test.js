// Every city's building source is one the app can serve: cities without their own survey read
// Overture's tiles in the browser, and Bogotá's cadastre id decodes on the backend with its storey
// field and Overture behind it. A person's own source replaces the city's without its fallback.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { decodeCustomBuildingSource } from '../parcels/custom-source-config.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const cityContext = { URLSearchParams, console };
cityContext.window = cityContext;
runInContext(read('../../frontend/js/city-config.js'), createContext(cityContext));
const manager = cityContext.CityConfigManager;

describe('city building sources', () => {
    const KNOWN = new Set(['gdi', 'nyc', 'overture', 'overture-tiles', 'cadastre', 'none']);
    const cities = manager.getAvailableCities();

    it('names only sources the app can serve, and no city reads OpenStreetMap through Overpass any more', () => {
        const bySource = {};
        for (const city of cities) {
            const source = city.buildings?.source || 'gdi';
            bySource[source] = (bySource[source] || 0) + 1;
            expect(KNOWN.has(source), `${city.id}: ${source}`).toBe(true);
        }
        expect(bySource.osm).toBeUndefined();
        expect(bySource['overture-tiles']).toBeGreaterThan(500);
    });

    it("reads Bogotá's cadastre buildings with their storey counts, Overture behind them", () => {
        const bogota = manager.getCityConfig('bogota').buildings;
        expect(bogota).toMatchObject({ source: 'cadastre', fallback: 'overture-tiles' });
        const descriptor = decodeCustomBuildingSource(bogota.sourceId);
        expect(descriptor).toMatchObject({ adapter: 'arcgis', kind: 'building', cityIds: ['bogota'], idField: 'FID', levelsField: 'CONNPISOS' });
        expect(descriptor.endpoint).toMatch(/Construcciones_Bogota_DC_vista\/FeatureServer\/0$/);
    });

    it("drops the city's fallback when a person chooses their own source", () => {
        cityContext.ParcelSourceSettings = { choiceForCity: (id, _, kind) => (kind === 'building' ? { id: 'building.mine', name: 'Mine' } : null) };
        try {
            const buildings = manager.getCityConfig('bogota').buildings;
            expect(buildings).toMatchObject({ source: 'custom', sourceId: 'building.mine', name: 'Mine', defaultSource: 'cadastre',
                defaultSourceName: 'IDECA/UAECD Construcción' });
            expect(buildings.fallback).toBeUndefined();
            expect(buildings.attribution).toBeUndefined();
        } finally {
            delete cityContext.ParcelSourceSettings;
        }
    });
});
