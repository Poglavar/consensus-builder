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

// Boot data-source.js against a localhost page carrying ?backend=http://localhost:4179.
function bootWithOverride(cityConfig) {
    const stored = new Map();
    const storage = {
        getItem: key => stored.get(key) ?? null,
        setItem: (key, value) => stored.set(key, String(value)),
        clear: () => stored.clear()
    };
    const window = {
        current_environment: 'development',
        location: {
            protocol: 'http:',
            hostname: 'localhost',
            search: '?backend=http%3A%2F%2Flocalhost%3A4179'
        },
        CityConfigManager: {
            requiresBackendDataSource: () => true,
            getCurrentCityConfig: () => cityConfig
        },
        localStorage: storage
    };
    const context = vm.createContext({
        window,
        localStorage: storage,
        PersistentStorage: storage,
        URLSearchParams,
        console,
        document: { addEventListener() {}, getElementById: () => null }
    });
    vm.runInContext(source, context);
    return { window, stored };
}

describe('data source backend override', () => {
    it('routes GDI building footprints through the backend named in the URL', () => {
        // A city that actually has GDI footprints — the Zagreb survey. The fixture used to name a
        // source of 'backend', which is not a building source at all; GDI requests are now refused
        // outside the cities that have GDI, so the placeholder stopped producing a request.
        const { window, stored } = bootWithOverride({ buildings: { source: 'gdi' } });

        expect(window.buildBuildingRequestParams('1,2,3,4', 'gdi').url)
            .toBe('http://localhost:4179/buildings?bbox=1%2C2%2C3%2C4&source=gdi');
        expect(stored.get('cb_dev_backend_base')).toBe('http://localhost:4179');
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
