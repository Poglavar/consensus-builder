// The shared header of every page outside the map (docs/design-language.md, "Every non-map page
// carries the same header"; css/page-chrome.css, js/ui/page-header.js): each page loads tokens,
// primitives and page-chrome before its own stylesheet and carries one cb-page-header with the
// product mark, the page title and ONE "Back to the map" link to the map. The five older back-link
// wordings and looks (a boxed sidebar link, "Back to the app", "Return to the map", "Open the map",
// "Consensus Builder ↗") must not come back. The campaign pages keep their own dialect.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { dictionary, testI18n } from './helpers/i18n.js';
import { load } from 'cheerio';
import { FRONTEND } from './helpers/design-audit.mjs';

const root = { i18n: testI18n() };
vm.runInNewContext(readFileSync(new URL('../../frontend/js/ui/page-header.js', import.meta.url), 'utf8'), { window: root });
const PageHeader = root.CbPageHeader;

const EXEMPT = new Set(['index.html', 'deck.html', 'deck2.html', 'deck3.html', 'hackathon-demo.html']);
const pages = readdirSync(FRONTEND).filter(f => f.endsWith('.html') && !EXEMPT.has(f)).sort();
const html = Object.fromEntries(pages.map(p => [p, readFileSync(path.join(FRONTEND, p), 'utf8')]));
const backWords = new Set(['en', 'es', 'hr', 'sr'].map(lang => dictionary(lang).pageHeader.backToMap));
const textOf = value => value.replace(/\s+/g, ' ').trim();

describe('satellite page header', () => {
    it('finds the satellite pages', () => {
        expect(pages.length).toBeGreaterThan(15);
    });

    it.each(pages)('%s loads tokens, primitives and page-chrome before any other stylesheet', (page) => {
        const $ = load(html[page]);
        const sheets = $('link[rel]')
            .filter((_, element) => $(element).attr('rel')?.toLowerCase().split(/\s+/).includes('stylesheet'))
            .map((_, element) => $(element).attr('href')?.split('?')[0])
            .get()
            .filter(Boolean);
        expect(sheets.slice(0, 3)).toEqual(['css/tokens.css', 'css/primitives.css', 'css/page-chrome.css']);
        expect(sheets).not.toContain('index.css');
    });

    it.each(pages)('%s carries one header with the mark, a title and one back link to the map', (page) => {
        const $ = load(html[page]);
        const headers = $('header.cb-page-header');
        expect(headers).toHaveLength(1);
        const header = headers.first();
        const brand = header.find('.cb-page-header__brand');
        expect(brand).toHaveLength(1);
        const logo = brand.find('img.cb-page-header__logo');
        expect(logo).toHaveLength(1);
        const logoPath = logo.attr('src');
        expect(logoPath).toMatch(/^images\/consensus-builder-logo(?:-2)?\.png$/);
        expect(readFileSync(path.join(FRONTEND, logoPath))).toBeTruthy();
        expect(textOf(brand.text())).toBe('Consensus Builder');
        const titles = header.find('.cb-page-header__title');
        expect(titles).toHaveLength(1);
        expect(titles.find('h1, p')).toHaveLength(1);
        const title = titles.find('h1, p').first();
        expect(textOf(title.text()) || title.attr('data-i18n') || '').not.toBe('');
        const backs = header.find('a.cb-link.cb-back-link');
        expect(backs).toHaveLength(1);
        const back = backs.first();
        const href = back.attr('href');
        expect({ page, href }).toEqual({ page, href: expect.stringMatching(/^\/(\?lang=[a-z]{2})?$/) });
        expect(back.find('i.fa-solid.fa-arrow-left[aria-hidden="true"]')).toHaveLength(1);
        expect(backWords.has(textOf(back.text()))).toBe(true);
        expect($('a.cb-back-link')).toHaveLength(1);
    });

    it.each(pages)('%s keeps none of the retired back-link wordings or looks', (page) => {
        const $ = load(html[page]);
        const visible = textOf($('body').text());
        expect(visible).not.toMatch(/Back to the app|Return to the map|Natrag na aplikaciju|Consensus Builder ↗/);
        expect($('[class~="back-link"], [class~="primary-link"], [class~="lang-switch"]')).toHaveLength(0);
    });
});

describe('page-header.js strings', () => {
    it('uses the shared selected dictionary and its English fallback', () => {
        for (const language of ['en', 'es', 'hr', 'sr']) {
            root.i18n = testI18n(language);
            expect(PageHeader.text('backToMap')).toBe(dictionary(language).pageHeader.backToMap);
        }
        root.i18n = testI18n();
        const nodes = [{ getAttribute: () => 'backToMap', textContent: '' }];
        PageHeader.apply({ querySelectorAll: () => nodes });
        expect(nodes[0].textContent).toBe('Back to the map');
        root.i18n = testI18n('hr');
        PageHeader.apply({ querySelectorAll: () => nodes });
        expect(nodes[0].textContent).toBe('Natrag na kartu');
    });
});
