import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Store = require('../../frontend/js/property-offer-store.js');
const Sync = require('../../frontend/js/property-offer-sync.js');
const Record = require('../../frontend/js/property-offer-record.js');
const Cid = require('../../frontend/js/cid.js');
const { Keypair } = require('@solana/web3.js');
const maker = Keypair.fromSeed(new Uint8Array(32).fill(21)).publicKey.toBase58();
const lens = Keypair.fromSeed(new Uint8Array(32).fill(22)).publicKey.toBase58();
function setup() {
    const data = new Map();
    const store = Store.create({ storage: { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key), forEach: fn => data.forEach(fn) } });
    const win = { PropertyOfferStore: store, PropertyOfferRecord: Record, Cid,
        resolveBackendBaseUrl: () => 'http://localhost:4201', resolveFrontendBaseUrl: () => 'http://localhost:5201',
        location: { href: 'http://localhost:5201/?backend=http%3A%2F%2Flocalhost%3A4201&city=test&at=1%2C2%2C18' },
        resolveCurrentCityCode: () => 'test', fetch: vi.fn() };
    const sync = Sync.browser(win);
    const content = { schema: 'property-offer/v2', title: 'Purchase', city: 'test', direction: 'buy', proposer: maker, currency: 'USDC', price: '1234567890',
        lens: { members: [lens], threshold: 1 }, asset: { kind: 'parcel', sourceId: 'cadastre', id: 'parcel-a', at: '1,2,18' },
        createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:00:00.000Z' };
    return { data, store, win, sync, content };
}
describe('standalone offer persistence and publication', () => {
    it('keeps immutable published terms separate from mutable chain state', async () => {
        const { store, sync, win, content } = setup();
        const draft = sync.create(content), cid = Record.cid(content);
        win.fetch.mockResolvedValue({ ok: true, status: 201, json: async () => ({ cid, content: draft.content, createdAt: content.createdAt }) });
        const published = await sync.publish(draft);
        expect(store.list()).toHaveLength(1);
        expect(published.published.cid).toBe(cid);
        expect(() => store.save({ ...published, content: { ...published.content, price: '1' } })).toThrow('immutable');
        expect(store.save({ ...published, onchain: { account: 'chain-account' } }).content).toEqual(draft.content);
        expect(new URL(sync.link(cid)).searchParams.get('backend')).toBe('http://localhost:4201');
        expect(new URL(sync.link(cid)).searchParams.get('at')).toBe('1,2,18');
    });
    it('publishes before minting and retries the same terms after a declined signature', async () => {
        const { sync, win, store, content } = setup();
        const draft = sync.create(content), cid = Record.cid(content);
        win.fetch.mockResolvedValue({ ok: true, status: 201, json: async () => ({ cid, content: draft.content, createdAt: content.createdAt }) });
        const mint = vi.fn().mockRejectedValueOnce(new Error('Signature declined'))
            .mockImplementationOnce(async record => ({ ...record, onchain: { account: 'offer-account' } }));
        win.PropertyOfferSolanaBridge = { connectedWallet: () => maker, mint };
        let failed;
        try { await sync.mint(draft); } catch (error) { failed = error; }
        expect(failed.message).toBe('Signature declined');
        expect(failed.record.published.cid).toBe(cid);
        expect(mint.mock.calls[0][0].published.cid).toBe(cid);
        const retried = await sync.mint(failed.record);
        expect(retried.onchain.account).toBe('offer-account');
        expect(win.fetch).toHaveBeenCalledTimes(1);
        expect(mint).toHaveBeenCalledTimes(2);
        expect(store.list()).toHaveLength(1);
    });
    it('never publishes without the proposer wallet, or mints when publication fails', async () => {
        const { sync, win, content } = setup();
        const draft = sync.create(content), mint = vi.fn();
        win.PropertyOfferSolanaBridge = { connectedWallet: () => null, mint };
        await expect(sync.mint(draft)).rejects.toMatchObject({ record: draft });
        expect(win.fetch).not.toHaveBeenCalled();
        win.PropertyOfferSolanaBridge.connectedWallet = () => maker;
        win.fetch.mockRejectedValue(new Error('Index unavailable'));
        await expect(sync.mint(draft)).rejects.toMatchObject({ message: 'Index unavailable', record: draft });
        expect(mint).not.toHaveBeenCalled();
    });
    it('preserves a confirmed transaction when its index refresh fails', async () => {
        const { sync, win, content } = setup();
        const record = { ...sync.create(content), published: { cid: Record.cid(content) } };
        const confirmed = { ...record, onchain: { account: 'confirmed-offer' } };
        win.PropertyOfferSolanaBridge = { connectedWallet: () => maker, preflight: vi.fn(),
            mint: vi.fn().mockRejectedValue(Object.assign(new Error('Index unavailable'), { record: confirmed })) };
        await expect(sync.mint(record)).rejects.toMatchObject({ record: confirmed });
        expect(win.fetch).not.toHaveBeenCalled();
    });
    it('refuses a remote body whose terms no longer match the publication CID', async () => {
        const { sync, win, content } = setup();
        const cid = Record.cid(content);
        win.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ cid, content: { ...content, price: '1' } }) });
        await expect(sync.importOffer(cid)).rejects.toThrow('CID');
    });
    it('lists the index with only the filters given and reads what waits for a lens member', async () => {
        const { sync, win } = setup();
        win.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ propertyOffers: [], hasMore: false }) });
        await sync.list({ city: 'test', direction: 'sell', kind: '', status: ['open', 'committed'], bbox: '1,2,3,4' });
        await sync.awaiting(lens);
        const urls = win.fetch.mock.calls.map(([url]) => new URL(url));
        expect(Object.fromEntries(urls[0].searchParams)).toEqual({ city: 'test', direction: 'sell', status: 'open,committed', bbox: '1,2,3,4' });
        expect(urls[1].pathname).toBe('/property-offers/awaiting');
        expect(urls[1].searchParams.get('member')).toBe(lens);
    });
    it('ignores browser copies of offers made under the retired v1 terms', () => {
        const { data, store } = setup();
        data.set('property-offer:old', JSON.stringify({ id: 'old', content: { schema: 'property-offer/v1', createdAt: '2026-01-01T00:00:00.000Z' } }));
        expect(store.list()).toEqual([]);
    });
    it('imports one copy and local removal never sends a server deletion', async () => {
        const { sync, win, store, content } = setup();
        const cid = Record.cid(content);
        win.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ cid, content: Record.published(content), createdAt: content.createdAt }) });
        const first = await sync.importOffer(cid), second = await sync.importOffer(cid);
        expect(first.id).toBe(second.id); expect(store.list()).toHaveLength(1);
        store.remove(first.id); expect(store.list()).toHaveLength(0);
        expect(win.fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
    });
});
