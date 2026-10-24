import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const { backendBase, loadMetadata, operationNames, operationEntries } = require('../../frontend/js/source-explorer.js');

describe('source explorer backend metadata reads', () => {
    it('uses native adapter method shapes while retaining methods from both runtime implementations', () => {
        const generic = { semantics: 'generic lookup' };
        const native = { semantics: 'native projected lookup' };
        const image = { semantics: 'server image bytes' };
        expect(operationEntries({ required: ['lookup', 'image'], contract: { operations: { lookup: native } } },
            { operations: { lookup: generic, image, unsupported: {} } })).toEqual([['lookup', native], ['image', image]]);
    });
    it('honours the explicit local backend and preserves its API path', () => {
        expect(backendBase({ hostname: 'localhost', protocol: 'http:', search: '?backend=https%3A%2F%2Fapi.example.org%2Fv1%2F' })).toBe('https://api.example.org/v1');
        expect(backendBase({ hostname: '127.0.0.1', protocol: 'http:', search: '' })).toBe('http://127.0.0.1:3000');
        expect(backendBase({ hostname: 'localhost', protocol: 'http:', search: '' }, 'http://localhost:3456/')).toBe('http://localhost:3456');
    });
    it('keeps production routing independent of local overrides and refuses credential-bearing URLs', () => {
        expect(backendBase({ hostname: 'urbangametheory.xyz', protocol: 'https:', search: '?backend=http://localhost:3456' }, 'http://localhost:3456')).toBe('https://api.urbangametheory.xyz');
        expect(() => backendBase({ hostname: 'localhost', protocol: 'http:', search: '?backend=https://user:password@example.org/' })).toThrow(/Invalid/);
    });
    it('loads actual catalogue and contracts from the chosen backend', async () => {
        const catalogue = { schema: 'source-catalogue/v1', abstractions: [{ id: 'parcels', sources: [] }] };
        const contracts = { schema: 'source-contracts/v1', abstractions: [{ id: 'parcels', operations: {} }] };
        const fetchImpl = vi.fn(async url => ({ ok: true, json: async () => url.endsWith('/contracts') ? contracts : catalogue }));
        expect(await loadMetadata('https://api.example.org', fetchImpl)).toEqual({ catalogue, contracts });
        expect(fetchImpl.mock.calls.map(call => call[0])).toEqual(['https://api.example.org/source-system', 'https://api.example.org/source-system/contracts']);
    });
    it('shows only methods declared by the selected adapter implementations and optional contract', () => {
        expect([...operationNames({ required: ['basemap'], contract: { methods: ['basemap', 'image'] } })]).toEqual(['basemap']);
        expect([...operationNames({ implementations: [{ required: ['image', 'tileRequest'] }, { required: ['tileUrl'] }], contract: { optional: ['mapRequest'] } })]).toEqual(['image', 'tileRequest', 'tileUrl', 'mapRequest']);
    });
    it('reports an HTTP or invalid response as unavailable rather than returning an empty catalogue', async () => {
        await expect(loadMetadata('https://api.example.org', async () => ({ ok: false, status: 503 }))).rejects.toThrow('HTTP 503');
        await expect(loadMetadata('https://api.example.org', async () => ({ ok: true, json: async () => ({ abstractions: [] }) }))).rejects.toThrow('Invalid source metadata');
    });
});
