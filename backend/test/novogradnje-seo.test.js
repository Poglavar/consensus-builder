// The Novogradnje catalogue page must render complete search and social-preview metadata, with JSON-LD that places it under zagreb.lol.
import { describe, it, expect } from 'vitest';
import { renderPublicPage, structuredData } from '../routes/novogradnje.js';

const meta = (html, key) => html.match(new RegExp(`<meta[^>]*(?:name|property)="${key}"[^>]*content="([^"]*)"`))?.[1];

describe('novogradnje search metadata', () => {
    it('renders Novogradnje branding without the retired notes or parcel explanation', async () => {
        const html = await renderPublicPage({ catalogue: { projects: [] } });
        expect(html).toContain('<a class="brand" href="/novogradnje/" aria-label="Novogradnje — početna"><img class="brand-icon" src="/novogradnje/favicon.svg" alt=""><span>Novogradnje</span></a>');
        expect(html).toContain('<a class="brand" href="https://zagreb.lol/"><span>zagreb.lol</span></a>');
        expect(html).not.toContain('brand-dot');
        expect(html).not.toContain('Prikazujemo samo podatke koji su poznati.');
        expect(html).not.toContain('izgradivost parcele');
        expect(html).not.toContain('Detalji novogradnji u Zagrebu');
    });

    it('renders the catalogue head with robots, share image details and a zagreb.lol breadcrumb', async () => {
        const html = (await renderPublicPage({ catalogue: { projects: [] } })).split('</head>')[0];
        const title = html.match(/<title>([^<]+)<\/title>/)[1];
        expect(title.length).toBeLessThanOrEqual(65);
        expect(title).toMatch(/ \| zagreb\.lol$/);
        expect(meta(html, 'robots')).toBe('index, follow, max-image-preview:large');
        expect(meta(html, 'og:image')).toBe('https://zagreb.lol/novogradnje/og.png');
        for (const key of ['og:image:type', 'og:image:alt', 'twitter:image:alt', 'theme-color', 'og:image:width', 'og:image:height']) expect(meta(html, key), key).toBeTruthy();
        const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
        const page = ld['@graph'].find(node => node['@type'] === 'WebPage');
        expect(page.url).toBe('https://zagreb.lol/novogradnje/');
        expect(page.description).toBe(meta(html, 'description'));
        expect(page.isPartOf.url).toBe('https://zagreb.lol/');
        expect(page.breadcrumb.itemListElement.map(c => c.item)).toEqual(['https://zagreb.lol/', 'https://zagreb.lol/novogradnje/']);
    });

    it('extends the breadcrumb through the project to the apartment on deep pages', () => {
        const project = { name: 'Primjer 12', url: '/novogradnje/zgrade/primjer-12-abc/', address: 'Primjer 12', apartments: [] };
        const apartment = { label: 'Stan A1', url: '/novogradnje/zgrade/primjer-12-abc/stanovi/a1/' };
        const ld = structuredData({ projects: [] }, project, apartment, { name: 'Stan A1 · Primjer 12', description: 'Opis.' });
        const page = ld['@graph'].find(node => node['@type'] === 'WebPage');
        expect(page.url).toBe(`https://zagreb.lol${apartment.url}`);
        expect(page.breadcrumb.itemListElement.map(c => c.position)).toEqual([1, 2, 3, 4]);
        expect(page.breadcrumb.itemListElement.at(-1).item).toBe(`https://zagreb.lol${apartment.url}`);
        expect(ld['@graph'].some(node => node['@type'] === 'Apartment')).toBe(true);
    });
});
