import { describe, expect, it } from 'vitest';
import { extractPageEvidence, normalizeUrl } from '../floor-plans/page-evidence.js';

describe('floor-plan page evidence', () => {
    it('normalizes only tracking parameters and fragments', () => { expect(normalizeUrl('/stan?id=7&utm_source=x#map', 'https://agency.test/oglasi')).toBe('https://agency.test/stan?id=7'); });
    it('extracts JSON-LD listing data, source links, and plan assets', () => {
        const html = `<title>Stan Avenue V</title><link rel="canonical" href="/stan-7"><script type="application/ld+json">{"@type":"Apartment","name":"Stan Avenue V","identifier":"842475","address":{"streetAddress":"Avenue V 7"},"floorLevel":"3","floorSize":72,"geo":{"latitude":45.8,"longitude":15.95},"isPartOf":{"name":"Avenue V"}}</script><a href="/projekt-avenue-v">Projekt Avenue V</a><img src="/media/tlocrt-3.pdf" alt="Tlocrt stana"><a href="/kontakt">Kontakt</a>`;
        const result = extractPageEvidence(html, 'https://agency.test/oglasi/stan-7');
        expect(result.listing).toMatchObject({ title: 'Stan Avenue V', sourceId: '842475', address: 'Avenue V 7', floor: '3', areaM2: 72, projectName: 'Avenue V', coordinates: { lat: 45.8, lng: 15.95 } });
        expect(result.assets[0]).toMatchObject({ kind: 'floor-plan' }); expect(result.links.map(link => link.kind)).toContain('project'); expect(result.links.map(link => link.kind)).toContain('contact');
    });
    it('does not mistake a footer office address for property location', () => { const result = extractPageEvidence('<h1>Stan bez adrese</h1><footer>Agencija, Ilica 1, Zagreb</footer>', 'https://agency.test/stan'); expect(result.listing).toBeNull(); });
    it('blocks challenge pages and returns no listing', () => { const result = extractPageEvidence('<title>Access denied</title><body>Verify you are human</body>', 'https://agency.test/stan'); expect(result.blocked).toBe(true); expect(result.listing).toBeNull(); });
    it('keeps missing numbers null and distinguishes generic PDFs', () => { const result = extractPageEvidence('<h1>Projekt</h1><a href="/brochure.pdf">Brochure</a>', 'https://agency.test/project'); expect(result.listing).toBeNull(); expect(result.assets[0].kind).toBe('document'); });
    it('extracts the supplied Eurovilla Avenue V evidence without treating challenge scripts as a block', () => {
        const html = `<script type="application/ld+json">{"@type":"Apartment","identifier":"842475","floorLevel":"5","floorSize":{"value":80.58},"geo":{"latitude":45.801079807845,"longitude":15.989073531216}}</script><script src="/cloudflare-recaptcha.js"></script><a href="https://s3.eu-central-1.amazonaws.com/blueprints.eurovilla-cdn.com/842475/A52.jpg">Plan</a>`;
        const result = extractPageEvidence(html, 'https://eurovilla.hr/nekretnina/842475/');
        expect(result.blocked).toBe(false);
        expect(result.listing).toMatchObject({ sourceId: '842475', floor: '5', areaM2: 80.58 });
        expect(result.assets.some(asset => asset.kind === 'floor-plan')).toBe(true);
        expect(result.listing.coordinates).toMatchObject({ lat: 45.801079807845, lng: 15.989073531216 });
    });
});


describe('listing asset ownership', () => {
    it('keeps project-table plans discoverable without assigning them to the main apartment', () => {
        const html = `<link rel="canonical" href="https://eurovilla.hr/en/property/main/577161/">
          <script type="application/ld+json">{"@type":"Product","sku":"577161","url":"https://eurovilla.hr/en/property/main/577161/","name":"Main apartment"}</script>
          <div id="property-view" data-propertyid="577161">
            <div class="swiper"><img src="/property-photos/577161/main.jpg"></div>
            <a class="property-blueprint" data-bp="577161/main.png" onclick="window.open(api+'blueprint/?link='+this.dataset.bp,'_blank','noopener')">Plan</a>
            <table id="property-project-items-table"><tbody><tr>
              <td><a href="/en/property/other/979550/">Other apartment</a></td>
              <td><a href="https://s3.eu-central-1.amazonaws.com/blueprints.eurovilla-cdn.com/979550/plan.png">Plan</a></td>
            </tr></tbody></table>
            <div class="property-small" data-propertyid="123456"><div class="swiper"><img src="/property-photos/123456/other.jpg"></div></div>
          </div>`;
        const result = extractPageEvidence(html, 'https://eurovilla.hr/en/property/main/577161/');
        expect(result.listing.sourceId).toBe('577161');
        expect(result.assets.find(a => a.url.includes('/api/blueprint/'))).toMatchObject({ listingOwned: true, kind: 'floor-plan', ownerSourceId: '577161' });
        expect(result.assets.find(a => a.url.includes('/979550/plan.png'))).toMatchObject({ listingOwned: false, ownerSourceId: '979550', ownerListingUrl: 'https://eurovilla.hr/en/property/other/979550/' });
        expect(result.assets.find(a => a.url.includes('/123456/other.jpg'))).toMatchObject({ listingOwned: false, listingGallery: true });
        expect(result.assets.filter(a => a.listingOwned).map(a => a.url)).toHaveLength(2);
    });

    it('does not turn the first property card on a project or search page into the page listing', () => {
        const result = extractPageEvidence('<h1>Project</h1><div data-propertyid="12"><div class="gallery"><img src="/photos/12.jpg"></div></div>', 'https://agency.test/project');
        expect(result.listing).toBeNull();
        expect(result.assets[0].listingOwned).toBe(false);
    });

    it('rejects another listing JSON-LD record and uses the record for this page', () => {
        const html = `<script type="application/ld+json">[{"@type":"Apartment","identifier":"other","url":"https://agency.test/other"},{"@type":"Apartment","identifier":"main","url":"https://agency.test/main"}]</script><img src="/main-plan.png">`;
        const result = extractPageEvidence(html, 'https://agency.test/main');
        expect(result.listing.sourceId).toBe('main');
        expect(result.assets[0].listingOwned).toBe(true);
    });

    it('keeps unlabeled listing gallery photos and plans while excluding global, regional, agent and legal assets', () => {
        const html = `<script type="application/ld+json">{"@type":"Apartment","identifier":"577161","url":"https://eurovilla.hr/nekretnina/577161/"}</script>
          <div id="property-view" data-propertyid="577161">
            <div class="swiper"><img src="/property-photos/577161/livingroom.jpg"></div>
            <a href="/media/tlocrt-577161.pdf">Plan</a>
            <img src="/regionalphotos/zagreb-office.jpg" alt="">
            <div class="agent-profile"><img src="/media/team/jane-portrait.jpg"></div>
            <a href="/documents/privacy.pdf">Privacy</a>
          </div>
          <footer><img src="/media/agents/office-portrait.jpg"></footer>`;
        const result = extractPageEvidence(html, 'https://eurovilla.hr/nekretnina/577161/');
        const owned = result.assets.filter(asset => asset.listingOwned);
        expect(owned.map(asset => asset.url)).toEqual([
            'https://eurovilla.hr/property-photos/577161/livingroom.jpg',
            'https://eurovilla.hr/media/tlocrt-577161.pdf',
        ]);
        expect(result.assets.find(asset => asset.url.includes('privacy.pdf'))).toMatchObject({ kind: 'document', listingOwned: false });
        expect(result.assets.find(asset => asset.url.includes('regionalphotos'))).toMatchObject({ listingOwned: false });
        expect(result.assets.find(asset => asset.url.includes('jane-portrait'))).toMatchObject({ listingOwned: false });
        expect(result.assets.find(asset => asset.url.includes('office-portrait'))).toMatchObject({ listingOwned: false });
    });
});


it('keeps a Houzez single-property identity and excludes linked recommendation card images', () => {
    const html = `<body class="single single-property postid-22132"><h1>Main apartment</h1><div class="gallery"><img src="/main.png"></div><div class="item-wrap"><a class="listing-featured-thumb" href="/nekretnina/other"><img src="/other.png"></a></div></body>`;
    const result = extractPageEvidence(html,'https://agency.test/nekretnina/main');
    expect(result.listing.sourceId).toBe('22132');
    expect(result.assets.find(a=>a.url.endsWith('/main.png')).listingOwned).toBe(true);
    expect(result.assets.find(a=>a.url.endsWith('/other.png'))).toMatchObject({listingOwned:false,ownerListingUrl:'https://agency.test/nekretnina/other'});
});

it('accepts JSON-LD for the fetched URL when its canonical uses another path', () => {
    const html = `<link rel="canonical" href="https://agency.test/hr/nekretnina/stan/42"><script type="application/ld+json">{"@type":"RealEstateListing","url":"https://agency.test/nekretnina/42","name":"Main apartment"}</script>`;
    const result = extractPageEvidence(html,'http://www.agency.test/nekretnina/42');
    expect(result.listing.title).toBe('Main apartment');
});
