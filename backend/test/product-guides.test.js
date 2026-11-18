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
// Label chips that are legitimately not dictionary strings. Keep this minimal.
const chipsOutsideDictionary = new Set([
    'Delete / Backspace', // keyboard keys that remove a selected vertex (buildings guides)
    'Enter' // keyboard key that finishes a footpath (park guides)
]);
const clips = ['block', 'row', 'detached', 'freeform', 'readjustment', 'park', 'square', 'lake', 'road', 'track', 'station', 'counterproposal']
    .map(name => `videos/howto/2026-10-26/${name}`);

describe('public product guides', () => {
    it.each(['how-to-use.html', 'kako-koristiti.html'])('%s explains the current proposal lifecycle', (name) => {
        const html = readFrontend(name);

        expect(html).toContain('site-intro-parcels.webp');
        expect(html).toMatch(/saved locally and applied to the map|sprema lokalno i primjenjuje na kartu/);
        expect(html).not.toMatch(/map doesn't change until|karta se ne mijenja dok/);
        expect(html).not.toMatch(/id="drafts"|id="skice"/);
    });

    it('how-to-use.html describes the current design-to-agreement workflow', () => {
        const html = readFrontend('how-to-use.html');
        expect(html).toContain('<span class="ui-label">Actions</span>');
        expect(html).toContain('<span class="ui-label">Park</span>');
        expect(html).toContain('<span class="ui-label">Propose here</span>');
        expect(html).toContain('<span class="ui-label">Manual</span>');
        expect(html).toContain('<span class="ui-label">Selected parcels</span>');
        expect(html).toContain('<span class="ui-label">Done selecting</span>');
        expect(html).not.toContain('<span class="ui-label">Custom site</span>');
        expect(html).toContain('Draw a parcel');
        expect(html).toContain('<span class="ui-label">Lists</span>');
        expect(html).toContain('<span class="ui-label">Plans</span>');
        expect(html).toContain('<span class="ui-label">Add to plan</span>');
        expect(html).toContain('<span class="ui-label">Create plan</span>');
        expect(html).toContain('Creating a plan saves it locally without publishing it.');
        expect(html).toContain('<span class="ui-label">Share plan</span>');
        expect(html).not.toContain('Share entire plan');
        expect(html).toContain('existing links keep their original content.');
        expect(html).toContain('<span class="ui-label">Create agreement</span> from a saved plan.');
        expect(html).toContain('Propose');
        expect(html).toContain('Owners sign decisions for that agreement');
        expect(html).toContain('A community vote is non-binding and counted off-chain');
        expect(html).not.toMatch(/<td>\s*Offer\s*<\/td>|Owner deal|Owner vote|Fork proposal|Propose tab/i);
    });

    it.each([
        ['how-to-use.html', 'workflow', 'videos', 'Draw a parcel'],
        ['kako-koristiti.html', 'tijek', 'videozapisi', 'Nacrtaj česticu']
    ])('%s presents the written steps before the videos', (name, workflow, videos, drawLabel) => {
        const html = readFrontend(name);
        const $ = load(html);
        expect($(`#${workflow}`).text()).toContain(drawLabel);
        expect(html.indexOf(`id="${workflow}"`)).toBeLessThan(html.indexOf(`id="${videos}"`));
    });

    it.each([
        ['how-to-use.html', 'en', 'workflow'],
        ['kako-koristiti.html', 'hr', 'tijek']
    ])('%s uses the current map controls', (name, language, workflow) => {
        const $ = load(readFrontend(name));
        const text = $(`#${workflow}`).text();
        const strings = JSON.parse(readFrontend(`i18n/${language}.json`));
        expect(text).toContain(strings.panel.parcel.selectManually);
        expect(text).toContain(strings.groundMenu.actions.drawSite);
        expect(text).toContain(strings.selectedParcels.actions.done);
        expect(text).toContain(strings.clickStackNavigation.actions);
        expect(text).toContain(strings.parcelMenu.actions.propose);
        expect($.text()).toContain(strings.planCompare.titleDesigns);
    });

    it.each([
        ['how-to-use.html', 'review the selection and choose the tool again', 'Place on selected land'],
        ['kako-koristiti.html', 'pregledaj odabir i ponovno odaberi alat', 'Postavi na odabrano zemljište'],
        ['how-to-use-buildings.html', 'choose Freeform building again', 'Place on selected land'],
        ['kako-koristiti-zgrade.html', 'ponovno odaberi alat Slobodna zgrada', 'Postavi na odabrano zemljište']
    ])('%s explains block review and building placement', (name, blockStep, placement) => {
        const text = load(readFrontend(name)).text();
        expect(text).toContain(blockStep);
        expect(text).toContain(placement);
    });

    it.each([
        ['how-to-use-park-square.html', 'choose the tool again afterwards'],
        ['kako-koristiti-park-trg.html', 'ponovno odaberi alat']
    ])('%s explains that block selection returns to tool choice', (name, step) => {
        expect(load(readFrontend(name)).text()).toContain(step);
    });

    it('links Croatian in-app instructions to the Croatian guide', () => {
        const dictionary = JSON.parse(readFrontend('i18n/hr.json'));
        expect(dictionary.sidebar.info.instructionsParagraph).toContain('href="kako-koristiti.html"');
    });

    it.each(['how-to-use-road.html', 'kako-koristiti-cesta.html'])('%s describes finished roads as local designs', (name) => {
        const html = readFrontend(name);

        expect(html).toMatch(/creates a local design and applies it immediately|stvara lokalni dizajn i odmah ga primjenjuje/);
        expect(html).not.toMatch(/built road is not yet a proposal|Izgrađena cesta još nije prijedlog/);
    });

    it.each([
        ['how-to-use.html', 'workflow'],
        ['kako-koristiti.html', 'tijek']
    ])('%s keeps optional paths outside its three first-park steps', (name, section) => {
        const $ = load(readFrontend(name));
        const guide = $(`#${section}`);
        expect(guide.find('ol.steps > li')).toHaveLength(3);
        expect(guide.find('details summary').text().trim()).toBeTruthy();
        expect(guide.find('ol.steps').text()).not.toMatch(/Draw a parcel|Nacrtaj česticu/);
        expect(guide.text()).not.toMatch(/Start a design|Započni dizajn/);
    });

    it.each([
        ['how-to-use.html', 'Creating a plan saves it locally without publishing it.', 'An execution status or source event is evidence of a recorded state; it does not prove payment, legal registration or physical construction.'],
        ['kako-koristiti.html', 'sprema ga lokalno bez objave.', 'Status izvršenja ili izvorni događaj dokaz je zabilježenog stanja; ne dokazuje plaćanje, pravnu registraciju ni fizičku izgradnju.']
    ])('%s explains immutable plan sharing and execution evidence', (name, sharing, evidence) => {
        const html = readFrontend(name);
        expect(html).toContain(sharing);
        expect(html).toContain(evidence);
        expect(html).toMatch(/saved plan|spremljen\w* plan/i);
    });

    it.each([
        ['how-to-use-views.html', 'The sliders model floor-area value and construction cost at a selected EUR per m² of floor area.', 'not sale prices or amounts paid to owners'],
        ['kako-koristiti-prikazi.html', 'Klizači modeliraju vrijednost i trošak gradnje etažne površine prema odabranoj cijeni u EUR po m² etažne površine.', 'a ne prodajne cijene ni iznosi isplaćeni vlasnicima'],
        ['how-to-use-reparcellization.html', 'Currency is the city’s stated fiat currency, EUR here.', 'Monetary compensation is calculated from each party’s remaining land entitlement and allocated area'],
        ['kako-koristiti-reparcelacija.html', 'Novac se iskazuje u valuti grada, ovdje u EUR.', 'Naknada se računa iz preostalog prava na zemljište i dodijeljene površine']
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

    // Every label chip names a control by its current text, so it must be a string the app's
    // dictionary for that language holds. A renamed or removed control leaves its chip behind and
    // fails here; fix the page rather than allowlisting the old label.
    it.each(guidePages)('%s names only current dictionary labels in its ui-label chips', name => {
        const strings = new Set();
        const collect = value => {
            if (value && typeof value === 'object') return Object.values(value).forEach(collect);
            const text = String(value).trim();
            strings.add(text);
            // Form labels carry a trailing colon and unit ("Building width (m):"); chips name the bare label.
            strings.add(text.replace(/\s*(\([^)]*\))?:$/, ''));
        };
        collect(JSON.parse(readFrontend(`i18n/${name.startsWith('how-to-use') ? 'en' : 'hr'}.json`)));
        const $ = load(readFrontend(name));
        const chips = $('.ui-label').map((_, node) => $(node).text().replace(/\s+/g, ' ').trim()).get();
        expect(chips.length).toBeGreaterThan(0);
        expect(chips.filter(chip => !strings.has(chip) && !chipsOutsideDictionary.has(chip)), name).toEqual([]);
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
