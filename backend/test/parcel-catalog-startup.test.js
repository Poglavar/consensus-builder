import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// A fresh process prevents projection definitions registered by other tests from
// hiding a catalog entry that would stop the real gateway at startup.
const routeUrl = new URL('../routes/parcel-sources.js', import.meta.url).href;
const catalogUrl = new URL('../parcels/sources.js', import.meta.url).href;
function startGateway(mutate = '') {
    return execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { setupParcelSourcesRoute } from ${JSON.stringify(routeUrl)};
        import { parcelSourceCatalog } from ${JSON.stringify(catalogUrl)};
        globalThis.fetch = () => { throw Error('Unexpected provider fetch at startup'); };
        ${mutate}
        const routes = new Map();
        const app = { get(path, ...handlers) { routes.set(path, handlers.at(-1)); }, post() {} };
        setupParcelSourcesRoute(app);
        routes.get('/parcel-sources')({}, { json(body) {
            process.stdout.write(JSON.stringify(body.sources.map(source => source.id)));
        } });
    `], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

describe('complete parcel catalog startup', () => {
    it('initializes the real gateway in isolation and lists its providers without fetching geometry', () => {
        const ids = JSON.parse(startGateway());
        expect(ids.length).toBeGreaterThan(0);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('exposes an unresolved native projection during gateway startup', () => {
        expect(() => startGateway(`
            const source = parcelSourceCatalog.sources.find(source => source.boundsSrid);
            if (!source) throw Error('No native projection descriptor to exercise');
            source.boundsProjection = 'EPSG:UNREGISTERED_CATALOG_TEST';
        `)).toThrow();
    });
});
