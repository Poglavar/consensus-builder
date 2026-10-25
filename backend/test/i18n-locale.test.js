// The viewer's locale (frontend/js/i18n.js): a UI language plus the region numbers and dates are
// written for. It comes from ?lang=, the saved preference or the browser; the saved preference
// holds the full tag, and a bare language keeps the region already chosen for it.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../frontend/js/i18n.js', import.meta.url), 'utf8');

function fakeStorage(initial = {}) {
    const data = { ...initial };
    return { ready: Promise.resolve(), getItem: k => (k in data ? data[k] : null), setItem: vi.fn((k, v) => { data[k] = v; }), data };
}

async function loadI18n({ search = '', stored = {}, languages = ['en-GB'] } = {}) {
    const win = {
        location: { search },
        navigator: { languages, language: languages[0] },
        PersistentStorage: fakeStorage(stored)
    };
    // eslint-disable-next-line no-new-func
    new Function('window', 'self', 'globalThis', 'document', src)(win, win, win, undefined);
    await win.i18n.ready;
    return win;
}

describe('locale detection', () => {
    it('takes the region from the browser', async () => {
        const win = await loadI18n({ languages: ['en-US', 'en'] });
        expect([win.i18n.getLanguage(), win.i18n.getLocale()]).toEqual(['en', 'en-US']);
    });

    it('falls back to the language default for a region the app does not have', async () => {
        expect((await loadI18n({ languages: ['en-AU'] })).i18n.getLocale()).toBe('en-GB');
        expect((await loadI18n({ languages: ['sr-RS'] })).i18n.getLocale()).toBe('sr-Latn-RS');
    });

    it('reads a saved locale, and a saved bare language as its default', async () => {
        expect((await loadI18n({ stored: { cb_language: 'en-US' } })).i18n.getLocale()).toBe('en-US');
        expect((await loadI18n({ stored: { cb_language: 'hr' }, languages: ['en-US'] })).i18n.getLocale()).toBe('hr-HR');
    });

    it('lets ?lang= name a locale, and a bare ?lang= keep the saved region', async () => {
        expect((await loadI18n({ search: '?lang=en-US' })).i18n.getLocale()).toBe('en-US');
        expect((await loadI18n({ search: '?lang=en', stored: { cb_language: 'en-US' } })).i18n.getLocale()).toBe('en-US');
        expect((await loadI18n({ search: '?lang=hr', stored: { cb_language: 'en-US' } })).i18n.getLocale()).toBe('hr-HR');
    });
});

describe('picking a locale', () => {
    it('saves the full tag and announces a region change', async () => {
        const win = await loadI18n();
        const heard = [];
        win.i18n.onChange(lang => heard.push(lang));
        win.i18n.setLanguage('en-US', { userChoice: true });
        expect(win.i18n.getLocale()).toBe('en-US');
        expect(win.PersistentStorage.data.cb_language).toBe('en-US');
        expect(heard).toEqual(['en']);
    });

    it('keeps the region when a bare language is set again', async () => {
        const win = await loadI18n({ languages: ['en-US'] });
        win.i18n.setLanguage('en');
        expect(win.i18n.getLocale()).toBe('en-US');
        win.i18n.setLanguage('es');
        expect(win.i18n.getLocale()).toBe('es-ES');
    });

    it('lists the locales the picker offers', async () => {
        expect((await loadI18n()).i18n.getSupportedLocales()).toEqual(['en-GB', 'en-US', 'es-ES', 'sr-Latn-RS', 'hr-HR']);
    });
});

describe('dictionary startup', () => {
    it('settles from the URL locale when the workspace is blocked without waiting for map storage', async () => {
        const persistent = fakeStorage();
        persistent.ready = new Promise(() => {});
        const win = {
            location: { search: '?lang=hr' },
            navigator: { languages: ['en-GB'], language: 'en-GB' },
            PersistentStorage: persistent,
            BrowserWorkspace: { ready: Promise.resolve(false) }
        };
        new Function('window', 'self', 'globalThis', 'document', src)(win, win, win, undefined);
        await win.i18n.ready;
        expect(win.i18n.getLocale()).toBe('hr-HR');
        expect(persistent.setItem).not.toHaveBeenCalled();
    });

    it('waits for map storage when the workspace is owned', async () => {
        let releaseStorage;
        const persistent = fakeStorage();
        persistent.ready = new Promise(resolve => { releaseStorage = resolve; });
        const win = {
            location: { search: '?lang=hr' },
            navigator: { languages: ['en-GB'], language: 'en-GB' },
            PersistentStorage: persistent,
            BrowserWorkspace: { ready: Promise.resolve(true) }
        };
        new Function('window', 'self', 'globalThis', 'document', src)(win, win, win, undefined);
        let settled = false;
        win.i18n.ready.then(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);
        releaseStorage();
        await win.i18n.ready;
        expect(win.i18n.getLocale()).toBe('hr-HR');
    });

    it('preserves readable HTML labels and attributes until their translations exist', async () => {
        const node = { textContent: 'Proposals', title: 'Proposals',
            getAttribute: key => ({ 'data-i18n-key':'mapShell.proposals', 'data-i18n-attr':'text,title' })[key],
            setAttribute(key,value) { this[key]=value; } };
        const document = { querySelectorAll: () => [node], addEventListener() {} };
        const win = { location:{search:'?lang=es'}, document, PersistentStorage:fakeStorage() };
        new Function('window','self','globalThis','document',src)(win,win,win,document);
        await win.i18n.ready;
        expect(node.textContent).toBe('Proposals');
        expect(node.title).toBe('Proposals');
        win.i18n.registerTranslations('es',{'mapShell.proposals':'Propuestas'});
        win.i18n.applyTranslations();
        expect(node.textContent).toBe('Propuestas');
        expect(node.title).toBe('Propuestas');
    });
});
