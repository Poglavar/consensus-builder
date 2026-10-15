// Reconcile every evidenced agency/studio seed, then rank residential new-build discovery first.
// The broad queue remains intact: old buildings and unresolved sources can still be visited.
import studios from './architecture-studios.json' with { type: 'json' };
import { importArchitectureSites } from './architecture-sites.js';
import { importWebsiteCandidates, seedKnownSites } from './agency-sites.js';
import developers from './developers.json' with { type: 'json' };
import { importDeveloperSites } from './developer-sites.js';

async function importDeveloperRoster(db) { return importDeveloperSites(db, developers); }

export async function refreshSourceRoster(db) {
    const architecture = await importArchitectureSites(db, studios);
    const developers = await importDeveloperRoster(db);
    const records = (await db.query(`SELECT registry_id,registry_record,registry_source FROM floor_plan.agency
        WHERE in_scope AND COALESCE(registry_record->>'website','')<>''`)).rows;
    const agencies = await importWebsiteCandidates(db, records.map(row => ({ registry_id: row.registry_id,
        website: row.registry_record.website, evidenceUrl: row.registry_source, basis: 'official-registry-website' })));
    const seeded = await seedKnownSites(db);
    const ranked = await prioritizeResidentialSources(db);
    return { architecture, developers, agencies, ...seeded, ...ranked };
}

export async function prioritizeResidentialSources(db) {
    // A stored new-build claim earns priority, not an eligibility exception. Verified map location
    // still gates assets; homes and contact pages still establish the source's legal identity.
    const updated = await db.query(`UPDATE floor_plan.target t SET priority=GREATEST(t.priority,75),updated_at=now()
        WHERE t.kind='page' AND t.priority<75 AND t.exclusion_reason IS NULL
          AND (t.url ~* '(novograd|new-build|new-construction|stamben|residential|housing)'
            OR EXISTS(SELECT 1 FROM floor_plan.listing l WHERE l.url=t.url AND
                (l.facts->>'newBuild'='true' OR l.facts#>>'{propertyDetails,newBuild}'='true')))`);
    const assets = await db.query(`UPDATE floor_plan.target t SET priority=GREATEST(t.priority,120),updated_at=now()
        WHERE t.kind='asset' AND t.priority<120 AND t.exclusion_reason IS NULL
          AND EXISTS(SELECT 1 FROM floor_plan.listing l WHERE l.location_status IN ('located','probable')
            AND (l.facts->>'newBuild'='true' OR l.facts#>>'{propertyDetails,newBuild}'='true')
            AND l.asset_urls @> jsonb_build_array(jsonb_build_object('url',t.url,'listingOwned',true,'kind','floor-plan')))`);
    return { prioritizedPages: updated.rowCount, prioritizedPlans: assets.rowCount };
}
