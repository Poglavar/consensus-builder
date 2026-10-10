// GET /bets/:proposalAccount — the shareable link to one proposal's bet (frontend/js/bets/bets-link.js
// builds it). The page carries Open Graph tags with the proposal's title, its chance and its pool,
// so a chat or a timeline unfurls the bet, and it sends a browser straight on to the app form,
// /?city=<id>&bets=<account>, which opens the Bets sheet on that row. nginx on the frontend host
// proxies /bets/ here (backend/nginx/urbangametheory.xyz.nginx.conf); without that proxy the host's
// fallback serves index.html and the app reads the same path itself, only without a preview.

import { createRequire } from 'node:module';
import { buildContests } from '../markets/contests.js';
import { PROPOSAL_COLUMNS_SQL, defaultMarketReader, defaultProposalStatusReader, rowToPlan, rowToProposal } from './markets.js';

const require = createRequire(import.meta.url);
// The same codecs the sheet renders with, so the preview quotes the numbers the row will show.
const BetsLink = require('../../frontend/js/bets/bets-link.js');
const BetsModel = require('../../frontend/js/bets/bets-model.js');

const DEFAULT_PUBLIC_BASE_URL = 'https://urbangametheory.xyz';
const DEFAULT_IMAGE_PATH = '/images/consensus-builder-logo-2.png';
const SITE_NAME = 'Consensus Builder';
const TAGLINE = 'Bet on cities';
const CACHE_SECONDS = 60;

// One minted proposal by its Solana account, whichever onchain_data field holds it (the same three
// markets/contests.js proposalAccountOf reads), newest first when a re-mint left two rows.
const PROPOSAL_BY_ACCOUNT_SQL = `
    SELECT ${PROPOSAL_COLUMNS_SQL}
    FROM proposal
    WHERE LOWER(COALESCE(onchain_data->>'chainId', onchain_data->>'chain', '')) LIKE 'solana%'
      AND $1 IN (onchain_data->>'proposalId', onchain_data->>'proposalAccount', onchain_data->>'tokenId')
    ORDER BY created_at DESC
    LIMIT 1`;

// A named plan minted as its own account (plans.md), and its members for the land and the image.
const PLAN_BY_ACCOUNT_SQL = `
    SELECT slug, title, place, author, created_at, proposal_ids, onchain_data, city
    FROM ens_plan
    WHERE LOWER(COALESCE(onchain_data->>'chainId', '')) LIKE 'solana%' AND onchain_data->>'proposalId' = $1
    LIMIT 1`;
const PLAN_MEMBERS_SQL = `SELECT ${PROPOSAL_COLUMNS_SQL} FROM proposal WHERE id = ANY($1::int[])`;

// The bet behind an account: a minted proposal, else a minted named plan. Returns what the page
// needs ({ city, title, screenshotUrl, proposals, plans }) or null.
async function betSubject(pool, proposalAccount) {
    const { rows } = await pool.query(PROPOSAL_BY_ACCOUNT_SQL, [proposalAccount]);
    if (rows.length) {
        const proposal = rowToProposal(rows[0]);
        return { city: proposal.city, title: proposal.title, screenshotUrl: proposal.screenshotUrl, proposals: [proposal], plans: [] };
    }
    const { rows: planRows } = await pool.query(PLAN_BY_ACCOUNT_SQL, [proposalAccount]);
    if (!planRows.length) return null;
    const plan = rowToPlan(planRows[0]);
    const { rows: memberRows } = await pool.query(PLAN_MEMBERS_SQL, [plan.memberIds.map(Number)]);
    const members = memberRows.map(rowToProposal);
    const byId = new Map(members.map(member => [String(member.id), member]));
    const image = plan.memberIds.map(id => byId.get(String(id))?.screenshotUrl).find(Boolean) || null;
    return { city: planRows[0].city || null, title: plan.title || plan.slug, screenshotUrl: image, proposals: members, plans: [plan] };
}

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
    if (!row) return `${TAGLINE}: bet yes or no on whether this proposal gets built.`;
    const pool = row.pool === null || row.pool === undefined ? null : `Pool ${row.pool} USDC`;
    switch (row.state) {
        case 'open': {
            const pays = `Yes pays ${row.paysYes.toFixed(2)}×, no pays ${row.paysNo.toFixed(2)}×.`;
            if (row.chanceYes === null) return `No bets yet · ${pool} · Bet yes or no on whether it gets built.`;
            // One side alone is not a chance worth printing: "100%" on a single 0.25 USDC bet misleads.
            if (row.oneSided) return `Only ${row.oneSided} bets so far · ${pool} · ${pays}`;
            return `${row.chanceYes}% chance it gets built · ${pool} · ${pays}`;
        }
        case 'resolved-yes': return `Settled yes: it gets built · ${pool}.`;
        case 'resolved-no': return `Settled no: it was dropped · ${pool}.`;
        case 'needs-market': return 'No pool yet · Open the pool and bet yes or no on whether it gets built.';
        case 'settling': return `Decided on-chain · ${pool} · Anyone can settle the pool.`;
        default: return `Decided on-chain before a pool was opened.`;
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
    const readProposalStatuses = options.readProposalStatuses || defaultProposalStatusReader(env);
    const publicBaseUrl = String(options.publicBaseUrl || env.PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL).replace(/\/+$/, '');
    const apiBaseUrl = String(options.apiBaseUrl || env.PUBLIC_API_BASE_URL || '').replace(/\/+$/, '');
    const now = typeof options.now === 'function' ? options.now : () => new Date();

    app.get('/bets/:proposalAccount', async (req, res) => {
        const proposalAccount = BetsLink.accountOf(req.params.proposalAccount);
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
        if (!proposalAccount) return res.status(400).send(renderPage(generic));
        try {
            const subject = await betSubject(pool, proposalAccount);
            if (!subject) return res.status(404).send(renderPage(generic));
            const [markets, statuses] = await Promise.all([readMarkets([proposalAccount]), readProposalStatuses([proposalAccount])]);
            const { contests } = buildContests({ city: subject.city, proposals: subject.proposals, plans: subject.plans, markets, statuses, now: now() });
            const entry = contests.flatMap(contest => contest.proposals).find(item => item.proposalAccount === proposalAccount) || null;
            const row = entry ? BetsModel.row(entry) : null;
            // The link's own city wins (it is the id the app was opened in); the row's is the fallback.
            const linkCity = city || BetsLink.cityOf(subject.city);
            const page = {
                title: `${subject.title || 'Untitled proposal'} · ${TAGLINE}`,
                description: describeRow(row),
                image: absoluteImage(subject.screenshotUrl, publicBaseUrl, apiBaseUrl),
                canonical: BetsLink.build({ origin: publicBaseUrl, city: linkCity, proposalAccount }),
                next: BetsLink.appHref({ city: linkCity, proposalAccount, lang })
            };
            res.set('Cache-Control', `public, max-age=${CACHE_SECONDS}`);
            res.send(renderPage(page));
        } catch (error) {
            console.error(`[${new Date().toISOString()}] GET /bets/${proposalAccount} failed:`, error);
            // People still get to the app; only the preview is lost.
            res.status(502).send(renderPage({ ...generic, next: BetsLink.appHref({ city, proposalAccount, lang }) }));
        }
    });
}
