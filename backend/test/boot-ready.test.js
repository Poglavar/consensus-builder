import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../frontend/js/boot-ready.js', import.meta.url), 'utf8');
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe('bootstrap control gate', () => {
    it.each(['before-dom', 'after-dom'])('attaches controls before enabling them when storage resolves %s', async order => {
        const storage = deferred(), translations = deferred(), listeners = [];
        let controlsReady = false;
        const remove = vi.fn(() => expect(controlsReady).toBe(true));
        const document = { readyState: 'loading', body: { classList: { remove } },
            addEventListener: (name, listener) => { if (name === 'DOMContentLoaded') listeners.push(listener); } };
        // The application's bootstrap listener is registered before the last script runs.
        document.addEventListener('DOMContentLoaded', () => storage.promise.then(() => { controlsReady = true; }));
        vm.runInNewContext(source, { document, window: { PersistentStorage: { ready: storage.promise },
            i18n: { translationsReady: translations.promise } } });
        translations.resolve();
        if (order === 'before-dom') storage.resolve();
        await flush();
        expect(remove).not.toHaveBeenCalled();
        document.readyState = 'interactive';
        listeners.forEach(listener => listener());
        if (order === 'after-dom') {
            await flush();
            expect(remove).not.toHaveBeenCalled();
            storage.resolve();
        }
        await flush();
        expect(remove).toHaveBeenCalledExactlyOnceWith('app-loading', 'i18n-loading');
    });

    it('keeps the translation gate after the document and storage are ready', async () => {
        const translations = deferred(), remove = vi.fn();
        vm.runInNewContext(source, { document: { readyState: 'complete', body: { classList: { remove } } },
            window: { PersistentStorage: { ready: Promise.resolve() }, i18n: { translationsReady: translations.promise } } });
        await flush();
        expect(remove).not.toHaveBeenCalled();
        translations.resolve();
        await flush();
        expect(remove).toHaveBeenCalledOnce();
    });

    it('the window-load recovery gate also waits for storage before enabling controls', async () => {
        const html = fs.readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');
        const fallback = html.match(/window\.addEventListener\('load', function \(\) \{[\s\S]*?\n            \}\);/)[0];
        const storage = deferred(), remove = vi.fn();
        let load;
        vm.runInNewContext(fallback, { document: { body: { classList: { remove } } }, window: {
            addEventListener: (_name, listener) => { load = listener; },
            PersistentStorage: { ready: storage.promise }, i18n: { translationsReady: Promise.resolve() }
        } });
        load();
        await flush();
        expect(remove).not.toHaveBeenCalled();
        storage.resolve();
        await flush();
        expect(remove).toHaveBeenCalledExactlyOnceWith('app-loading', 'i18n-loading');
    });
});
