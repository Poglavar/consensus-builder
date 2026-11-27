// Hosted property-offer v2 tools: the list passes its filters to the index (or asks for the offers
// awaiting one lens member), a holding request is prepared with the exact text the claimant signs and
// is relayed only with confirm=true and a supplied signature, and the registered tools and their
// annotations are the v2 set (no acceptance or consent tools).
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { Keypair } from '@solana/web3.js';
import { createPropertyOfferTools, registerPropertyOfferTools } from '../agents/mcp-property-offers.js';

const require = createRequire(import.meta.url);
const HoldingRequest = require('../../frontend/js/holding-request.js');
const [claimant, member] = [91, 92].map(n => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58());
const FLAT = { kind: 'flat', xrayBuilding: 'zagreb::gdi-3d::148972', unit: '6::4', at: '45.7665,15.9722,19' };
const json = body => ({ ok: true, status: 200, json: async () => body });

function tools() {
    const fetchImpl = vi.fn(async () => json({ ok: true }));
    return { fetchImpl, actions: createPropertyOfferTools({ apiBase: 'http://api.test', appOrigin: 'http://app.test', fetchImpl, now: () => Date.parse('2026-11-27T12:00:00.400Z') }) };
}

describe('hosted property-offer tools', () => {
    it('lists with the index filters, and the awaiting list for a lens member', async () => {
        const { actions, fetchImpl } = tools();
        await actions.list({ city: 'zagreb', kind: 'flat', status: 'open,committed', bbox: '15,45,16,46', member, limit: 5 });
        expect(fetchImpl.mock.calls[0][0]).toBe(`http://api.test/property-offers?city=zagreb&kind=flat&status=open%2Ccommitted&bbox=15%2C45%2C16%2C46&member=${member}&limit=5&offset=0`);
        await actions.list({ awaiting: member });
        expect(fetchImpl.mock.calls[1][0]).toBe(`http://api.test/property-offers/awaiting?member=${member}&limit=20&offset=0`);
    });
    it('prepares a holding request’s signed text and relays it only with confirm and a signature', async () => {
        const { actions, fetchImpl } = tools();
        const prepared = await actions.requestHolding({ request: { city: 'zagreb', asset: FLAT, claimant, lensMembers: [member] } });
        expect(prepared.request.createdAt).toBe('2026-11-27T12:00:00.000Z');
        expect(prepared.message).toBe(HoldingRequest.message(prepared.request));
        expect(fetchImpl).not.toHaveBeenCalled();
        await expect(actions.requestHolding({ request: prepared.request, confirm: true })).rejects.toThrow(/signature/);
        await actions.requestHolding({ request: prepared.request, signature: 'sig', confirm: true });
        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe('http://api.test/holding-requests');
        expect(JSON.parse(init.body)).toEqual({ request: prepared.request, signature: 'sig' });
        expect(init.headers.Origin).toBe('http://app.test');
    });
    it('registers the v2 tools; publishing and relaying are non-destructive writes behind the publish gate', async () => {
        const registered = new Map(), gate = vi.fn();
        const server = { ugtPublishGate: gate, registerTool: (name, spec, run) => registered.set(name, { spec, run }) };
        registerPropertyOfferTools(server, { handler: fn => fn, env: { UGT_API_BASE: 'http://api.test' }, fetchImpl: async () => json({}) });
        expect([...registered.keys()]).toEqual(['ugt_draft_property_offer', 'ugt_edit_property_offer', 'ugt_list_property_offer', 'ugt_get_property_offer',
            'ugt_publish_property_offer', 'ugt_request_holding', 'ugt_list_holding_requests']);
        expect(registered.get('ugt_request_holding').spec.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
        expect(registered.get('ugt_list_holding_requests').spec.annotations.readOnlyHint).toBe(true);
        await registered.get('ugt_request_holding').run({ request: { city: 'zagreb', asset: FLAT, claimant, lensMembers: [member] } });
        expect(gate).not.toHaveBeenCalled();
        await registered.get('ugt_request_holding').run({ request: { city: 'zagreb', asset: FLAT, claimant, lensMembers: [member], createdAt: '2026-11-27T12:00:00.000Z' }, signature: 's', confirm: true });
        expect(gate).toHaveBeenCalledOnce();
    });
});
