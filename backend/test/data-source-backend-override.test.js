// Verifies that localhost backend overrides also route building-footprint scans, not only 3D meshes.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/data-source.js', import.meta.url), 'utf8');

describe('data source backend override', () => {
    it('routes GDI building footprints through the backend named in the URL', () => {
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
                getCurrentCityConfig: () => ({ buildings: { source: 'backend' } })
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

        expect(window.buildBuildingRequestParams('1,2,3,4', 'gdi').url)
            .toBe('http://localhost:4179/buildings?bbox=1%2C2%2C3%2C4&source=gdi');
        expect(stored.get('cb_dev_backend_base')).toBe('http://localhost:4179');
    });
});
