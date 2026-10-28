import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';
import { makeDocument } from './helpers/fake-dom.js';

describe('Settings reference dialogs', () => {
    it('moves one live reference node into a dialog and restores it on close', () => {
        const document = makeDocument();
        document.body.innerHTML = '<div hidden id="home"><div id="settings-reference-credits"><dl id="map-credits-details"></dl></div></div>';
        const original = document.getElementById('map-credits-details');
        const context = { document, i18n: { t: key => key }, CbDialog: { open(options) {
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
});

it('a simulation switch cannot disable the surrounding Advanced tools', () => {
    const doc = makeDocument();
    doc.body.innerHTML = `<details class="accordion-section" id="advanced"><div class="sheet-section-body">
      <section class="activity-simulation" id="game"><div class="sheet-section-body"><input id="enable" type="checkbox" data-layer="game"><button id="play"></button></div></section>
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
