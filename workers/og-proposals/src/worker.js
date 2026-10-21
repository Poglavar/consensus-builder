// Cloudflare Worker: per-link social preview (og:image / twitter:card) for shared design and
// agreement links (plan-design-agreement.md M2). Social/forum crawlers do not run JS, so the SPA's
// static <head> makes every share look identical. This Worker sits in front of
// urbangametheory.xyz/designs/* and /agreements/* and injects per-link meta before the crawler sees
// the HTML, and serves the record's image at a stable URL. Link shapes:
//   /designs/<cid>[,<cid>…]               -> the (first) design's own preview
//   /agreements/<cid>                     -> the agreement's own preview
//   either, with ?scene=<slug>            -> a shared AI render: card = the AI image itself
// Humans get the same HTML (SPA still boots); only <head> is augmented.

// Fallback card, used when an upstream lookup fails. We strip the page's own static og tags before
// injecting, so these values REPLACE them — they must be at least as good as the site's originals,
// and `image` must be the same public globe card used by the site’s static metadata.
const DEFAULTS = {
    siteName: 'Urban Game Theory',
    title: 'Consensus Builder',
    description: 'Help communities reach consensus on future land development.',
    image: 'https://urbangametheory.xyz/images/og-globe-20261019.jpg'
};

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Search snippets show about 160 characters: collapse whitespace and cut on a word with an ellipsis.
function clip(text, max = 160) {
    const t = String(text).replace(/\s+/g, ' ').trim();
    if (t.length <= max) return t;
    return t.slice(0, t.lastIndexOf(' ', max - 1) > 80 ? t.lastIndexOf(' ', max - 1) : max - 1) + '…';
}

// Injects the social meta tags at the end of <head>. The page's own og:/twitter:/<title> tags are
// stripped first (see handleHtml) — leaving duplicates is NOT safe: crawlers commonly honour the
// FIRST occurrence, which would be the SPA's generic site card, silently defeating the whole Worker.
class HeadInjector {
    constructor(meta) { this.meta = meta; }
    element(head) {
        const m = this.meta;
        const tags = [
            ['og:type', 'website'],
            ['og:site_name', m.siteName],
            ['og:title', m.title],
            ['og:description', m.description],
            ['og:url', m.canonical || m.url],
            ['og:image', m.image],
            ['twitter:card', 'summary_large_image'],
            ['twitter:title', m.title],
            ['twitter:description', m.description],
            ['twitter:image', m.image]
        ];
        const html = tags
            .map(([k, v]) => {
                const attr = k.startsWith('twitter:') ? 'name' : 'property';
                return `<meta ${attr}="${k}" content="${escapeHtml(v)}">`;
            })
            .join('');
        // The SPA's own description and canonical (the homepage) are stripped too: a canonical of "/"
        // on every proposal link told search engines each proposal was a duplicate of the homepage.
        const seo = `<meta name="description" content="${escapeHtml(m.description)}">`
            + `<link rel="canonical" href="${escapeHtml(m.canonical || m.url)}">`;
        head.append(`<title>${escapeHtml(m.title)}</title>${seo}${html}`, { html: true });
    }
}

async function sceneMeta(slug, url, env, base) {
    const resp = await fetch(`${env.API_BASE}/ai-scene/scene/${encodeURIComponent(slug)}`);
    if (!resp.ok) return base;
    const s = await resp.json();
    if (!s || !s.imageUrl) return base;
    const where = s.city ? ` in ${s.city}` : '';
    return {
        ...base,
        title: `AI render of an urban proposal${where} · ${DEFAULTS.siteName}`,
        description: s.prompt
            ? clip(s.prompt)
            : 'A photorealistic AI view of a proposed change to the city — open to explore it in 3D.',
        image: s.imageUrl,          // already an absolute hosted PNG — point the card straight at it
        url: url.toString()
    };
}

// The records a link can name, by path prefix, and the API route that serves each by its CID.
const RECORD_KINDS = Object.freeze([
    { prefix: '/designs/', api: 'designs', label: 'Design' },
    { prefix: '/agreements/', api: 'agreements', label: 'Agreement' }
]);
// The CID scheme of published records: CIDv1, raw, sha2-256, base32 (`bafkrei…`, 59 characters).
const CID = /^bafkrei[a-z2-7]{52}$/;

async function readRecord(kind, cid, env) {
    const resp = await fetch(`${env.API_BASE}/${kind.api}/${encodeURIComponent(cid)}`);
    return resp.ok ? resp.json() : null;
}

// The card of a design or agreement: its title and description come from its CID-addressed content.
async function recordMeta(kind, cid, url, env, base) {
    const record = await readRecord(kind, cid, env);
    if (!record) return base;
    const content = record.content || {};
    return {
        ...base,
        title: `${content.title || kind.label} · ${DEFAULTS.siteName}`,
        description: content.description ? clip(content.description) : base.description,
        // Routed through our image endpoint (Route 2), so the card URL is stable and absolute.
        image: `${env.SITE_BASE}/${kind.api}/${encodeURIComponent(cid)}/og-image.png`,
        url: url.toString()
    };
}

// Route 2: serve a record's image at a stable URL: a redirect to its hosted before/after pair (the
// server-rendered link-preview image), else its thumbnail, else the site card. Scenes don't use
// this — their imageUrl is already an absolute hosted PNG.
async function handleRecordImage(kind, cid, env) {
    const record = CID.test(cid) ? await readRecord(kind, cid, env) : null;
    const hosted = record && (record.screenshotPairUrl || record.screenshotUrl);
    if (hosted && /^https?:\/\//.test(hosted)) return Response.redirect(hosted, 302);
    return Response.redirect(DEFAULTS.image, 302);
}

async function handleHtml(kind, url, request, env) {
    const originResp = await fetch(request); // origin index.html (SPA fallback); unchanged for humans
    const ct = originResp.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return originResp;

    const cids = url.pathname.slice(kind.prefix.length).split(',').map(s => s.trim()).filter(Boolean);
    const firstCid = cids[0];
    // Canonical drops tracking and debug parameters; only ?scene= names a different page.
    const canonical = new URL(url.origin + url.pathname);
    if (url.searchParams.get('scene')) canonical.searchParams.set('scene', url.searchParams.get('scene'));
    let meta = { ...DEFAULTS, url: url.toString(), canonical: canonical.toString() };
    try {
        const scene = url.searchParams.get('scene');
        if (scene) meta = await sceneMeta(scene, url, env, meta);
        else if (firstCid && CID.test(firstCid)) meta = await recordMeta(kind, firstCid, url, env, meta);
    } catch (_) { /* keep defaults on any upstream failure */ }

    // Strip the SPA's static social tags so ours are the only ones the crawler can see, then append.
    const strip = { element(el) { el.remove(); } };
    return new HTMLRewriter()
        .on('head title', strip)
        .on('head meta[property^="og:"]', strip)
        .on('head meta[name^="twitter:"]', strip)
        .on('head meta[name="description"]', strip)
        .on('head link[rel="canonical"]', strip)
        .on('head', new HeadInjector(meta))
        .transform(originResp);
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname;

        for (const kind of RECORD_KINDS) {
            if (!path.startsWith(kind.prefix)) continue;
            const image = path.slice(kind.prefix.length).match(/^([^/]+)\/og-image\.png$/);
            if (image) return handleRecordImage(kind, image[1], env);
            return handleHtml(kind, url, request, env);
        }

        return fetch(request); // not ours — pass through
    }
};
