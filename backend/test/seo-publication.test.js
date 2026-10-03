import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../../frontend/${path}`, import.meta.url), 'utf8');

describe('public SEO entry points', () => {
    it('gives the app a descriptive canonical title and search snippet', () => {
        const html = read('index.html');
        expect(html).toMatch(/<html lang="en">/);
        expect(html).toContain('<title>Consensus Builder · Free urban planning software</title>');
        expect(html).toContain('<meta property="og:site_name" content="Consensus Builder">');
        expect(html).toMatch(/<meta name="description" content="[^"]*(real parcels|community zoning)[^"]*"/);
        expect(html).toContain('<link rel="canonical" href="https://urbangametheory.xyz/">');
        expect(html).toContain('href="/urban-planning.html"');
        const description = html.match(/<meta name="description" content="([^"]*)"/);
        expect(description?.[1]).toContain('ArcGIS alternative');
        const visibleDocument = html.slice(html.indexOf('<body'), html.indexOf('</body>'));
        expect(visibleDocument).not.toMatch(/ArcGIS|Esri/i);
    });

    it('publishes a useful, scoped landing page with an app handoff', () => {
        const html = read('urban-planning.html');
        expect(html).toContain('<title>Consensus Builder · Free urban planning software</title>');
        expect(html).toContain('<h1>Consensus Builder: free urban planning software</h1>');
        expect(html).toContain('<meta property="og:site_name" content="Consensus Builder" />');
        expect(html).toMatch(/<meta name="description" content="[^"]*community zoning proposals[^"]*"/);
        expect(html).toContain('focused ArcGIS alternative'); // search description only
        expect(html).toContain('does not create an adopted zoning plan');
        expect(html).toContain('href="/">Explore the urban planning map</a>');
        const visibleDocument = html.slice(html.indexOf('<body'), html.indexOf('</body>'));
        expect(visibleDocument).not.toMatch(/ArcGIS|Esri/i);
        expect(html).toContain('href="css/urban-planning.css"');
        const pageCss = read('css/urban-planning.css');
        expect(pageCss).toContain('body.urban-planning-page .main-content');
        expect(pageCss).toContain('height: auto;');
        expect(pageCss).toContain('aspect-ratio: 2 / 1;');
    });

    it('links the sitemap from robots and lists only existing static pages', () => {
        const robots = read('robots.txt');
        const sitemap = read('sitemap.xml');
        expect(robots).toContain('Sitemap: https://urbangametheory.xyz/sitemap.xml');
        expect(sitemap).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
        expect(sitemap).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
        const paths = [...sitemap.matchAll(/<loc>https:\/\/urbangametheory\.xyz(\/[^<]*)<\/loc>/g)]
            .map(match => match[1]);
        expect(paths).toContain('/urban-planning.html');
        expect(paths.length).toBeGreaterThan(10);
        paths.forEach(path => {
            const target = path === '/' ? 'index.html' : path.slice(1);
            expect(existsSync(new URL(`../../frontend/${target}`, import.meta.url)), `${path} exists`).toBe(true);
        });
        // The existing frontend deploy synchronizes all files under frontend into the static docroot.
        expect(readFileSync(new URL('../../frontend/deploy-frontend.sh', import.meta.url), 'utf8'))
            .toContain('"$REMOTE_REPO/frontend/" "$DOCROOT/"');
    });

    it('keeps the public intro translations aligned across all supported languages', () => {
        ['en', 'hr', 'sr', 'es'].forEach(language => {
            const dictionary = JSON.parse(read(`i18n/${language}.json`));
            expect(dictionary.modal.siteIntro.lead).toBeTruthy();
            expect(dictionary.sidebar.info.aboutParagraph).toContain('/urban-planning.html');
            expect(dictionary.sidebar.header.title).toBe('Consensus Builder');
            expect(dictionary.sidebar.info.aboutParagraph).toMatch(/^<strong>Consensus Builder<\/strong>/);
            expect(dictionary.modal.siteIntro.eyebrow).toMatch(/^Consensus Builder/);
            expect(dictionary.modal.siteIntro.lead).toMatch(/^Consensus Builder/);
            expect(dictionary.modal.welcome.kicker).toMatch(/^Consensus Builder/);
            expect(dictionary.modal.siteIntro.lead).not.toMatch(/ArcGIS|Esri/i);
            expect(dictionary.sidebar.info.aboutParagraph).not.toMatch(/ArcGIS|Esri/i);
        });
    });
});
