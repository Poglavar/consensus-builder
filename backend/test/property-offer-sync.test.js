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
    const content = { schema: 'property-offer/v1', title: 'Purchase', city: 'test', direction: 'buy', proposer: maker, buyer: maker, seller: null, lens,
        parcels: [{ sourceId: 'cadastre', id: 'parcel-a' }, { sourceId: 'cadastre', id: 'parcel-b' }], priceLamports: '1234567890',
        createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:00:00.000Z' };
    return { data, store, win, sync, content };
}
describe('standalone offer persistence and publication', () => {
    it('keeps immutable published terms separate from mutable chain and acceptance state', async () => {
        const { store, sync, win, content } = setup();
        const draft = sync.create(content), cid = Record.cid(content);
        win.fetch.mockResolvedValue({ ok: true, status: 201, json: async () => ({ cid, content: draft.content, createdAt: content.createdAt }) });
        const published = await sync.publish(draft);
        expect(store.list()).toHaveLength(1);
        expect(published.published.cid).toBe(cid);
        expect(() => store.save({ ...published, content: { ...published.content, priceLamports: '1' } })).toThrow('immutable');
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
        win.PropertyOfferSolanaBridge = { connectedWallet: () => maker, preflight: vi.fn(), mint };
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
        win.PropertyOfferSolanaBridge = { connectedWallet: () => null, preflight: vi.fn(), mint };
        await expect(sync.mint(draft)).rejects.toMatchObject({ record: draft });
        expect(win.fetch).not.toHaveBeenCalled();
        win.PropertyOfferSolanaBridge.connectedWallet = () => maker;
        win.fetch.mockRejectedValue(new Error('Index unavailable'));
        await expect(sync.mint(draft)).rejects.toMatchObject({ message: 'Index unavailable', record: draft });
        expect(mint).not.toHaveBeenCalled();
    });
    it('does not publish or mint when lens preflight fails', async () => {
        const { sync, win, store, content } = setup();
        const draft = sync.create(content), mint = vi.fn();
        win.PropertyOfferSolanaBridge = { connectedWallet: () => maker,
            preflight: vi.fn().mockRejectedValue(new Error('Ownership incomplete')), mint };
        await expect(sync.mint(draft)).rejects.toMatchObject({ message: 'Ownership incomplete', record: draft });
        expect(win.fetch).not.toHaveBeenCalled();
        expect(mint).not.toHaveBeenCalled();
        expect(store.list()[0].published).toBeFalsy();
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
        win.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ cid, content: { ...content, priceLamports: '1' } }) });
        await expect(sync.importOffer(cid)).rejects.toThrow('CID');
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
