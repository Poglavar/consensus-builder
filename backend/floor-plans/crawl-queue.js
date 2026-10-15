// Fair, bounded selection from the durable target queue.
import { DEFERRED_GENERATED_SEARCH_SQL } from './discovery-policy.js';
import { NEGATIVE_IMAGE_CACHE_SQL } from './image-retention.js';
import { ALLOWED_TARGET_SQL } from './source-policy.js';
const hostSql = url => `regexp_replace(lower(split_part(${url},'/',3)),'^www\\.','')`;
const HOST_SQL = hostSql('t.url');
export function normalizeSiteHost(site) {
  if (site == null) return null;
  if (typeof site !== 'string' || !/^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/i.test(site))
    throw new Error('Site must be a hostname such as opereta.hr.');
  return site.toLowerCase().replace(/^www\./, '');
}

const planAssetSql = listing => `(${['floor-plan','document'].map(kind =>
  `${listing}.asset_urls @> jsonb_build_array(jsonb_build_object('url',t.url,'listingOwned',true,'kind','${kind}'))`).join(' OR ')})`;

// Assets belong to a site through a listing page, not their CDN host or agency_id.
function siteScopeSql(site, parameter, planAssetsOnly = false) {
  if (!site) return '';
  return `AND ((t.kind IN ('home','sitemap','page') AND ${HOST_SQL}=${parameter})
    OR (t.kind='asset' AND t.url IN (
      SELECT asset->>'url'
      FROM floor_plan.listing site_listing
      CROSS JOIN LATERAL jsonb_array_elements(site_listing.asset_urls) AS asset
      WHERE ${hostSql('site_listing.url')}=${parameter}
        AND site_listing.facts->>'sourceEvidenceStatus' IS DISTINCT FROM 'not-a-listing'
        AND asset->'listingOwned'='true'::jsonb
        ${planAssetsOnly ? "AND asset->>'kind' IN ('floor-plan','document')" : ''})))`;
}
export const MATCHED_ASSET_SQL = `EXISTS (
  SELECT 1 FROM floor_plan.listing l
  WHERE l.match_status='verified' AND l.building_id IS NOT NULL
    AND l.asset_urls @> jsonb_build_array(jsonb_build_object('url',t.url,'listingOwned',true))
)`;
export const OWNED_ASSET_SQL = `EXISTS (
  SELECT 1 FROM floor_plan.listing l
  WHERE l.facts->>'sourceEvidenceStatus' IS DISTINCT FROM 'not-a-listing'
    AND l.asset_urls @> jsonb_build_array(jsonb_build_object('url',t.url,'listingOwned',true))
)`;
export const PLAN_ASSET_SQL = `EXISTS (
  SELECT 1 FROM floor_plan.listing l
  WHERE l.facts->>'sourceEvidenceStatus' IS DISTINCT FROM 'not-a-listing'
    AND ${planAssetSql('l')}
)`;
export const LOCATED_ASSET_SQL = `EXISTS (
  SELECT 1 FROM floor_plan.listing l
  WHERE l.asset_urls @> jsonb_build_array(jsonb_build_object('url',t.url,'listingOwned',true))
    AND (l.location_status IN ('located','probable')
      OR (l.match_status='verified' AND l.building_id IS NOT NULL))
)`;

function stageFilter(stage) {
  if (stage === 'homes') return `t.kind='home'`;
  if (stage === 'sitemaps') return `t.kind='sitemap' AND (t.discovered_from IS NULL OR regexp_replace(t.discovered_from,'^https?://[^/]+','') IN ('','/'))`;
  if (stage === 'nestedSitemaps') return `t.kind='sitemap' AND t.discovered_from IS NOT NULL AND regexp_replace(t.discovered_from,'^https?://[^/]+','') NOT IN ('','/')`;
  if (stage === 'pages') return `t.kind='page'`;
  return `t.kind='asset'`;
}

export async function revisitKnownTargets(db, { site } = {}) {
  site = normalizeSiteHost(site);
  if (!site) throw new Error('A site is required for revisiting known targets.');
  const result = await db.query(`UPDATE floor_plan.target t SET next_check_at=LEAST(next_check_at,now()),updated_at=now()
    WHERE ${HOST_SQL}=$1 AND t.kind IN ('home','sitemap','page') AND t.current_sha256 IS NOT NULL
      AND ${ALLOWED_TARGET_SQL} AND NOT ${DEFERRED_GENERATED_SEARCH_SQL}`, [site]);
  return { targets: result.rowCount };
}

export function createTargetSelector({ agencyId = null, site = null, discoveryOnly = false, assetOnly = false, matchedAssetsOnly = false, ownedAssetsOnly = false, planAssetsOnly = false, knownFirst = false } = {}) {
  site=normalizeSiteHost(site);
  const visitedHosts = new Map();
  let stage = assetOnly ? 'assets' : 'homes';
  let nestedSweepHadWork = false;
  let pageSweepRequired = false;
  const assetFilters = [LOCATED_ASSET_SQL, `NOT ${NEGATIVE_IMAGE_CACHE_SQL}`,matchedAssetsOnly ? MATCHED_ASSET_SQL : null,
    ownedAssetsOnly && !site ? OWNED_ASSET_SQL : null,
    planAssetsOnly && !site ? PLAN_ASSET_SQL : null]
    .filter(Boolean).map(filter => `AND ${filter}`).join('\n        ');

  async function choose(db, current) {
    const excluded = [...(visitedHosts.get(current) || [])];
    const sql = `SELECT t.*,COALESCE(b.bytes_available,false) AS cached_bytes_available,
      (b.discard_reason='processed-source.v1' AND EXISTS(SELECT 1 FROM floor_plan.observation o
        WHERE o.url=t.url AND o.sha256=t.current_sha256
          AND o.evidence->'sourcePacket'->>'schema'='processed-source-evidence.v1'
          AND o.evidence->'sourcePacket'->'source'->>'sha256'=t.current_sha256
          AND o.evidence->'sourcePacket'->'source'->>'url'=t.url
          AND o.evidence->'sourcePacket'->'building'->'source'->>'sha256'=t.current_sha256
          AND o.evidence->'sourcePacket'->'building'->'source'->>'url'=t.url)) AS cached_processed,
      b.storage_path AS cached_storage_path,b.byte_count AS cached_byte_count FROM floor_plan.target t
      LEFT JOIN floor_plan.blob b ON b.sha256=t.current_sha256
      WHERE t.next_check_at<=now()
        AND ${ALLOWED_TARGET_SQL}
        AND ($1::bigint IS NULL OR t.agency_id=$1)
        ${siteScopeSql(site,'$3',planAssetsOnly)}
        AND ${stageFilter(current)}
        ${current === 'assets' ? '' : `AND NOT ${DEFERRED_GENERATED_SEARCH_SQL}`}
        AND NOT (${HOST_SQL}=ANY($2::text[]))
        ${current === 'assets' ? assetFilters : ''}
      ORDER BY t.priority DESC, (t.last_fetched_at IS NULL) ${knownFirst ? 'ASC' : 'DESC'},
        t.next_check_at, ${HOST_SQL}, t.url
      LIMIT 1`;
    return (await db.query(sql, site ? [agencyId, excluded, site] : [agencyId, excluded])).rows[0] || null;
  }

  const record = (target, current) => {
    const seen = visitedHosts.get(current) || new Set();
    seen.add(new URL(target.url).host.replace(/^www\./, ''));
    visitedHosts.set(current, seen);
  };

  return async db => {
    for (;;) {
      let target = await choose(db, stage);
      if (target) {
        const current = stage;
        record(target, current);
        if (current === 'nestedSitemaps') nestedSweepHadWork = true;
        if (current === 'pages' && !discoveryOnly && !assetOnly) stage = 'assets';
        else if (current === 'assets' && !discoveryOnly && !assetOnly) stage = 'pages';
        return target;
      }

      if (stage === 'homes') { stage = 'sitemaps'; continue; }
      if (stage === 'sitemaps') {
        visitedHosts.set(stage, new Set());
        target = await choose(db, stage);
        if (target) { record(target, stage); return target; }
        stage = 'nestedSitemaps';
        continue;
      }
      if (stage === 'nestedSitemaps') {
        // Fetch at most one nested map per host before giving discovered pages a turn.
        visitedHosts.set(stage, new Set());
        pageSweepRequired = nestedSweepHadWork;
        nestedSweepHadWork = false;
        stage = 'pages';
        continue;
      }
      if (stage === 'pages') {
        target = await choose(db, stage); // One page per host per sweep; nested maps get turns between sweeps.
        if (target) {
          record(target, stage);
          if (!discoveryOnly && !assetOnly) stage = 'assets';
          return target;
        }
        visitedHosts.set(stage, new Set());
        if (pageSweepRequired) {
          pageSweepRequired = false;
          stage = 'nestedSitemaps';
          continue;
        }
        target = await choose(db, stage); // Drain remaining pages after the nested-map sweep is exhausted.
        if (target) {
          record(target, stage);
          if (!discoveryOnly && !assetOnly) stage = 'assets';
          return target;
        }
        if (!discoveryOnly && !assetOnly) { stage = 'assets'; continue; }
        return null;
      }
      if (stage === 'assets') {
        visitedHosts.set(stage, new Set());
        target = await choose(db, stage);
        if (target) {
          record(target, stage);
          if (!discoveryOnly && !assetOnly) stage = 'pages';
          return target;
        }
        if (discoveryOnly || assetOnly) return null;
        stage = 'pages';
        target = await choose(db, stage);
        if (target) { record(target, stage); stage = 'assets'; return target; }
        visitedHosts.set(stage, new Set());
        if (pageSweepRequired) {
          pageSweepRequired = false;
          stage = 'nestedSitemaps';
          continue;
        }
        target = await choose(db, stage);
        if (target) { record(target, stage); stage = 'assets'; return target; }
        return null;
      }
      return null;
    }
  };
}

export async function countPendingTargets(db, { agencyId = null, site = null, discoveryOnly = false, assetOnly = false, matchedAssetsOnly = false, ownedAssetsOnly = false, planAssetsOnly = false } = {}) {
  site=normalizeSiteHost(site);
  const kindFilter = discoveryOnly ? `t.kind IN ('home','sitemap','page')` : assetOnly ? `t.kind='asset'` : `TRUE`;
  const matchFilter = matchedAssetsOnly ? `AND ${assetOnly ? MATCHED_ASSET_SQL : `(t.kind<>'asset' OR ${MATCHED_ASSET_SQL})`}` : '';
  // For site-scoped assets, siteScopeSql already enforces ownership and (when
  // requested) plan/document kind from the same listing asset element.
  const ownedFilter = ownedAssetsOnly && !site ? `AND ${assetOnly ? OWNED_ASSET_SQL : `(t.kind<>'asset' OR ${OWNED_ASSET_SQL})`}` : '';
  const planFilter = planAssetsOnly && !site ? `AND ${assetOnly ? PLAN_ASSET_SQL : `(t.kind<>'asset' OR ${PLAN_ASSET_SQL})`}` : '';
  const parameters=site ? [agencyId,site] : [agencyId];
  const pending = Number((await db.query(`SELECT count(*) AS n FROM floor_plan.target t
    WHERE t.next_check_at<=now() AND ($1::bigint IS NULL OR t.agency_id=$1)
      AND ${ALLOWED_TARGET_SQL}
      ${siteScopeSql(site,'$2',planAssetsOnly)}
      AND ${kindFilter} ${matchFilter} ${ownedFilter} ${planFilter}
      AND (t.kind<>'asset' OR ${LOCATED_ASSET_SQL})
      AND NOT ${NEGATIVE_IMAGE_CACHE_SQL}
      AND NOT ${DEFERRED_GENERATED_SEARCH_SQL}`, parameters)).rows[0].n);
  const deferredUnlocatedAssets = Number((await db.query(`SELECT count(*) AS n FROM floor_plan.target t
    WHERE t.kind='asset' AND t.next_check_at<=now()
      AND ${ALLOWED_TARGET_SQL}
      AND NOT ${NEGATIVE_IMAGE_CACHE_SQL}
      AND ($1::bigint IS NULL OR t.agency_id=$1)
      ${siteScopeSql(site,'$2',planAssetsOnly)}
      AND ${OWNED_ASSET_SQL}
      AND NOT ${LOCATED_ASSET_SQL}`, parameters)).rows[0].n);
  let deferredUnmatchedAssets = 0;
  if (discoveryOnly || matchedAssetsOnly) {
    deferredUnmatchedAssets = Number((await db.query(`SELECT count(*) AS n FROM floor_plan.target t
      WHERE t.kind='asset' AND t.next_check_at<=now()
        AND ${ALLOWED_TARGET_SQL}
        AND NOT ${NEGATIVE_IMAGE_CACHE_SQL}
        AND ($1::bigint IS NULL OR t.agency_id=$1)
        ${siteScopeSql(site,'$2',planAssetsOnly)}
        AND NOT ${MATCHED_ASSET_SQL}`, parameters)).rows[0].n);
  }
  let deferredUnownedAssets = 0;
  if ((discoveryOnly || matchedAssetsOnly || ownedAssetsOnly) && !site) {
    deferredUnownedAssets = Number((await db.query(`SELECT count(*) AS n FROM floor_plan.target t
      WHERE t.kind='asset' AND t.next_check_at<=now()
        AND ${ALLOWED_TARGET_SQL}
        AND NOT ${NEGATIVE_IMAGE_CACHE_SQL}
        AND ($1::bigint IS NULL OR t.agency_id=$1)
        ${siteScopeSql(site,'$2',planAssetsOnly)}
        AND NOT ${OWNED_ASSET_SQL}`, parameters)).rows[0].n);
  }
  const deferredGeneratedSearchTargets = Number((await db.query(`SELECT count(*) AS n FROM floor_plan.target t
    WHERE t.next_check_at<=now() AND ($1::bigint IS NULL OR t.agency_id=$1)
      AND ${ALLOWED_TARGET_SQL}
      ${siteScopeSql(site,'$2',planAssetsOnly)}
      AND ${DEFERRED_GENERATED_SEARCH_SQL}`, parameters)).rows[0].n);
  return { pending, deferredUnlocatedAssets, deferredUnmatchedAssets, deferredUnownedAssets, deferredGeneratedSearchTargets };
}
