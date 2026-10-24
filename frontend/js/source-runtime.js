// Shared source registration and adapter dispatch for browser and server. Domain readers retain
// their own operations and validators; source selection never guesses from location or catches errors.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SourceRuntime = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const registries = new Set();
    const contracts = () => typeof window !== 'undefined' ? window.SourceContracts
        : typeof require === 'function' ? require('./source-contracts.js') : null;
    function fail(message) { return Object.assign(new Error(message), { status: 400, code: 'invalid-data-source' }); }
    function definition(abstraction, value) {
        if (!value || value.abstraction !== abstraction || typeof value.id !== 'string' || !value.id.length
            || value.id.length > 10000 || typeof value.adapter !== 'string' || !value.adapter.length
            || !['default', 'custom'].includes(value.kind) || !value.config || typeof value.config !== 'object'
            || Array.isArray(value.config)) throw fail('Invalid source definition.');
        return Object.freeze({ ...value, label: value.label || value.id });
    }
    function createRegistry({ abstraction, adapters, sources = [], required = [], runtime = typeof process !== 'undefined' && process.versions?.node ? 'server' : 'browser' }) {
        if (typeof abstraction !== 'string' || !abstraction || !adapters || typeof adapters !== 'object') throw fail('Invalid source abstraction.');
        const factories = new Map(Object.entries(adapters).map(([id, spec]) => {
            const adapter = typeof spec === 'function' ? { create: spec } : spec;
            if (!adapter || typeof adapter.create !== 'function') throw fail('An adapter needs a create function.');
            return [id, adapter];
        }));
        const entries = new Map();
        function checked(value) {
            const source = definition(abstraction, value);
            const adapter = factories.get(source.adapter);
            if (!adapter) throw fail(`Unknown ${abstraction} adapter: ${source.adapter}`);
            if (source.kind === 'custom' && adapter.custom === false) throw fail('This adapter only accepts configured sources.');
            return { source, adapter };
        }
        function register(value, { replace = false } = {}) {
            const { source } = checked(value);
            if (entries.has(source.id) && !replace) throw fail(`Duplicate ${abstraction} source: ${source.id}`);
            entries.set(source.id, source); return source;
        }
        sources.forEach(value => register(value));
        function resolve(value) {
            let source = typeof value === 'string' ? entries.get(value) : value;
            if (!source) throw fail(`Choose an explicit ${abstraction} source.`);
            if (typeof value !== 'string') definition(abstraction, value);
            if (source.kind === 'default') {
                const registered = entries.get(source.id);
                if (!registered || registered.kind !== 'default' || registered.adapter !== source.adapter) {
                    throw fail('Default sources must be registered by the application.');
                }
                // Public callers cannot substitute configuration while borrowing a default ID.
                source = registered;
            }
            return checked(source);
        }
        function instantiate(value, context) {
            const { source, adapter } = resolve(value);
            if (adapter.validateConfig) adapter.validateConfig(source.config);
            return { source, adapter, reader: adapter.create(source.config, context, source) };
        }
        function checkReader(reader, source, adapter) {
            // A missing adapter method fails at construction, before a partial result escapes.
            if (!reader || typeof reader !== 'object' || typeof reader.then === 'function'
                || [...required, ...(adapter.required || [])].some(method => typeof reader[method] !== 'function')) {
                throw fail(`Adapter ${source.adapter} does not implement the ${abstraction} contract.`);
            }
            return reader;
        }
        function open(value, context = {}) {
            const { source, adapter, reader } = instantiate(value, context);
            return checkReader(reader, source, adapter);
        }
        async function openAsync(value, context = {}) {
            const { source, adapter, reader } = instantiate(value, context);
            return checkReader(await reader, source, adapter);
        }
        const api = Object.freeze({ abstraction, runtime, register, open, openAsync,
            source: value => resolve(value).source,
            sources: () => [...entries.values()],
            adapters: () => [...factories.entries()].map(([id, adapter]) => ({ id, abstraction,
                custom: adapter.custom !== false, required: [...new Set([...required, ...(adapter.required || [])])],
                runtime, contract: contracts()?.adapter(abstraction, id) || null })) });
        registries.add(api);
        return api;
    }
    // Native provider descriptors stay adapter configuration, keeping established source IDs,
    // transport settings and dataset identities intact while sharing one registration contract.
    function source(abstraction, adapter, config, { id = config?.id, label = config?.name || id, kind = 'default' } = {}) {
        return definition(abstraction, { id, label, abstraction, adapter, kind, config });
    }
    function catalogue() {
        const byFamily = new Map();
        for (const registry of registries) {
            if (!byFamily.has(registry.abstraction)) byFamily.set(registry.abstraction, { id: registry.abstraction,
                contract: contracts()?.abstraction(registry.abstraction) || null, runtimes: new Set(), adapters: new Map(), sources: new Map() });
            const family = byFamily.get(registry.abstraction);
            family.runtimes.add(registry.runtime);
            registry.adapters().forEach(adapter => {
                const old = family.adapters.get(adapter.id);
                const implementations = [...(old?.implementations || []).filter(entry => entry.runtime !== registry.runtime),
                    { runtime: registry.runtime, required: adapter.required, custom: adapter.custom }];
                family.adapters.set(adapter.id, { ...adapter, implementations });
            });
            registry.sources().forEach(source => family.sources.set(source.id, source));
        }
        return { schema: 'source-catalogue/v1', abstractions: [...byFamily.values()].map(family => ({ ...family,
            runtimes: [...family.runtimes], adapters: [...family.adapters.values()], sources: [...family.sources.values()] })) };
    }
    return Object.freeze({ createRegistry, source, catalogue });
});
