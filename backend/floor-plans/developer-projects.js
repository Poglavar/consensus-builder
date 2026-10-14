// Narrow project-page recognition for the currently evidenced Zagreb developer seeds.
// This is intentionally not a general property-page parser.
import developers from './developers.json' with { type: 'json' };

const INDEX_PATHS = new Set([
    '/ponuda', '/projects', '/en/investments', '/investments', '/prodaja-nekretnina',
]);
const OWN_ROOTS = {
    'landmark.hr': '.entry-content',
    'pionir.hr': '.elementor',
    'kso-gradnja.hr': 'article',
    'bhb.hr': 'main',
    'mesic-com.hr': 'main',
    'vmdgrupa.hr': 'main',
    'privium.hr': '.project-detail-simple',
    'orvencapital.com': 'main#main',
    'mado.hr': '.body-margin-x',
    'novogradnjazagreb.com': 'main',
    'gradnja.nobelgrupa.hr': '#page',
};

const seedPaths = new Set(developers.records.flatMap(record => record.seed_project_urls || []).map(raw => {
    const url = new URL(raw);
    return `${url.hostname.replace(/^www\./i, '').toLowerCase()}${url.pathname.replace(/\/$/, '') || '/'}`;
}));
const EXCLUDED_PROJECT_PATHS = new Set([
    'pionir.hr/prodaja-nekretnina/savica',
    'pionir.hr/prodaja-nekretnina/borongajska-caviceva',
]);

function normalizedKey(raw) {
    try {
        const url = new URL(raw);
        return `${url.hostname.replace(/^www\./i, '').toLowerCase()}${url.pathname.replace(/\/$/, '') || '/'}`;
    } catch { return null; }
}

export function developerProjectRoot($, rawUrl) {
    const key = normalizedKey(rawUrl);
    if (!key || !seedPaths.has(key)) return null;
    if (EXCLUDED_PROJECT_PATHS.has(key)) return null;
    const [, host, path] = key.match(/^([^/]+)(\/.*)$/) || [];
    if (!host || INDEX_PATHS.has(path)) return null;
    const selector = OWN_ROOTS[host];
    if (selector) {
        const root = host === 'mado.hr'
            ? $(selector).filter((_, element) => $(element).find('h1').length).first()
            : $(selector).first();
        if (root.length) return root;
    }
    // For hosts without a distinctive content wrapper, use a single article only.
    const article = $('article').first();
    return article.length ? article : null;
}

export function extractDeveloperProject($, rawUrl) {
    const root = developerProjectRoot($, rawUrl);
    if (!root) return null;
    const scoped = root.clone();
    scoped.find('script,style,noscript,nav,footer,header,form,aside,[role="navigation"],[role="contentinfo"],[role="dialog"],[aria-hidden="true"],[hidden],[data-elementor-type="popup"],[class*="modal" i],[class*="dialog" i],[class*="popup" i],[class*="related" i],[class*="similar" i],[class*="recommend" i]').remove();
    const heading = scoped.find('h1').first().text().replace(/\s+/g, ' ').trim();
    const pageTitle = $('meta[property="og:title"]').attr('content')?.trim() || $('title').text().split('|')[0].trim();
    const title = /^(?:fotogalerija|gallery|photos)$/i.test(heading) ? pageTitle : heading || pageTitle;
    if (!title) return null;
    return { title, rootHtml: $.html(scoped), text: scoped.text().replace(/\s+/g, ' ').trim() };
}
