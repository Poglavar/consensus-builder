import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';
import { makeDocument } from './helpers/fake-dom.js';
import { readSource } from './helpers/read-source.js';
import { testI18n } from './helpers/i18n.js';

// Settings also shows where published records are read from (chain/read-source.js).
const reading = (source = 'server') => ({ ReadSource: readSource(source), ChainReader: { cluster: () => 'devnet' }, addEventListener() {} });

describe('Settings reference dialogs', () => {
    it('opens the current language guide from both Settings and the design starter', () => {
        const document = makeDocument();
        document.body.innerHTML = '<a data-user-guide></a><a data-user-guide></a>';
        let language = 'hr';
        const languageListeners = [];
        const changeLanguage = () => languageListeners.forEach(listener => listener());
        const context = { document, ...reading(), i18n: { t: key => key, getLanguage: () => language, onChange: listener => { languageListeners.push(listener); } } };
        context.window = context;
        vm.runInNewContext(readFileSync(new URL('../../frontend/js/ui/settings-panel.js', import.meta.url), 'utf8'), context);
        const paths = () => Array.from(document.querySelectorAll('[data-user-guide]'), link => link.href);
        expect(paths()).toEqual(['kako-koristiti.html', 'kako-koristiti.html']);
        language = 'fr';
        changeLanguage();
        expect(paths()).toEqual(['how-to-use.html', 'how-to-use.html']);
    });

    it('moves one live reference node into a dialog and restores it on close', () => {
        const document = makeDocument();
        document.body.innerHTML = '<div hidden id="home"><div id="settings-reference-credits"><dl id="map-credits-details"></dl></div></div>';
        const original = document.getElementById('map-credits-details');
        const context = { document, ...reading(), i18n: { t: key => key, getLanguage: () => 'en', onChange() {} }, CbDialog: { open(options) {
            const body = document.createElement('div'); document.body.appendChild(body); body.appendChild(options.body);
            return { body, close() { options.onClose(); body.remove(); } };
        } } };
        context.window = context; vm.createContext(context);
        vm.runInContext(readFileSync(new URL('../../frontend/js/ui/settings-panel.js', import.meta.url), 'utf8'), context);
        for (let i = 0; i < 2; i++) {
            const dialog = context.SettingsPanel.openReference('credits');
            expect(dialog.body.querySelector('#map-credits-details')).toBe(original);
            expect(document.querySelectorAll('#map-credits-details')).toHaveLength(1);
            dialog.close();
            expect(document.getElementById('home').querySelector('#map-credits-details')).toBe(original);
        }
        expect(context.SettingsPanel.openReference('unknown')).toBeNull();
    });

    it('chooses where published records are read from, keeps it in this browser, and describes the choice', () => {
        const document = makeDocument();
        document.body.innerHTML = ['server', 'chain', 'both'].map(source =>
            `<button type="button" data-read-source-choice="${source}" aria-pressed="false"></button>`).join('') + '<p id="read-source-note"></p>';
        const i18n = testI18n('en');
        const stored = new Map();
        const context = { document, ...reading(), ReadSource: readSource('chain', { stored }), i18n: { t: i18n.t, getLanguage: () => 'en', onChange() {} } };
        context.window = context; vm.createContext(context);
        vm.runInContext(readFileSync(new URL('../../frontend/js/ui/settings-panel.js', import.meta.url), 'utf8'), context);
        const pressed = () => Array.from(document.querySelectorAll('[data-read-source-choice]'))
            .filter(button => button.getAttribute('aria-pressed') === 'true').map(button => button.dataset.readSourceChoice);
        const note = () => document.getElementById('read-source-note').textContent;
        // A link chose the chain for this page: Settings says so, and keeps nothing yet.
        expect(pressed()).toEqual(['chain']);
        expect(note()).toContain('Agreements are listed from the agreement program on Solana devnet');
        expect(note()).toContain('This link chose it for this page');
        expect(stored.size).toBe(0);
        // The fake document does not bubble to itself: the click reaches its listener as the page's would.
        document.dispatchEvent({ type: 'click', target: document.querySelector('[data-read-source-choice="both"]') });
        expect([context.ReadSource.get(), stored.get('cb.readFrom'), pressed()]).toEqual(['both', 'both', ['both']]);
        expect(note()).toBe('Both are read: lists show the rows of either, each marked by where it was found, and an object is taken from whichever holds it (our server’s copy when both do).');
    });
});

it('a nested section\'s switch cannot disable the surrounding Advanced tools', () => {
    const doc = makeDocument();
    doc.body.innerHTML = `<details class="accordion-section" id="advanced"><div class="sheet-section-body">
      <details class="accordion-section" id="game"><div class="sheet-section-body"><input id="enable" type="checkbox" data-layer="game"><button id="play"></button></div></details>
      <input id="debug" type="checkbox"><button id="reset"></button></div></details>`;
    const src = readFileSync(new URL('../../frontend/js/map-controls.js', import.meta.url), 'utf8');
    const start = src.indexOf('function updateSectionControlsState('), end = src.indexOf('\n}\n', start) + 2;
    const update = new Function('window', `${src.slice(start, end)};return updateSectionControlsState;`)({});
    const el = id => doc.getElementById(id);
    el('enable').checked = false;
    update(el('advanced')); update(el('game'));
    expect(el('play').disabled).toBe(true);
    expect(el('debug').disabled).toBe(false); expect(el('reset').disabled).toBe(false);
    el('enable').checked = true; update(el('game'));
    expect(el('play').disabled).toBe(false);
    expect(el('debug').disabled).toBe(false); expect(el('reset').disabled).toBe(false);
});
