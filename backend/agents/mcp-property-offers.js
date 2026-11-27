// Hosted MCP tools for property-offer/v2 (one plot or one flat, SOL or USDC) and for holding
// requests: draft, edit, list, read and publish offer terms, and prepare or relay a person's signed
// request that lens members state it holds a plot or a flat. Nothing here signs, funds or settles:
// wallets sign in the browser or through the local signer (property-offer-signer.js).
import { createRequire } from 'node:module';
import * as z from 'zod/v4';
import { apartmentUnitLocator } from './mcp-flat-address.js';
const require = createRequire(import.meta.url);
const Offer = require('../../frontend/js/property-offer-record.js');
const HoldingRequest = require('../../frontend/js/holding-request.js');

export function createPropertyOfferTools({ apiBase, appOrigin, fetchImpl = fetch, now = () => Date.now() }) {
    const draft = offer => { const content = Offer.published(offer); return { cid: Offer.cid(content), content, publication: 'private' }; };
    async function request(path, body) {
        const response = await fetchImpl(`${apiBase}${path}`, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(30000),
            ...(body ? { headers: { 'Content-Type': 'application/json', Origin: new URL(appOrigin).origin }, body: JSON.stringify(body) } : {}) });
        const result = await response.json();
        if (!response.ok && !(response.status === 409 && result.cid)) throw new Error(result.error || `HTTP ${response.status}`);
        return result;
    }
    const query = (args, names) => {
        const params = new URLSearchParams();
        for (const name of names) if (args[name] !== undefined && args[name] !== null) params.set(name, Array.isArray(args[name]) ? args[name].join(',') : String(args[name]));
        return params;
    };
    return {
        draft: ({ offer }) => draft(offer),
        edit: ({ offer, expectedCid, changes }) => {
            if (Offer.cid(offer) !== expectedCid) throw new Error('The offer revision differs from expectedCid.');
            return draft({ ...offer, ...changes });
        },
        // `awaiting` lists the committed offers waiting for that lens member's confirmation.
        list: (args = {}) => {
            const params = query({ limit: 20, offset: 0, ...args }, ['city', 'kind', 'direction', 'status', 'bbox', 'asset', 'maker', 'member', 'currency', 'limit', 'offset']);
            if (args.awaiting) return request(`/property-offers/awaiting?${query({ member: args.awaiting, limit: args.limit ?? 20, offset: args.offset ?? 0 }, ['member', 'limit', 'offset'])}`);
            return request(`/property-offers?${params}`);
        },
        get: async ({ cid }) => { const row = await request(`/property-offers/${encodeURIComponent(cid)}`); if (Offer.cid(row.content) !== cid) throw new Error('Offer CID mismatch.'); return row; },
        publish: async ({ offer, expectedCid, confirm }) => {
            if (confirm !== true) throw new Error('Publication requires confirm=true.');
            const { cid, content } = draft(offer);
            if (cid !== expectedCid) throw new Error('The reviewed offer differs from expectedCid.');
            await request('/property-offers', { cid, content });
            const row = await request(`/property-offers/${cid}`);
            if (Offer.cid(row.content) !== cid) throw new Error('Published offer CID mismatch.');
            const url = new URL(`/property-offers/${cid}`, appOrigin); url.searchParams.set('city', content.city);
            return { ...row, publication: 'published', url: url.href };
        },
        // Without confirm: the canonical request and the exact text the claimant's wallet signs.
        // With confirm=true and the claimant's signature over that text: relayed to the index.
        requestHolding: async ({ request: raw, signature, confirm }) => {
            const prepared = HoldingRequest.normalize({ ...raw, createdAt: raw?.createdAt ?? new Date(Math.floor(now() / 1000) * 1000).toISOString() });
            const message = HoldingRequest.message(prepared);
            if (confirm !== true) return { request: prepared, message, publication: 'private', next: 'Have the claimant’s wallet sign message, then call again with signature and confirm=true.' };
            if (typeof signature !== 'string' || !signature) throw new Error('Relaying a holding request needs the claimant’s signature over message.');
            return { ...(await request('/holding-requests', { request: prepared, signature })), publication: 'published' };
        },
        listHoldingRequests: (args = {}) => request(`/holding-requests?${query({ limit: 20, offset: 0, ...args }, ['member', 'asset', 'claimant', 'city', 'limit', 'offset'])}`)
    };
}

export function registerPropertyOfferTools(server, { handler, env, fetchImpl }) {
    const actions = createPropertyOfferTools({ apiBase: (env.UGT_API_BASE || env.AGENT_API_BASE || 'https://api.urbangametheory.xyz').replace(/\/$/, ''), appOrigin: env.UGT_APP_ORIGIN || 'https://urbangametheory.xyz', fetchImpl });
    const asset = z.object({ kind: z.enum(['parcel', 'flat']), sourceId: z.string().optional(), id: z.string().optional(), xrayBuilding: z.string().optional(),
        unit: apartmentUnitLocator.optional(), at: z.string().describe('lat,lng,zoom'), access: z.enum(['point', 'corridor']).optional() })
        .describe('One plot { kind: "parcel", sourceId, id, at } or one flat { kind: "flat", xrayBuilding, unit: "6::1", at }.');
    const lens = z.object({ members: z.array(z.string()).max(8), threshold: z.number().int().min(0).max(8) });
    const payouts = z.array(z.object({ recipient: z.string(), amount: z.string() })).max(16);
    const offer = z.object({ schema: z.literal('property-offer/v2'), asset }).passthrough();
    const cid = z.string().regex(/^baf(?:krei|ybei)[a-z2-7]{52}$/);
    const key = z.string().min(32).max(44);
    const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
    const changes = z.object({ title: z.string().nullable().optional(), city: z.string().optional(), expiresAt: z.string().optional(),
        direction: z.enum(['buy', 'sell']).optional(), proposer: z.string().optional(), currency: z.enum(['SOL', 'USDC']).optional(),
        price: z.string().optional(), lens: lens.optional(), asset: asset.optional(), payouts: payouts.nullable().optional() });
    const paging = { limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().min(0).max(1000000).default(0) };
    const holding = z.object({ city: z.string(), asset, claimant: key, lensMembers: z.array(key).min(1).max(8), note: z.string().max(1000).optional(),
        createdAt: z.string().optional().describe('ISO instant; set when preparing, then passed back unchanged with the signature') });
    const specs = [
        ['ugt_draft_property_offer', 'draft', 'Create private property-offer/v2 terms to buy or sell one plot or one flat for SOL or USDC (price in base units). The maker names its side’s lens (members and threshold): a buyer’s lens confirms the seller holds the asset; a seller’s optional lens qualifies the buyer. A sale lists its payouts. Returns canonical content for review or browser import.', z.object({ offer })],
        ['ugt_edit_property_offer', 'edit', 'Edit explicit fields of an inspected revision; published terms keep their CID. No wallet signature or publication.', z.object({ offer, expectedCid: cid, changes })],
        ['ugt_list_property_offer', 'list', 'List published property offers, newest first. Without status: open or committed offers not past expiry. Filter by city, kind (parcel|flat), direction, status (comma list of unminted, open, committed, settled, cancelled, expired), bbox (west,south,east,north), asset (asset hash), maker, member (a lens member key) and currency. awaiting=<lens member key> lists the committed offers waiting for that member’s confirmation.',
            z.object({ city: z.string().optional(), kind: z.enum(['parcel', 'flat']).optional(), direction: z.enum(['buy', 'sell']).optional(), status: z.string().optional(),
                bbox: z.string().optional(), asset: z.string().regex(/^[0-9a-f]{64}$/).optional(), maker: key.optional(), member: key.optional(), currency: z.enum(['SOL', 'USDC']).optional(), awaiting: key.optional(), ...paging })],
        ['ugt_get_property_offer', 'get', 'Read canonical offer terms with their status and the Solana state the index last read (counterparty, lenses, confirmations, escrow).', z.object({ cid })],
        ['ugt_publish_property_offer', 'publish', 'Publish the exact reviewed offer. Requires confirm=true and expectedCid; does not sign, fund or settle anything.', z.object({ offer, expectedCid: cid, confirm: z.literal(true) })],
        ['ugt_request_holding', 'requestHolding', 'Ask lens members to state that a person (the claimant) holds one plot or one flat. Without confirm: returns the canonical request and the exact message the claimant’s wallet must sign. With confirm=true and that signature: relays the request to the lens members’ request list. Never signs. Whether a member answered is its PropertyHolding-v1 statement on Solana.', z.object({ request: holding, signature: z.string().max(128).optional(), confirm: z.boolean().optional() })],
        ['ugt_list_holding_requests', 'listHoldingRequests', 'List signed holding requests, newest first, by lens member, asset hash, claimant or city.', z.object({ member: key.optional(), asset: z.string().regex(/^[0-9a-f]{64}$/).optional(), claimant: key.optional(), city: z.string().optional(), ...paging })]
    ];
    // Publishing terms and relaying a wallet-signed request are public writes like ugt_publish_design:
    // nothing here signs, funds or settles, so none is destructive (the hosted server's signing/paid
    // guard). They share the hosted publish budget.
    const write = { publish: { ...read, readOnlyHint: false }, requestHolding: { ...read, readOnlyHint: false } };
    const gated = operation => args => {
        if (operation === 'publish' || (operation === 'requestHolding' && args?.confirm === true)) server.ugtPublishGate?.();
        return actions[operation](args);
    };
    for (const [name, operation, description, inputSchema] of specs) server.registerTool(name, {
        description, inputSchema, annotations: write[operation] || read
    }, handler(gated(operation)));
}
