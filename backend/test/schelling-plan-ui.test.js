// The Schelling plan's layer, panel and painting tool speak every supported language, ask only for
// keys that exist, and are wired into the page: a missing key would silently show the English
// fallback, and a missing script or stylesheet would leave the panel dead.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const html = read('../../frontend/index.html');
const sources = {
    layer: read('../../frontend/js/schelling/schelling-layer.js'),
    propose: read('../../frontend/js/schelling/schelling-propose.js')
};
const leafKeys = (node, prefix = '') => Object.entries(node).flatMap(([key, value]) =>
    (value && typeof value === 'object') ? leafKeys(value, `${prefix}${key}.`) : [`${prefix}${key}`]);
const dictOf = locale => JSON.parse(read(`../../frontend/i18n/${locale}.json`));

describe('the Schelling plan UI', () => {
    const reference = leafKeys(dictOf('en').schellingPlan).sort();

    it('has every sentence in every locale', () => {
        expect(reference.length).toBeGreaterThan(30);
        // Every English key exists in every locale; a Slavic plural adds its own `few` form.
        const base = key => key.replace(/\.(one|few|other)$/, '');
        for (const locale of ['hr', 'sr', 'es']) {
            const keys = new Set(leafKeys(dictOf(locale).schellingPlan));
            reference.forEach(key => expect(keys.has(key), `${locale} ${key}`).toBe(true));
            [...keys].forEach(key => expect(reference.some(english => base(english) === base(key)), `${locale} extra ${key}`).toBe(true));
        }
        for (const locale of ['hr', 'sr']) expect(dictOf(locale).schellingPlan.propose.blockCount.few, locale).toBeTruthy();
    });

    it('asks only for keys that exist', () => {
        const available = new Set(reference);
        const layerKeys = Array.from(sources.layer.matchAll(/\bt\('([a-zA-Z.]+)'/g), match => match[1]);
        const proposeKeys = [
            ...Array.from(sources.propose.matchAll(/\bt\('([a-zA-Z.]+)'/g), match => match[1]),
            ...Array.from(sources.propose.matchAll(/counted\('([a-zA-Z]+)'/g), match => `propose.${match[1]}.other`)
        ];
        const staticKeys = Array.from(html.matchAll(/data-i18n-key="schellingPlan\.([a-zA-Z.]+)"/g), match => match[1]);
        expect(layerKeys.length).toBeGreaterThan(10);
        expect(proposeKeys.length).toBeGreaterThan(10);
        expect(staticKeys.length).toBeGreaterThan(5);
        [...layerKeys, ...proposeKeys, ...staticKeys].forEach(key => expect(available.has(key), key).toBe(true));
    });

    it('keeps Layers to the switch and the settings in the plan\'s own panel', () => {
        const layers = html.slice(html.indexOf('data-section="schelling-plan"'), html.indexOf('<!-- Parcel blocks: the layer toggles'));
        const panelStart = html.indexOf('<section id="schelling-panel"');
        const panel = html.slice(panelStart, html.indexOf('</section>', panelStart));
        expect(layers).toContain('id="showSchellingPlan"');
        for (const id of ['schelling-plan-type', 'schelling-plan-block', 'schelling-plan-street', 'schelling-plan-plots', 'schelling-plan-propose', 'schelling-panel-collapse', 'schelling-panel-close',
            'schelling-plan-man-here', 'schelling-plan-esplanade', 'schelling-plan-rings', 'schelling-plan-depth', 'schelling-plan-man-street', 'schelling-plan-bearing']) {
            expect(panel, id).toContain(`id="${id}"`);
            expect(layers, id).not.toContain(`id="${id}"`);
        }
        // The host carries the map-mode rule (MapShell un-hides what it marks), so the panel's own
        // hidden state stays the plan's: it starts hidden.
        expect(html).toMatch(/<div class="schelling-panel-host" data-map-modes="2d">\s*<section id="schelling-panel"[^>]* hidden>/);
        expect(panel).not.toContain('data-map-modes');
    });

    it('offers both plan types, the meridian plan first and shown, each with its own settings', () => {
        const panelStart = html.indexOf('<section id="schelling-panel"');
        const panel = html.slice(panelStart, html.indexOf('</section>', panelStart));
        const picker = panel.slice(panel.indexOf('<select id="schelling-plan-type">'), panel.indexOf('</select>', panel.indexOf('id="schelling-plan-type"')));
        expect(Array.from(picker.matchAll(/<option value="([^"]+)"/g), match => match[1])).toEqual(['meridians', 'burning-man']);
        expect(panel).toMatch(/<div id="schelling-plan-meridians" class="schelling-plan-settings__group">/);
        expect(panel).toMatch(/<div id="schelling-plan-burning-man" class="schelling-plan-settings__group" hidden>/);
        // The type's own settings sit in its group (closed at its own indentation); the plot size is shared.
        const group = id => {
            const start = panel.indexOf(`<div id="${id}"`);
            const indent = panel.slice(panel.lastIndexOf('\n', start) + 1, start);
            return panel.slice(start, panel.indexOf(`\n${indent}</div>`, start));
        };
        expect(group('schelling-plan-meridians')).toContain('id="schelling-plan-block"');
        expect(group('schelling-plan-meridians')).not.toContain('id="schelling-plan-esplanade"');
        expect(group('schelling-plan-burning-man')).toContain('id="schelling-plan-esplanade"');
        expect(group('schelling-plan-burning-man')).not.toContain('id="schelling-plan-plots"');
    });

    it('loads its modules in the page bundle and its stylesheet, and starts after the map', () => {
        for (const file of ['schelling-settings', 'schelling-streets', 'burning-man-plan', 'schelling-layer', 'schelling-propose']) {
            expect(html).toContain(`'js/schelling/${file}.js'`);
        }
        expect(html).toContain("'css/schelling-plan.css'");
        expect(html.indexOf('window.SchellingLayer.initialize();')).toBeGreaterThan(html.indexOf('initializeMapCore();'));
    });
});
