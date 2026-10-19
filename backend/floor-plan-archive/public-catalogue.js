// Public, source-backed project catalogue. Stable IDs survive changed titles; payloads omit the
// raw archive and expose only residential projects, apartment facts and available reconstructions.
import { createHash } from 'node:crypto';
import { buildingThumbnailSvg } from './building-thumbnail.js';
import { createRequire } from 'node:module';
const { compareCompletion } = createRequire(import.meta.url)('../../frontend/novogradnje/catalogue.js');

export const PUBLIC_ORIGIN = 'https://zagreb.lol';
export const BASE_PATH = '/novogradnje/';
export const projectId = key => createHash('sha256').update(key).digest('hex').slice(0, 16);
const slugify = value => String(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 85);
const httpUrl = value => { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) ? u.href : null; } catch { return null; } };

function location(model) {
    const g = model.envelope?.footprint;
    const ring = g?.type === 'Polygon' ? g.coordinates?.[0] : g?.type === 'MultiPolygon' ? g.coordinates?.[0]?.[0] : null;
    if (!ring || ring.length < 4 || ring.some(p => !Array.isArray(p) || p.length < 2
        || !p.slice(0, 2).every(Number.isFinite) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90)) return null;
    const open = ring.slice(0, -1);
    return { lng: open.reduce((sum, p) => sum + p[0], 0) / open.length,
        lat: open.reduce((sum, p) => sum + p[1], 0) / open.length, status: model.location.status };
}

export function publicProject(row, { detail = false, retained = new Set() } = {}) {
    const model = row.model, inventory = model?.inventory;
    if (!inventory || inventory.excludedUse || !model.siteKey) return null;
    const located = ['located','probable'].includes(model.location?.status) && Boolean(location(model));
    const id = row.public_id || projectId(model.siteKey), label = model.label || inventory.name || 'Stambeni projekt';
    const slug = `${slugify(label) || 'projekt'}-${id}`, url = `${BASE_PATH}zgrada/${slug}/`;
    // Facts-only postings stay private; geometry or a retained original drawing qualifies.
    const apartments = (inventory.apartments || []).map(a => ({ ...a, hasGeometry: Boolean(a.architecture) }))
        .filter(a => a.hasPlan === true && (a.hasGeometry || Boolean(a.source?.sha256 && retained.has(a.source.sha256)))).map(a => {
        const value = { id: a.id, label: a.label, url: `${url}stan/${a.id}/`, areaM2: a.areaM2,
            rooms: a.rooms, orientation: a.orientation, floor: a.floor, hasPlan: true,
            hasGeometry: a.hasGeometry, sourceTitle: a.sourceTitle };
        if (detail) Object.assign(value, { ...a, ...value,
            source: a.source ? { ...a.source, url: httpUrl(a.source.url), mediaType: retained.get?.(a.source.sha256) || null, assetUrl: a.source.sha256 && retained.has(a.source.sha256)
                ? `${BASE_PATH}api/source/${a.source.sha256}` : null } : null,
            sourceUrls: (a.sourceUrls || []).map(httpUrl).filter(Boolean),
            placement: (model.placements || []).find(p => p.planId === a.planId) || null });
        return value;
    });
    const floorPlans = (inventory.floorPlans || []).filter(p => p.scope === 'floor' && p.hasPlan === true
        && (p.architecture || (p.source?.sha256 && retained.has(p.source.sha256)))).map(p => {
        const value={id:p.id,label:p.label,scope:'floor',levels:p.levels||[],url:`${url}tlocrt/${p.id}/`,hasPlan:true,hasGeometry:Boolean(p.architecture)};
        if(detail)Object.assign(value,{...p,...value,source:p.source?{...p.source,url:httpUrl(p.source.url),
            mediaType:retained.get?.(p.source.sha256)||null,assetUrl:p.source.sha256&&retained.has(p.source.sha256)?`${BASE_PATH}api/source/${p.source.sha256}`:null}:null});
        return value;
    });
    if (!apartments.length && !floorPlans.length) return null;
    const value = { id, slug, url, label, name: inventory.name || label, address: located ? label : 'Nepoznata lokacija',
        locationAvailable: located,
        availability: 'ready',
        archiveEvidence:model.archiveEvidence||null,
        kind: inventory.kind, constructionYear: inventory.constructionYear, completionYear: inventory.completionYear,
        thumbnailUrl: located && buildingThumbnailSvg(model) ? `${BASE_PATH}api/projects/${id}/thumbnail.svg` : null,
        titles: inventory.titles || [], location: located ? location(model) : null, apartments, floorPlans,
        sourceCount: inventory.sourceCount, planCount: apartments.filter(a => a.hasPlan).length + floorPlans.length,
        updatedAt: row.built_at || null };
    if (detail) Object.assign(value, { model: { ...model, inventory: undefined, ...(located ? {} : { envelope: null, footprint: null, placements: [], location: { status: 'unknown' } }) },
        sources: (model.sources || []).map(s => ({ url: httpUrl(s.url), label: s.label })).filter(s => s.url),
        yearEvidence: inventory.yearEvidence || [], conflicts: inventory.conflicts || [] });
    return value;
}

export async function readPublicCatalogue(db) {
    const rows = (await db.query('SELECT site_key,model,built_at FROM floor_plan.site_model ORDER BY site_key')).rows;
    // Located leads stay in the collection database; source-only plans require retained bytes.
    const hashes = [...new Set(rows.flatMap(row => [...(row.model.inventory?.apartments || []),...(row.model.inventory?.floorPlans || [])].map(a => a.source?.sha256).filter(Boolean)))];
    const retained = hashes.length ? new Map((await db.query('SELECT sha256,media_type FROM floor_plan.blob WHERE sha256=ANY($1::text[]) AND bytes_available', [hashes])).rows.map(b => [b.sha256,b.media_type])) : new Map();
    const projects = rows.map(row => publicProject(row, { retained })).filter(Boolean)
        .sort(compareCompletion);
    return { projects, counts: { projects: projects.length, apartments: projects.reduce((n, p) => n + p.apartments.length, 0),
        withPlans: projects.filter(p => p.planCount > 0).length, floorPlans: projects.reduce((n,p)=>n+p.floorPlans.length,0) },
        updatedAt: rows.map(r => r.built_at).filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0] || null };
}

export async function readPublicProject(db, token) {
    const rows = (await db.query('SELECT site_key,model,built_at FROM floor_plan.site_model ORDER BY site_key')).rows;
    const row = rows.find(r => projectId(r.site_key) === token || token.endsWith(`-${projectId(r.site_key)}`));
    if (!row) return null;
    const hashes = [...(row.model.inventory?.apartments || []),...(row.model.inventory?.floorPlans || [])].map(a => a.source?.sha256).filter(Boolean);
    const retained = hashes.length ? new Map((await db.query('SELECT sha256,media_type FROM floor_plan.blob WHERE sha256=ANY($1::text[]) AND bytes_available', [hashes])).rows.map(b => [b.sha256,b.media_type])) : new Map();
    return publicProject(row, { detail: true, retained });
}
