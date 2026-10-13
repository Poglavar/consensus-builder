// Runs heuristic site location over listings: signals from the listing's own text, candidate sites
// from address points/permits/parcels, weighted ranking. Checkpointed per listing; idempotent.
import { readSourceEvidence } from './compact-sources.js';
import { hasLocationSignal, listingSignals } from './site-signals.js';
import { siteCandidates, zagrebStreetIndex } from './site-candidates.js';
import { rankSites } from './site-scoring.js';

export const LOCATION_SCHEMA = 'listing-site-location.v1';
const MAX_ALTERNATIVES = 5;

function summarize(entry) {
    const site = entry.candidate;
    return { id: site.id, score: entry.score, reasons: entry.reasons, source: site.source,
        parcels: site.parcels.slice(0, 20), addressPoints: site.addressPoints, survey: [...new Set(site.survey || [])],
        permits: (site.permits || []).map(p => ({ caseId: p.caseId, klasa: p.klasa, kind: p.kind, works: p.works || p.worksDetail,
            use: p.use, finalOn: p.finalOn, decidedOn: p.decidedOn, streets: p.streets, units: p.units ?? null, gbpM2: p.gbpM2 ?? null,
            height: p.height ?? null, layers: p.layers })),
        featureIds: site.featureIds || [], pinDistanceM: site.pinDistanceM === null ? null : Math.round(site.pinDistanceM) };
}

export async function locateListing(db, listing, { observedAt = Date.now(), streetIndex } = {}) {
    const evidence = await readSourceEvidence(db,{url:listing.url,sha256:listing.current_sha256,facts:listing.facts||{}});
    if (!evidence) throw new Error('Listing source evidence is unavailable.');
    const signals = listingSignals({ facts: listing.facts || {}, text: evidence.building.text, title: listing.facts?.title || '', streetIndex });
    const candidates = await siteCandidates(db, signals);
    const ranking = rankSites(candidates, signals, { observedAt });
    return { schema: LOCATION_SCHEMA, status: ranking.status, margin: ranking.margin, signals,
        sourceSha256: listing.current_sha256, candidates: ranking.ranked.slice(0, MAX_ALTERNATIVES).map(summarize),
        candidateCount: ranking.ranked.length };
}

export async function locateSites(db, { limit = 100, urls = null, recheck = false, deadline = Infinity, log = console.log } = {}) {
    const streetIndex = await zagrebStreetIndex(db);
    const rows = (await db.query(`SELECT l.url, l.facts, l.last_observed_at, t.current_sha256
        FROM floor_plan.listing l JOIN floor_plan.target t ON t.url = l.url
        JOIN floor_plan.blob b ON b.sha256 = t.current_sha256
        LEFT JOIN floor_plan.observation o ON o.url=l.url AND o.sha256=t.current_sha256
        WHERE ($1::text[] IS NULL OR l.url = ANY($1::text[]))
          AND (b.bytes_available OR (o.evidence->'sourcePacket'->>'schema'='processed-source-evidence.v1'
            AND o.evidence->'sourcePacket'->'source'->>'sha256'=t.current_sha256
            AND o.evidence->'sourcePacket'->'source'->>'url'=l.url))
          AND ($2 OR l.location_checked_at IS NULL OR l.location->>'sourceSha256' IS DISTINCT FROM t.current_sha256)
          AND l.facts->>'sourceEvidenceStatus' IS DISTINCT FROM 'not-a-listing'
        ORDER BY l.location_checked_at NULLS FIRST, l.url LIMIT $3`, [urls, recheck, limit])).rows;
    const result = { selected: rows.length, processed: 0, located: 0, probable: 0, ambiguous: 0, unresolved: 0, failed: 0, deferred: 0 };
    const started = Date.now();
    for (const listing of rows) {
        if (Date.now() >= deadline) { result.deferred = rows.length - result.processed - result.failed; break; }
        try {
            const observedAt = listing.last_observed_at ? new Date(listing.last_observed_at).getTime() : Date.now();
            const location = await locateListing(db, listing, { observedAt, streetIndex });
            // The listing's own signals also decide eligibility for retained postings parsed before the relaxed gate.
            const { schema, ...locationSignals } = location.signals;
            const flags = { locationSignals, hasLocationSignal: Boolean(listing.facts?.explicitLocation) || hasLocationSignal(location.signals) };
            await db.query(`UPDATE floor_plan.listing SET location=$2, location_status=$3, facts=facts||$4::jsonb,
                location_checked_at=now(), updated_at=now() WHERE url=$1`,
            [listing.url, JSON.stringify(location), location.status, JSON.stringify(flags)]);
            result[location.status]++;
            result.processed++;
        } catch (error) {
            result.failed++;
            log(JSON.stringify({ at: new Date().toISOString(), stage: 'locate-sites', url: listing.url, error: error.message }));
        }
        const done = result.processed + result.failed;
        if (done % 25 === 0 || done === rows.length) {
            const elapsed = (Date.now() - started) / 1000;
            log(JSON.stringify({ at: new Date().toISOString(), stage: 'locate-sites', progress: `${done}/${rows.length}`,
                etaS: Math.round(elapsed / done * (rows.length - done)), ...result }));
        }
    }
    return result;
}
