// Fair, bounded selection from the durable target queue.
const HOST_SQL = `regexp_replace(split_part(t.url,'/',3),'^www\\.','')`;
export const MATCHED_ASSET_SQL = `EXISTS (
  SELECT 1 FROM floor_plan.listing l
  WHERE l.match_status='verified' AND l.building_id IS NOT NULL
    AND l.asset_urls @> jsonb_build_array(jsonb_build_object('url',t.url,'listingOwned',true))
)`;

function stageFilter(stage) {
  if (stage === 'homes') return `t.kind='home'`;
  if (stage === 'sitemaps') return `t.kind='sitemap' AND (t.discovered_from IS NULL OR regexp_replace(t.discovered_from,'^https?://[^/]+','') IN ('','/'))`;
  if (stage === 'nestedSitemaps') return `t.kind='sitemap' AND t.discovered_from IS NOT NULL AND regexp_replace(t.discovered_from,'^https?://[^/]+','') NOT IN ('','/')`;
  if (stage === 'pages') return `t.kind='page'`;
  return `t.kind='asset'`;
}

export function createTargetSelector({ agencyId = null, discoveryOnly = false, assetOnly = false, matchedAssetsOnly = false } = {}) {
  const visitedHosts = new Map();
  let stage = assetOnly ? 'assets' : 'homes';
  const matched = matchedAssetsOnly ? `AND ${MATCHED_ASSET_SQL}` : '';

  async function choose(db, current) {
    const excluded = [...(visitedHosts.get(current) || [])];
    const sql = `SELECT t.* FROM floor_plan.target t
      WHERE t.next_check_at<=now()
        AND ($1::bigint IS NULL OR t.agency_id=$1)
        AND ${stageFilter(current)}
        AND NOT (${HOST_SQL}=ANY($2::text[]))
        ${current === 'assets' ? matched : ''}
      ORDER BY (t.last_fetched_at IS NULL) DESC, t.priority DESC,
        t.next_check_at, ${HOST_SQL}, t.url
      LIMIT 1`;
    return (await db.query(sql, [agencyId, excluded])).rows[0] || null;
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
        visitedHosts.set(stage, new Set()); // Later rounds drain nested sitemaps from each host.
        target = await choose(db, stage);
        if (target) { record(target, stage); return target; }
        stage = 'pages';
        continue;
      }
      if (stage === 'pages') {
        visitedHosts.set(stage, new Set());
        target = await choose(db, stage); // One page per host per round; fetches make each target not due.
        if (target) {
          record(target, stage);
          if (!discoveryOnly && !assetOnly) stage = 'assets';
          return target;
        }
        if (!discoveryOnly && !assetOnly) {
          stage = 'assets';
          continue;
        }
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
        visitedHosts.set(stage, new Set());
        target = await choose(db, stage);
        if (target) { record(target, stage); stage = 'assets'; return target; }
      }
      return null;
    }
  };
}

export async function countPendingTargets(db, { agencyId = null, discoveryOnly = false, assetOnly = false, matchedAssetsOnly = false } = {}) {
  const kindFilter = discoveryOnly ? `t.kind IN ('home','sitemap','page')`
    : assetOnly ? `t.kind='asset'`
      : matchedAssetsOnly ? `(t.kind<>'asset' OR ${MATCHED_ASSET_SQL})` : `TRUE`;
  const matchFilter = assetOnly && matchedAssetsOnly ? `AND ${MATCHED_ASSET_SQL}` : '';
  const pending = Number((await db.query(`SELECT count(*) AS n FROM floor_plan.target t
    WHERE t.next_check_at<=now() AND ($1::bigint IS NULL OR t.agency_id=$1)
      AND ${kindFilter} ${matchFilter}`, [agencyId])).rows[0].n);
  let deferredUnmatchedAssets = 0;
  if (discoveryOnly || matchedAssetsOnly) {
    deferredUnmatchedAssets = Number((await db.query(`SELECT count(*) AS n FROM floor_plan.target t
      WHERE t.kind='asset' AND t.next_check_at<=now()
        AND ($1::bigint IS NULL OR t.agency_id=$1)
        AND NOT ${MATCHED_ASSET_SQL}`, [agencyId])).rows[0].n);
  }
  return { pending, deferredUnmatchedAssets };
}
