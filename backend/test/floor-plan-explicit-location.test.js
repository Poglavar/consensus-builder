import { describe, expect, it } from 'vitest';
import { extractExplicitLocation, listingIdentity } from '../floor-plans/explicit-location.js';

const url = 'https://www.opereta.hr/de/immobilie/wohnung/117038-miete-wohnung';

describe('explicit listing location', () => {
    it('reads an address in the listing record and preserves the cited words', () => {
        const html = `<script type="application/ld+json">{"@type":"Apartment","url":"https://example.hr/stan/1","address":{"streetAddress":"Ulica 1. odvojak 12"}}</script>`;
        expect(extractExplicitLocation(html, 'https://example.hr/stan/1')).toMatchObject({
            street: 'Ulica 1. odvojak', houseNumber: '12', address: 'Ulica 1. odvojak 12',
            quote: 'Ulica 1. odvojak 12', basis: 'structured-property-address',
        });
    });

    it('reads only the Opereta listing address immediately after the title', () => {
        const html = `<main><h1>Stan u centru</h1><p>Varšavska 12A</p><div class="recommendation"><p>Adresa: Ilica 99</p></div><div class="agent"><p>Adresa: Trg bana Jelačića 1</p></div></main>`;
        expect(extractExplicitLocation(html, url)).toMatchObject({ street: 'Varšavska', houseNumber: '12A', basis: 'opereta-listing-address' });
    });

    it('accepts explicit property text and excludes agency and recommendation addresses', () => {
        const html = `<main><p>Adresa nekretnine: Ilica 12, Zagreb</p><aside>Adresa: Varšavska 3</aside><div class="related"><p>Adresa: Prilaz 8</p></div></main>`;
        expect(extractExplicitLocation(html, 'https://example.hr/stan/2')).toMatchObject({ street: 'Ilica', houseNumber: '12', basis: 'explicit-property-address-text' });
        expect(extractExplicitLocation('<main><div class="agent"><p>Adresa: Ilica 12</p></div><footer>Ulica grada Vukovara 1</footer></main>', 'https://example.hr/stan/2')).toBeNull();
    });

    it('reads project detail fields with city before the street', () => {
        const page = 'https://studio.example/projects/river-house';
        const table = `<main><h1>River House</h1><table><tr><th>Lokacija</th><td>Zagreb, Ilica 15</td></tr></table><div class="contact"><p>Adresa: Varšavska 3</p></div></main>`;
        expect(extractExplicitLocation(table, page)).toMatchObject({
            street: 'Ilica', houseNumber: '15', quote: 'Zagreb, Ilica 15', basis: 'project-location-field',
        });
        const dl = `<article><h1>River House</h1><dl><dt>Adresa građevine</dt><dd>10000 Zagreb, Ulica grada Vukovara 42</dd></dl></article>`;
        expect(extractExplicitLocation(dl, page)).toMatchObject({ street: 'Ulica grada Vukovara', houseNumber: '42' });
        const divs = `<main><section class="section-project-title"><h1>Campus Infobip</h1><div><div>Address</div><div>Utinjska street 29A, Klara</div></div></section></main>`;
        expect(extractExplicitLocation(divs, page)).toMatchObject({ street: 'Utinjska', houseNumber: '29A', quote: 'Utinjska street 29A, Klara' });
        const facts = `<main><section class="project-data"><div><p>Location</p><p>Croatia, Zagreb, 10/1, Ilica street</p></div></section></main>`;
        expect(extractExplicitLocation(facts, page)).toMatchObject({ street: 'Ilica', houseNumber: '10/1', quote: 'Croatia, Zagreb, 10/1, Ilica street' });
    });

    it('finds an explicit address in long project prose but not a studio contact phrase', () => {
        const filler = 'Ovaj projekt obuhvaća stambene prostore. '.repeat(20);
        const page = 'https://studio.example/projekti/river-house';
        expect(extractExplicitLocation(`<main><p>${filler} Projekt se nalazi na adresi Ilica 15. Projekt je dovršen.</p></main>`, page))
            .toMatchObject({ street: 'Ilica', houseNumber: '15', basis: 'explicit-property-address-text' });
        expect(extractExplicitLocation('<main><p>Naš studio nalazi se na adresi Ilica 15.</p></main>', page)).toBeNull();
        expect(extractExplicitLocation('<main><p>Adresa: Ilica 15</p></main>', 'https://studio.example/contact')).toBeNull();
    });

    it('rejects multiple project addresses in one unassigned field and Organization metadata', () => {
        const page = 'https://studio.example/projects/river-house';
        expect(extractExplicitLocation('<main><p>Lokacija: Ilica 15, Varšavska 3</p></main>', page)).toBeNull();
        expect(extractExplicitLocation('<script type="application/ld+json">{"@type":"Organization","address":{"streetAddress":"Ilica 15"}}</script><main><h1>River House</h1></main>', page)).toBeNull();
    });
    it('does not turn proximity to a numbered street address into the property house number', () => {
        const page = 'https://studio.example/projects/river-house';
        for (const relation of ['kod','blizu','pored','pokraj','nasuprot','near','next to','opposite']) {
            expect(extractExplicitLocation(`<main><p>Lokacija: Ulica pape Ivana Pavla II ${relation} 10</p></main>`,page)).toBeNull();
        }
        expect(extractExplicitLocation('<main><p>Lokacija: Ulica pape Ivana Pavla II 10</p></main>',page))
            .toMatchObject({street:'Ulica pape Ivana Pavla II',houseNumber:'10'});
    });
    it('accepts a Hiperprostor building located directly at a numbered street in its own introduction', () => {
        const page = 'https://hiperprostor.hr/projekti/obnova-palace-greinerwaronig/29/';
        const own = '<h1 class="title">Obnova palače Greiner–Waronig</h1><div class="heading left dark no-padd-top"><p>Obnova palače Greiner–Waronig</p><p>Palača Greiner–Waronig, smještena u Jurišićevoj ulici 26 u Zagrebu, jedan je od vrijednih primjera secesijske arhitekture.</p></div>';
        expect(extractExplicitLocation(`${own}<footer>Kušlanova 2/IV</footer>`,page)).toMatchObject({
            street:'Jurišićevoj ulici',houseNumber:'26',quote:'smještena u Jurišićevoj ulici 26',basis:'explicit-building-locative-text',
        });
        expect(extractExplicitLocation(own.replace(' u Jurišićevoj ulici 26',' u Jurišićevoj ulici kod 26'),page)).toBeNull();
        expect(extractExplicitLocation('<div class="heading left dark no-padd-top"><p>Palača, smještena u Jurišićevoj ulici 26 u Zagrebu.</p></div>',page)).toBeNull();
    });

    it.each([
        '<main><h1>Stan</h1><p>Split 3</p></main>',
        '<main><h1>Stan</h1><p>Varšavska</p></main>',
        '<main><p>Adresa: 21000 Split</p></main>',
        '<main><p>Adresa: 3. kat, 72 m2</p></main>',
        '<main><p>Adresa: projekt Avenue V 12</p></main>',
        '<main><div class="similar"><p>Adresa: Ilica 12</p></div></main>',
    ])('rejects non-address or other-property evidence', html => {
        expect(extractExplicitLocation(html, url)).toBeNull();
    });

    it('does not import another JSON-LD property address', () => {
        const html = `<script type="application/ld+json">{"@type":"Apartment","url":"https://example.hr/other","address":{"streetAddress":"Ilica 12"}}</script>`;
        expect(extractExplicitLocation(html, 'https://example.hr/this')).toBeNull();
    });

    it('collapses Opereta language and slug variants but retains unrelated URL identities', () => {
        expect(listingIdentity(url)).toBe(listingIdentity('https://opereta.hr/nekretnina/stan/117038-drugi-naziv?utm_source=test'));
        expect(listingIdentity(url)).not.toBe(listingIdentity('https://opereta.hr/nekretnina/stan/117039'));
        expect(listingIdentity(url)).toBe(listingIdentity('https://www.opereta.hr/en/real-estate/apartment/117038-rent-apartment'));
        expect(listingIdentity(url)).not.toBe(listingIdentity('https://www.opereta.hr/de/suche/wohnung/117038-rent-apartment'));
        expect(listingIdentity('https://www.example.hr/stan/1/?utm_source=test#photos')).toBe('https://example.hr/stan/1');
    });

    it('reads Radionica project heading evidence without borrowing its contact address', () => {
        const project = 'https://www.radionica-arhitekture.hr/project/38/preradovi%C4%87eva-11-%2F-zagreb-%2F-2015.';
        // Text follows the public project's Preradovićeva 11 / Zagreb / 2015 page.
        const html = '<nav>Projects About Contact</nav><main id="PAGES_CONTAINER"><div class="wixui-rich-text"><p class="font_7 wixui-rich-text__text">PRERADOVIĆEVA 11 / Zagreb / 2015.</p></div><div class="wixui-rich-text"><p class="font_8 wixui-rich-text__text">Preradovićeva Street 11<br/>Location: Zagreb, Croatia<br/>Type: Competition / 2nd prize<br/>Author: Radionica arhitekture</p></div></main><footer>Office: Črnomerec 135</footer>';
        expect(extractExplicitLocation(html, project)).toMatchObject({
            street: 'Preradovićeva', houseNumber: '11', quote: 'Preradovićeva Street 11', basis: 'project-fact-block-address',
        });
        expect(extractExplicitLocation('<main id="PAGES_CONTAINER"><p>Preradovićeva 11<br/>Mjesto: Zagreb<br/>Vrsta: natječaj / 2. nagrada</p></main>',
            'https://www.radionica-arhitekture.hr/projekt/38/preradovi%C4%87eva-11-%2F-zagreb-%2F-2015.'))
            .toMatchObject({street:'Preradovićeva',houseNumber:'11',basis:'project-fact-block-address'});
        expect(extractExplicitLocation('<main><p>Zagreb Airport Terminal</p><p>Location: Zagreb, Croatia</p></main><footer>Črnomerec 135</footer>',
            'https://www.radionica-arhitekture.hr/project/21/zagreb-airport-terminal-%2F-zagreb-%2F-2008')).toBeNull();
    });
    it('requires an exact numbered location line in the matching Njirić project fragment', () => {
        const url = 'https://www.njiric.com/Handlers/Project.ashx?id=p143';
        const fragment = location => `<div class="tekst" id="project_143_divSadrzajZaSkrivanje"><div id="project_143_tdTekst">
            <div class="navigacija"><a class="projectlinkclose" name="p143">144 Market Place, 2016.</a></div>
            Project credits:<br>location: ${location}<br>competition 1st PRIZE</div>
            <div class="project_details"><p>Office: Ilica 54</p></div></div>`;
        expect(extractExplicitLocation(fragment('Zadar, Zlatarska ulica'), url)).toBeNull();
        expect(extractExplicitLocation(fragment('Zadar, Zlatarska ulica 5'), url))
            .toMatchObject({street:'Zlatarska ulica',houseNumber:'5',basis:'project-location-field'});
        expect(extractExplicitLocation(fragment('Zadar, Zlatarska ulica 5').replace('name="p143"','name="p142"'),url)).toBeNull();
        expect(extractExplicitLocation(fragment('Zadar, Zlatarska ulica 5'),
            'https://www.njiric.com/Handlers/Project.ashx?id=p142')).toBeNull();
        const addressControl = '<div itemprop="streetAddress">Zlatarska ulica 5</div>';
        expect(extractExplicitLocation(fragment('Zadar').replace('Project credits:',addressControl+'Project credits:')
            .replace('name="p143"','name="p142"'),url)).toBeNull();
        expect(extractExplicitLocation(fragment('Zadar').replace('Project credits:',addressControl+'Project credits:'),url))
            .toMatchObject({street:'Zlatarska ulica',houseNumber:'5',basis:'listing-address-element'});
    });
});
