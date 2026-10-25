// Cloudflare Worker: per-link social preview (og:image / twitter:card) for shared design and
// agreement links (plan-design-agreement.md M2). Social/forum crawlers do not run JS, so the SPA's
// static <head> makes every share look identical. This Worker sits in front of
// urbangametheory.xyz/designs/* and /agreements/* and injects per-link meta before the crawler sees
// the HTML, and serves the record's image at a stable URL. Link shapes:
//   /designs/<cid>[,<cid>…]               -> one preview framed around the whole plan
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
            ...(m.imageDimensions ? [['og:image:width', m.imageDimensions.width], ['og:image:height', m.imageDimensions.height]] : []),
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
    { prefix: '/agreements/', api: 'agreements', label: 'Agreement' },
    { prefix: '/plans/', api: 'plans', label: 'Plan' }
]);
// CIDv1 UnixFS files: raw single chunks or dag-pb roots, sha2-256, base32 (59 characters).
const CID = /^baf(?:krei|ybei)[a-z2-7]{52}$/;

async function readRecord(kind, cid, env) {
    const resp = await fetch(`${env.API_BASE}/${kind.api}/${encodeURIComponent(cid)}`);
    return resp.ok ? resp.json() : null;
}

function consultationDescription(content) {
    const parts = ['Nonbinding community consultation'];
    const organiser = content.consultation?.organiser;
    // Only the immutable agreement is read: naming its organiser never verifies that website.
    if (typeof organiser === 'string' && organiser.startsWith('did:web:')) {
        const host = organiser.slice(8).split(':')[0].replace(/%3A/gi, ':');
        if (host) parts.push(`by ${host}`);
    }
    if (Array.isArray(content.designs)) {
        const count = content.designs.length;
        parts.push(`about ${count} ${count === 1 ? 'design' : 'designs'}`);
    }
    let text = parts.join(' ') + '.';
    if (typeof content.deadline === 'string') {
        const deadline = new Date(content.deadline);
        if (Number.isFinite(deadline.getTime()) && deadline.toISOString() === content.deadline) {
            text += ` Closes ${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(deadline)}.`;
        }
    }
    return clip(text);
}

// The card of a design or agreement: its title and description come from its CID-addressed content.
async function recordMeta(kind, cid, url, env, base) {
    const record = await readRecord(kind, cid, env);
    if (!record) return base;
    const content = record.content || {};
    const community = kind.api === 'agreements' && content.rule?.electorate === 'community';
    return {
        ...base,
        title: `${content.title || (community ? 'Community consultation' : kind.label)} · ${DEFAULTS.siteName}`,
        description: community ? consultationDescription(content) : content.description ? clip(content.description) : base.description,
        // Routed through our image endpoint (Route 2), so the card URL is stable and absolute.
        image: `${env.SITE_BASE}/${kind.api}/${encodeURIComponent(cid)}/og-image.png`,
        url: url.toString()
    };
}

// Design images redirect to the backend's combined plan preview. Agreement images redirect to the
// hosted before/after pair, else their thumbnail, else the site card. Scenes already have a hosted PNG.
async function handleRecordImage(kind, cid, env) {
    if (kind.api === 'designs') {
        const cids = cid.split(',');
        if (!cids.length || cids.some(value => !CID.test(value))) {
            return Response.redirect(DEFAULTS.image, 302);
        }
        const target = `${env.API_BASE}/map-previews/${cids.join(',')}/image.png`;
        return Response.redirect(target, 302);
    }
    const record = CID.test(cid) ? await readRecord(kind, cid, env) : null;
    if (kind.api === 'plans') {
        const cids = record?.content?.designCids;
        if (Array.isArray(cids) && cids.length && cids.every(value => CID.test(value))) {
            return Response.redirect(`${env.API_BASE}/map-previews/${cids.join(',')}/image.png`, 302);
        }
    }
    const hosted = record && (record.screenshotPairUrl || record.screenshotUrl);
    if (hosted && /^https?:\/\//.test(hosted)) return Response.redirect(hosted, 302);
    return Response.redirect(DEFAULTS.image, 302);
}

async function handleHtml(kind, url, request, env) {
    const originResp = await fetch(request); // origin index.html (SPA fallback); unchanged for humans
    const ct = originResp.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return originResp;

    const cids = url.pathname.slice(kind.prefix.length).split(',');
    const validDesignList = kind.api !== 'designs' || (cids.length > 0 && cids.every(cid => CID.test(cid)));
    // Canonical drops tracking and debug parameters; only ?scene= names a different page.
    const canonical = new URL(url.origin + url.pathname);
    if (url.searchParams.get('scene')) canonical.searchParams.set('scene', url.searchParams.get('scene'));
    let meta = { ...DEFAULTS, url: url.toString(), canonical: canonical.toString() };
    try {
        const scene = url.searchParams.get('scene');
        if (scene) meta = await sceneMeta(scene, url, env, meta);
        else if (kind.api === 'designs' && validDesignList) {
            const count = cids.length;
            meta = {
                ...meta,
                title: count === 1 ? `Design · ${DEFAULTS.siteName}` : `${count} designs · ${DEFAULTS.siteName}`,
                description: count === 1
                    ? 'Explore this urban development design.'
                    : `Explore a shared plan composed of ${count} urban development designs.`,
                image: `${env.SITE_BASE}/designs/${cids.map(encodeURIComponent).join(',')}/og-image.png`,
                imageDimensions: { width: 1200, height: 630 },
                url: canonical.toString()
            };
            if (count === 1) meta = await recordMeta(kind, cids[0], url, env, meta);
        }
        else if ((kind.api === 'agreements' || kind.api === 'plans') && cids.length === 1 && CID.test(cids[0])) meta = await recordMeta(kind, cids[0], url, env, meta);
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
