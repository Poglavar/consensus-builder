// The generated city files (data/city-index.js, data/cities/<id>.js) match data/city-configs.js, and a
// browser boot loads exactly the current city's full configuration on top of every city's light one;
// under node, data/city-configs.js alone gives the manager every full configuration.
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { CITY_FILE_PATHS, staleCityFiles, writeCityFiles } from '../../scripts/build-city-files.mjs';
import { parseCityConfigs } from '../../scripts/lib/parcel-city-settings.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => readFileSync(path.join(REPO, rel), 'utf8');
const stable = value => JSON.stringify(value, (_k, v) => v === Infinity ? 'Infinity'
    : (v && typeof v === 'object' && !Array.isArray(v)) ? Object.keys(v).sort().reduce((o, k) => { o[k] = v[k]; return o; }, {}) : v);

describe('generated city files', () => {
    it('match frontend/data/city-configs.js (regenerate: node scripts/build-city-files.mjs --run)', () => {
        const { stale, extra } = staleCityFiles(REPO);
        expect(stale).toEqual([]);
        expect(extra).toEqual([]);
    });
    // The writers (admission, city settings) report these counts, so they must be what happened.
    it('reports what a regeneration wrote and removed', () => {
        const root = mkdtempSync(path.join(os.tmpdir(), 'city-files-'));
        try {
            mkdirSync(path.join(root, 'frontend/data/cities'), { recursive: true });
            writeFileSync(path.join(root, CITY_FILE_PATHS.source), read(CITY_FILE_PATHS.source));
            writeFileSync(path.join(root, CITY_FILE_PATHS.cities, 'gone.js'), '// no city owns this\n');
            const first = writeCityFiles(root);
            expect(first).toEqual({ written: first.total, removed: 1, total: 1993 });
            expect(existsSync(path.join(root, CITY_FILE_PATHS.cities, 'gone.js'))).toBe(false);
            expect(readFileSync(path.join(root, CITY_FILE_PATHS.index), 'utf8')).toBe(read(CITY_FILE_PATHS.index));
            expect(writeCityFiles(root)).toEqual({ written: 0, removed: 0, total: 1993 });
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});

// A page while it is still parsing: scripts run in order, document.write queues the next one.
function bootBrowser(search) {
    const writes = [];
    const storage = { getItem: () => null, setItem() {}, setScope() {}, ready: Promise.resolve() };
    const window = {
        location: { search, href: `http://localhost/${search}`, pathname: '/' },
        localStorage: storage, PersistentStorage: storage,
        dispatchEvent() {}, addEventListener() {}, URLSearchParams, URL, console,
        document: { readyState: 'loading', write: html => writes.push(html) }
    };
    window.window = window;
    const context = vm.createContext(window);
    const run = rel => vm.runInContext(read(rel), context, { filename: rel });
    run('frontend/js/city-light-config.js');
    run(CITY_FILE_PATHS.index);
    run('frontend/js/city-config.js');
    return { manager: window.CityConfigManager, writes, run, window };
}

describe('browser boot', () => {
    it('writes the current city file into the page and reads the full configuration from it', () => {
        const { manager, writes, run } = bootBrowser('?city=zg');
        expect(manager.getCurrentCityId()).toBe('zagreb');
        expect(writes).toEqual(['<script src="data/cities/zagreb.js"><\/script><script>window.CityConfigManager.markCityConfigLoaded();<\/script>']);
        // Until that script runs the full configuration is missing, and that is an error, not a guess:
        // for a direct read, and for the marker the written inline script calls.
        expect(() => manager.getCurrentCityConfig()).toThrow(/data\/cities\/zagreb\.js/);
        expect(() => manager.markCityConfigLoaded()).toThrow(/data\/cities\/zagreb\.js/);
        run(`${CITY_FILE_PATHS.cities}/zagreb.js`);
        manager.markCityConfigLoaded();
        const current = manager.getCurrentCityConfig();
        expect(current.id).toBe('zagreb');
        expect(current.planning).toBeTruthy();
        const source = parseCityConfigs(read(CITY_FILE_PATHS.source));
        expect(stable(current)).toBe(stable(source.zagreb));
    });

    it('knows every other city from the index, without their per-city detail', () => {
        const { manager, run } = bootBrowser('?city=zg');
        run(`${CITY_FILE_PATHS.cities}/zagreb.js`);
        manager.markCityConfigLoaded();
        const cities = manager.getAvailableCities();
        expect(cities.length).toBe(1991);
        const zurich = manager.getCityConfig('zurich');
        expect(zurich.label).toBe('Zurich, Switzerland');
        expect(manager.getCityCenter(zurich)).toEqual([47.3819463819352, 8.53646620813248]);
        expect(zurich.parcels.sourceId).toBe('ch-zh-geoinformation-avwfs-liegenschaften');
        expect(zurich.parcels.attribution).toMatch(/Kanton Zürich/);
        expect(zurich.projection.fallbackDataset).toEqual([8.53646620813248, 47.3819463819352]);
        const source = parseCityConfigs(read(CITY_FILE_PATHS.source));
        for (const key of ['planning', 'walk', 'curatedRoads', 'transitAlignments', 'language']) {
            expect(manager.getCityConfig('new_york')[key]).toBeUndefined();
            expect(manager.getCityConfig('zagreb')[key]).toEqual(source.zagreb[key]);
        }
        expect(manager.resolveCityId('explore')).toBe('explore');
        expect(manager.findNearestCity(47.38, 8.54).id).toBe('zurich');
        expect(manager.getCitiesByParcelSource('oss-wfs').map(city => city.id)).toContain('split');
    });

    it('puts the page\'s explore view over the explore entry', () => {
        const { manager, writes, run } = bootBrowser('?city=explore');
        expect(writes[0]).toMatch(/^<script src="data\/cities\/explore\.js">/);
        run(`${CITY_FILE_PATHS.cities}/explore.js`);
        manager.markCityConfigLoaded();
        const explore = manager.getCurrentCityConfig();
        expect(explore.explore).toBe(true);
        expect(explore.map.defaultCenter).toEqual([30, 15]);
        expect(explore.map.defaultZoom).toBe(3);
        expect(explore.projection.fallbackDataset).toEqual([15, 30]);
    });
});

describe('node', () => {
    it('reads every full configuration from data/city-configs.js, writing nothing', () => {
        const context = { URLSearchParams, URL, console };
        context.window = context;
        vm.createContext(context);
        vm.runInContext(read(CITY_FILE_PATHS.source), context, { filename: CITY_FILE_PATHS.source });
        vm.runInContext(read('frontend/js/city-config.js'), context, { filename: 'city-config.js' });
        const manager = context.CityConfigManager;
        expect(manager.getAvailableCities().length).toBe(1991);
        expect(manager.getCurrentCityConfig().id).toBe('new_york');
        expect(manager.getCityConfig('zagreb').planning).toBeTruthy();
    });
});
