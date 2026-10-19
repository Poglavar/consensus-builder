// Stored file URLs never derive their origin from the request: the API bakes in the pinned public
// base when there is one and the served path alone otherwise, and the client resolves a path
// against the backend it is talking to. Both halves are covered here, plus the repair transform
// that turns rows with a dead localhost origin back into paths.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { publicApiBaseUrl, publicFileUrl } from '../utils/public-base-url.js';
import { relativizeStoredUrl } from '../scripts/relativize-screenshot-urls.mjs';

const dataSource = readFileSync(new URL('../../frontend/js/data-source.js', import.meta.url), 'utf8');

describe('public file URLs on the server', () => {
    const previous = process.env.PUBLIC_API_BASE_URL;
    afterEach(() => {
        if (previous === undefined) delete process.env.PUBLIC_API_BASE_URL;
        else process.env.PUBLIC_API_BASE_URL = previous;
    });

    it('returns the served path alone when no public base is pinned', () => {
        delete process.env.PUBLIC_API_BASE_URL;
        expect(publicApiBaseUrl()).toBe('');
        expect(publicFileUrl('/uploads/images/a.png')).toBe('/uploads/images/a.png');
        expect(publicFileUrl('images/a.png')).toBe('/images/a.png');
    });

    it('bakes in the pinned base, trailing slash or not', () => {
        process.env.PUBLIC_API_BASE_URL = 'https://api.example.test/';
        expect(publicApiBaseUrl()).toBe('https://api.example.test');
        expect(publicFileUrl('/uploads/images/a.png')).toBe('https://api.example.test/uploads/images/a.png');
    });
});

describe('resolveBackendAssetUrl on the client', () => {
    function boot(search) {
        const stored = new Map();
        const storage = {
            getItem: key => stored.get(key) ?? null,
            setItem: (key, value) => stored.set(key, String(value)),
            clear: () => stored.clear()
        };
        const window = {
            current_environment: 'development',
            location: { protocol: 'http:', hostname: 'localhost', search },
            CityConfigManager: { requiresBackendDataSource: () => true, getCurrentCityConfig: () => ({}) },
            localStorage: storage
        };
        const context = vm.createContext({
            window, localStorage: storage, PersistentStorage: storage, URLSearchParams, console,
            document: { addEventListener() {}, getElementById: () => null }
        });
        vm.runInContext(dataSource, context);
        return window;
    }

    it('prefixes a served path with the backend the page talks to, override included', () => {
        const window = boot('?backend=http%3A%2F%2Flocalhost%3A4179');
        expect(window.resolveBackendAssetUrl('/uploads/images/a.png')).toBe('http://localhost:4179/uploads/images/a.png');
        expect(window.resolveBackendAssetUrl('images/a.png')).toBe('http://localhost:4179/images/a.png');
    });

    it('re-anchors a stale localhost origin onto the backend the page talks to', () => {
        const window = boot('?backend=http%3A%2F%2Flocalhost%3A4179');
        expect(window.resolveBackendAssetUrl('http://localhost:4583/uploads/images/a.png')).toBe('http://localhost:4179/uploads/images/a.png');
        expect(window.resolveBackendAssetUrl('http://127.0.0.1:3000/images/a.png')).toBe('http://localhost:4179/images/a.png');
        expect(window.resolveBackendAssetUrl('http://localhost:3000/other/a.png')).toBe('http://localhost:3000/other/a.png');
    });

    it('leaves absolute, data, blob and ipfs references alone and returns null for nothing', () => {
        const window = boot('?backend=http%3A%2F%2Flocalhost%3A4179');
        expect(window.resolveBackendAssetUrl('https://api.urbangametheory.xyz/uploads/images/a.png')).toBe('https://api.urbangametheory.xyz/uploads/images/a.png');
        expect(window.resolveBackendAssetUrl('data:image/png;base64,aGVsbG8=')).toBe('data:image/png;base64,aGVsbG8=');
        expect(window.resolveBackendAssetUrl('blob:http://localhost/abc')).toBe('blob:http://localhost/abc');
        expect(window.resolveBackendAssetUrl('ipfs://abc')).toBe('ipfs://abc');
        expect(window.resolveBackendAssetUrl('')).toBeNull();
        expect(window.resolveBackendAssetUrl(null)).toBeNull();
    });
});

describe('relativizeStoredUrl', () => {
    it('strips a localhost origin off a served path and nothing else', () => {
        expect(relativizeStoredUrl('http://localhost:4583/uploads/images/proposal-thumb-1.png')).toBe('/uploads/images/proposal-thumb-1.png');
        expect(relativizeStoredUrl('http://127.0.0.1:3000/images/x.png')).toBe('/images/x.png');
        expect(relativizeStoredUrl('https://api.urbangametheory.xyz/uploads/images/a.png')).toBeNull();
        expect(relativizeStoredUrl('http://localhost:3000/ipfs/abc')).toBeNull();
        expect(relativizeStoredUrl('/uploads/images/already.png')).toBeNull();
        expect(relativizeStoredUrl(null)).toBeNull();
    });

    it('strips any origin when asked, still only for served paths', () => {
        expect(relativizeStoredUrl('https://api.urbangametheory.xyz/uploads/images/a.png', { allOrigins: true })).toBe('/uploads/images/a.png');
        expect(relativizeStoredUrl('https://gateway.pinata.cloud/ipfs/abc', { allOrigins: true })).toBeNull();
    });
});
