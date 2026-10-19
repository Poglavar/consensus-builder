// Cloudflare Worker: per-link social preview (og:image / twitter:card) for /proposals/* links.
// Social/forum crawlers do not run JS, so the SPA's static <head> makes every share look identical.
// This Worker sits in front of urbangametheory.xyz/proposals/* and injects per-link meta before the
// crawler sees the HTML, and serves a proposal's image at a stable URL. Two link shapes:
//   /proposals/:ids                       -> the proposal(s)' own preview
//   /proposals/:ids?scene=<slug>          -> a shared AI render: card = the AI image itself
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

async function proposalMeta(firstId, url, env, base) {
    const resp = await fetch(`${env.API_BASE}/proposals/${encodeURIComponent(firstId)}`);
    if (!resp.ok) return base;
    const p = await resp.json();
    const title = p.title || p.name || `Proposal #${firstId}`;
    return {
        ...base,
        title: `${title} · ${DEFAULTS.siteName}`,
        description: p.description ? clip(p.description) : base.description,
        // The proposal's own image may be a data: URL server-side, so route the card through our
        // image endpoint (Route 2), which always yields absolute PNG bytes.
        image: `${env.SITE_BASE}/proposals/${encodeURIComponent(firstId)}/og-image.png`,
        url: url.toString()
    };
}

// Route 2: serve a proposal's image as real PNG bytes at a stable URL (redirect hosted/IPFS, decode
// data: URLs). Scenes don't use this — their imageUrl is already an absolute hosted PNG.
async function handleProposalImage(id, env) {
    const resp = await fetch(`${env.API_BASE}/proposals/${encodeURIComponent(id)}`);
    if (!resp.ok) return Response.redirect(DEFAULTS.image, 302);
    const p = await resp.json();

    const hosted = p.screenshotUrl || (p.onchainData && p.onchainData.imageUrl);
    if (hosted && /^https?:\/\//.test(hosted)) {
        return Response.redirect(hosted, 302);
    }
    const dataUrl = p.screenshotDataUrl || (p.proposal_data && p.proposal_data.screenshotDataUrl);
    const m = typeof dataUrl === 'string' && dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (m) {
        const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
        return new Response(bytes, {
            headers: { 'Content-Type': m[1], 'Cache-Control': 'public, max-age=86400' }
        });
    }
    return Response.redirect(DEFAULTS.image, 302);
}

async function handleHtml(url, request, env) {
    const originResp = await fetch(request); // origin index.html (SPA fallback); unchanged for humans
    const ct = originResp.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return originResp;

    const ids = url.pathname.replace(/^\/proposals\//, '').split(',').map(s => s.trim()).filter(Boolean);
    const firstId = ids[0];
    // Canonical drops tracking and debug parameters; only ?scene= names a different page.
    const canonical = new URL(url.origin + url.pathname);
    if (url.searchParams.get('scene')) canonical.searchParams.set('scene', url.searchParams.get('scene'));
    let meta = { ...DEFAULTS, url: url.toString(), canonical: canonical.toString() };
    try {
        const scene = url.searchParams.get('scene');
        if (scene) meta = await sceneMeta(scene, url, env, meta);
        else if (firstId) meta = await proposalMeta(firstId, url, env, meta);
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

        const imgMatch = path.match(/^\/proposals\/([^/]+)\/og-image\.png$/);
        if (imgMatch) return handleProposalImage(imgMatch[1], env);

        if (path.startsWith('/proposals/')) return handleHtml(url, request, env);

        return fetch(request); // not ours — pass through
    }
};
