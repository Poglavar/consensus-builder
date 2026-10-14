// Public IDs, alias grouping, metadata, HTTP deep links and actual filter decisions stay testable without a browser.
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { constructionSummary, projectInventory, projectSources } from '../floor-plans/project-inventory.js';
import { publicProject, projectId } from '../floor-plan-archive/public-catalogue.js';
import { setupNovogradnjeRoute } from '../routes/novogradnje.js';

const facts = { title: 'Zagreb, trosoban stan, novogradnja', sourceId: '123456', areaM2: 70,
    propertyDetails: { propertyType: 'apartment', newBuild: true, constructionYear: 2026, completionYear: null, roomCount: 3, orientation: ['SE'], evidence: {} } };
const postings = [{ url: 'https://eurovilla.hr/nekretnina/stan/123456/', facts }, { url: 'https://eurovilla.hr/en/property/apartment/123456/', facts }];
const plan = { id: 'example-plan', kind: 'reviewed', listing_url: postings[0].url, sha256: 'a'.repeat(64),
    model: { scope: 'unit', unitId: 'A1', architecture: { schema: 'consensus-builder.floor-architecture.v1' }, source: { url: 'https://example.test/plan.png' } } };
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

describe('source-backed residential catalogue', () => {
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
        expect(p.apartments[0].url).toBe(`${p.url}stan/${p.apartments[0].id}/`);
        expect(p.apartments).toHaveLength(1);
        expect(p.planCount).toBe(1);
        expect(publicProject(noPlan)).toBeNull();
        expect(publicProject(lead)).toBeNull();
    });
});

describe('public pages and metadata', () => {
    const app = express();
    setupNovogradnjeRoute(app, { query: async sql => ({ rows: sql.includes('floor_plan.site_model') ? [row, lead, noPlan] : [] }) });
    const project = publicProject(row);
    it('serves indexable project and apartment HTML before JavaScript with per-page canonical and JSON-LD', async () => {
        const page = await request(app).get(project.apartments[0].url).expect(200);
        expect(page.headers['content-type']).toContain('text/html');
        expect(page.text).toContain(`https://zagreb.lol${project.apartments[0].url}`);
        expect(page.text).toContain('application/ld+json'); expect(page.text).toContain('70 m²');
        expect(page.text).toContain('Oglas stana'); expect(page.text).not.toContain('__NOVOGRADNJE_BOOT__');
    });
    it('redirects stale name slugs by stable ID and answers genuine 404s for missing apartments and assets', async () => {
        await request(app).get(`/novogradnje/zgrada/stari-naziv-${projectId(model.siteKey)}/`).expect(301).expect('Location', project.url);
        await request(app).get(`${project.url}stan/missing/`).expect(404);
        await request(app).get('/novogradnje/missing.js').expect(404);
    });
    it('migrates archive site links and never accepts an external redirect target', async () => {
        await request(app).get(`/novogradnje/legacy?site=${encodeURIComponent(model.siteKey)}`).expect(301).expect('Location',project.url);
        await request(app).get('/novogradnje/legacy?site=https://example.test').expect(301).expect('Location','/novogradnje/');
    });
    it('lists deep links in the sitemap and prevents filtered duplicate pages from being indexed', async () => {
        const sitemap = await request(app).get('/novogradnje/sitemap.xml').expect(200);
        expect(sitemap.text).toContain(project.apartments[0].url);
        const filtered = await request(app).get('/novogradnje/?min=100').expect(200);
        expect(filtered.text).toContain('noindex,follow');
        expect(filtered.text).toContain('href="https://zagreb.lol/parcele/"');
        expect(filtered.text).toContain('href="https://zagreb.lol/lovac/"');
    });
    it('keeps facts-only apartments and projects out of public responses, pages and sitemap', async () => {
        const catalogue = await request(app).get('/novogradnje/api/projects').expect(200);
        expect(catalogue.body.counts).toMatchObject({ projects: 1, apartments: 1 });
        expect(catalogue.body.projects.map(p => p.id)).toEqual([project.id]);
        const sitemap = await request(app).get('/novogradnje/sitemap.xml').expect(200);
        expect(sitemap.text).not.toContain('facts-only');
        expect(sitemap.text).not.toContain(projectId(lead.site_key));
        expect(sitemap.text).not.toContain(projectId(noPlan.site_key));
        const detail = await request(app).get(`/novogradnje/api/projects/${project.id}`).expect(200);
        expect(detail.body.apartments.map(a => a.id)).toEqual([project.apartments[0].id]);
        const page = await request(app).get(`${project.url}stan/facts-only/`).expect(404);
        expect(page.text).toContain('noindex');
        await request(app).get(`/novogradnje/zgrada/${projectId(lead.site_key)}/`).expect(404);
        await request(app).get(`/novogradnje/api/projects/${projectId(lead.site_key)}`).expect(404);
        await request(app).get(`/novogradnje/zgrada/${projectId(noPlan.site_key)}/`).expect(404);
        await request(app).get(`/novogradnje/api/projects/${projectId(noPlan.site_key)}`).expect(404);
        await request(app).get('/novogradnje/legacy?plan=unread-plan').expect(301).expect('Location','/novogradnje/');
    });
});
