// Every city's building sources are ones the app can serve, as one ordered list: OpenStreetMap for
// cities without their own survey, Zagreb's GDI survey with DGU and OSM listed for comparison, and
// Bogotá's cadastre (a URL source the browser reads, with its storey field) with OSM behind it.
import { describe, expect, it } from 'vitest';
import { cityConfigSource } from './helpers/city-config-source.js';
import { createContext, runInContext } from 'node:vm';
import { decodeCustomBuildingSource } from '../parcels/custom-source-config.js';

const cityContext = { URLSearchParams, console };
cityContext.window = cityContext;
runInContext(cityConfigSource(), createContext(cityContext));
const manager = cityContext.CityConfigManager;
const SourceList = cityContext.SourceList;

describe('city building sources', () => {
    const DATABASE = new Set(['gdi-3d', 'dgu', 'osm', 'nyc-arcgis', 'wien-lod2']);
    const cities = manager.getAvailableCities();

    it('lists only sources the app serves, OpenStreetMap for every city without its own survey', () => {
        let osmOnly = 0;
        for (const city of cities) {
            const list = SourceList.cityList(city);
            expect(list.length, city.id).toBeGreaterThan(0);
            expect(SourceList.inUse(list).length, city.id).toBeGreaterThan(0);
            for (const { id } of list) expect(DATABASE.has(id) || SourceList.isUrlSource(id), `${city.id}: ${id}`).toBe(true);
            if (list.length === 1 && list[0].id === 'osm') osmOnly++;
        }
        expect(osmOnly).toBeGreaterThan(500);
    });

    it("lists Zagreb's survey in use and the other two surveys for comparison", () => {
        expect(SourceList.cityList(manager.getCityConfig('zagreb')).map(entry => [entry.id, entry.use]))
            .toEqual([['gdi-3d', true], ['dgu', false], ['osm', false]]);
    });

    it("reads Bogotá's cadastre buildings with their storey counts, OSM behind them", () => {
        const list = SourceList.cityList(manager.getCityConfig('bogota'));
        expect(SourceList.inUse(list).slice(1)).toEqual(['osm']);
        expect(list[0]).toMatchObject({ name: 'IDECA/UAECD Construcción', use: true });
        const descriptor = decodeCustomBuildingSource(list[0].id);
        expect(descriptor).toMatchObject({ adapter: 'arcgis', kind: 'building', cityIds: ['bogota'], idField: 'FID', levelsField: 'CONNPISOS' });
        expect(descriptor.endpoint).toMatch(/Construcciones_Bogota_DC_vista\/FeatureServer\/0$/);
    });
});
