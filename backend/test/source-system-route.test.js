import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { setupSourceSystemRoutes } from '../routes/source-system.js';
const require = createRequire(import.meta.url);
const SourceRuntime = require('../../frontend/js/source-runtime.js');
const SourceContracts = require('../../frontend/js/source-contracts.js');

function route(path, params = {}) {
    const handlers = new Map();
    setupSourceSystemRoutes({ get: (name, handler) => handlers.set(name, handler) });
    const res = { statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; } };
    handlers.get(path)({ params }, res);
    return res;
}

describe('public source-system metadata routes', () => {
    it('lists initialized defaults and actual registrations without opening readers or exposing runtime context', () => {
        const create = vi.fn();
        const abstraction = 'source-system-test-family';
        SourceRuntime.createRegistry({ abstraction,
            adapters: { fixture: { create } },
            sources: [SourceRuntime.source(abstraction, 'fixture', { endpoint: 'https://example.org/features' }, { id: 'public-fixture' })]
        });
        const res = route('/source-system');
        expect(res.statusCode).toBe(200);
        expect(res.body.schema).toBe('source-catalogue/v1');
        const families = new Map(res.body.abstractions.map(family => [family.id, family]));
        for (const id of ['parcels', 'buildings', 'planning', 'ownership', 'building-details']) {
            expect(families.get(id).sources.length).toBeGreaterThan(0);
            expect(families.get(id).runtimes).toContain('server');
        }
        expect(families.get(abstraction).sources[0].config).toEqual({ endpoint: 'https://example.org/features' });
        expect(create).not.toHaveBeenCalled();
        expect(JSON.stringify(res.body)).not.toContain('BEGIN CERTIFICATE');
    });

    it('lists real browser registrations with their runtime and keeps the imagery gateway distinct', () => {
        const families = route('/source-system').body.abstractions;
        for (const id of ['terrain-profile', 'transit-alignments', 'reality-mesh']) {
            expect(families.find(family => family.id === id)).toMatchObject({ id, runtime: 'browser', registered: true });
        }
        expect(families.find(family => family.id === 'geocoding').runtime).toBe('shared');
        expect(families.find(family => family.id === 'economics').runtime).toBe('shared');
        expect(families.find(family => family.id === 'geocoding').sources).toContainEqual(expect.objectContaining({ id: 'photon' }));
        expect(families.find(family => family.id === 'reality-mesh').sources).toContainEqual(expect.objectContaining({ id: 'google-photorealistic', config: { id: 'google-photorealistic', assetId: 2275207 } }));
        const imagery = families.find(family => family.id === 'imagery');
        expect(imagery.runtime).toBe('mixed');
        expect(imagery.adapters.find(adapter => adapter.id === 'xyz').implementations).toEqual(expect.arrayContaining([
            expect.objectContaining({ runtime: 'server', required: ['image', 'tileRequest'] }),
            expect.objectContaining({ runtime: 'browser', required: ['tileUrl'] })
        ]));
        expect(imagery.adapters).toContainEqual(expect.objectContaining({ id: 'maptiler-basemap', runtime: 'browser' }));
        expect(imagery.sources.find(source => source.id === 'maptiler').config).not.toHaveProperty('apiKey');
    });

    it('returns canonical contracts and schemas unchanged', () => {
        expect(route('/source-system/contracts').body.abstractions).toEqual(SourceContracts.all());
        expect(route('/source-system/contracts/:abstraction', { abstraction: 'parcels' }).body).toEqual(SourceContracts.abstraction('parcels'));
        expect(route('/source-system/schemas').body.schemas).toEqual(SourceContracts.schemas());
        expect(route('/source-system/schemas/:name', { name: 'source' }).body).toEqual(SourceContracts.schemas().source);
        expect(route('/source-system/schemas/:name', { name: 'operations' }).body).toEqual(SourceContracts.schemas().operations);
    });

    it('returns 404 for unknown abstractions and schema names, including inherited keys', () => {
        expect(route('/source-system/contracts/:abstraction', { abstraction: 'unregistered' }).statusCode).toBe(404);
        expect(route('/source-system/contracts/:abstraction', { abstraction: 'constructor' }).statusCode).toBe(404);
        expect(route('/source-system/schemas/:name', { name: 'unregistered' }).statusCode).toBe(404);
        expect(route('/source-system/schemas/:name', { name: 'constructor' }).statusCode).toBe(404);
    });
});
