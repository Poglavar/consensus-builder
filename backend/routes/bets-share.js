// GET /bets/:account — the shareable link to one agreement's bet, named by the agreement's chain
// account (frontend/js/bets/bets-link.js builds it). The page carries Open Graph tags with the bet's
// question, its chance and its pool and the agreement's thumbnail, so a chat or a timeline unfurls
// the bet, and it sends a browser straight on to the app form, /?city=<id>&bets=<account>, which
// opens the bet's dialog. nginx on the frontend host proxies /bets/ here
// (backend/nginx/urbangametheory.xyz.nginx.conf); without that proxy the host's fallback serves
// index.html and the app reads the same path itself, only without a preview.

import { createRequire } from 'node:module';
import { buildContests } from '../markets/contests.js';
import { agreementByAccount, defaultMarketReader } from './markets.js';

const require = createRequire(import.meta.url);
// The same codecs the sheet renders with, so the preview quotes the numbers the row will show.
const BetsLink = require('../../frontend/js/bets/bets-link.js');
const BetsModel = require('../../frontend/js/bets/bets-model.js');
const MarketQuestion = require('../../frontend/js/bets/market-question.js');

const DEFAULT_PUBLIC_BASE_URL = 'https://urbangametheory.xyz';
const DEFAULT_IMAGE_PATH = '/images/og-globe-20261019.jpg';
const SITE_NAME = 'Consensus Builder';
const TAGLINE = 'Bet on cities';
const CACHE_SECONDS = 60;

export function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// The one line a preview card shows under the title, from the row the sheet would render.
export function describeRow(row) {
    if (!row) return `${TAGLINE}: bet on whether an agreement executes on-chain.`;
    const pool = row.pool === null || row.pool === undefined ? null : `Pool ${row.pool} USDC`;
    switch (row.state) {
        case 'open': {
            const pays = `Yes pays ${row.paysYes.toFixed(2)}×, no pays ${row.paysNo.toFixed(2)}×.`;
            if (row.chanceYes === null) return `No bets yet · ${pool} · Bet on on-chain execution.`;
            // One side alone is not a chance worth printing: "100%" on a single 0.25 USDC bet misleads.
            if (row.oneSided) return `Only ${row.oneSided} bets so far · ${pool} · ${pays}`;
            return `Yes: ${row.chanceYes}% of pool · ${pool} · ${pays}`;
        }
        case 'resolved-yes': return `Settled yes: Executed on-chain · ${pool}.`;
        case 'resolved-no': return `Settled no: Cancelled or Expired on-chain · ${pool}.`;
        case 'needs-market': return 'No pool yet · Open the pool and bet on on-chain execution.';
        case 'settling': return `Decided on-chain · ${pool} · Anyone can settle the pool.`;
        default: return 'Not open for bets.';
    }
}

function absoluteImage(screenshotUrl, publicBaseUrl, apiBaseUrl) {
    const value = typeof screenshotUrl === 'string' ? screenshotUrl.trim() : '';
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith('/') && apiBaseUrl) return `${apiBaseUrl}${value}`;
    return `${publicBaseUrl}${DEFAULT_IMAGE_PATH}`;
}

// The whole page: tags for crawlers, an immediate hand-over for people. The hand-over is a meta
// refresh, not a script: the API's content security policy allows no inline script, and crawlers
// read the tags either way.
export function renderPage({ title, description, image, canonical, next }) {
    const safeNext = escapeHtml(next);
    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}">
    <meta name="robots" content="noindex">
    <link rel="canonical" href="${escapeHtml(canonical)}">
    <meta property="og:title" content="${escapeHtml(title)}">
    <meta property="og:description" content="${escapeHtml(description)}">
    <meta property="og:image" content="${escapeHtml(image)}">
    <meta property="og:url" content="${escapeHtml(canonical)}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="${SITE_NAME}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:site" content="@UrbanGameTheory">
    <meta name="twitter:title" content="${escapeHtml(title)}">
    <meta name="twitter:description" content="${escapeHtml(description)}">
    <meta name="twitter:image" content="${escapeHtml(image)}">
    <meta http-equiv="refresh" content="0; url=${safeNext}">
</head>
<body>
    <p>Opening the bet… <a href="${safeNext}">Continue</a></p>
</body>
</html>
`;
}

export function setupBetsShareRoute(app, pool, options = {}) {
    const env = options.env || process.env;
    const readMarkets = options.readMarkets || defaultMarketReader(env);
    const publicBaseUrl = String(options.publicBaseUrl || env.PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL).replace(/\/+$/, '');
    const apiBaseUrl = String(options.apiBaseUrl || env.PUBLIC_API_BASE_URL || '').replace(/\/+$/, '');
    const now = typeof options.now === 'function' ? options.now : () => new Date();

    app.get('/bets/:account', async (req, res) => {
        const account = BetsLink.accountOf(req.params.account);
        const city = BetsLink.cityOf(req.query.city);
        const lang = typeof req.query.lang === 'string' ? req.query.lang : null;
        const generic = {
            title: `${TAGLINE} · ${SITE_NAME}`,
            description: describeRow(null),
            image: `${publicBaseUrl}${DEFAULT_IMAGE_PATH}`,
            canonical: `${publicBaseUrl}/`,
            next: BetsLink.appHref({ city, lang })
        };
        res.type('html');
        if (!account) return res.status(400).send(renderPage(generic));
        try {
            const agreement = await agreementByAccount(pool, account);
            if (!agreement) return res.status(404).send(renderPage(generic));
            const markets = await readMarkets([account]);
            const { contests } = buildContests({ city: agreement.city, agreements: [agreement], markets, now: now() });
            const entry = contests.flatMap(contest => contest.agreements).find(item => item.account === account) || null;
            const row = entry ? BetsModel.row(entry) : null;
            // The link's own city wins (it is the id the app was opened in); the agreement's is the fallback.
            const linkCity = city || BetsLink.cityOf(agreement.city);
            const label = BetsModel.labelOf(agreement) || 'this agreement';
            const page = {
                title: `${MarketQuestion.agreementQuestion(label)} · ${TAGLINE}`,
                description: describeRow(row),
                // The preview shows before and after side by side when the pair has been rendered.
                image: absoluteImage(agreement.screenshotPairUrl || agreement.screenshotUrl, publicBaseUrl, apiBaseUrl),
                canonical: BetsLink.build({ origin: publicBaseUrl, city: linkCity, account }),
                next: BetsLink.appHref({ city: linkCity, account, lang })
            };
            res.set('Cache-Control', `public, max-age=${CACHE_SECONDS}`);
            res.send(renderPage(page));
        } catch (error) {
            console.error(`[${new Date().toISOString()}] GET /bets/${account} failed:`, error);
            // People still get to the app; only the preview is lost.
            res.status(502).send(renderPage({ ...generic, next: BetsLink.appHref({ city, account, lang }) }));
        }
    });
}
