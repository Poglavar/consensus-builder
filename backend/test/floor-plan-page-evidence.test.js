import { describe, expect, it } from 'vitest';
import { extractPageEvidence, normalizeUrl } from '../floor-plans/page-evidence.js';

describe('retention audit evidence', () => {
    it('keeps an opaque translated property route subject to the address gate', () => {
        const url='https://www.top-shop.hr/immobile/appartamento/94000-affitto-appartamento';
        const page=extractPageEvidence('<main><h1>Apartment</h1><p>Zagreb</p></main>',url,{discovery:false});
        expect(page.listing).toMatchObject({sourceId:null,address:null});
        expect(extractPageEvidence('<main><h1>Search</h1></main>',
            'https://www.top-shop.hr/ricerca/appartamento/94000',{discovery:false}).listing).toBeNull();
    });
    it('omits generic discovery while preserving object detection and owned assets', () => {
        const generic = '<main><h1>Directory</h1><a href="/project/one">Project</a><img src="/office.jpg"></main>';
        expect(extractPageEvidence(generic, 'https://studio.test/').links).toHaveLength(1);
        expect(extractPageEvidence(generic, 'https://studio.test/', { discovery: false }))
            .toMatchObject({ listing: null, links: [], assets: [] });
        const project = '<main><h1>Building</h1><dl><dt>Location</dt><dd>Ilica 12, Zagreb</dd></dl><img src="/plan.jpg"><a href="/project/other">Other</a></main>';
        const url = 'https://studio.test/project/one';
        const full = extractPageEvidence(project, url, { sourceKind: 'architecture' });
        const audit = extractPageEvidence(project, url, { sourceKind: 'architecture', discovery: false });
        expect(audit.listing).toEqual(full.listing);
        expect(audit.assets).toEqual(full.assets);
        expect(audit.links).toEqual([]);
        const incomplete = extractPageEvidence('<main><h1>Building</h1></main>', url,
            { sourceKind: 'architecture', discovery: false });
        expect(incomplete.listing.sourceType).toBe('architecture-project');
        expect(incomplete.listing.address).toBeNull();
    });
});

describe('property-detail page links', () => {
    it('keeps a “Tlocrt” unit-detail link as a page and reserves plan assets for actual file endpoints', () => {
        const pageUrl='https://eurovilla.hr/projekt/zagreb-kuniscak-residence/945/';
        const childUrl='https://eurovilla.hr/nekretnina/zagreb-kuniscak-stan-001/144012/';
        const page=extractPageEvidence(`<script type="application/ld+json">{"@type":"Residence","name":"Kuniščak Residence - stambena novogradnja","address":{"streetAddress":"Kuniščak 14, Zagreb"}}</script>
            <main><table id="property-project-items-table"><tr><td><a href="/nekretnina/zagreb-kuniscak-stan-001/144012/">Tlocrt</a></td></tr></table>
            <a href="/files/stan-001-tlocrt.pdf">Tlocrt PDF</a></main>`,pageUrl);

        expect(page.projectListings).toEqual([{url:childUrl}]);
        expect(page.links).toContainEqual(expect.objectContaining({url:childUrl,kind:'listing'}));
        expect(page.assets.map(asset=>asset.url)).not.toContain(childUrl);
        expect(page.assets).toContainEqual(expect.objectContaining({
            url:'https://eurovilla.hr/files/stan-001-tlocrt.pdf',kind:'floor-plan',listingOwned:true,
        }));
    });
});

describe('architecture project evidence', () => {
    const url = 'https://3lhd.com/en/project/campus-infobip/';
    it('creates a project listing from an own detail page and owns only main assets', () => {
        const html = `<header><img src="/logo.jpg"></header><main><section class="section-project-title"><h1>Campus Infobip</h1><h2>Zagreb</h2><div><div>Address</div><div>Utinjska street 29A, Klara</div><div>City</div><div>Zagreb</div></div></section><img src="/files/photo.jpg"><a href="/files/plan.pdf">Plan</a><div class="related"><a href="/en/project/other"><img src="/files/other.jpg"></a></div></main><footer><img src="/office.jpg"></footer>`;
        const page = extractPageEvidence(html, url, { sourceKind: 'architecture' });
        expect(page.listing).toMatchObject({ sourceType: 'architecture-project', title: 'Campus Infobip',
            address: 'Utinjska 29A', locality: 'Zagreb', projectUrl: url });
        expect(page.assets.find(asset => asset.url.endsWith('/files/photo.jpg'))).toMatchObject({ listingOwned: true });
        expect(page.assets.find(asset => asset.url.endsWith('/files/plan.pdf'))).toMatchObject({ listingOwned: true });
        expect(page.assets.find(asset => asset.url.endsWith('/files/other.jpg'))).toMatchObject({ listingOwned: false });
        expect(page.assets.find(asset => asset.url.endsWith('/office.jpg'))).toMatchObject({ listingOwned: false });
    });
    it('keeps an addressless project page but rejects a catalog page', () => {
        expect(extractPageEvidence('<main><h1>River House</h1><img src="/files/a.jpg"></main>',
            'https://studio.test/projects/river-house', { sourceKind: 'architecture' }).listing)
            .toMatchObject({ sourceType: 'architecture-project', address: null });
        expect(extractPageEvidence('<main><h1>Projects</h1><img src="/files/a.jpg"></main>',
            'https://studio.test/projects', { sourceKind: 'architecture' }).listing).toBeNull();
    });
    it('uses only the project heading fallback for locality, never a studio office address', () => {
        const page = extractPageEvidence('<main><section class="section-project-title"><h1>River House</h1><h2>Split</h2></section><div class="contact"><p>City</p><p>Zagreb</p></div></main><footer>Office: Zagreb</footer>',
            'https://studio.test/projects/river-house', { sourceKind: 'architecture' });
        expect(page.listing.locality).toBe('Split');
        const unknown = extractPageEvidence('<main><h1>River House</h1></main><footer>City: Zagreb</footer>',
            'https://studio.test/projects/river-house', { sourceKind: 'architecture' });
        expect(unknown.listing.locality).toBeNull();
    });
    it('recognizes real studio detail routes while leaving ambiguous and addressless projects unresolved', () => {
        const radionica = 'https://www.radionica-arhitekture.hr/project/38/preradovi%C4%87eva-11-%2F-zagreb-%2F-2015.';
        const html = '<title>38, PRERADOVIĆEVA 11 / Zagreb / 2015.</title><main id="PAGES_CONTAINER"><div class="wixui-rich-text"><p>PRERADOVIĆEVA 11 / Zagreb / 2015.</p></div><div class="wixui-rich-text"><p>Preradovićeva Street 11<br/>Location: Zagreb, Croatia<br/>Type: Competition / 2nd prize</p></div><img src="/project-photo.jpg"></main><footer>Office: Črnomerec 135</footer>';
        const project = extractPageEvidence(html, radionica, { sourceKind: 'architecture' });
        expect(project.listing).toMatchObject({ sourceType: 'architecture-project', address: 'Preradovićeva 11', locality: 'Zagreb',
            projectStatus: {value:'Competition / 2nd prize',quote:'Type: Competition / 2nd prize'} });
        expect(project.assets.find(asset => asset.url.endsWith('/project-photo.jpg'))).toMatchObject({ listingOwned: true });
        const croatian = extractPageEvidence('<main id="PAGES_CONTAINER"><p>Preradovićeva 11<br/>Mjesto: Zagreb<br/>Vrsta: natječaj / 2. nagrada</p></main>',
            'https://www.radionica-arhitekture.hr/projekt/38/preradovi%C4%87eva-11-%2F-zagreb-%2F-2015.',{sourceKind:'architecture'});
        expect(croatian.listing).toMatchObject({address:'Preradovićeva 11',locality:'Zagreb',
            projectStatus:{value:'natječaj / 2. nagrada'}});

        const njiric = 'https://www.njiric.com/work/all-projects/078-rural-mat-markusevac-zagreb/26';
        expect(extractPageEvidence('<title>Rural Mat</title><main><p>Rural Mat, Markuševec</p></main>', njiric,
            { sourceKind: 'architecture' }).listing).toMatchObject({ sourceType: 'architecture-project', address: null });

        const sza = 'https://sza.hr/project_variable.php?id=195';
        const szaHtml = '<title>SZA</title><div class="node node-project"><h1 class="title gutter">Residential and Office Building in Voćarska street</h1><p>The new construction includes two site plots, with street numbers 3 and 5.</p><p>Address: Zagreb</p></div>';
        expect(extractPageEvidence(szaHtml, sza, { sourceKind: 'architecture' }).listing)
            .toMatchObject({ sourceType: 'architecture-project', title: 'Residential and Office Building in Voćarska street', address: null });
        expect(extractPageEvidence('<main><h1>Projects</h1></main>', 'https://www.njiric.com/work/all-projects',
            { sourceKind: 'architecture' }).listing).toBeNull();
        expect(extractPageEvidence('<main id="PAGES_CONTAINER"><p>Project text without a heading or address</p></main>',
            'https://studio.test/projects/untitled-house', { sourceKind: 'architecture' }).listing)
            .toMatchObject({ sourceType: 'architecture-project', address: null });
    });
    it('records only stated project status from project fact fields',()=>{
        const completed = extractPageEvidence('<main><section class="section-project-title"><h1>Campus Infobip</h1></section><section class="project-data"><div><p>status</p><p>completed</p></div></section></main>',
            url,{sourceKind:'architecture'});
        expect(completed.listing.projectStatus).toMatchObject({value:'completed',basis:'project-status-field'});
        const planned = extractPageEvidence('<div class="project-details"><ul class="project-details-list"><li><h3>Status</h3><p>Project</p></li></ul></div>',
            'https://send-arch.com/en/projects/residential-building-preradoviceva-11-zagreb/',{sourceKind:'architecture'});
        expect(planned.listing.projectStatus).toMatchObject({value:'Project',basis:'project-status-field'});
    });
    it('discovers only source-scripted Njirić fragments and parses their own project body', () => {
        const index = `<script>$(object).load("/Handlers/Project.ashx?id=" + link + "&ticks=" + ticks)</script>
            <a class="projectlink" name="p143" href="">144 Market Place</a><a class="projectlink" name="bogus" href="">Other</a>`;
        const indexUrl = 'https://www.njiric.com/work/all-projects';
        const discovered = extractPageEvidence(index, indexUrl, {sourceKind:'architecture'});
        expect(discovered.links.filter(link=>link.kind==='project').map(link=>link.url))
            .toEqual(['https://www.njiric.com/Handlers/Project.ashx?id=p143']);
        expect(extractPageEvidence(index.replace('Project.ashx', 'Unknown.ashx'), indexUrl,
            {sourceKind:'architecture'}).links.filter(link=>link.kind==='project')).toEqual([]);
        const fragment = `<div class="tekst" id="project_143_divSadrzajZaSkrivanje"><div id="project_143_tdTekst">
            <div class="navigacija"><a class="projectlinkclose" name="p143">144 Market Place Zadar, 2016.</a></div>
            Project credits:<br>location: Zadar, Zlatarska ulica<br>competition 1st PRIZE</div>
            <div class="project_details"><img src="/Projects/143/images/photo.jpg"></div></div>`;
        const page = extractPageEvidence(fragment, 'https://www.njiric.com/Handlers/Project.ashx?id=p143', {sourceKind:'architecture'});
        expect(page.listing).toMatchObject({sourceType:'architecture-project',title:'144 Market Place Zadar, 2016.',address:null});
        expect(page.assets.find(asset=>asset.url.endsWith('/photo.jpg'))).toMatchObject({listingOwned:true});
        const missingTitle = extractPageEvidence('<div class="tekst"><p>location: Zadar, Zlatarska ulica 5</p></div>',
            'https://www.njiric.com/Handlers/Project.ashx?id=p143', {sourceKind:'architecture'});
        expect(missingTitle.listing).toMatchObject({sourceType:'architecture-project',address:null});
        const mismatchedTitle = extractPageEvidence(fragment.replace('name="p143"','name="p142"'),
            'https://www.njiric.com/Handlers/Project.ashx?id=p143', {sourceKind:'architecture'});
        expect(mismatchedTitle.listing).toMatchObject({sourceType:'architecture-project',address:null});
    });
    it('classifies verified newer studio detail routes without treating indexes and company pages as projects', () => {
        const cases = [
            ['https://hiperprostor.hr/projekti/obnova-palace-greinerwaronig/29/', '<main><h1>Obnova palače Greiner–Waronig</h1><p>Lokacija Zagreb</p></main>'],
            ['https://ivaarch.hr/hrvatski/obiteljska-kuca-na-horvatovcu-zagreb_9/', '<main><h1>Obiteljska kuća na Horvatovcu</h1></main>'],
            ['https://unifika.hr/hrvatski/upu-bosanka_10/', '<main><h1>UPU Bosanka</h1></main>'],
            ['https://gin.hr/projektiranje-stambeno-poslovne-zgrade/', '<h1>Projektiranje stambeno poslovne zgrade</h1>'],
            ['https://gin.hr/projektiranje-savjetovanje-i-projektantski-nadzor/', '<h1>Projektiranje, savjetovanje i projektantski nadzor</h1>'],
            ['https://atmosfera.hr/projekti/ab-61/', '<main class="single-project-main"><p>AB61, Havišće</p></main>'],
            ['https://sangrad-avp.com/projects/americka-medunarodna-skola-u-zagrebu/', '<h1 class="project-title">ODGOJNO-OBRAZOVNI KOMPLEKS SREDIŠĆE</h1>'],
        ];
        for (const [url,html] of cases) expect(extractPageEvidence(html,url,{sourceKind:'architecture'}).listing)
            .toMatchObject({sourceType:'architecture-project',address:null});
        const interkonzalting = '<main><h1 class="page-title">City Island</h1><div class="project-section-content"><p><strong>Projekt:</strong> Izgradnja poslovnih zgrada - CITY ISLAND</p><p><strong>Lokacije:</strong> Buzin (Zagreb), Hrvatska</p></div></main>';
        expect(extractPageEvidence(interkonzalting,'https://www.interkonzalting.hr/city-island',{sourceKind:'architecture'}).listing)
            .toMatchObject({sourceType:'architecture-project',address:null});
        for (const [url,html] of [
            ['https://www.interkonzalting.hr/usluge','<main><h1>Usluge</h1><div class="project-section-content"><strong>1. PROJEKTIRANJE</strong></div></main>'],
            ['https://gin.hr/studio-a/','<h1>STUDIO A</h1><p>Tuškanova 41, 10000 Zagreb</p>'],
            ['https://ivaarch.hr/english/architecture_3/index','<main><h1>Architecture</h1></main>'],
            ['https://unifika.hr/hrvatski/prostorno-uredjenje_3/index','<main><h1>Prostorno uređenje</h1></main>'],
            ['https://ivaarch.hr/hrvatski/kontakt_4/','<main><h1>Kontakt</h1><p>Ulica grada Vukovara 43</p></main>'],
            ['https://ivaarch.hr/english/contact_4/','<main><h1>Contact</h1><p>Office: Ilica 12</p></main>'],
            ['https://ivaarch.hr/english/architecture_3/','<main><h1>Architecture</h1></main>'],
        ]) expect(extractPageEvidence(html,url,{sourceKind:'architecture'}).listing).toBeNull();
        const unifikaIndex = extractPageEvidence('<main><h1>Prostorno uređenje</h1><a href="/hrvatski/upu-bosanka_10/">UPU Bosanka</a></main>',
            'https://unifika.hr/hrvatski/prostorno-uredjenje_3/',{sourceKind:'architecture'});
        expect(unifikaIndex.listing).toBeNull();
        expect(unifikaIndex.links).toContainEqual({url:'https://unifika.hr/hrvatski/upu-bosanka_10/',text:'UPU Bosanka',kind:'other'});
    });
});

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
    it('reads explicit Opereta property facts and owns only the main data-slot carousel', () => {
        const url = 'https://www.opereta.hr/de/immobilie/wohnung/117038-miete-wohnung';
        const html = `<link rel="canonical" href="${url}">
          <script type="application/ld+json">{"@type":"RealEstateListing","url":"${url}","name":"Main apartment"}</script>
          <main><div data-slot="carousel"><div class="carousel-item"><img src="/main-1.jpg"></div><img src="/main-2.jpg"></div>
            <h1>Main apartment</h1><p>Varšavska</p><p>ID I34135</p>
            <div><div><p>Etage</p></div><p>1/3</p></div>
            <div><div><p>Größe</p></div><p>102 m2</p></div>
            <div class="recommendation"><div data-slot="carousel"><div class="carousel-item"><img src="/other.jpg"></div>
              <div class="carousel-item"><img src="/tlocrt-other.jpg" alt="Tlocrt"></div></div></div>
            <div class="agent-profile"><img src="/agent.jpg"></div></main><footer><img src="/logo.jpg"></footer>`;
        const result = extractPageEvidence(html, url);
        expect(result.listing).toMatchObject({ sourceId: 'I34135', address: 'Varšavska', floor: '1/3', areaM2: 102 });
        expect(result.listing).toMatchObject({ coordinates: null, unitId: null, projectName: null });
        expect(result.assets.filter(asset => asset.listingOwned).map(asset => asset.url))
            .toEqual([`${new URL('/main-1.jpg', url)}`, `${new URL('/main-2.jpg', url)}`]);
        expect(result.assets.find(asset => asset.url.endsWith('/other.jpg'))).toMatchObject({ listingOwned: false });
        expect(result.assets.find(asset => asset.url.endsWith('/other.jpg'))).not.toHaveProperty('listingGallery');
        expect(result.assets.find(asset => asset.url.endsWith('/tlocrt-other.jpg'))).toMatchObject({ kind: 'floor-plan', listingOwned: false });
        expect(result.assets.find(asset => asset.url.endsWith('/tlocrt-other.jpg'))).not.toHaveProperty('listingGallery');
        expect(result.assets.find(asset => asset.url.endsWith('/agent.jpg')).listingOwned).toBe(false);
        expect(result.assets.find(asset => asset.url.endsWith('/logo.jpg')).listingOwned).toBe(false);
        const nonOpereta = extractPageEvidence(html.replaceAll('opereta.hr', 'other.hr'), url.replace('opereta.hr', 'other.hr'));
        expect(nonOpereta.listing).toMatchObject({ sourceId: null, address: null, floor: null, areaM2: null });
    });

    it('recognizes a German Grundriss label on a listing image without a plan URL hint', () => {
        const url = 'https://www.opereta.hr/de/immobilie/wohnung/123';
        const html = `<script type="application/ld+json">{"@type":"RealEstateListing","url":"${url}"}</script>
          <main><div data-slot="carousel"><img src="/media/photo-123.jpg" alt="Grundriss"></div></main>`;
        const asset = extractPageEvidence(html, url).assets.find(item => item.url.endsWith('/media/photo-123.jpg'));
        expect(asset).toMatchObject({ kind: 'floor-plan', listingOwned: true, listingGallery: true });
    });

    it('rejects the archived Eurovilla personal-data statement and brokerage terms outside footer markup', () => {
        const privacyUrl = 'https://static.eurovilla-cdn.com/docs/izjava-o-obradi-osobnih-podataka-eurovilla-2026.pdf';
        const html = `<script type="application/ld+json">{"@type":"Apartment","identifier":"842475"}</script>
          <div class="gallery">
            <a rel="nofollow privacy-policy" href="${privacyUrl}" target="_blank">Izjava o obradi osobnih podataka</a>
            <a href="/docs/opci-uvjeti-poslovanja.pdf">Opći uvjeti poslovanja</a>
            <a href="/docs/ugovor-posredovanju.pdf">Ugovor o posredovanju</a>
          </div>`;
        const result = extractPageEvidence(html, 'https://eurovilla.hr/nekretnina/842475/');

        expect(result.assets.find(asset => asset.url === privacyUrl)).toMatchObject({ kind: 'document', listingOwned: false });
        expect(result.assets.find(asset => asset.url.endsWith('/opci-uvjeti-poslovanja.pdf'))).toMatchObject({ listingOwned: false });
        expect(result.assets.find(asset => asset.url.endsWith('/ugovor-posredovanju.pdf'))).toMatchObject({ listingOwned: false });
    });

    it('keeps legitimate private-apartment floor plans listing-owned', () => {
        const html = `<script type="application/ld+json">{"@type":"Apartment","identifier":"842475"}</script>
          <div class="gallery"><a href="/media/private-apartment-floor-plan.pdf">Private apartment floor plan</a></div>`;
        const result = extractPageEvidence(html, 'https://eurovilla.hr/nekretnina/842475/');

        expect(result.assets.find(asset => asset.url.endsWith('/private-apartment-floor-plan.pdf')))
            .toMatchObject({ kind: 'floor-plan', listingOwned: true });
    });

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

describe('Opereta slug-variant JSON-LD identity', () => {
    const page = (pageUrl, recordUrl) => extractPageEvidence(`<link rel="canonical" href="${pageUrl}">
        <script type="application/ld+json">{"@type":"RealEstateListing","url":"${recordUrl}","name":"JSON-LD listing","identifier":"route-id"}</script>
        <main><h1>Visible listing</h1><p>ID I33275</p></main>`, pageUrl);

    it.each([
        ['German apartment',
            'https://www.opereta.hr/de/immobilie/wohnung/112279-verkauf-wohnung-4-zimmer-varazdinska-zupanija-varazdin',
            'https://www.opereta.hr/de/immobilie/wohnung/112279-verkauf-wohnung-4-zimmer-varazdinska-zupanija'],
        ['German house',
            'https://www.opereta.hr/de/immobilie/haus/113514-verkauf-haus-einzelhaus',
            'https://www.opereta.hr/de/immobilie/haus/113514-verkauf-haus-einzelhaus-varazdinska-zupanija-ivanecka-zeljeznica'],
        ['Croatian apartment',
            'https://opereta.hr/nekretnina/stan/22132-prodaja-stan-varazdin',
            'https://www.opereta.hr/nekretnina/stan/22132-prodaja-stan'],
    ])('matches same-property %s slugs while keeping the public I-number as sourceId', (_label, pageUrl, recordUrl) => {
        expect(page(pageUrl, recordUrl).listing).toMatchObject({ title: 'JSON-LD listing', sourceId: 'I33275' });
    });

    it.each([
        ['different Opereta property ID', 'https://www.opereta.hr/de/immobilie/wohnung/112280-similar-recommendation'],
        ['same ID on another host', 'https://other.hr/de/immobilie/wohnung/112279-same-id'],
        ['same ID on a non-property route', 'https://www.opereta.hr/de/suche/wohnung/112279-same-id'],
        ['German prefix with the Croatian route', 'https://www.opereta.hr/de/nekretnina/wohnung/112279-same-id'],
        ['bare immobilie route', 'https://www.opereta.hr/immobilie/wohnung/112279-same-id'],
    ])('does not attach JSON-LD from %s', (_label, recordUrl) => {
        const result = page('https://www.opereta.hr/de/immobilie/wohnung/112279-page-slug', recordUrl);
        expect(result.listing?.title).not.toBe('JSON-LD listing');
        expect(result.listing?.sourceId).not.toBe('route-id');
    });
});
