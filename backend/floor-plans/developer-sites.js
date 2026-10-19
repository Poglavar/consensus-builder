// Developer role evidence stays distinct from the shared agency/site identity queue.
import { isIP } from 'node:net';
import { enqueue } from './archive.js';
import { normalizeUrl } from './page-evidence.js';

function publicUrl(raw) {
    const url = normalizeUrl(raw);
    if (!url) return null;
    const parsed = new URL(url), host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
        || !host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || isIP(host)) return null;
    return url;
}

function siteHost(raw) { return new URL(raw).hostname.toLowerCase().replace(/^www\./, ''); }

export async function importDeveloperSites(db, document) {
    if (!Array.isArray(document?.records) || !document.records.length) throw new Error('A nonempty developer evidence document is required.');
    const rows = document.records.map(row => {
        const website = publicUrl(row.website), websiteProof = publicUrl(row.website_evidence_url);
        const discoveryEvidence = (row.discovery_evidence_urls || []).map(publicUrl);
        const seeds = (row.seed_project_urls || []).map(publicUrl);
        if (!row.id || typeof row.id !== 'string' || !row.id.trim() || !row.name || typeof row.name !== 'string'
            || !website || !websiteProof || siteHost(website) !== siteHost(websiteProof)
            || !row.verification_basis || typeof row.verification_basis !== 'string'
            || !Array.isArray(row.discovery_evidence_urls) || !discoveryEvidence.length || discoveryEvidence.some(url => !url)
            || !Array.isArray(row.seed_project_urls) || seeds.some(url => !url || siteHost(url) !== siteHost(website))) {
            throw new Error('Developer needs a stable identity, public URLs, same-domain own-site role proof, discovery evidence and same-host project seeds.');
        }
        return { row, website, websiteProof, discoveryEvidence, seeds };
    });
    const ids = new Set(), websites = new Set();
    for (const item of rows) {
        if (ids.has(item.row.id) || websites.has(item.website)) throw new Error('Developer roster IDs and websites must be unique.');
        ids.add(item.row.id); websites.add(item.website);
    }

    const result = { developers: 0, sites: 0, queued: 0, scopeComplete: document.scope_complete === true };
    for (const { row, website, websiteProof, discoveryEvidence, seeds } of rows) {
        const evidence = {
            developerSource: {
                sourceKind: 'developer', developerId: row.id, name: row.name,
                ...(row.legal_name ? { legalName: row.legal_name } : {}),
                roleStatus: 'verified-own-site', roleEvidenceUrl: websiteProof,
                verificationBasis: row.verification_basis,
                discoveryEvidenceUrls: discoveryEvidence, seedProjectUrls: seeds,
                authority: document.source || null,
                sourceObservedAt: row.observedAt || document.observedAt || null,
                scopeComplete: document.scope_complete === true,
            },
        };
        const current = (await db.query(`SELECT url,evidence,verification_status,name,agency_id FROM floor_plan.site
          WHERE regexp_replace(lower(split_part(url,'/',3)),'^www\\.','')=$1
          ORDER BY CASE WHEN evidence->>'sourceKind'='architecture' THEN 0 WHEN agency_id IS NOT NULL THEN 1 ELSE 2 END LIMIT 1`, [siteHost(website)])).rows[0];
        const siteUrl = current?.url || website;
        const oldEvidence = current?.evidence || {};
        const primaryKind = oldEvidence.sourceKind || (current?.agency_id != null ? 'agency' : 'developer');
        await db.query(`INSERT INTO floor_plan.site(url,name,discovery_url,evidence,verification_status)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT(url) DO UPDATE SET
          name=COALESCE(floor_plan.site.name,excluded.name),
          evidence=floor_plan.site.evidence || jsonb_build_object('developerSource',excluded.evidence->'developerSource'),
          updated_at=now()`, [siteUrl, row.name, discoveryEvidence[0], JSON.stringify({ ...evidence, sourceKind: primaryKind }),
            current?.verification_status || 'verified_developer_website']);

        const targets = new Map();
        for (const [url, kind, priority] of [[siteUrl, 'home', 60], [new URL('/sitemap.xml', siteUrl).href, 'sitemap', 40], ...seeds.map(url => [url, 'page', 45])]) {
            if (!targets.has(url)) targets.set(url, { url, kind, priority });
        }
        const existing = (await db.query(`SELECT source_kind FROM floor_plan.target
          WHERE regexp_replace(lower(split_part(url,'/',3)),'^www\\.','')=$1
          ORDER BY CASE source_kind WHEN 'architecture' THEN 0 WHEN 'agency' THEN 1 ELSE 2 END LIMIT 1`, [siteHost(siteUrl)])).rows[0];
        const sourceKind = existing?.source_kind || primaryKind;
        for (const target of targets.values()) {
            if (await enqueue(db, target.url, { kind: target.kind, priority: target.priority,
                from: discoveryEvidence[0], sourceKind })) result.queued++;
        }
        result.developers++;
        result.sites++;
    }
    return result;
}
