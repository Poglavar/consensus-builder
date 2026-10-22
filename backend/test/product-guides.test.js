// Check the public guides' proposal lifecycle, bilingual navigation and packaged video walkthroughs.
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';

const frontendPath = fileURLToPath(new URL('../../frontend/', import.meta.url));
const readFrontend = (name) => readFileSync(`${frontendPath}${name}`, 'utf8');
const guidePairs = [
    ['how-to-use.html', 'kako-koristiti.html'],
    ['how-to-use-buildings.html', 'kako-koristiti-zgrade.html'],
    ['how-to-use-park-square.html', 'kako-koristiti-park-trg.html'],
    ['how-to-use-reparcellization.html', 'kako-koristiti-reparcelacija.html'],
    ['how-to-use-road.html', 'kako-koristiti-cesta.html'],
    ['how-to-use-views.html', 'kako-koristiti-prikazi.html']
];
const guidePages = guidePairs.flat();
const clips = ['block', 'row', 'detached', 'freeform', 'readjustment', 'park', 'square', 'lake', 'road', 'track', 'station', 'counterproposal']
    .map(name => `videos/howto/2026-10-19/${name}`);

describe('public product guides', () => {
    it.each(['how-to-use.html', 'kako-koristiti.html'])('%s explains the current proposal lifecycle', (name) => {
        const html = readFrontend(name);

        expect(html).toContain('site-intro-parcels.webp');
        expect(html).toMatch(/Fork proposal|Razgranaj prijedlog/);
        expect(html).toMatch(/local\s+proposal is created and applied|lokalni prijedlog koji je već primijenjen/);
        expect(html).toMatch(/source stays unchanged|Izvor ostaje netaknut/);
        expect(html).not.toMatch(/map doesn't change until|karta se ne mijenja dok/);
        expect(html).not.toMatch(/id="drafts"|id="skice"/);
    });

    it.each(['how-to-use-road.html', 'kako-koristiti-cesta.html'])('%s describes finished roads as proposals', (name) => {
        const html = readFrontend(name);

        expect(html).toMatch(/creates a local proposal and applies it immediately|stvara lokalni prijedlog i odmah ga primjenjuje/);
        expect(html).not.toMatch(/built road is not yet a proposal|Izgrađena cesta još nije prijedlog/);
    });

    it.each([
        ['how-to-use.html', 'Source parcels are provider records; a formed ground piece is a modeled result, not proof of a legal lot or ownership.'],
        ['kako-koristiti.html', 'Izvorne čestice su zapisi pružatelja podataka; oblikovani dio tla modelirani je rezultat, a ne dokaz pravne čestice ili vlasništva.']
    ])('%s distinguishes source evidence from modeled ground', (name, statement) => {
        expect(readFrontend(name)).toContain(statement);
    });

    // Named plans are gone (plan-design-agreement.md, M2): the guides describe the shared
    // composition and no longer contrast it with a named plan.
    it.each([
        ['how-to-use.html', 'The shared composition preserves the applied set and its dependencies.', 'An execution status or source event is evidence of a recorded state; it does not prove payment, legal registration or physical construction.'],
        ['kako-koristiti.html', 'Dijeljena kompozicija čuva skup primijenjenih prijedloga i njihove ovisnosti.', 'Status izvršenja ili izvorni događaj dokaz je zabilježenog stanja; ne dokazuje plaćanje, pravnu registraciju ni fizičku izgradnju.']
    ])('%s distinguishes local sharing and execution evidence', (name, sharing, evidence) => {
        const html = readFrontend(name);
        expect(html).toContain(sharing);
        expect(html).toContain(evidence);
        expect(html).not.toMatch(/named plan|imenovan\w* plan/i);
    });

    it.each([
        ['how-to-use-views.html', 'The slider models floor-area value at a selected EUR per m² of floor area.', 'not sale prices or amounts paid to owners'],
        ['kako-koristiti-prikazi.html', 'Klizač modelira vrijednost etažne površine prema odabranoj cijeni u EUR po m² etažne površine.', 'a ne prodajne cijene ni iznosi isplaćeni vlasnicima'],
        ['how-to-use-reparcellization.html', 'Cash figures in this ledger are EUR.', 'the EUR 100/m² fallback applies only when no source price is present'],
        ['kako-koristiti-reparcelacija.html', 'Novčani iznosi u ovom obračunu iskazani su u EUR.', 'model od 100 EUR/m² koristi se samo kad izvorna cijena ne postoji']
    ])('%s names the basis and limits of money amounts', (name, basis, limit) => {
        const html = readFrontend(name);
        expect(html).toContain(basis);
        expect(html).toContain(limit);
    });

    it('uses capability horizons instead of expired roadmap dates', () => {
        const html = readFrontend('roadmap.html');

        expect(html).toContain('id="now"');
        expect(html).toContain('id="next"');
        expect(html).toContain('id="later"');
        expect(html).not.toMatch(/Oct 2024|Dec 2025|Jun 2026/);
    });

    it.each(guidePages)('%s has working local navigation and packaged assets', name => {
        const $ = load(readFrontend(name));
        const ids = $('[id]').map((_, node) => $(node).attr('id')).get();
        expect(new Set(ids).size).toBe(ids.length);

        $('a[href], link[href], img[src], source[src], track[src], video[poster]').each((_, node) => {
            const element = $(node);
            const href = element.attr('href') || element.attr('src') || element.attr('poster');
            const url = new URL(href, `https://guide.test/${name}`);
            if (url.origin !== 'https://guide.test') return;
            const target = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
            expect(existsSync(resolve(frontendPath, target)), `${name}: ${href}`).toBe(true);
            if (url.hash) {
                const destination = load(readFrontend(target));
                const destinationIds = destination('[id]').map((_, item) => destination(item).attr('id')).get();
                expect(destinationIds, `${name}: ${href}`).toContain(decodeURIComponent(url.hash.slice(1)));
            }
        });
    });

    it.each(guidePairs)('%s and %s cover the same clips in both languages', (en, hr) => {
        const sources = name => load(readFrontend(name))('video source').map((_, node) => node.attribs.src).get();
        expect(sources(en)).toEqual(sources(hr));
    });

    it.each(guidePairs[0])('%s links all twelve clips to their matching walkthrough players', name => {
        const $ = load(readFrontend(name));
        const cards = $('.video-library a.video-card');
        expect(cards).toHaveLength(clips.length);
        cards.each((index, node) => {
            const card = $(node);
            expect(card.find('img').attr('src')).toBe(`${clips[index]}.jpg`);
            const [page, anchor] = card.attr('href').split('#');
            const destination = load(readFrontend(page));
            expect(destination(`#${anchor} video source`).attr('src')).toBe(`${clips[index]}.mp4`);
        });
    });

    it.each(guidePages.filter(name => !guidePairs[0].includes(name)))('%s uses labelled, on-demand video players', name => {
        const $ = load(readFrontend(name));
        expect($('video').length).toBeGreaterThan(0);
        $('video').each((_, node) => {
            const player = $(node);
            expect(player.attr('controls')).toBeDefined();
            expect(player.attr('playsinline')).toBeDefined();
            expect(player.attr('preload')).toBe('none');
            expect(player.attr('autoplay')).toBeUndefined();
            expect(player.attr('aria-label')).toBeTruthy();
            expect($(`#${player.attr('aria-describedby')}`).text().trim()).toBeTruthy();
            expect(player.find('source').attr('type')).toBe('video/mp4');
            expect(player.find('track[kind="captions"]').attr('srclang')).toBe('en');
            expect(player.closest('figure').find('.video-transcript p[lang="en"]').text().trim()).toBeTruthy();
            expect(player.find('a').attr('href')).toBe(player.find('source').attr('src'));
        });
    });

    it('ships every video with its index before media data for streaming playback', () => {
        for (const clip of clips) {
            const buffer = readFileSync(resolve(frontendPath, `${clip}.mp4`));
            const atoms = [];
            for (let offset = 0; offset + 8 <= buffer.length;) {
                const size = buffer.readUInt32BE(offset);
                atoms.push(buffer.toString('ascii', offset + 4, offset + 8));
                const length = size === 1 ? Number(buffer.readBigUInt64BE(offset + 8)) : size;
                if (length === 0) break;
                expect(length).toBeGreaterThanOrEqual(8);
                offset += length;
            }
            expect(atoms).toContain('ftyp');
            expect(atoms).toContain('moov');
            expect(atoms).toContain('mdat');
            expect(atoms.indexOf('moov')).toBeLessThan(atoms.indexOf('mdat'));
            const poster = readFileSync(resolve(frontendPath, `${clip}.jpg`));
            expect(poster.readUInt16BE(0)).toBe(0xffd8);
        }
    });
});
