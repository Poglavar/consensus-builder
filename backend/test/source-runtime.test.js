// Source selection, dispatch and capability checks work identically for default and custom data.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SourceRuntime = require('../../frontend/js/source-runtime.js');
const SourceContracts = require('../../frontend/js/source-contracts.js');

const makeSource = (abstraction, adapter, config = {}, options = {}) =>
    SourceRuntime.source(abstraction, adapter, config, options);

describe('SourceRuntime', () => {
    it('dispatches configured and custom sources through the same adapter factory', () => {
        const create = vi.fn((config, context, source) => ({
            read: () => ({ config, context, source })
        }));
        const registry = SourceRuntime.createRegistry({
            abstraction: 'fixture-family', adapters: { 'fixture-adapter': { create, required: ['read'] } }
        });
        const context = { runtimeOnly: 'context-marker' };
        const configured = makeSource('fixture-family', 'fixture-adapter', { endpoint: 'configured' }, { id: 'configured-source' });
        const custom = makeSource('fixture-family', 'fixture-adapter', { endpoint: 'custom' }, { id: 'custom-source', kind: 'custom' });
        registry.register(configured);
        registry.register(custom);

        expect(registry.open(configured.id, context).read()).toEqual({ config: configured.config, context, source: configured });
        expect(registry.open(custom.id, context).read()).toEqual({ config: custom.config, context, source: custom });
        expect(create).toHaveBeenCalledTimes(2);
        expect(create.mock.calls.map(([config]) => config.endpoint)).toEqual(['configured', 'custom']);
    });

    it('rejects unknown adapters, source IDs, wrong families, and adapters that disallow custom sources', () => {
        const registry = SourceRuntime.createRegistry({ abstraction: 'fixture-family', adapters: {
            configuredOnly: { create: () => ({ read() {} }), custom: false },
            accepted: { create: () => ({ read() {} }) }
        } });
        expect(() => registry.register(makeSource('fixture-family', 'unknown', {}, { id: 'unknown-adapter' }))).toThrow(/Unknown/);
        expect(() => registry.open('missing-source')).toThrow(/explicit fixture-family source/);
        expect(() => registry.open(makeSource('other-family', 'accepted', {}, { id: 'wrong-family', kind: 'custom' }))).toThrow(/Invalid source definition/);
        expect(() => registry.register(makeSource('fixture-family', 'configuredOnly', {}, { id: 'custom-disallowed', kind: 'custom' }))).toThrow(/only accepts configured/);
    });

    it('rejects malformed canonical wrapper fields', () => {
        const registry = SourceRuntime.createRegistry({ abstraction: 'fixture-family', adapters: {
            accepted: { create: () => ({ read() {} }) }
        } });
        const valid = makeSource('fixture-family', 'accepted', {}, { id: 'valid-source' });
        const malformed = [
            { ...valid, id: '' },
            { ...valid, abstraction: 'other-family' },
            { ...valid, adapter: '' },
            { ...valid, kind: 'legacy' },
            { ...valid, config: null },
            { ...valid, config: [] }
        ];
        for (const definition of malformed) expect(() => registry.register(definition)).toThrow(/Invalid source definition/);
    });

    it('checks all required methods before returning a reader', () => {
        const registry = SourceRuntime.createRegistry({ abstraction: 'fixture-family', required: ['read'], adapters: {
            accepted: { create: () => ({ other() {} }) }
        } });
        const source = makeSource('fixture-family', 'accepted', {}, { id: 'missing-method' });
        registry.register(source);
        expect(() => registry.open(source.id)).toThrow(/does not implement the fixture-family contract/);
    });

    it('propagates factory errors unchanged without trying another adapter', () => {
        const failure = new Error('factory failure');
        const fallback = vi.fn(() => ({ read() {} }));
        const registry = SourceRuntime.createRegistry({ abstraction: 'fixture-family', adapters: {
            primary: { create: () => { throw failure; } }, fallback: { create: fallback }
        } });
        const source = makeSource('fixture-family', 'primary', {}, { id: 'factory-error' });
        registry.register(source);
        let caught;
        try { registry.open(source.id); } catch (error) { caught = error; }
        expect(caught).toBe(failure);
        expect(fallback).not.toHaveBeenCalled();
    });

    it('awaits asynchronous factories and checks their required methods', async () => {
        const reader = { read: vi.fn(() => 'ready') };
        const create = vi.fn(async () => reader);
        const registry = SourceRuntime.createRegistry({ abstraction: 'fixture-family', adapters: {
            accepted: { create, required: ['read'] }
        } });
        const source = makeSource('fixture-family', 'accepted', {}, { id: 'async-reader' });
        registry.register(source);
        await expect(registry.openAsync(source.id)).resolves.toBe(reader);
        expect(reader.read()).toBe('ready');
        expect(create).toHaveBeenCalledOnce();

        const invalid = SourceRuntime.createRegistry({ abstraction: 'fixture-family', adapters: {
            incomplete: { create: async () => ({}) , required: ['read'] }
        } });
        invalid.register(makeSource('fixture-family', 'incomplete', {}, { id: 'async-incomplete' }));
        await expect(invalid.openAsync('async-incomplete')).rejects.toThrow(/does not implement/);
    });

    it('propagates asynchronous factory rejection unchanged', async () => {
        const failure = new Error('async factory failure');
        const registry = SourceRuntime.createRegistry({ abstraction: 'fixture-family', adapters: {
            accepted: { create: async () => { throw failure; } }
        } });
        const source = makeSource('fixture-family', 'accepted', {}, { id: 'async-failure' });
        registry.register(source);
        await expect(registry.openAsync(source.id)).rejects.toBe(failure);
    });

    it('rejects forged defaults and uses only the trusted configuration registered for a known ID', () => {
        const create = vi.fn(config => ({ read: () => config }));
        const registry = SourceRuntime.createRegistry({ abstraction: 'fixture-family', adapters: {
            accepted: { create }, other: { create: vi.fn(() => ({ read() {} })) }
        } });
        const trusted = makeSource('fixture-family', 'accepted', { endpoint: 'trusted' }, { id: 'registered-default' });
        registry.register(trusted);
        expect(() => registry.open(makeSource('fixture-family', 'accepted', {}, { id: 'unregistered-default' }))).toThrow(/registered by the application/);
        expect(registry.open({ ...trusted, config: { endpoint: 'forged' } }).read()).toEqual({ endpoint: 'trusted' });
        expect(create.mock.calls.at(-1)[0]).toEqual({ endpoint: 'trusted' });
        expect(() => registry.open({ ...trusted, adapter: 'other', config: { endpoint: 'forged' } })).toThrow(/registered by the application/);
        expect(() => registry.open({ ...trusted, abstraction: 'other-family' })).toThrow(/Invalid source definition/);
    });

    it('guards duplicate IDs and supports an explicit trusted replacement', () => {
        const create = vi.fn(config => ({ read: () => config }));
        const registry = SourceRuntime.createRegistry({ abstraction: 'fixture-family', adapters: { accepted: { create } } });
        const initial = makeSource('fixture-family', 'accepted', { revision: 1 }, { id: 'replaceable' });
        const replacement = makeSource('fixture-family', 'accepted', { revision: 2 }, { id: 'replaceable' });
        registry.register(initial);
        expect(() => registry.register(replacement)).toThrow(/Duplicate/);
        registry.register(replacement, { replace: true });
        expect(registry.source('replaceable')).toEqual(replacement);
        expect(registry.open('replaceable').read()).toEqual({ revision: 2 });
    });

    it('attaches operation contracts to catalogue metadata without serializing runtime context', () => {
        const registry = SourceRuntime.createRegistry({ abstraction: 'parcels', adapters: {
            arcgis: { create: (_config, context) => ({ queryBounds: () => context.marker }) }
        }, required: ['queryBounds'] });
        const source = makeSource('parcels', 'arcgis', { endpoint: 'https://example.test/parcels' }, { id: 'catalogue-fixture' });
        registry.register(source);
        registry.open(source.id, { marker: 'runtime-context-marker' }).queryBounds();

        const catalogue = SourceRuntime.catalogue();
        const family = catalogue.abstractions.find(item => item.id === 'parcels');
        const adapter = family.adapters.find(item => item.id === 'arcgis');
        expect(adapter.contract).toEqual(SourceContracts.adapter('parcels', 'arcgis'));
        expect(adapter.required).toContain('queryBounds');
        expect(family.sources.find(item => item.id === source.id)).toEqual(source);
        expect(JSON.stringify(catalogue)).not.toContain('runtime-context-marker');
    });
});
