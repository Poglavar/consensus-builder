// Exercise the real runtime and loader with controlled network completion, failure and locale changes.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = name => readFileSync(new URL(`../../frontend/js/${name}.js`, import.meta.url), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function boot({ language = 'en', storage, fetchImpl } = {}) {
    const events = [], classes = new Set(['i18n-loading']);
    const node = { textContent: 'Readable label', getAttribute: key => ({ 'data-i18n-key': 'example.label' })[key] };
    const document = { body: { classList: { remove: name => classes.delete(name) } },
        querySelectorAll: () => [node], addEventListener() {} };
    const window = { document, location: { search: `?lang=${language}` }, PersistentStorage: storage,
        getCacheBustToken: () => 'build token', dispatchEvent: event => events.push(event) };
    const fetch = vi.fn(fetchImpl || (async url => ({ ok: true, json: async () => ({ example: { label: url.includes('/en.') ? 'English' : 'Selected' } }) })));
    const warn = vi.fn();
    const context = vm.createContext({ window, self: window, document, fetch, AbortSignal, URLSearchParams,
        Intl, CustomEvent: class { constructor(type) { this.type = type; } }, console: { warn } });
    vm.runInContext(source('i18n'), context);
    vm.runInContext(source('i18n-loader'), context);
    const requests = () => fetch.mock.calls.map(([url]) => url.split('?')[0]);
    return { api: window.i18n, requests, fetch, classes, events, warn, node };
}

describe('on-demand dictionaries', () => {
    it.each(['en', 'es'])('loads only English and selected %s at startup', async language => {
        const f = boot({ language });
        await f.api.translationsReady;
        expect(f.requests()).toEqual(language === 'en' ? ['i18n/en.json'] : ['i18n/en.json', 'i18n/es.json']);
        expect(f.node.textContent).toBe(language === 'en' ? 'English' : 'Selected');
        expect(f.classes.has('i18n-loading')).toBe(false);
        expect(f.fetch.mock.calls[0][0]).toContain('v=build%20token');
    });

    it('waits for the selected dictionary without requesting other languages', async () => {
        const held = deferred(), requested = deferred();
        const f = boot({ language: 'es', fetchImpl: async url => {
            if (url.includes('/es.')) { requested.resolve(); await held.promise; }
            return { ok: true, json: async () => ({ example: { label: 'Listo' } }) };
        } });
        await requested.promise;
        expect(f.classes.has('i18n-loading')).toBe(true);
        expect(f.node.textContent).toBe('Readable label');
        expect(f.requests()).toEqual(['i18n/en.json', 'i18n/es.json']);
        held.resolve(); await f.api.translationsReady;
        expect(f.node.textContent).toBe('Listo');
    });

    it('shares concurrent requests and retains loaded dictionaries across region changes and revisits', async () => {
        const f = boot(); await f.api.translationsReady;
        const first = f.api.loadLanguage('hr');
        expect(f.api.loadLanguage('hr')).toBe(first);
        expect(await first).toBe(true);
        await f.api.loadLanguage('hr');
        f.api.setLanguage('en-US');
        await f.api.loadLanguage('en');
        expect(f.requests()).toEqual(['i18n/en.json', 'i18n/hr.json']);
    });

    it('loads a newly selected language and ignores a stale completion', async () => {
        const held = deferred(), requested = deferred();
        const f = boot({ fetchImpl: async url => {
            if (url.includes('/es.')) { requested.resolve(); await held.promise; }
            return { ok: true, json: async () => ({ example: { label: url.includes('/hr.') ? 'Hrvatski' : 'Other' } }) };
        } });
        await f.api.translationsReady;
        f.api.setLanguage('es'); await requested.promise;
        f.api.setLanguage('hr'); await f.api.loadLanguage('hr');
        expect(f.node.textContent).toBe('Hrvatski');
        const events = f.events.length;
        held.resolve(); await f.api.loadLanguage('es');
        expect(f.node.textContent).toBe('Hrvatski');
        expect(f.events).toHaveLength(events);
        expect(f.requests()).toEqual(['i18n/en.json', 'i18n/es.json', 'i18n/hr.json']);
    });

    it('falls back to English on failure and retries with the same cache identity', async () => {
        let fail = true;
        const f = boot({ language: 'es', fetchImpl: async url => {
            if (url.includes('/es.') && fail) return { ok: false, status: 503 };
            return { ok: true, json: async () => ({ example: { label: 'Readable fallback' } }) };
        } });
        await f.api.translationsReady;
        expect(f.node.textContent).toBe('Readable fallback');
        expect(f.classes.has('i18n-loading')).toBe(false);
        expect(f.warn).toHaveBeenCalledOnce();
        fail = false;
        expect(await f.api.loadLanguage('es')).toBe(true);
        expect(f.fetch.mock.calls[1][0]).toBe(f.fetch.mock.calls[2][0]);
    });

    it.each([[], { example: 42 }, { example: null }, { 'example.label': 'first', example: { label: 'second' } }])('rejects invalid dictionaries atomically: %j', async invalid => {
        const f = boot({ fetchImpl: async () => ({ ok: true, json: async () => invalid }) });
        await f.api.translationsReady;
        expect(f.node.textContent).toBe('Readable label');
        expect(f.warn).toHaveBeenCalledOnce();
        expect(await f.api.loadLanguage('en')).toBe(false);
        expect(f.requests()).toHaveLength(2);
    });

    it('does not fetch unregistered languages or arbitrary paths', async () => {
        const f = boot(); await f.api.translationsReady;
        expect(await f.api.loadLanguage('ar')).toBe(false);
        expect(await f.api.loadLanguage('../other')).toBe(false);
        expect(f.requests()).toEqual(['i18n/en.json']);
    });
});
