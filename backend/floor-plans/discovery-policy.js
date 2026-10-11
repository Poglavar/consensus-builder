// Eurovilla's translated search sitemap is a generated taxonomy, not a listing index.
// Keep canonical pages discovered through other sources eligible for crawling.
const EUROVILLA_HOST = 'eurovilla.hr';
const SEARCH_SITEMAP_PATH = /^\/sitemap-searches-[a-z]{2}\.xml\.gz$/i;

function parsedUrl(value) {
  try { return new URL(value); } catch { return null; }
}

function isEurovillaSearchSitemap(value) {
  const url = parsedUrl(value);
  return Boolean(url && url.hostname.replace(/^www\./i, '').toLowerCase() === EUROVILLA_HOST
    && SEARCH_SITEMAP_PATH.test(url.pathname));
}

export function isGeneratedSearchTarget({ url, kind, discovered_from: discoveredFrom = null } = {}) {
  if (kind === 'sitemap') return isEurovillaSearchSitemap(url);
  return kind === 'page' && isEurovillaSearchSitemap(discoveredFrom);
}

const EUROVILLA_HOST_SQL = `regexp_replace(lower(split_part(t.url,'/',3)),'^www\\.','')='eurovilla.hr'`;
const SEARCH_SITEMAP_PATH_SQL = `regexp_replace(t.url,'^https?://[^/]+','') ~* '^/sitemap-searches-[a-z]{2}\\.xml\\.gz$'`;
export const DEFERRED_GENERATED_SEARCH_SQL = `(
  ${EUROVILLA_HOST_SQL}
  AND (
    (t.kind='sitemap' AND ${SEARCH_SITEMAP_PATH_SQL})
    OR (t.kind='page' AND t.discovered_from IS NOT NULL
      AND regexp_replace(t.discovered_from,'^https?://[^/]+','') ~* '^/sitemap-searches-[a-z]{2}\\.xml\\.gz$'
      AND regexp_replace(lower(split_part(t.discovered_from,'/',3)),'^www\\.','')='eurovilla.hr')
  )
)`;
