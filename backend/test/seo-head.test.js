// Every page in frontend/sitemap.xml must carry a complete search/social head, and noindex consoles must stay out of it.
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { load } from 'cheerio';

const BASE = 'https://urbangametheory.xyz/';
const frontendPath = new URL('../../frontend/', import.meta.url);
const read = (name) => readFileSync(new URL(name, frontendPath), 'utf8');
const sitemap = load(read('sitemap.xml'), { xml: true });
const urls = sitemap('url > loc').map((_, node) => sitemap(node).text()).get();
const fileOf = (loc) => loc.slice(BASE.length) || 'index.html';

describe('SEO head of sitemap pages', () => {
    it('lists only pages that exist on this host', () => {
        expect(urls.length).toBeGreaterThan(10);
        for (const loc of urls) {
            expect(loc.startsWith(BASE), loc).toBe(true);
            expect(existsSync(new URL(fileOf(loc), frontendPath)), loc).toBe(true);
        }
    });

    it.each(urls)('%s has title, description, canonical, social tags and one h1', (loc) => {
        const $ = load(read(fileOf(loc)));
        const meta = (selector) => $(selector).attr('content');
        const title = $('title').text().trim();
        const description = meta('meta[name="description"]');

        expect($('html').attr('lang')).toMatch(/^(en|hr)$/);
        expect($('title')).toHaveLength(1);
        expect(title.length).toBeGreaterThan(10);
        expect(title.length).toBeLessThanOrEqual(70);
        expect(description.length).toBeGreaterThanOrEqual(70);
        expect(description.length).toBeLessThanOrEqual(170);
        expect($('link[rel="canonical"]').attr('href')).toBe(loc);
        expect(meta('meta[name="robots"]') || '').not.toMatch(/noindex/);
        expect(meta('meta[property="og:url"]')).toBe(loc);
        for (const key of ['og:title', 'og:description', 'og:image', 'og:type']) {
            expect(meta(`meta[property="${key}"]`), key).toBeTruthy();
        }
        expect(meta('meta[property="og:image"]')).toMatch(/^https:\/\//);
        expect(meta('meta[name="twitter:card"]')).toBeTruthy();
        expect($('h1')).toHaveLength(1);
        expect($('img:not([alt])')).toHaveLength(0);
        $('script[type="application/ld+json"]').each((_, node) => {
            expect(() => JSON.parse($(node).text())).not.toThrow();
        });
    });

    it.each(urls.filter(loc => $hreflang(loc).length))('%s has reciprocal absolute hreflang alternates', (loc) => {
        const links = $hreflang(loc);
        const langs = links.map(link => link.lang).sort();
        expect(langs).toEqual(['en', 'hr', 'x-default']);
        for (const { lang, href } of links) {
            expect(href.startsWith(BASE), href).toBe(true);
            if (lang === 'x-default') continue;
            const back = $hreflang(href).map(link => link.href);
            expect(back, `${href} links back`).toContain(loc);
        }
    });

    it.each(['lens.html', 'tx-explorer.html'])('%s is noindex and not in the sitemap', (name) => {
        const $ = load(read(name));
        expect($('meta[name="robots"]').attr('content')).toMatch(/noindex/);
        expect(urls).not.toContain(BASE + name);
    });
});

function $hreflang(loc) {
    const $ = load(read(fileOf(loc)));
    return $('link[rel="alternate"][hreflang]').map((_, node) => ({ lang: $(node).attr('hreflang'), href: $(node).attr('href') })).get();
}
