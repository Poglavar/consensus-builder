// Resolve listings through explicit source bindings or exact addressed cadastral identities.
import { readFile } from 'node:fs/promises';
import { fingerprint, validateModelIdentity } from '../buildings/floor-models.js';
import { normalizeUrl } from './page-evidence.js';

export function addressKey(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    // Postcodes and settlements are not house addresses. Accept only a named street
    // followed by a plausible house number, suffix, or number range.
    for (const part of value.split(',')) {
        const normalized = part.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
            .replace(/\bulica\b/g, ' ').replace(/[^a-z0-9/ -]/g, ' ').replace(/\s+/g, ' ').trim();
        if (/\d{5}/.test(normalized)) continue;
        const match = normalized.match(/^(.+?)(\d{1,4}[a-z]?(?:\s*[-/]\s*\d{1,4}[a-z]?)?)$/);
        if (!match) continue;
        const street = match[1].replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (!/[a-z]{2}/.test(street)) continue;
        const number = match[2].replace(/\s+/g, '');
        return `${street} ${number}`;
    }
    return null;
}

export function prepareBinding(input) {
    const identity = validateModelIdentity(input);
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(identity.city)
        || !/^[a-z0-9][a-z0-9._:-]{0,99}$/.test(identity.source)) {
        throw new Error('Binding city and source must be canonical identifiers.');
    }
    if (!['listing', 'project', 'address'].includes(input.match?.kind)) throw new Error('Invalid building binding match kind.');
    const value = input.match.kind === 'address' ? addressKey(input.match.value) : normalizeUrl(input.match.value);
    if (typeof input.name !== 'string' || input.name.trim() !== input.name || input.name.length < 2 || input.name.length > 255
        || !value || !input.evidence || typeof input.evidence !== 'object' || Array.isArray(input.evidence)
        || typeof input.evidence.basis !== 'string' || !input.evidence.basis.trim() || input.evidence.basis.length > 1000
        || !normalizeUrl(input.evidence.sourceUrl)) {
        throw new Error('A binding needs an exact match, building name, and independent source evidence.');
    }
    return { ...identity, name: input.name, matchKind: input.match.kind, matchValue: value,
        footprint: input.footprint || null, evidence: input.evidence,
        id: fingerprint([identity, input.match.kind, value]) };
}

export async function importBuildingBindings(db, document) {
    if (document?.schema !== 'consensus-builder.building-bindings.v1' || !Array.isArray(document.bindings)) throw new Error('Expected building-bindings.v1.');
    const bindings = document.bindings.map(prepareBinding);
    for (const b of bindings) await db.query(`INSERT INTO floor_plan.building_binding
        (id,city,source,owner_id,building_id,name,match_kind,match_value,footprint,evidence)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,footprint=excluded.footprint,evidence=excluded.evidence,updated_at=now()
        WHERE (floor_plan.building_binding.name,floor_plan.building_binding.footprint,floor_plan.building_binding.evidence)
        IS DISTINCT FROM (excluded.name,excluded.footprint,excluded.evidence)`,
    [b.id,b.city,b.source,b.ownerId,b.buildingId,b.name,b.matchKind,b.matchValue,b.footprint,JSON.stringify(b.evidence)]);
    return { bindings: bindings.length };
}

export async function seedReviewedBindings(db) {
    const source = JSON.parse(await readFile(new URL('../../rekonstrukcije/avenue-v/floor-plan-sources.json', import.meta.url), 'utf8'));
    const identity = {city:'zagreb',source:'landmark',buildingId:source.building.landmarkId,name:source.building.name};
    const evidence = {basis:'Reviewed project and unit source manifest',sourceUrl:source.building.developerUrl};
    const imported = await importBuildingBindings(db,{schema:'consensus-builder.building-bindings.v1',bindings:[
        {...identity,match:{kind:'project',value:source.building.agencyProjectUrl},evidence},
        ...source.units.map(unit=>({...identity,match:{kind:'listing',value:unit.listingUrl},
            evidence:{basis:'Reviewed project/unit drawing association',sourceUrl:unit.url}}))
    ]});
    const augmented = await augmentReviewedUnitAssets(db, source.units);
    return {...imported, ...augmented};
}

export async function augmentReviewedUnitAssets(db, units) {
    let attached = 0, skipped = 0;
    for (const unit of units) {
        const listingUrl = normalizeUrl(unit.listingUrl), sourceUrl = normalizeUrl(unit.url);
        const sourceId = listingUrl && new URL(listingUrl).pathname.match(/\/(\d+)\/?$/)?.[1];
        if (!listingUrl || !sourceUrl || !sourceId || !/^[a-f\d]{64}$/i.test(unit.sha256 || '')) {
            skipped++;
            continue;
        }
        const asset = {url:sourceUrl,kind:'floor-plan',listingOwned:true,
            associationBasis:'reviewed-source-manifest',evidenceUrl:sourceUrl,sha256:unit.sha256.toLowerCase()};
        const result = await db.query(`UPDATE floor_plan.listing l
            SET asset_urls=CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(l.asset_urls,'[]'::jsonb)) AS q(asset)
                    WHERE q.asset->>'url'=$4)
                THEN (SELECT jsonb_agg(CASE WHEN q.asset->>'url'=$4 THEN q.asset || ($3::jsonb->0) ELSE q.asset END ORDER BY q.ordinal)
                    FROM jsonb_array_elements(COALESCE(l.asset_urls,'[]'::jsonb)) WITH ORDINALITY AS q(asset,ordinal))
                ELSE COALESCE(l.asset_urls,'[]'::jsonb) || $3::jsonb END,
                updated_at=now()
            WHERE l.url=$1 AND l.source_id=$2 AND l.facts->>'sourceId'=$2
              AND EXISTS(SELECT 1 FROM floor_plan.target t WHERE t.url=$4 AND t.kind='asset' AND t.current_sha256=$5)
              AND NOT (COALESCE(l.asset_urls,'[]'::jsonb) @> $3::jsonb)
            RETURNING l.url`, [listingUrl,sourceId,JSON.stringify([asset]),sourceUrl,unit.sha256.toLowerCase()]);
        if (result.rowCount) attached++;
        else skipped++;
    }
    return {reviewedAssetsAttached:attached,reviewedAssetsSkipped:skipped};
}

function identityKey(row) { return JSON.stringify([row.city,row.source,row.owner_id||'',String(row.building_id)]); }

export function chooseBinding(listing, bindings, projectUrls = []) {
    const keys = {listing:normalizeUrl(listing.url),address:addressKey(listing.facts?.address)};
    const projects = new Set([listing.facts?.projectUrl,...projectUrls].map(url=>normalizeUrl(url)).filter(Boolean));
    const found = bindings.filter(binding => binding.match_kind === 'project' ? projects.has(binding.match_value)
        : keys[binding.match_kind] && keys[binding.match_kind] === binding.match_value);
    // An exact source URL can still refer to a multi-building project; ambiguity is retained.
    const identities = new Set(found.map(identityKey));
    return identities.size === 1 ? found[0] : null;
}

async function addressedBuildings(db) {
    const relations=(await db.query(`SELECT to_regclass('buildings.dating_building') AS addresses,
        to_regclass('public.dgu_gdi_building_match') AS matches,to_regclass('public.gdi_building_3d') AS buildings`)).rows[0];
    if(!relations.addresses || !relations.matches || !relations.buildings) return [];
    return (await db.query(`SELECT d.id,d.address,d.lat,d.lng,m.object_id::text AS building_id,
        ST_AsGeoJSON(ST_Transform(b.geom2d_3765,4326))::jsonb AS footprint
        FROM buildings.dating_building d JOIN public.dgu_gdi_building_match m USING(zgrada_id)
        JOIN public.gdi_building_3d b ON b.object_id=m.object_id
        WHERE d.zgrada_id IS NOT NULL AND m.building_overlap_ratio>=0.9 AND m.footprint_overlap_ratio>=0.9`)).rows;
}

export function chooseAddressedBuilding(listing, rows) {
    const key=addressKey(listing.facts?.address),c=listing.facts?.coordinates;
    if(!key || !Number.isFinite(c?.lat) || !Number.isFinite(c?.lng)) return null;
    const candidates=rows.filter(row=>addressKey(row.address)===key && Number.isFinite(row.lat) && Number.isFinite(row.lng)
        && Math.hypot((row.lng-c.lng)*111320*Math.cos(c.lat*Math.PI/180),(row.lat-c.lat)*111320)<=100);
    if(new Set(candidates.map(r=>r.building_id)).size!==1) return null;
    const row=candidates[0];
    return {city:'zagreb',source:'zagreb-3d',owner_id:'',building_id:row.building_id,name:row.address,footprint:row.footprint,
        evidence:{basis:'Exact street and house number in building address inventory; source map corroborates; cadastral/survey overlap >=90% in both directions',
            address:row.address,addressRecordId:row.id,sourceUrl:listing.url}};
}

export async function resolveBuildingLinks(db,{limit=10000,deadline=Infinity,log=console.log}={}) {
    const bindings=(await db.query('SELECT * FROM floor_plan.building_binding')).rows;
    const addresses=await addressedBuildings(db);
    const memberships=(await db.query(`SELECT t.url,o.evidence->'projectListings' AS listings
        FROM floor_plan.target t JOIN floor_plan.observation o ON (o.url,o.sha256)=(t.url,t.current_sha256)
        WHERE o.evidence ? 'projectListings' AND EXISTS(SELECT 1 FROM floor_plan.building_binding b WHERE b.match_kind='project' AND b.match_value=t.url)`)).rows;
    const projectsByListing=new Map();
    for(const row of memberships) for(const listing of row.listings || []) {
        const url=normalizeUrl(listing.url);if(!url) continue;
        projectsByListing.set(url,[...(projectsByListing.get(url)||[]),row.url]);
    }
    const rows=(await db.query(`SELECT url,facts,match_status,building_id,building_source FROM floor_plan.listing
        WHERE (match_status<>'verified' OR building_city IS NULL)
        AND facts->>'sourceEvidenceStatus' IS DISTINCT FROM 'not-a-listing'
        AND (match_checked_at IS NULL OR match_checked_at<=now()-interval '1 day')
        ORDER BY match_checked_at NULLS FIRST,match_checked_at,updated_at,url LIMIT $1`,[limit])).rows;
    const result={processed:0,verified:0,unresolved:0,deferred:0};
    for(const listing of rows) {
        if(Date.now()>=deadline) { result.deferred=rows.length-result.processed; break; }
        const binding=chooseBinding(listing,bindings,projectsByListing.get(normalizeUrl(listing.url))||[])
            || chooseAddressedBuilding(listing,addresses);
        if(binding && (listing.match_status!=='verified' || (binding.building_id===listing.building_id && binding.source===listing.building_source))) {
            await db.query(`UPDATE floor_plan.listing SET match_status='verified',building_city=$2,building_source=$3,
                building_owner_id=$4,building_id=$5,building_evidence=$6,match_checked_at=now(),updated_at=now() WHERE url=$1`,
            [listing.url,binding.city,binding.source,binding.owner_id||'',binding.building_id,
                JSON.stringify({...binding.evidence,bindingId:binding.id||null,name:binding.name,footprint:binding.footprint,automatic:true})]);
            result.verified++;
        } else {
            await db.query(`UPDATE floor_plan.listing SET match_checked_at=now(),updated_at=now() WHERE url=$1`,[listing.url]);
            result.unresolved++;
        }
        result.processed++;
    }
    log(JSON.stringify({at:new Date().toISOString(),stage:'building-resolution',...result}));
    return result;
}
