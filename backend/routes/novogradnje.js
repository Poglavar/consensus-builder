// Server-rendered project/apartment deep links, search metadata and read-only catalogue for zagreb.lol.
import express from 'express';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as cheerio from 'cheerio';
import { BASE_PATH, PUBLIC_ORIGIN, projectId, readPublicCatalogue, readPublicProject } from '../floor-plan-archive/public-catalogue.js';
import { readBlobRow } from '../floor-plans/blob-store.js';

const require = createRequire(import.meta.url);
const { filterProjects, decodeFilters } = require('../../frontend/novogradnje/catalogue.js');
const directory = fileURLToPath(new URL('../../frontend/novogradnje/', import.meta.url));
const shared = fileURLToPath(new URL('../../frontend/js/', import.meta.url));
const sharedFiles = new Set(['building-floor-plans.js', 'three-floor-plans.js', 'floor-plan-review-geometry.js', 'floor-plan-review-renderer.js', 'site-model-geometry.js']);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = value => JSON.stringify(value).replace(/</g, '\\u003c');
const kindLabel = kind => ({ new_build: 'Novogradnja', existing: 'Starogradnja', unknown: 'Vrsta nije utvrđena' })[kind] || 'Vrsta nije utvrđena';
const yearLabel = p => p.constructionYear ? `Izgradnja ${p.constructionYear}` : p.completionYear ? `Planirani završetak ${p.completionYear}` : 'Godina nije navedena';
function apartmentFacts(a) { return [typeof a.areaM2 === 'number' ? `${a.areaM2} m²` : null, typeof a.rooms === 'number' ? `${a.rooms} soba` : null,
    Number.isInteger(a.floor) ? `${a.floor}. kat` : null].filter(Boolean).join(' · '); }

export function projectMarkup(project) {
    return `<article class="project-card"><a class="card-link" href="${escape(project.url)}"><div class="card-visual"><span class="building-tag">${kindLabel(project.kind)}</span></div><div class="card-body"><h3 class="card-title">${escape(project.name)}</h3><p class="card-address">${escape(project.address)}</p><div class="card-chips"><span class="chip">${yearLabel(project)}</span></div><p>${project.apartments.length ? `${project.apartments.length} stanova u katalogu` : 'Broj stanova nije naveden'} · ${project.planCount} tlocrta</p></div></a></article>`;
}

function detailMarkup(project, apartment) {
    const chosen = apartment ? [apartment] : project.apartments;
    return `<article class="detail-card"><h2>${escape(apartment?.label || project.name)}</h2><p>${escape(project.address)} · ${kindLabel(project.kind)} · ${yearLabel(project)}</p><div class="apartment-list">${chosen.map(a => `<a class="apartment-row" href="${escape(a.url)}"><strong>${escape(a.label)}</strong><span>${escape(apartmentFacts(a)) || 'Podaci nisu navedeni'}</span><span>${a.hasGeometry ? 'Tlocrt i 3D prikaz' : 'Izvorni tlocrt'}</span></a>`).join('')}</div><p>Lokacija i geometrija prema dostupnim izvorima. Rekonstrukcije su označene prema stupnju provjere; dostupnost stana provjerite kod izvora.</p><ul>${project.sources.map(s => `<li><a href="${escape(s.url)}" rel="noopener noreferrer">${escape(s.label)}</a></li>`).join('')}</ul></article>`;
}

export function structuredData(catalogue, project = null, apartment = null) {
    const website = { '@type': 'WebSite', '@id': `${PUBLIC_ORIGIN}${BASE_PATH}#website`, name: 'Novogradnje u Zagrebu', url: `${PUBLIC_ORIGIN}${BASE_PATH}`, inLanguage: 'hr' };
    const selected = apartment || project;
    if (!selected) return { '@context': 'https://schema.org', '@graph': [website, { '@type': 'ItemList', name: 'Stambeni projekti Zagreba',
        itemListElement: catalogue.projects.map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: `${PUBLIC_ORIGIN}${p.url}`, name: p.name })) }] };
    return { '@context': 'https://schema.org', '@graph': [website, { '@type': apartment ? 'Apartment' : 'ApartmentComplex',
        '@id': `${PUBLIC_ORIGIN}${selected.url}`, name: apartment ? `${apartment.label} · ${project.name}` : project.name,
        url: `${PUBLIC_ORIGIN}${selected.url}`, address: { '@type': 'PostalAddress', streetAddress: project.address, addressLocality: 'Zagreb', addressCountry: 'HR' },
        ...(project.location ? { geo: { '@type': 'GeoCoordinates', latitude: project.location.lat, longitude: project.location.lng } } : {}),
        ...(apartment?.areaM2 ? { floorSize: { '@type': 'QuantitativeValue', value: apartment.areaM2, unitCode: 'MTK' } } : {}),
        ...(apartment?.rooms ? { numberOfRooms: apartment.rooms } : {}) },
        { '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Novogradnje', item: `${PUBLIC_ORIGIN}${BASE_PATH}` },
            { '@type': 'ListItem', position: 2, name: project.name, item: `${PUBLIC_ORIGIN}${project.url}` },
            ...(apartment ? [{ '@type': 'ListItem', position: 3, name: apartment.label, item: `${PUBLIC_ORIGIN}${apartment.url}` }] : [])] }] };
}

export async function renderPublicPage({ catalogue, project = null, apartment = null, search = '' }) {
    const $ = cheerio.load(await readFile(`${directory}/index.html`, 'utf8'));
    const selected = apartment || project;
    const title = selected ? `${apartment ? `${apartment.label} · ` : ''}${project.name} · Novogradnje · zagreb.lol` : 'Novogradnje u Zagrebu — stanovi, tlocrti i 3D · zagreb.lol';
    const description = project ? `${project.address}. ${kindLabel(project.kind)}. ${yearLabel(project)}. ${apartment ? apartmentFacts(apartment) : `${project.apartments.length} stanova u katalogu`}. Izvorni tlocrti i 3D prikazi kada su dostupni.`
        : 'Pronađite novogradnje u Zagrebu na karti. Pretražite stanove po površini, sobama i orijentaciji; pogledajte dostupne tlocrte i 3D rekonstrukcije.';
    const canonical = `${PUBLIC_ORIGIN}${selected?.url || BASE_PATH}`;
    $('title').text(title); $('meta[name="description"]').attr('content', description);
    for (const name of ['og:title', 'twitter:title']) $(`meta[property="${name}"],meta[name="${name}"]`).attr('content', title);
    for (const name of ['og:description', 'twitter:description']) $(`meta[property="${name}"],meta[name="${name}"]`).attr('content', description);
    $('meta[property="og:url"]').attr('content', canonical); $('link[rel="canonical"]').attr('href', canonical);
    $('head').append(`<meta name="robots" content="${search ? 'noindex,follow' : 'index,follow'}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><script type="application/ld+json">${json(structuredData(catalogue, project, apartment))}</script>`);
    const visible = filterProjects(catalogue.projects, decodeFilters(search));
    $('#results').html(visible.map(projectMarkup).join(''));
    if (project) {
        $('body').attr('data-page', 'detail');
        $('h1').text(apartment ? `${apartment.label} · ${project.name}` : project.name);
        $('#detail').html(detailMarkup(project, apartment));
        // Detail URLs are useful without scripts and appear before the catalogue.
        $('#detail').insertBefore('.search-panel');
    }
    $('#novogradnje-boot').text(json({ catalogue, project, apartmentId: apartment?.id || null }));
    return $.html();
}

export function setupNovogradnjeRoute(app, pool) {
    const get = (path, action) => app.get(path, async (req, res, next) => {
        res.set('Cache-Control', 'no-store').set('X-Content-Type-Options', 'nosniff');
        try { await action(req, res); } catch (error) { next(error); }
    });
    get(/^\/novogradnje$/, (req, res) => res.redirect(301, `/novogradnje/${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`));
    // Keep shared links from the former archive useful during the domain migration.
    get('/novogradnje/legacy', async (req, res) => {
        const rows=(await pool.query('SELECT site_key,model,built_at FROM floor_plan.site_model ORDER BY site_key')).rows;
        const visibleProjects=new Map((await readPublicCatalogue(pool)).projects.map(project=>[project.id,project]));
        const site=typeof req.query.site==='string'?req.query.site:null, plan=typeof req.query.plan==='string'?req.query.plan:null;
        for(const row of rows) {
            const project=visibleProjects.get(projectId(row.site_key));
            if(!project)continue;
            const apartment=plan ? (row.model.inventory?.apartments||[]).find(a=>a.planId===plan||a.source?.sha256===plan||a.unitId===plan) : null;
            const visible=apartment&&project.apartments.find(a=>a.id===apartment.id);
            if(visible)return res.redirect(301,visible.url);
            if(site===row.site_key)return res.redirect(301,project.url);
        }
        res.redirect(301,BASE_PATH);
    });
    get('/novogradnje/api/projects', async (_req, res) => res.json(await readPublicCatalogue(pool)));
    get('/novogradnje/api/projects/:id', async (req, res) => {
        const project = await readPublicProject(pool, req.params.id);
        return project ? res.json(project) : res.status(404).json({ error: 'Projekt nije pronađen.' });
    });
    get('/novogradnje/api/source/:hash', async (req, res) => {
        if (!/^[a-f0-9]{64}$/.test(req.params.hash)) return res.status(400).end();
        const row = (await pool.query(`SELECT b.* FROM floor_plan.blob b WHERE b.sha256=$1 AND EXISTS (
            SELECT 1 FROM floor_plan.site_model m, jsonb_array_elements(COALESCE(m.model#>'{inventory,apartments}','[]')) a
            WHERE a#>>'{source,sha256}'=b.sha256)`, [req.params.hash])).rows[0];
        if (!row) return res.status(404).end();
        if (!row.bytes_available) return res.status(410).end();
        const type = row.media_type.split(';')[0].toLowerCase();
        if (!['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(type)) return res.status(415).end();
        res.type(type).send(await readBlobRow(row));
    });
    get('/novogradnje/sitemap.xml', async (_req, res) => {
        const catalogue = await readPublicCatalogue(pool);
        const paths = [BASE_PATH, ...catalogue.projects.flatMap(p => [p.url, ...p.apartments.map(a => a.url)])];
        res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map(path => `<url><loc>${PUBLIC_ORIGIN}${escape(path)}</loc></url>`).join('')}</urlset>`);
    });
    get('/novogradnje/shared/:file', (req, res) => sharedFiles.has(req.params.file) ? res.sendFile(req.params.file, { root: shared }) : res.status(404).end());
    const page = async (req, res) => {
        const catalogue = await readPublicCatalogue(pool);
        const project = req.params.slug ? await readPublicProject(pool, req.params.slug) : null;
        const apartment = req.params.apartment ? project?.apartments.find(a => a.id === req.params.apartment) : null;
        if ((req.params.slug && !project) || (req.params.apartment && !apartment)) return res.status(404).type('html').send('<!doctype html><html lang="hr"><meta name="robots" content="noindex"><title>Nije pronađeno · Novogradnje</title><h1>Projekt ili stan nije pronađen.</h1><a href="/novogradnje/">Pretraži novogradnje</a></html>');
        const expected = apartment?.url || project?.url || BASE_PATH;
        const search = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
        if (req.path !== expected) return res.redirect(301, expected + search);
        res.type('html').send(await renderPublicPage({ catalogue, project, apartment, search }));
    };
    get('/novogradnje/', page);
    get('/novogradnje/zgrada/:slug/stan/:apartment/', page);
    get('/novogradnje/zgrada/:slug/', page);
    app.use('/novogradnje', express.static(directory, { index: false, dotfiles: 'deny', setHeaders: res => res.set('Cache-Control', 'no-store') }));
    app.use('/novogradnje', (_req, res) => res.status(404).type('text').send('Nije pronađeno.'));
}
