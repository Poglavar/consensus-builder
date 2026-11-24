import { createRequire } from 'node:module';
import * as z from 'zod/v4';
import { createHash } from 'node:crypto';
import { canonicalBytes } from '../cid.js';
import { client } from '../property-offers/onchain.js';
import { prepareAcceptance } from '../property-offers/acceptance.js';
const require = createRequire(import.meta.url);
const Offer = require('../../frontend/js/property-offer-record.js');
const Consent = require('../../frontend/js/property-offer-consent.js');
export function createPropertyOfferTools({ apiBase, appOrigin, fetchImpl = fetch }) {
    const draft = offer => { const content = Offer.published(offer); return { cid: Offer.cid(content), content, publication: 'private' }; };
    async function request(path, body) {
        const response = await fetchImpl(`${apiBase}/property-offers${path}`, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(30000),
            ...(body ? { headers: { 'Content-Type': 'application/json', Origin: new URL(appOrigin).origin }, body: JSON.stringify(body) } : {}) });
        const result = await response.json();
        if (!response.ok && !(response.status === 409 && result.cid)) throw new Error(result.error || `HTTP ${response.status}`);
        return result;
    }
    return {
        draft: ({ offer }) => draft(offer),
        edit: ({ offer, expectedCid, changes }) => {
            if (Offer.cid(offer) !== expectedCid) throw new Error('The offer revision differs from expectedCid.');
            return draft({ ...offer, ...changes });
        },
        list: ({ city, xrayBuilding, unit, limit = 20, offset = 0 }) => {
            const params = new URLSearchParams({ ...(city ? { city } : {}), limit, offset });
            if (xrayBuilding !== undefined || unit !== undefined) {
                if (!city) throw new Error('Supply the city for the selected apartment.');
                Offer.apartmentKey({ xrayBuilding, unit });
                params.set('xrayBuilding', xrayBuilding);
                params.set('unit', unit);
            }
            return request(`?${params}`);
        },
        get: async ({ cid }) => { const row = await request(`/${encodeURIComponent(cid)}`); if (Offer.cid(row.content) !== cid) throw new Error('Offer CID mismatch.'); return row; },
        prepare: ({ offer, expectedCid, ownershipHash, buyer, seller, payouts, consents = [] }) => {
            const { cid, content } = draft(offer);
            if (cid !== expectedCid) throw new Error('The offer differs from expectedCid.');
            buyer = content.direction === 'buy' ? content.proposer : buyer;
            seller = content.direction === 'sell' ? content.proposer : seller;
            client.getOfferPda(cid, buyer); client.getOfferPda(cid, seller);
            if (buyer === seller) throw new Error('Buyer and seller must differ.');
            const schedule = Offer.published({ ...content, direction: 'sell', buyer: null, seller: content.proposer,
                payouts: content.direction === 'sell' ? content.payouts : payouts }).payouts;
            const candidate = { cid, offer: client.getOfferPda(cid, content.proposer)[0].toBase58(),
                termsHash: createHash('sha256').update(canonicalBytes(content)).digest('hex'),
                payoutsHash: Buffer.from(client.payoutScheduleHash(schedule)).toString('hex'), ...(content.apartment ? {} : { ownershipHash }), buyer, seller, payouts: schedule, consents };
            const sessionId = prepareAcceptance({ cid, content }, candidate).id;
            return { cid, candidate, sessionId, sharingMessage: Consent.sessionMessage({ cid, id: sessionId }), sellerMessages: content.apartment ? [] : schedule.map(row => ({ owner: row.recipient,
                message: Consent.sellerConsentMessage({ ...candidate, seller: row.recipient }) })),
                requestMessage: Consent.requestMessage(candidate), publication: 'private' };
        },
        consent: async ({ operation, cid, id, candidate, requester, signature, owner, confirm }) => {
            if (operation === 'get') return request(`/${cid}/acceptances/${id}`);
            if (confirm !== true) throw new Error('Sharing terms or a signature requires confirm=true.');
            if (operation === 'share') {
                const shared = await request(`/${cid}/acceptances`, { candidate, requester, signature });
                const url = new URL(`/property-offers/${cid}`, appOrigin); url.searchParams.set('acceptance', shared.id);
                const offer = await request(`/${cid}`); url.searchParams.set('city', offer.content.city);
                return { ...shared, url: url.href };
            }
            if (operation === 'add-consent') return request(`/${cid}/acceptances/${id}/consents`, { owner, signature });
            throw new Error('Unknown acceptance operation.');
        },
        publish: async ({ offer, expectedCid, confirm }) => {
            if (confirm !== true) throw new Error('Publication requires confirm=true.');
            const { cid, content } = draft(offer);
            if (cid !== expectedCid) throw new Error('The reviewed offer differs from expectedCid.');
            await request('', { cid, content });
            const row = await request(`/${cid}`);
            if (Offer.cid(row.content) !== cid) throw new Error('Published offer CID mismatch.');
            const url = new URL(`/property-offers/${cid}`, appOrigin); url.searchParams.set('city', content.city);
            return { ...row, publication: 'published', url: url.href };
        }
    };
}
export function registerPropertyOfferTools(server, { handler, env, fetchImpl }) {
    const actions = createPropertyOfferTools({ apiBase: (env.UGT_API_BASE || env.AGENT_API_BASE || 'https://api.urbangametheory.xyz').replace(/\/$/, ''), appOrigin: env.UGT_APP_ORIGIN || 'https://urbangametheory.xyz', fetchImpl });
    const apartment = z.object({ xrayBuilding: z.string(), unit: z.string(), at: z.string(), access: z.enum(['auto', 'point', 'corridor']).optional() });
    const parcels = z.array(z.object({ sourceId: z.string(), id: z.string(), snapshotId: z.string().optional() }));
    const offer = z.object({ schema: z.literal('property-offer/v1'), apartment: apartment.optional(), parcels: parcels.optional() }).passthrough();
    const cid = z.string().regex(/^baf(?:krei|ybei)[a-z2-7]{52}$/);
    const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
    const changes = z.object({ title: z.string().nullable().optional(), city: z.string().optional(), expiresAt: z.string().optional(),
        direction: z.enum(['buy', 'sell']).optional(), proposer: z.string().optional(), buyer: z.string().nullable().optional(), seller: z.string().nullable().optional(),
        lens: z.string().optional(), apartment: apartment.nullable().optional(), parcels: parcels.nullable().optional(),
        priceLamports: z.string().optional(), payouts: z.array(z.object({ recipient: z.string(), lamports: z.string() })).nullable().optional() });
    const specs = [
        ['draft', 'Create private buy or sell terms in SOL for one X-ray apartment or a parcel bundle. The proposer chooses the lens. Return canonical content for review or browser import.', z.object({ offer })],
        ['edit', 'Edit explicit purchase/sale fields of an inspected revision; published terms retain their CID. No wallet signature or publication.', z.object({ offer, expectedCid: cid, changes })],
        ['list', 'List published property offers. Supply city, xrayBuilding and unit together for open, anchored offers on one apartment.', z.object({ city: z.string().optional(), xrayBuilding: z.string().optional(), unit: z.string().optional(), limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().min(0).max(1000000).default(0) })],
        ['get', 'Read canonical purchase/sale offer terms and indexed settlement state.', z.object({ cid })],
        ['prepare', 'Prepare or edit an acceptance JSON package and exact wallet messages for the reviewed offer. Parcel offers require ownershipHash from the lens check. Apartment offers use the named lens’s counterparty qualification and require no ownershipHash.', z.object({ offer, expectedCid: cid, ownershipHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), buyer: z.string(), seller: z.string(), payouts: z.array(z.object({ recipient: z.string(), lamports: z.string() })).max(16).optional(), consents: z.array(z.object({ owner: z.string(), signature: z.string().max(128) })).max(16).default([]) })],
        ['consent', 'Inspect shared acceptance terms or relay a wallet-signed sharing request or seller consent. prepare returns the sharing message. Mutations require confirm=true; signatures are supplied, never generated by this tool.', z.object({ operation: z.enum(['get', 'share', 'add-consent']), cid, id: z.string().regex(/^[a-f0-9]{64}$/).optional(), candidate: z.object({}).passthrough().optional(), requester: z.string().optional(), owner: z.string().optional(), signature: z.string().max(128).optional(), confirm: z.boolean().optional() })],
        ['publish', 'Publish the exact reviewed purchase/sale offer. Requires confirm=true and expectedCid; does not sign, fund or accept a financial transaction.', z.object({ offer, expectedCid: cid, confirm: z.literal(true) })]
    ];
    // Publishing terms and relaying wallet-signed consents are public writes like ugt_publish_design:
    // nothing here signs, funds or settles, so none is destructive (the hosted server's signing/paid
    // guard). They share the hosted publish budget.
    const write = { publish: { ...read, readOnlyHint: false }, consent: { ...read, readOnlyHint: false, idempotentHint: false } };
    const gated = operation => args => {
        if (operation === 'publish' || (operation === 'consent' && args?.operation !== 'get')) server.ugtPublishGate?.();
        return actions[operation](args);
    };
    for (const [operation, description, inputSchema] of specs) server.registerTool(`ugt_${operation}_property_offer`, {
        description, inputSchema, annotations: write[operation] || read
    }, handler(gated(operation)));
}
