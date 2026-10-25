// The link-preview Worker (workers/og-proposals/src/worker.js, plan-design-agreement.md M2): a shared
// /designs/<cid> or /agreements/<cid> link gets the record's own title, description and image in its
// <head>, read from the index by CID, and /…/<cid>/og-image.png redirects to the record's hosted
// picture. Cloudflare's HTMLRewriter and fetch are replaced by recording stand-ins.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../workers/og-proposals/src/worker.js';

const env = { API_BASE: 'https://api.example', SITE_BASE: 'https://site.example' };
const DESIGN = 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq';
const AGREEMENT = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';
const DEFAULT_IMAGE = 'https://urbangametheory.xyz/images/og-globe-20261019.jpg';
const SPA = '<html><head><title>Consensus Builder</title></head><body></body></html>';

// HTMLRewriter as the Worker uses it: selector handlers, then transform. The head handler's appended
// markup is what the crawler would see; the selectors it strips are recorded.
class FakeRewriter {
    static last = null;
    constructor() { this.handlers = []; FakeRewriter.last = this; }
    on(selector, handler) { this.handlers.push({ selector, handler }); return this; }
    transform(response) {
        let appended = '';
        const head = { append: html => { appended += html; } };
        this.handlers.filter(({ selector }) => selector === 'head').forEach(({ handler }) => handler.element(head));
        this.appended = appended;
        return new Response(appended, { headers: response.headers });
    }
}

function serve(records = {}) {
    const fetchImpl = vi.fn(async (input) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.startsWith(env.API_BASE)) {
            const path = new URL(url).pathname;
            return path in records ? Response.json(records[path]) : new Response('{}', { status: 404 });
        }
        return new Response(SPA, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    });
    vi.stubGlobal('fetch', fetchImpl);
    return fetchImpl;
}
const meta = (html, key) => (html.match(new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)">`)) || [])[1];
const get = path => worker.fetch(new Request(`https://site.example${path}`), env);

beforeEach(() => {
    vi.stubGlobal('HTMLRewriter', FakeRewriter);
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe('per-link previews of designs and agreements', () => {
    it('uses a named plan title and previews its exact design selection', async () => {
        serve({ [`/plans/${AGREEMENT}`]: { cid: AGREEMENT, content: { title: 'Digbeth Green Quarter', designCids: [DESIGN] } } });
        const html = await (await get(`/plans/${AGREEMENT}`)).text();
        expect(meta(html, 'og:title')).toBe('Digbeth Green Quarter · Urban Game Theory');
        expect(meta(html, 'og:image')).toBe(`${env.SITE_BASE}/plans/${AGREEMENT}/og-image.png`);
        const image = await get(`/plans/${AGREEMENT}/og-image.png`);
        expect(image.headers.get('location')).toBe(`${env.API_BASE}/map-previews/${DESIGN}/image.png`);
    });
    it('gives an agreement link its own card, read from the index by CID', async () => {
        const fetchImpl = serve({ [`/agreements/${AGREEMENT}`]: { cid: AGREEMENT, content: { title: 'Riverside deal', description: 'Two owners   swap\nland.' } } });
        const res = await get(`/agreements/${AGREEMENT}?utm_source=chat`);
        const html = await res.text();
        expect(fetchImpl).toHaveBeenCalledWith(`${env.API_BASE}/agreements/${AGREEMENT}`);
        expect(meta(html, 'og:title')).toBe('Riverside deal · Urban Game Theory');
        expect(meta(html, 'og:description')).toBe('Two owners swap land.');
        expect(meta(html, 'og:image')).toBe(`${env.SITE_BASE}/agreements/${AGREEMENT}/og-image.png`);
        expect(meta(html, 'og:image:width')).toBeUndefined();
        expect(meta(html, 'twitter:card')).toBe('summary_large_image');
        // The canonical link drops tracking parameters, so search engines see one page per record.
        expect(html).toContain(`<link rel="canonical" href="https://site.example/agreements/${AGREEMENT}">`);
        expect(html).toContain('<title>Riverside deal · Urban Game Theory</title>');
        expect(FakeRewriter.last.handlers.map(({ selector }) => selector)).toEqual(expect.arrayContaining([
            'head title', 'head meta[property^="og:"]', 'head meta[name^="twitter:"]', 'head meta[name="description"]', 'head link[rel="canonical"]'
        ]));
    });

    it('describes an NGO consultation from its agreement, with a website, design count and stated deadline', async () => {
        const fetchImpl = serve({ [`/agreements/${AGREEMENT}`]: { cid: AGREEMENT, content: {
            title: 'Riverside consultation', rule: { electorate: 'community', binding: false },
            consultation: { organiser: 'did:web:community.example:chapter' },
            designs: [{ cid: DESIGN }, { cid: DESIGN }], deadline: '2026-11-01T00:00:00.000Z',
            description: 'A description that does not state the kind of agreement.'
        } } });
        const html = await (await get(`/agreements/${AGREEMENT}`)).text();
        expect(meta(html, 'og:title')).toBe('Riverside consultation · Urban Game Theory');
        expect(meta(html, 'og:description')).toBe('Nonbinding community consultation by community.example about 2 designs. Closes 1 Nov 2026.');
        expect(meta(html, 'twitter:description')).toBe(meta(html, 'og:description'));
        expect(fetchImpl.mock.calls.map(([input]) => typeof input === 'string' ? input : input.url)).toEqual([
            `https://site.example/agreements/${AGREEMENT}`, `${env.API_BASE}/agreements/${AGREEMENT}`
        ]);
    });

    it.each([null, 'invalid deadline', '2026-02-30T00:00:00.000Z'])('does not invent an organiser or closing date for %s', async deadline => {
        serve({ [`/agreements/${AGREEMENT}`]: { content: { rule: { electorate: 'community' }, designs: [{ cid: DESIGN }], deadline } } });
        const html = await (await get(`/agreements/${AGREEMENT}`)).text();
        expect(meta(html, 'og:title')).toBe('Community consultation · Urban Game Theory');
        expect(meta(html, 'og:description')).toBe('Nonbinding community consultation about 1 design.');
    });

    it('reads a multi-chunk UnixFS agreement for its consultation card and image', async () => {
        const cid = AGREEMENT.replace('bafkrei', 'bafybei');
        const fetchImpl = serve({ [`/agreements/${cid}`]: { content: { rule: { electorate: 'community' }, designs: [] }, screenshotUrl: 'https://api.example/consultation.png' } });
        const html = await (await get(`/agreements/${cid}`)).text();
        expect(meta(html, 'og:description')).toBe('Nonbinding community consultation about 0 designs.');
        expect(fetchImpl).toHaveBeenCalledWith(`${env.API_BASE}/agreements/${cid}`);
        expect((await get(`/agreements/${cid}/og-image.png`)).headers.get('location')).toBe('https://api.example/consultation.png');
    });

    it('uses the full design list for metadata and image URL without fetching one design as representative', async () => {
        const second = 'bafkreid2zzzld3ix5ws24s3qn3ghwqsot7byya2sgrh4txbyjtwy2oabtq';
        const fetchImpl = serve({ [`/designs/${DESIGN}`]: { cid: DESIGN, content: { title: null } } });
        const html = await (await get(`/designs/${DESIGN},${second}`)).text();
        expect(fetchImpl.mock.calls.some(([url]) => String(url).startsWith(`${env.API_BASE}/designs/`))).toBe(false);
        expect(fetchImpl).not.toHaveBeenCalledWith(`${env.API_BASE}/designs/${second}`);
        expect(meta(html, 'og:title')).toBe('2 designs · Urban Game Theory');
        expect(meta(html, 'og:description')).toBe('Explore a shared plan composed of 2 urban development designs.');
        expect(meta(html, 'og:image')).toBe(`${env.SITE_BASE}/designs/${DESIGN},${second}/og-image.png`);
        expect(meta(html, 'og:image:width')).toBe('1200');
        expect(meta(html, 'og:image:height')).toBe('630');
        expect(html).toContain(`<link rel="canonical" href="https://site.example/designs/${DESIGN},${second}">`);
    });

    it('preserves the existing single design metadata with the unified image route', async () => {
        serve({ [`/designs/${DESIGN}`]: { cid: DESIGN, content: { title: 'Single proposal' } } });
        const html = await (await get(`/designs/${DESIGN}`)).text();
        expect(meta(html, 'og:title')).toBe('Single proposal · Urban Game Theory');
        expect(meta(html, 'og:image')).toBe(`${env.SITE_BASE}/designs/${DESIGN}/og-image.png`);
        expect(meta(html, 'og:image:width')).toBe('1200');
        expect(meta(html, 'og:image:height')).toBe('630');
    });

    it('keeps a usable title when the single design index lookup is unavailable', async () => {
        serve({});
        const html = await (await get(`/designs/${DESIGN}`)).text();
        expect(meta(html, 'og:title')).toBe('Design · Urban Game Theory');
        expect(meta(html, 'og:image')).toBe(`${env.SITE_BASE}/designs/${DESIGN}/og-image.png`);
    });

    it('rejects a design list if any CID is invalid', async () => {
        const fetchImpl = serve({});
        const html = await (await get(`/designs/${DESIGN},bad`)).text();
        expect(meta(html, 'og:title')).toBe('Consensus Builder');
        expect(meta(html, 'og:image')).toBe(DEFAULT_IMAGE);
        expect(fetchImpl.mock.calls.some(([url]) => String(url).startsWith(env.API_BASE))).toBe(false);
    });

    it('keeps the site card for a link that names no CID, or a record the index does not hold', async () => {
        for (const path of ['/designs/42', `/agreements/${AGREEMENT}`]) {
            const fetchImpl = serve({});
            const html = await (await get(path)).text();
            expect(meta(html, 'og:title'), path).toBe('Consensus Builder');
            expect(meta(html, 'og:image'), path).toBe(DEFAULT_IMAGE);
            if (path === '/designs/42') expect(fetchImpl.mock.calls.some(([url]) => String(url).startsWith(env.API_BASE))).toBe(false);
        }
    });

    it('escapes record text into the markup it injects', async () => {
        serve({ [`/designs/${DESIGN}`]: { cid: DESIGN, content: { title: '"><script>alert(1)</script>' } } });
        const html = await (await get(`/designs/${DESIGN}`)).text();
        expect(html).not.toContain('<script>');
        expect(meta(html, 'og:title')).toBe('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; · Urban Game Theory');
    });
});

describe('the record image route', () => {
    it('redirects design lists to the backend plan preview endpoint', async () => {
        const fetchImpl = serve({});
        const second = 'bafkreid2zzzld3ix5ws24s3qn3ghwqsot7byya2sgrh4txbyjtwy2oabtq';
        const res = await get(`/designs/${DESIGN},${second}/og-image.png`);
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe(`${env.API_BASE}/map-previews/${DESIGN},${second}/image.png`);
        expect(fetchImpl).not.toHaveBeenCalledWith(`${env.API_BASE}/designs/${DESIGN}`);
    });

    it('rejects an image list containing any invalid CID', async () => {
        const fetchImpl = serve({});
        const res = await get(`/designs/${DESIGN},bad/og-image.png`);
        expect(res.headers.get('location')).toBe(DEFAULT_IMAGE);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
    it.each([
        [{ screenshotPairUrl: 'https://api.example/uploads/images/pair.png', screenshotUrl: 'https://api.example/uploads/images/after.png' }, 'https://api.example/uploads/images/pair.png'],
        [{ screenshotPairUrl: null, screenshotUrl: 'https://api.example/uploads/images/after.png' }, 'https://api.example/uploads/images/after.png'],
        [{ screenshotPairUrl: '/uploads/images/relative.png', screenshotUrl: null }, DEFAULT_IMAGE]
    ])('redirects agreement images to the hosted before/after pair, else thumbnail, else site card', async (record, location) => {
        serve({ [`/agreements/${AGREEMENT}`]: { cid: AGREEMENT, ...record } });
        const res = await get(`/agreements/${AGREEMENT}/og-image.png`);
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe(location);
    });

    it('answers the site card for a path that is not a CID, without asking the index', async () => {
        const fetchImpl = serve({});
        const res = await get('/agreements/not-a-cid/og-image.png');
        expect(res.headers.get('location')).toBe(DEFAULT_IMAGE);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('passes every other path through untouched', async () => {
        const fetchImpl = serve({});
        FakeRewriter.last = null;
        const res = await get('/proposals/12');
        expect(await res.text()).toBe(SPA);
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(FakeRewriter.last).toBeNull();
    });
});
