// Public, source-backed project catalogue. Stable IDs survive changed titles; payloads omit the
// raw archive and expose only residential projects, apartment facts and available reconstructions.
import { createHash } from 'node:crypto';

export const PUBLIC_ORIGIN = 'https://zagreb.lol';
export const BASE_PATH = '/novogradnje/';
export const projectId = key => createHash('sha256').update(key).digest('hex').slice(0, 16);
const slugify = value => String(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 85);
const httpUrl = value => { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) ? u.href : null; } catch { return null; } };

function location(model) {
    const g = model.envelope?.footprint;
    const ring = g?.type === 'Polygon' ? g.coordinates?.[0] : g?.type === 'MultiPolygon' ? g.coordinates?.[0]?.[0] : null;
    if (!ring?.length || ring.some(p => !p.slice(0, 2).every(Number.isFinite))) return null;
    const open = ring.slice(0, -1);
    return { lng: open.reduce((sum, p) => sum + p[0], 0) / open.length,
        lat: open.reduce((sum, p) => sum + p[1], 0) / open.length, status: model.location?.status || 'probable' };
}

export function publicProject(row, { detail = false, retained = new Set() } = {}) {
    const model = row.model, inventory = model?.inventory;
    if (!inventory || inventory.excludedUse || !model.siteKey) return null;
    const id = projectId(model.siteKey), label = model.label || inventory.name || 'Stambeni projekt';
    const slug = `${slugify(label) || 'projekt'}-${id}`, url = `${BASE_PATH}zgrada/${slug}/`;
    const apartments = (inventory.apartments || []).map(a => {
        const value = { id: a.id, label: a.label, url: `${url}stan/${a.id}/`, areaM2: a.areaM2,
            rooms: a.rooms, orientation: a.orientation, floor: a.floor, hasPlan: a.hasPlan, sourceTitle: a.sourceTitle };
        if (detail) Object.assign(value, { ...a, ...value,
            source: a.source ? { ...a.source, url: httpUrl(a.source.url), mediaType: retained.get?.(a.source.sha256) || null, assetUrl: retained.has(a.source.sha256)
                ? `${BASE_PATH}api/source/${a.source.sha256}` : null } : null,
            sourceUrls: (a.sourceUrls || []).map(httpUrl).filter(Boolean),
            placement: (model.placements || []).find(p => p.planId === a.planId) || null });
        return value;
    });
    const value = { id, slug, url, label, name: inventory.name || label, address: label,
        kind: inventory.kind, constructionYear: inventory.constructionYear, completionYear: inventory.completionYear,
        titles: inventory.titles || [], location: location(model), apartments,
        sourceCount: inventory.sourceCount, planCount: apartments.filter(a => a.hasPlan).length,
        updatedAt: row.built_at || null };
    if (detail) Object.assign(value, { model: { ...model, inventory: undefined },
        sources: (model.sources || []).map(s => ({ url: httpUrl(s.url), label: s.label })).filter(s => s.url),
        yearEvidence: inventory.yearEvidence || [], conflicts: inventory.conflicts || [] });
    return value;
}

export async function readPublicCatalogue(db) {
    const rows = (await db.query('SELECT site_key,model,built_at FROM floor_plan.site_model ORDER BY site_key')).rows;
    const projects = rows.map(row => publicProject(row)).filter(Boolean)
        .sort((a, b) => Number(b.kind === 'new_build') - Number(a.kind === 'new_build') || b.planCount - a.planCount || a.label.localeCompare(b.label, 'hr'));
    return { projects, counts: { projects: projects.length, apartments: projects.reduce((n, p) => n + p.apartments.length, 0),
        withPlans: projects.filter(p => p.planCount > 0).length },
        updatedAt: rows.map(r => r.built_at).filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0] || null };
}

export async function readPublicProject(db, token) {
    const rows = (await db.query('SELECT site_key,model,built_at FROM floor_plan.site_model ORDER BY site_key')).rows;
    const row = rows.find(r => projectId(r.site_key) === token || token.endsWith(`-${projectId(r.site_key)}`));
    if (!row) return null;
    const hashes = (row.model.inventory?.apartments || []).map(a => a.source?.sha256).filter(Boolean);
    const retained = hashes.length ? new Map((await db.query('SELECT sha256,media_type FROM floor_plan.blob WHERE sha256=ANY($1::text[]) AND bytes_available', [hashes])).rows.map(b => [b.sha256,b.media_type])) : new Map();
    return publicProject(row, { detail: true, retained });
}
