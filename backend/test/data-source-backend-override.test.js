// Verifies that a localhost `?backend=` override routes EVERY backend request, not just some.
//
// ./dev.sh exists so a worktree can run on its own ports and hands back a `?backend=<url>` link.
// Any request that hardcodes LOCAL_BASE instead of calling getBackendBase() ignores that link and
// goes to port 3000, where nothing is listening — so the page half-works, or in the parcels case
// loads nothing at all, with only ERR_CONNECTION_REFUSED to explain it. That has now happened twice
// (building scans, then Croatian parcels), so each request builder gets a case here.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/data-source.js', import.meta.url), 'utf8');
const environmentSource = readFileSync(new URL('../../frontend/js/environment.js', import.meta.url), 'utf8');

// Boot data-source.js against a localhost page carrying ?backend=http://localhost:4179.
function bootWithOverride(cityConfig, options = {}) {
    const stored = new Map(Object.entries(options.stored || {}));
    const storageCalls = [];
    const domLookups = [];
    const readyListeners = [];
    const storage = {
        getItem: key => {
            storageCalls.push(['get', key]);
            return stored.get(key) ?? null;
        },
        setItem: (key, value) => {
            storageCalls.push(['set', key, value]);
            stored.set(key, String(value));
        },
        clear: () => {
            storageCalls.push(['clear']);
            stored.clear();
        }
    };
    const window = {
        // map-core.js's view → EPSG:3765 bbox, stubbed: the request carries what it returns
        bboxInCrs: (bounds, crs) => (crs === 'EPSG:3765' ? '1,2,3,4' : null),
        location: {
            protocol: 'http:',
            hostname: options.hostname || 'localhost',
            search: options.search ?? '?backend=http%3A%2F%2Flocalhost%3A4179'
        },
        CityConfigManager: {
            requiresBackendDataSource: () => true,
            getCurrentCityConfig: () => cityConfig
        },
        localStorage: storage,
        BrowserWorkspace: options.workspaceStorage ? { storage: options.workspaceStorage } : undefined
    };
    const context = vm.createContext({
        window,
        localStorage: storage,
        PersistentStorage: storage,
        URLSearchParams,
        console,
        document: {
            readyState: 'loading',
            body: { classList: { add() {}, contains: () => false } },
            addEventListener(event, listener) {
                if (event === 'DOMContentLoaded') readyListeners.push(listener);
            },
            getElementById(id) {
                domLookups.push(id);
                return null;
            }
        }
    });
    vm.runInContext(environmentSource, context);
    vm.runInContext(source, context);
    readyListeners.forEach(listener => listener());
    return { window, stored, storageCalls, domLookups };
}

describe('data source backend override', () => {
    it('persists and restores the backend override inside the tab workspace', () => {
        const values = new Map([['cb_dev_backend_base', 'https://tab-api.example']]);
        const workspaceStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
        const options = { stored: { cb_dev_backend_base: 'https://shared-api.example' }, workspaceStorage, search: '' };
        const first = bootWithOverride({}, options);
        expect(first.window.getBackendBase()).toBe('https://tab-api.example');
        const second = bootWithOverride({}, { ...options, search: '?backend=https%3A%2F%2Freplacement-api.example' });
        expect(second.window.getBackendBase()).toBe('https://replacement-api.example');
        expect(values.get('cb_dev_backend_base')).toBe('https://replacement-api.example');
        expect(second.stored.get('cb_dev_backend_base')).toBe('https://shared-api.example');
    });

    it.each(['oss.uredjenazemlja.hr', 'api.urbangametheory.xyz', 'localhost'])(
        'ignores the obsolete stored global choice %s and preserves saved data on startup', choice => {
            const initial = {
                cb_data_source: choice,
                saved_parcels: '[{"id":"parcel-1"}]',
                saved_proposals: '[{"id":"proposal-1"}]',
                dataset_provider: 'direct'
            };
            const { window, stored, storageCalls, domLookups } = bootWithOverride({
                parcels: { source: 'oss-wfs', requiresBackend: false }
            }, { stored: initial, search: '' });

            expect(window.getCurrentDataSource()).toBe('localhost');
            expect(window.buildParcelRequestParams('1,2,3,4').url)
                .toBe('http://localhost:3000/parcels?bbox=1%2C2%2C3%2C4');
            expect(Object.fromEntries(stored)).toEqual(initial);
            expect(storageCalls).not.toContainEqual(['get', 'cb_data_source']);
            expect(storageCalls.some(([operation]) => operation === 'set' || operation === 'clear')).toBe(false);
            expect(domLookups).not.toContain('data-source-select');
        }
    );

    it('ignores URL and saved backend overrides in production', () => {
        const { window, stored } = bootWithOverride({ parcels: { source: 'oss-wfs' } }, {
            hostname: 'urbangametheory.xyz',
            stored: { cb_data_source: 'localhost', cb_dev_backend_base: 'http://localhost:9999' }
        });
        expect(window.getCurrentDataSource()).toBe('api.urbangametheory.xyz');
        expect(window.getBackendBase()).toBe('https://api.urbangametheory.xyz');
        expect(window.buildParcelRequestParams('1,2,3,4').url)
            .toBe('https://api.urbangametheory.xyz/parcels?bbox=1%2C2%2C3%2C4');
        expect(stored.get('cb_dev_backend_base')).toBe('http://localhost:9999');
    });

    it('preserves environment defaults for street providers', () => {
        const local = bootWithOverride({}).window;
        expect(local.buildStreetRequestParams({ bbox: '1,2,3,4' })).toEqual({
            url: 'http://localhost:4179/streets?bbox=1%2C2%2C3%2C4',
            pageSize: null,
            source: 'backend'
        });
        const production = bootWithOverride({}, { hostname: 'urbangametheory.xyz' }).window;
        const request = production.buildStreetRequestParams();
        expect(request.source).toBe('arcgis');
        expect(request.url.startsWith('https://services8.arcgis.com/')).toBe(true);
    });

    it('routes Croatian parcels through it too — they used to hardcode port 3000', () => {
        // Zagreb, Split and Šibenik all take the `oss-wfs` path, which built its URL from
        // LOCAL_BASE. Every other city source (parcel-ba/-bg/-lj/-co/-nyc) already called
        // getBackendBase(), so this was the one branch that ignored the override — and it is the
        // branch the three most-used cities take, which is why a worktree showed an empty map.
        const { window } = bootWithOverride({
            parcels: { source: 'oss-wfs', requiresBackend: true },
            buildings: { source: 'none' }
        });

        const { url, isOSS } = window.buildParcelRequestParams('450000,4843500,450500,4844000');
        expect(isOSS).toBe(false);
        expect(url).toBe('http://localhost:4179/parcels?bbox=450000%2C4843500%2C450500%2C4844000');
        expect(url).not.toContain(':3000');
    });

    it('routes NYC parcel discovery through the worktree backend instead of a fixed port', () => {
        const { window } = bootWithOverride({ parcels: { source: 'parcel-nyc' } });
        const request = window.buildParcelRequestParams('', { latLonBbox: '-74.01,40.71,-74,40.72' });
        expect(request.url).toBe('http://localhost:4179/parcel-nyc?bbox=-74.01%2C40.71%2C-74%2C40.72&limit=2000');
        expect(request.ownershipBase).toBe('http://localhost:4179/parcel-nyc');
    });

    it('leaves no request builder hardcoding a base URL', () => {
        // The real guard: LOCAL_BASE / UGT_BASE must appear ONLY inside getBackendBase(), which is
        // the single place that consults the override. Anywhere else is another silent port-3000 bug
        // waiting to happen, and greppable long before someone loses an afternoon to it.
        const withoutComments = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const body = withoutComments.slice(withoutComments.indexOf('function getBackendBase'));
        const afterGetBackendBase = body.slice(body.indexOf('\n    }') + 1);
        expect(afterGetBackendBase).not.toMatch(/\bLOCAL_BASE\b/);
        expect(afterGetBackendBase).not.toMatch(/\bUGT_BASE\b/);
    });
});
