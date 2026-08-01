// Road parcels now come from the SHARED roads API, not this app's backend — the two used to run
// near-identical queries that drifted into different identifier systems. These lock the two things
// that would break silently: reaching the wrong service, and losing the classification filter to
// naive "?bbox=" concatenation (which would produce a second question mark and ship every
// classification while still returning 200).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CuratedRoadsUrl = require('../../frontend/js/curated-roads-url.js');

const dataSource = readFileSync(new URL('../../frontend/js/data-source.js', import.meta.url), 'utf8');

function roadsApiBaseFor(location) {
    const storage = { getItem: () => null, setItem: () => {}, clear: () => {} };
    const window = { current_environment: 'production', location, localStorage: storage };
    vm.runInContext(dataSource, vm.createContext({
        window,
        localStorage: storage,
        PersistentStorage: storage,
        URLSearchParams,
        console,
        document: { addEventListener() {}, getElementById: () => null }
    }));
    return window.getRoadsApiBase();
}

// The SHIPPED builder — road-detection.js calls this exact function.
const curatedRoadsUrl = (config, bbox, base) =>
    CuratedRoadsUrl.build(config, bbox, base, 'https://urbangametheory.xyz/');

const ZAGREB_CURATED_ROADS = { path: '/roads/parcels', params: { classification: 'road' } };
const BBOX = '15.9941,45.8003,15.9966,45.8019';

describe('roads API base', () => {
    it('is the shared service in production, never this app\'s own backend', () => {
        const base = roadsApiBaseFor({ protocol: 'https:', hostname: 'urbangametheory.xyz', search: '' });
        expect(base).toBe('https://zagreb.lol/api');
        expect(base).not.toContain('urbangametheory');
    });

    it('is the local container in dev, matching how the other consumers resolve it', () => {
        expect(roadsApiBaseFor({ protocol: 'http:', hostname: 'localhost', search: '' }))
            .toBe('http://localhost:3001/api');
        expect(roadsApiBaseFor({ protocol: 'http:', hostname: '127.0.0.1', search: '' }))
            .toBe('http://127.0.0.1:3001/api');
    });

    it('is not repointed by the ?backend= dev override, which names a different service', () => {
        expect(roadsApiBaseFor({
            protocol: 'http:', hostname: 'localhost', search: '?backend=http%3A%2F%2Flocalhost%3A4913'
        })).toBe('http://localhost:3001/api');
    });
});

describe('curated road parcels URL', () => {
    it('keeps the classification filter alongside the bbox', () => {
        const url = new URL(curatedRoadsUrl(ZAGREB_CURATED_ROADS, BBOX, 'https://zagreb.lol/api'));
        expect(url.origin + url.pathname).toBe('https://zagreb.lol/api/roads/parcels');
        expect(url.searchParams.get('classification')).toBe('road');
        expect(url.searchParams.get('bbox')).toBe(BBOX);
        // One query string. Concatenating "?bbox=" onto a path that already had params is the
        // failure this guards: still HTTP 200, filter silently gone.
        expect((url.toString().match(/\?/g) || []).length).toBe(1);
    });

    it('builds the same URL whichever base it is given', () => {
        const local = new URL(curatedRoadsUrl(ZAGREB_CURATED_ROADS, BBOX, 'http://localhost:3001/api'));
        expect(local.pathname).toBe('/api/roads/parcels');
        expect(local.searchParams.get('classification')).toBe('road');
    });

    it('works for a config with no params at all', () => {
        const url = new URL(curatedRoadsUrl({ path: '/roads/parcels' }, BBOX, 'https://zagreb.lol/api'));
        expect(url.searchParams.get('bbox')).toBe(BBOX);
        expect(url.searchParams.get('classification')).toBeNull();
    });
});
