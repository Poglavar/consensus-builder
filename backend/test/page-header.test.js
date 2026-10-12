// The shared header of every page outside the map (docs/design-language.md, "Every non-map page
// carries the same header"; css/page-chrome.css, js/ui/page-header.js): each page loads tokens,
// primitives and page-chrome before its own stylesheet and carries one cb-page-header with the
// product mark, the page title and ONE "Back to the map" link to the map. The five older back-link
// wordings and looks (a boxed sidebar link, "Back to the app", "Return to the map", "Open the map",
// "Consensus Builder ↗") must not come back. The campaign pages keep their own dialect.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FRONTEND } from './helpers/design-audit.mjs';

const require = createRequire(import.meta.url);
const PageHeader = require('../../frontend/js/ui/page-header.js');

const EXEMPT = new Set(['index.html', 'deck.html', 'deck2.html', 'deck3.html', 'hackathon-demo.html']);
const pages = readdirSync(FRONTEND).filter(f => f.endsWith('.html') && !EXEMPT.has(f)).sort();
const html = Object.fromEntries(pages.map(p => [p, readFileSync(path.join(FRONTEND, p), 'utf8')]));
const backWords = new Set(Object.values(PageHeader.STRINGS.backToMap));
const textOf = fragment => fragment.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

describe('satellite page header', () => {
    it('finds the satellite pages', () => {
        expect(pages.length).toBeGreaterThan(15);
    });

    it.each(pages)('%s loads tokens, primitives and page-chrome before any other stylesheet', (page) => {
        const sheets = [...html[page].matchAll(/<link rel="stylesheet" href="([^"?]+)/g)].map(m => m[1]);
        expect(sheets.slice(0, 3)).toEqual(['css/tokens.css', 'css/primitives.css', 'css/page-chrome.css']);
        expect(sheets).not.toContain('index.css');
    });

    it.each(pages)('%s carries one header with the mark, a title and one back link to the map', (page) => {
        const headers = html[page].match(/<header class="cb-page-header">[\s\S]*?<\/header>/g) || [];
        expect(headers).toHaveLength(1);
        const header = headers[0];
        expect(header).toMatch(/class="cb-page-header__brand"><img class="cb-page-header__logo" src="images\/consensus-builder-logo\.png"/);
        expect(textOf(header.match(/<span class="cb-page-header__brand">[\s\S]*?<\/span><\/span>/)[0])).toBe('Consensus Builder');
        expect(header).toMatch(/<div class="cb-page-header__title"><(h1|p)\b/);
        const backs = [...html[page].matchAll(/<a class="cb-link cb-back-link" href="([^"]*)">([\s\S]*?)<\/a>/g)];
        expect(backs).toHaveLength(1);
        const [, href, inner] = backs[0];
        expect({ page, href }).toEqual({ page, href: expect.stringMatching(/^\/(\?lang=[a-z]{2})?$/) });
        expect(inner).toMatch(/^<i class="fa-solid fa-arrow-left" aria-hidden="true"><\/i>/);
        expect(backWords.has(textOf(inner))).toBe(true);
        expect((html[page].match(/cb-back-link/g) || []).length).toBe(1);
    });

    it.each(pages)('%s keeps none of the retired back-link wordings or looks', (page) => {
        const visible = textOf(html[page].slice(html[page].indexOf('<body')));
        expect(visible).not.toMatch(/Back to the app|Return to the map|Natrag na aplikaciju|Consensus Builder ↗/);
        expect(html[page]).not.toMatch(/class="(?:[^"]*\s)?(back-link|primary-link|lang-switch)(?:\s[^"]*)?"/);
    });
});

describe('page-header.js strings', () => {
    it('has "Back to the map" in every UI language and falls back to English', () => {
        expect(['en', 'es', 'hr', 'sr'].map(lang => PageHeader.text('backToMap', lang)))
            .toEqual(['Back to the map', 'Volver al mapa', 'Natrag na kartu', 'Nazad na mapu']);
        expect(PageHeader.text('backToMap', 'de')).toBe('Back to the map');
    });

    it('refuses a key it does not have instead of printing the key', () => {
        expect(() => PageHeader.text('backToTheApp', 'en')).toThrow(/no string "backToTheApp"/);
    });

    it('rewrites every element that names a header string', () => {
        const nodes = [{ getAttribute: () => 'backToMap', textContent: 'Back to the map' }, { getAttribute: () => 'backToMap', textContent: '' }];
        PageHeader.apply('hr', { querySelectorAll: selector => (selector === '[data-page-header-key]' ? nodes : []) });
        expect(nodes.map(node => node.textContent)).toEqual(['Natrag na kartu', 'Natrag na kartu']);
    });
});
