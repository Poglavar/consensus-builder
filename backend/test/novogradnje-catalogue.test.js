import {readPublicCatalogue,readPublicProject} from '../floor-plan-archive/public-catalogue.js';
// Public IDs, alias grouping, metadata, HTTP deep links and actual filter decisions stay testable without a browser.
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { constructionSummary, projectInventory, projectSources } from '../floor-plans/project-inventory.js';
import { publicProject, projectId } from '../floor-plan-archive/public-catalogue.js';
import { setupNovogradnjeRoute as setupSharedNovogradnjeRoute } from '../routes/novogradnje.js';

const setupNovogradnjeRoute=(app,pool)=>setupSharedNovogradnjeRoute(app,pool,{catalogue:{read:()=>readPublicCatalogue(pool),project:token=>readPublicProject(pool,token),sourceUrl:hash=>`https://shared.test/api/floor-plans/sources/${hash}`}});

const facts = { title: 'Zagreb, trosoban stan, novogradnja', sourceId: '123456', areaM2: 70,
    propertyDetails: { propertyType: 'apartment', newBuild: true, constructionYear: 2026, completionYear: null, roomCount: 3, orientation: ['SE'], evidence: {} } };
const postings = [{ url: 'https://eurovilla.hr/nekretnina/stan/123456/', facts }, { url: 'https://eurovilla.hr/en/property/apartment/123456/', facts }];
const plan = { id: 'example-plan', kind: 'reviewed', listing_url: postings[0].url, sha256: 'a'.repeat(64),
    model: { scope: 'unit', unitId: 'A1', architecture: { schema: 'consensus-builder.floor-architecture.v1' }, source: { url: 'https://example.test/plan.png' } } };
const originalPlan = { id: 'original-plan', kind: 'original', listing_url: postings[1].url, sha256: 'b'.repeat(64),
    model: { scope: 'unit', unitId: 'B2', architecture: null, source: { url: 'https://example.test/original.png', page: 2 } } };
const factsOnly = projectInventory(postings, [], { year: 2026 }).apartments[0];
const model = { siteKey: 'permit:example', label: 'Primjer 12', location: { status: 'probable' },
    envelope: { footprint: { type: 'Polygon', coordinates: [[[15, 45], [15.001, 45], [15.001, 45.001], [15, 45]]] }, storeys: [] },
    placements: [], sources: [{ url: postings[0].url, label: 'Oglas stana' }], inventory: projectInventory(postings, [plan], { year: 2026 }) };
model.inventory.apartments.push({ ...factsOnly, id: 'facts-only', unitId: 'unread-unit', planId: 'unread-plan' });
const row = { site_key: model.siteKey, model, built_at: '2026-10-13T12:00:00Z' };
const lead = { ...row, site_key: 'permit:discovered', model: { ...model, siteKey: 'permit:discovered',
    label: 'Pronađen projekt', inventory: { ...model.inventory, apartments: [] } } };
const noPlan = { ...row, site_key: 'permit:no-plan', model: { ...model, siteKey: 'permit:no-plan',
    inventory: { ...model.inventory, apartments: [factsOnly] } } };
const originalInventory = projectInventory(postings, [originalPlan], { year: 2026 });
const originalRow = { ...row, site_key: 'permit:original', model: { ...model, siteKey: 'permit:original', label: 'Izvorni tlocrt 2',
    inventory: originalInventory } };

describe('source-backed residential catalogue', () => {
    it.each(['PRODANO – stan Siget', 'prodana nekretnina', 'NAJAM, stan Perjavica', 'Stan za iznajmljivanje'])('hides %s from this site without changing the stored model', title => {
        const hidden = structuredClone(row);
        hidden.model.label = title;
        const before = JSON.stringify(hidden);
        expect(publicProject(hidden)).toBeNull();
        expect(publicProject(hidden, { detail: true })).toBeNull();
        expect(JSON.stringify(hidden)).toBe(before);
    });

    it('removes sold and rental units from mixed projects while preserving other plans', () => {
        const mixed = structuredClone(row);
        const apartment = mixed.model.inventory.apartments[0];
        mixed.model.inventory.apartments.push(
            { ...apartment, id: 'sold', sourceTitle: 'PRODANO – Stan' },
            { ...apartment, id: 'rental', source: { listingUrl: 'https://example.test/nekretnine/najam/stan/' } }
        );
        mixed.model.inventory.floorPlans = [{ ...apartment, id: 'rental-floor', scope: 'floor', sourceTitle: 'NAJAM' }];
        expect(publicProject(mixed).apartments.map(a => a.id)).toEqual([apartment.id]);
        expect(publicProject(mixed).floorPlans).toEqual([]);
        mixed.model.inventory.apartments = mixed.model.inventory.apartments.filter(a => a.id === 'sold');
        expect(publicProject(mixed)).toBeNull();
    });

    it('keeps sale listings, existing buildings and unknown locations eligible', () => {
        const sale = structuredClone(row);
        sale.model.label = 'Prodaja stana – nepoznata lokacija';
        sale.model.location = { status: 'unknown' };
        sale.model.inventory.kind = 'existing';
        expect(publicProject(sale)).toMatchObject({ locationAvailable: false, kind: 'existing', planCount: 1 });
    });

    it.each(['ambiguous','unresolved','unknown',null])('publishes plans with %s location without mapping them', status => {
        const project=publicProject({...row,model:{...model,location:{status}}},{detail:true});
        expect(project).toMatchObject({location:null,locationAvailable:false,address:'Nepoznata lokacija',thumbnailUrl:null});
        expect(project.apartments).toHaveLength(1);
        expect(project.model).toMatchObject({envelope:null,footprint:null,placements:[]});
    });
    it('does not map missing or projected footprints', () => {
        expect(publicProject({...row,model:{...model,envelope:null}}).location).toBeNull();
        expect(publicProject({...row,model:{...model,envelope:{footprint:{type:'Polygon',
            coordinates:[[[500000,5000000],[500001,5000000],[500001,5000001],[500000,5000000]]]}}}}).location).toBeNull();
        expect(publicProject({...noPlan,model:{...noPlan.model,location:{status:'unknown'}}})).toBeNull();
    });
    it('merges language aliases and keeps unknown values separate from zero', () => {
        expect(projectInventory(postings, []).apartments).toHaveLength(1);
        expect(model.inventory.apartments[0]).toMatchObject({ areaM2: 70, rooms: 3, orientation: ['SE'], floor: null });
        const unknown = projectInventory([{ url: 'https://example.test/1', facts: { title: 'Stan', propertyDetails: { propertyType: 'apartment' } } }], []);
        expect(unknown.apartments[0]).toMatchObject({ areaM2: null, rooms: null, floor: null, orientation: [] });
    });
    it('labels an old building with its year despite new-build wording and never treats planned completion as year built', () => {
        const p = [{ url: 'https://example.test', facts: { newBuild: true, propertyDetails: { newBuild: true, constructionYear: 1980 } } }];
        expect(constructionSummary(p, { year: 2026 })).toMatchObject({ kind: 'existing', constructionYear: 1980 });
        p[0].facts.propertyDetails = { completionYear: 2027 };
        expect(constructionSummary(p, { year: 2026 })).toMatchObject({ kind: 'new_build', constructionYear: null, completionYear: 2027 });
    });
    it('does not offer offices as apartments and keeps commercial-only projects out', () => {
        const inventory = projectInventory([{ url: 'https://example.test/2', facts: { title: 'Office spaces', propertyDetails: { propertyType: 'commercial' } } }], []);
        expect(inventory.apartments).toHaveLength(0); expect(inventory.excludedUse).toBe(true);
        expect(publicProject({ model: { ...model, inventory } })).toBeNull();
    });
    it('prefers the Croatian posting and keeps advertised area distinct from physical plan area', () => {
        const aliases=[...postings].reverse();
        const plan={id:'unit',kind:'reviewed',listing_url:postings[0].url,sha256:'a'.repeat(64),model:{scope:'unit',unitId:'A1',areaM2:72,physicalNetAreaM2:80}};
        const a=projectInventory(aliases,[plan]).apartments[0];
        expect(a).toMatchObject({areaM2:70,marketedAreaM2:70,physicalNetAreaM2:80,areaBasis:'advertised',postingUrl:postings[0].url});
        expect(projectSources(aliases)).toEqual([{url:postings[0].url,label:facts.title}]);
    });
    it('uses stable identity after labels change and does not expose geometry in catalogue summaries', () => {
        const p = publicProject(row);
        expect(publicProject({ ...row, model: { ...model, label: 'Novi naziv' } }).id).toBe(p.id);
        expect(p.apartments[0]).not.toHaveProperty('architecture');
        expect(p.url).toBe(`/novogradnje/zgrade/primjer-12-${projectId(model.siteKey)}/`);
        expect(p.apartments[0].url).toBe(`${p.url}stanovi/${p.apartments[0].id}/`);
        expect(p.apartments).toHaveLength(1);
        expect(p.planCount).toBe(1);
        expect(publicProject(noPlan)).toBeNull();
        expect(publicProject(lead)).toBeNull();
    });
    it('publishes original drawings without promising geometry and keeps the source identity', () => {
        const retained = new Map([['b'.repeat(64), 'image/png']]);
        const summary = publicProject(originalRow, { retained });
        expect(summary.apartments).toHaveLength(1);
        expect(summary.apartments[0]).toMatchObject({ hasPlan: true, hasGeometry: false });
        expect(summary.apartments[0]).not.toHaveProperty('architecture');
        const detail = publicProject(originalRow, { detail: true, retained });
        expect(detail.apartments[0]).toMatchObject({ hasPlan: true, hasGeometry: false,
            source: { sha256: 'b'.repeat(64), page: 2, assetUrl: `/novogradnje/api/source/${'b'.repeat(64)}` } });
        expect(publicProject({ ...originalRow, model: { ...originalRow.model, inventory: { ...originalInventory,
            apartments: [{ ...originalInventory.apartments[0], source: null }] } } })).toBeNull();
        expect(publicProject({ ...originalRow, model: { ...originalRow.model, inventory: { ...originalInventory,
            apartments: [{ ...originalInventory.apartments[0], hasPlan: false }] } } }, { retained })).toBeNull();
    });
});

describe('sold and rental site visibility', () => {
    const hiddenRows = ['PRODANO stan', 'NAJAM stan'].map((title, i) => ({ ...row, site_key: `listing:hidden-${i}`,
        model: { ...model, siteKey: `listing:hidden-${i}`, label: title } }));
    const app = express();
    setupNovogradnjeRoute(app, { query: async sql => ({ rows: sql.includes('floor_plan.site_model') ? [row, ...hiddenRows] : [] }) });

    it('excludes hidden listings from counts, search HTML, sitemap and direct project/apartment URLs', async () => {
        const catalogue = await request(app).get('/novogradnje/api/projects').expect(200);
        expect(catalogue.body.counts).toMatchObject({ projects: 1, apartments: 1 });
        const index = await request(app).get('/novogradnje/').expect(200);
        const sitemap = await request(app).get('/novogradnje/sitemap.xml').expect(200);
        for (const hidden of hiddenRows) {
            const id = projectId(hidden.site_key);
            expect(index.text).not.toContain(id);
            expect(sitemap.text).not.toContain(id);
            await request(app).get(`/novogradnje/api/projects/${id}`).expect(404);
            await request(app).get(`/novogradnje/zgrade/${id}/`).expect(404);
            await request(app).get(`/novogradnje/zgrade/${id}/stanovi/${model.inventory.apartments[0].id}/`).expect(404);
        }
    });
});

describe('public pages and metadata', () => {
    const app = express();
    setupNovogradnjeRoute(app, { query: async (sql, params) => ({ rows: sql.includes('floor_plan.site_model') ? [row, lead, noPlan, originalRow] : sql.includes('floor_plan.blob') && params?.[0]?.includes('b'.repeat(64)) ? [{ sha256: 'b'.repeat(64), media_type: 'image/png' }] : [] }) });
    const project = publicProject(row);
    it('serves indexable project and apartment HTML before JavaScript with per-page canonical and JSON-LD', async () => {
        const page = await request(app).get(project.apartments[0].url).expect(200);
        expect(page.headers['content-type']).toContain('text/html');
        const canonical = `https://zagreb.lol${project.apartments[0].url}`;
        expect(page.text).toContain(`<link rel="canonical" href="${canonical}">`);
        expect(page.text).toContain(`<meta property="og:url" content="${canonical}">`);
        expect(page.text).toContain('application/ld+json'); expect(page.text).toContain('70 m²');
        expect(page.text).toContain('Oglas stana'); expect(page.text).not.toContain('__NOVOGRADNJE_BOOT__');
    });
    it('rejects singular building and apartment routes without redirects', async () => {
        const apartment = project.apartments[0];
        for (const path of [
            `/novogradnje/zgrada/${project.slug}/`,
            `/novogradnje/zgrada/${project.slug}/stan/${apartment.id}/`,
            `/novogradnje/zgrada/${project.slug}/stanovi/${apartment.id}/`,
            `${project.url}stan/${apartment.id}/`,
        ]) {
            const response = await request(app).get(path).expect(404);
            expect(response.headers.location).toBeUndefined();
        }
    });
    it('serves original-only apartment pages with an original-plan label and no false 3D promise', async () => {
        const original = publicProject(originalRow, { retained: new Map([['b'.repeat(64), 'image/png']]) });
        const page = await request(app).get(`${original.url}stanovi/${original.apartments[0].id}/`).expect(200);
        expect(page.text).toContain('Izvorni tlocrt');
        expect(page.text).not.toContain('Tlocrt i 3D prikaz');
        expect(page.text).toContain('"hasGeometry":false');
        await request(app).get(`/novogradnje/legacy?site=${encodeURIComponent(originalRow.site_key)}`).expect(301).expect('Location',original.url);
    });
    it('redirects stale name slugs by stable ID and answers genuine 404s for missing apartments and assets', async () => {
        await request(app).get(`/novogradnje/zgrade/stari-naziv-${projectId(model.siteKey)}/`).expect(301).expect('Location', project.url);
        await request(app).get(`${project.url}stanovi/missing/`).expect(404);
        await request(app).get('/novogradnje/missing.js').expect(404);
    });
    it('migrates archive site links and never accepts an external redirect target', async () => {
        await request(app).get(`/novogradnje/legacy?site=${encodeURIComponent(model.siteKey)}`).expect(301).expect('Location',project.url);
        await request(app).get('/novogradnje/legacy?site=https://example.test').expect(301).expect('Location','/novogradnje/');
    });
    it('lists deep links in the sitemap and prevents filtered duplicate pages from being indexed', async () => {
        const sitemap = await request(app).get('/novogradnje/sitemap.xml').expect(200);
        expect(sitemap.text).toContain(`<loc>https://zagreb.lol${project.url}</loc>`);
        expect(sitemap.text).toContain(`<loc>https://zagreb.lol${project.apartments[0].url}</loc>`);
        expect(sitemap.text).not.toMatch(/\/(zgrada|stan|tlocrt)\//);
        const filtered = await request(app).get('/novogradnje/?min=100').expect(200);
        expect(filtered.text).toContain('noindex,follow');
        expect(filtered.text).toContain('href="https://zagreb.lol/parcele/"');
        expect(filtered.text).toContain('href="https://zagreb.lol/lovac/"');
    });
    it('keeps facts-only apartments and projects out of public responses, pages and sitemap', async () => {
        const catalogue = await request(app).get('/novogradnje/api/projects').expect(200);
        expect(catalogue.body.counts).toMatchObject({ projects: 2, apartments: 2 });
        expect(catalogue.body.projects.map(p => p.id)).toEqual(expect.arrayContaining([project.id, projectId(originalRow.site_key)]));
        const sitemap = await request(app).get('/novogradnje/sitemap.xml').expect(200);
        expect(sitemap.text).not.toContain('facts-only');
        expect(sitemap.text).not.toContain(projectId(lead.site_key));
        expect(sitemap.text).not.toContain(projectId(noPlan.site_key));
        const detail = await request(app).get(`/novogradnje/api/projects/${project.id}`).expect(200);
        expect(detail.body.apartments.map(a => a.id)).toEqual([project.apartments[0].id]);
        const original = await request(app).get(`/novogradnje/api/projects/${projectId(originalRow.site_key)}`).expect(200);
        expect(original.body.apartments[0]).toMatchObject({ hasPlan: true, hasGeometry: false,
            source: { sha256: 'b'.repeat(64) } });
        const page = await request(app).get(`${project.url}stanovi/facts-only/`).expect(404);
        expect(page.text).toContain('noindex');
        await request(app).get(`/novogradnje/zgrade/${projectId(lead.site_key)}/`).expect(404);
        await request(app).get(`/novogradnje/api/projects/${projectId(lead.site_key)}`).expect(404);
        await request(app).get(`/novogradnje/zgrade/${projectId(noPlan.site_key)}/`).expect(404);
        await request(app).get(`/novogradnje/api/projects/${projectId(noPlan.site_key)}`).expect(404);
        await request(app).get('/novogradnje/legacy?plan=unread-plan').expect(301).expect('Location','/novogradnje/');
    });
});

describe('project building thumbnails', () => {
    const envelope = { ...model.envelope, storeys: [
        { level: 0, elevationM: 0, heightM: 3 }, { level: 1, elevationM: 3, heightM: 3 },
    ] };
    const first = { ...row, model: { ...model, envelope } };
    const second = { ...row, site_key: 'permit:taller', model: { ...model, siteKey: 'permit:taller',
        envelope: { ...envelope, storeys: [...envelope.storeys, { level: 2, elevationM: 6, heightM: 3 }] } } };
    const app = express();
    setupNovogradnjeRoute(app, { query: async sql => ({ rows: sql.includes('floor_plan.site_model') ? [first, second, originalRow, lead] : [] }) });

    it('advertises per-project thumbnail URLs only for actual building envelopes', async () => {
        const catalogue = await request(app).get('/novogradnje/api/projects').expect(200);
        const project = catalogue.body.projects.find(p => p.id === projectId(first.site_key));
        expect(project.thumbnailUrl).toBe(`/novogradnje/api/projects/${project.id}/thumbnail.svg`);
        expect(project).not.toHaveProperty('model');
        expect(publicProject(row).thumbnailUrl).toBeNull();
    });

    it('serves different SVG views for different building geometry', async () => {
        const one = await request(app).get(publicProject(first).thumbnailUrl).expect(200);
        const two = await request(app).get(publicProject(second).thumbnailUrl).expect(200);
        expect(one.headers['content-type']).toContain('image/svg+xml');
        const text = response => response.text ?? response.body.toString('utf8');
        expect(text(one)).toContain('<svg');
        expect(text(one)).not.toBe(text(two));
    });

    it('does not invent thumbnails for missing or non-public projects', async () => {
        await request(app).get('/novogradnje/api/projects/missing/thumbnail.svg').expect(404);
        await request(app).get(`/novogradnje/api/projects/${projectId(lead.site_key)}/thumbnail.svg`).expect(404);
        await request(app).get(`/novogradnje/api/projects/${projectId(originalRow.site_key)}/thumbnail.svg`).expect(404);
    });

    it('includes the building image in server-rendered cards before JavaScript', async () => {
        const page = await request(app).get('/novogradnje/?kind=all').expect(200);
        expect(page.text).toContain('<img class="building-thumbnail"');
        expect(page.text).toContain(`src="${publicProject(first).thumbnailUrl}"`);
        expect(page.text).not.toContain('window-grid');
    });
});
