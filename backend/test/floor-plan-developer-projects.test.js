import { describe, expect, it } from 'vitest';
import { extractPageEvidence } from '../floor-plans/page-evidence.js';
import { qualifyPageEvidence, listingQualifies, removeDeveloperProjectTitleNumbers } from '../floor-plans/source-policy.js';

describe('verified developer project pages', () => {
    it('recognizes an evidenced project leaf and owns only assets inside its project root', () => {
        const html = `<header><p>Office: Ilica 10, Zagreb</p></header><main><h1>Comfor H</h1>
          <p>Adresa: Branimirova 123, Zagreb</p><img src="/floor-plan.jpg" alt="Tlocrt stana"></main>
          <footer><p>Office: Ilica 10, Zagreb</p><img src="/footer.jpg"></footer>`;
        const url = 'https://www.bhb.hr/objekti/comfor-h/';
        const evidence = qualifyPageEvidence(html, url, extractPageEvidence(html, url));
        expect(evidence.listing).toMatchObject({ sourceType: 'developer-project', title: 'Comfor H' });
        expect(evidence.listing.explicitLocation?.address).toMatch(/Branimirova 123/);
        expect(listingQualifies(evidence.listing)).toBe(true);
        expect(evidence.assets.find(asset => asset.url.endsWith('/floor-plan.jpg'))).toMatchObject({ listingOwned: true });
        expect(evidence.assets.find(asset => asset.url.endsWith('/footer.jpg'))).toMatchObject({ listingOwned: false });
    });

    it('does not promote a developer index or borrow the office address from chrome', () => {
        const index = '<main><h1>Projects</h1><p>Our developments</p></main><footer>Office: Ilica 10, Zagreb</footer>';
        expect(extractPageEvidence(index, 'https://kso-gradnja.hr/').listing).toBeNull();
        expect(extractPageEvidence(index, 'https://imag.hr/en/investments/').listing).toBeNull();
        const html = '<article><main id="content"><h1>Project Brezovička 2</h1><p>New apartments</p></main></article><footer>Office: Ilica 10, Zagreb</footer>';
        const url = 'https://kso-gradnja.hr/projekt-brezovicka-2/';
        const evidence = qualifyPageEvidence(html, url, extractPageEvidence(html, url));
        expect(evidence.listing?.sourceType).toBe('developer-project');
        expect(evidence.listing.explicitLocation).toBeNull();
        expect(listingQualifies(evidence.listing)).toBe(false);
    });

    it('does not treat an unseeded unit or unrelated path on a verified developer host as a project', () => {
        expect(extractPageEvidence('<main><h1>Apartment</h1></main>', 'https://pionir.hr/prodaja-nekretnina/savica/stan-12/').listing).toBeNull();
        expect(extractPageEvidence('<main><h1>Savica</h1></main>', 'https://pionir.hr/prodaja-nekretnina/savica/').listing).toBeNull();
    });

    it('keeps hidden project popups out of both property facts and owned assets', () => {
        const html = `<article><main><h1>Projekt Brezovička 2</h1><p>Adresa projekta: Brezovička 2, Zagreb</p>
          <div role="dialog" aria-hidden="true"><p>Broj soba: 4</p><img src="/other-project-plan.jpg" alt="Tlocrt"></div>
          <img src="/project-photo.jpg"></main></article>`;
        const url = 'https://kso-gradnja.hr/projekt-brezovicka-2/';
        const evidence = extractPageEvidence(html, url);
        expect(evidence.listing.propertyDetails.propertyType).not.toBe('apartment');
        expect(evidence.listing.propertyDetails.roomCount).toBeNull();
        expect(evidence.assets.find(asset => asset.url.endsWith('/other-project-plan.jpg'))).toMatchObject({ listingOwned: false });
    });

    it('uses project page title when a VMD gallery heading is generic', () => {
        const html = '<main id="tm-main"><div class="uk-width-4-5@m"><h1>Fotogalerija</h1></div></main><title>Projekt Park Kneževa</title>';
        const evidence = extractPageEvidence(html, 'https://vmdgrupa.hr/poslovni-prostori/projekt-park-knezeva');
        expect(evidence.listing.title).toBe('Projekt Park Kneževa');
    });

    it('does not borrow another VMD project address from its in-main side navigation', () => {
        const html = `<main id="tm-main"><section class="uk-section-default"><div class="uk-container"><div class="uk-grid">
          <div class="uk-width-1-5@m"><div class="sticky-section"><p>Adresa: Oreškovićeva 6N, Zagreb</p><a href="/poslovni-prostori/projekt-zaprudski-otok-oreskoviceva-6n">Projekt Zaprudski Otok</a></div></div>
          <div class="uk-width-4-5@m"><h2>Projekt Park Kneževa</h2><p>Stambeno-poslovni projekt u Zagrebu.</p></div>
        </div></div></section></main><title>Projekt Park Kneževa</title>`;
        const url = 'https://vmdgrupa.hr/poslovni-prostori/projekt-park-knezeva';
        const evidence = qualifyPageEvidence(html, url, extractPageEvidence(html, url));
        expect(evidence.listing.title).toBe('Projekt Park Kneževa');
        expect(evidence.listing.explicitLocation).toBeNull();
        expect(evidence.listing.locationSignals.addresses).toEqual([]);
        expect(listingQualifies(evidence.listing)).toBe(false);
    });

    it('drops the KSO contact section embedded inside the project article', () => {
        const html = `<article><main><h1>Projekt Brezovička 2</h1><p>O projektu: novi projekt u Zagrebu.</p>
          <section class="elementor-section"><h2>Kontakt</h2><p>Lukoranska 26A, 10020 Zagreb, Hrvatska</p><p>Broj soba: 7</p><form name="Kontakt"></form></section>
        </main></article>`;
        const url = 'https://kso-gradnja.hr/projekt-brezovicka-2/';
        const evidence = qualifyPageEvidence(html, url, extractPageEvidence(html, url));
        expect(evidence.listing.explicitLocation).toBeNull();
        expect(evidence.listing.locationSignals.addresses).toEqual([]);
        expect(evidence.listing.propertyDetails.roomCount).toBeNull();
    });

    it('keeps a number in a project title as a street-only mention, not a house number', () => {
        const result = removeDeveloperProjectTitleNumbers({
            addresses: [{ street: 'Brezovička', number: '2', quote: 'Projekt Brezovička 2', basis: 'title-mention' }],
            streets: [], nearbyStreets: [],
        });
        expect(result.addresses).toEqual([]);
        expect(result.streets).toEqual([{ street: 'Brezovička', quote: 'Projekt Brezovička 2', basis: 'title-mention' }]);
    });
});
