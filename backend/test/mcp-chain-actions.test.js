// The local MCP's signed chain actions that mirror what a person does with a wallet in the app:
// each reaches the shared node adapter with the agent's key, behind UGT_MCP_LIVE and confirm.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { createUrbanGameTheoryTools } from '../agents/ugt-agent-tools.js';
import { agreementAccountOf } from '../agents/agreement-minter.js';
import { cidOfObject } from '../cid.js';

let dir, keypair, keyFile;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-chain-actions-'));
    keypair = Keypair.generate();
    keyFile = join(dir, 'wallet.json');
    writeFileSync(keyFile, JSON.stringify([...keypair.secretKey]), { mode: 0o600 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ACCOUNT = Keypair.generate().publicKey.toBase58();
const MARKET = Keypair.generate().publicKey.toBase58();
function tools(dependencies, env = {}, fetchImpl = vi.fn(() => { throw new Error('no API in this test'); })) {
    return createUrbanGameTheoryTools({ env: { UGT_AGENT_KEYPAIR: keyFile, UGT_MCP_LIVE: '1', UGT_API_BASE: 'https://api.test', ...env },
        fetchImpl, createConnection: () => ({}), dependencies });
}
const json = body => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(body), json: async () => body });
// An indexed agreement as the index answers it, sponsored by `sponsor`.
function indexed(sponsor, electorate = 'owners') {
    const content = { schema: 'agreement/v1', title: 'Fixture', sponsor, rule: { electorate, binding: true, lens: [sponsor], lensThreshold: 1 }, inputs: { parcels: [] } };
    const cid = cidOfObject(content);
    return { cid, content, onchain: null, createIndexClient: () => ({ getAgreement: async asked => asked === cid ? { cid, content, onchain: null } : null }) };
}

describe('local MCP chain actions', () => {
    it('takes back a resolved market\'s seed as its opener, behind live mode and confirm', async () => {
        const reclaimAgreementMarketSeed = vi.fn(async () => ({ replayed: false, signature: 'reclaim-fixture', amount: '988001000' }));
        const live = tools({ reclaimAgreementMarketSeed });
        expect(await live.reclaimSeed({ agreementAccount: ACCOUNT, marketAddress: MARKET, confirm: true }))
            .toEqual({ replayed: false, signature: 'reclaim-fixture', amount: '988001000' });
        expect(reclaimAgreementMarketSeed).toHaveBeenCalledWith(expect.objectContaining({ subject: ACCOUNT, marketAddress: MARKET }));
        expect(reclaimAgreementMarketSeed.mock.calls[0][0].creatorKeypair.publicKey.toBase58()).toBe(keypair.publicKey.toBase58());
        await expect(live.reclaimSeed({ agreementAccount: ACCOUNT, marketAddress: MARKET })).rejects.toThrow(/confirm must be true/);
        await expect(tools({ reclaimAgreementMarketSeed }, { UGT_MCP_LIVE: '' }).reclaimSeed({ agreementAccount: ACCOUNT, marketAddress: MARKET, confirm: true }))
            .rejects.toThrow(/live actions are disabled/);
        expect(reclaimAgreementMarketSeed).toHaveBeenCalledTimes(1);
    });

    it('executes, expires, records a lens decision and refunds on the account the indexed agreement derives', async () => {
        const row = indexed(Keypair.generate().publicKey.toBase58());
        const account = agreementAccountOf(row.cid, row.content.sponsor);
        const adapters = { executeAgreement: vi.fn(async () => ({ signature: 'x' })), expireAgreement: vi.fn(async () => ({ signature: 'e' })),
            recordAgreementDecision: vi.fn(async () => ({ signature: 'a' })), refundContributions: vi.fn(async () => ({ signature: 'r' })) };
        const live = tools({ ...adapters, createIndexClient: row.createIndexClient });
        expect(await live.executeAgreement({ agreementCid: row.cid, confirm: true })).toMatchObject({ agreementCid: row.cid, account, signature: 'x' });
        expect(adapters.executeAgreement).toHaveBeenCalledWith(expect.objectContaining({ account }));
        await live.expireAgreement({ agreementCid: row.cid, confirm: true });
        expect(adapters.expireAgreement).toHaveBeenCalledWith(expect.objectContaining({ account }));
        const attestation = Keypair.generate().publicKey.toBase58();
        await live.recordLensDecision({ agreementCid: row.cid, attestation, confirm: true });
        expect(adapters.recordAgreementDecision).toHaveBeenCalledWith(expect.objectContaining({ account, attestation }));
        await live.refundContributions({ agreementCid: row.cid, confirm: true });
        expect(adapters.refundContributions.mock.calls[0][0].agreement).toMatchObject({ cid: row.cid, content: row.content });
        await expect(live.executeAgreement({ agreementCid: cidOfObject({ other: 1 }), confirm: true })).rejects.toThrow(/not in the index/);
    });

    it('cancels only as the sponsor, and confirms as a lens member over the relayed signed decisions', async () => {
        const self = keypair.publicKey.toBase58();
        const foreign = indexed(Keypair.generate().publicKey.toBase58());
        const cancelAgreement = vi.fn(async () => ({ signature: 'c' }));
        await expect(tools({ cancelAgreement, createIndexClient: foreign.createIndexClient }).cancelAgreement({ agreementCid: foreign.cid, confirm: true }))
            .rejects.toThrow(/only agreement .* sponsor/);
        expect(cancelAgreement).not.toHaveBeenCalled();
        const own = indexed(self);
        await tools({ cancelAgreement, createIndexClient: own.createIndexClient }).cancelAgreement({ agreementCid: own.cid, confirm: true });
        expect(cancelAgreement).toHaveBeenCalledWith(expect.objectContaining({ cid: own.cid }));

        const receipts = [{ decision: 'approve', ownerId: 'o1' }];
        const fetchImpl = vi.fn(async url => String(url) === `https://api.test/agreements/${own.cid}/decisions` ? json({ decisions: receipts }) : json({}));
        const confirmAsLensMember = vi.fn(async () => ({ signature: 'm' }));
        await tools({ confirmAsLensMember, createIndexClient: own.createIndexClient }, {}, fetchImpl).confirmAsLensMember({ agreementCid: own.cid, confirm: true });
        expect(confirmAsLensMember.mock.calls[0][0]).toMatchObject({ receipts, agreement: { cid: own.cid } });
        expect(confirmAsLensMember.mock.calls[0][0].memberKeypair.publicKey.toBase58()).toBe(self);
        // A crowdfunding round's member states its own decision: no relayed decisions are read.
        const round = indexed(self, 'investors');
        fetchImpl.mockClear();
        await tools({ confirmAsLensMember, createIndexClient: round.createIndexClient }, {}, fetchImpl).confirmAsLensMember({ agreementCid: round.cid, confirm: true });
        expect(confirmAsLensMember.mock.calls[1][0].receipts).toBeNull();
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('lists a round\'s apartments only as its developer and only while the round is open', async () => {
        const self = keypair.publicKey.toBase58();
        const round = (sponsor, funding = { targetUsdcAtomic: '3000000', apartments: { projectId: 'p', units: [{ unitId: 'u1' }] } }) => {
            const content = { schema: 'agreement/v1', title: 'Round', sponsor, funding, rule: { electorate: 'investors', binding: true, lens: [sponsor], lensThreshold: 1 }, inputs: { parcels: [] } };
            const cid = cidOfObject(content);
            return { cid, content, createIndexClient: () => ({ getAgreement: async asked => asked === cid ? { cid, content, onchain: null } : null }) };
        };
        const open = { status: 'Active', deadline: Math.floor(Date.now() / 1000) + 3600, lenses: [] };
        const listApartments = vi.fn(async () => ({ listed: 1, alreadyListed: 0, signatures: ['l'] }));
        const own = round(self);
        const account = agreementAccountOf(own.cid, self);
        const live = (row, value = open, inventory = [{ unitId: 'u1', status: 'unlisted' }]) => tools({ listApartments, createIndexClient: row.createIndexClient,
            readAgreementAccount: vi.fn(async () => value), readRoundInventory: vi.fn(async () => inventory) });
        expect(await live(own).listApartments({ agreementCid: own.cid, confirm: true })).toEqual({ agreementCid: own.cid, account, listed: 1, alreadyListed: 0, signatures: ['l'] });
        expect(listApartments.mock.calls[0][0]).toMatchObject({ account, content: own.content });
        expect(listApartments.mock.calls[0][0].developerKeypair.publicKey.toBase58()).toBe(self);

        const foreign = round(Keypair.generate().publicKey.toBase58());
        await expect(live(foreign).listApartments({ agreementCid: foreign.cid, confirm: true })).rejects.toMatchObject({ code: 'developer-required' });
        await expect(live(own, { ...open, deadline: Math.floor(Date.now() / 1000) - 1 }).listApartments({ agreementCid: own.cid, confirm: true })).rejects.toMatchObject({ code: 'round-closed' });
        await expect(live(own, null).listApartments({ agreementCid: own.cid, confirm: true })).rejects.toMatchObject({ code: 'not-minted' });
        const landDeal = round(self, null);
        await expect(live(landDeal).listApartments({ agreementCid: landDeal.cid, confirm: true })).rejects.toMatchObject({ code: 'not-apartment-round' });
        await expect(live(own).listApartments({ agreementCid: own.cid })).rejects.toThrow(/confirm must be true/);
        expect(listApartments).toHaveBeenCalledTimes(1);
    });

    it('reserves an apartment with the qualification the round\'s lens issued this wallet, within the USDC cap', async () => {
        const self = keypair.publicKey.toBase58();
        const sponsor = Keypair.generate().publicKey.toBase58();
        const lens = Keypair.generate().publicKey.toBase58();
        const content = { schema: 'agreement/v1', title: 'Round', sponsor, rule: { electorate: 'investors', binding: true, lens: [lens], lensThreshold: 1 }, inputs: { parcels: [] },
            funding: { targetUsdcAtomic: '3000000', apartments: { projectId: 'p', units: [{ unitId: 'u1' }, { unitId: 'u2' }] } } };
        const cid = cidOfObject(content);
        const account = agreementAccountOf(cid, sponsor);
        const createIndexClient = () => ({ getAgreement: async asked => asked === cid ? { cid, content, onchain: null } : null });
        const value = { status: 'Active', deadline: Math.floor(Date.now() / 1000) + 3600, lenses: [lens] };
        const offer = { unitId: 'u1', status: 'available', deposit: 200000n, account: 'unit-account', termsHash: 'h' };
        const qualification = { address: 'qualification-account', credential: 'c' };
        const members = [{ key: lens, serviceUrl: 'https://lens.test' }];
        const adapters = () => ({
            createIndexClient, readAgreementAccount: vi.fn(async () => value),
            readRoundInventory: vi.fn(async () => [offer, { unitId: 'u2', status: 'reserved', buyer: self, deposit: 200000n }]),
            fetchLensMembers: vi.fn(async () => members), apartmentQualification: vi.fn(async () => qualification),
            reserveApartment: vi.fn(async ({ qualification: proof }) => (proof ? { signature: 'r', replayed: false } : { signature: null, replayed: true }))
        });
        const deps = adapters();
        const result = await tools(deps).reserveApartment({ agreementCid: cid, unitId: 'u1', confirm: true });
        expect(result).toEqual({ agreementCid: cid, account, unitId: 'u1', qualification: 'qualification-account', signature: 'r', replayed: false });
        expect(deps.apartmentQualification).toHaveBeenCalledWith(expect.objectContaining({ cid, sponsor, lenses: [lens], members, offer, buyer: self }));
        expect(deps.reserveApartment.mock.calls[0][0]).toMatchObject({ account, content, unitId: 'u1', qualification });
        expect(deps.reserveApartment.mock.calls[0][0].buyerKeypair.publicKey.toBase58()).toBe(self);

        // A unit this wallet holds is a replay: no qualification is asked for, nothing is signed.
        const replay = adapters();
        expect(await tools(replay).reserveApartment({ agreementCid: cid, unitId: 'u2', confirm: true })).toMatchObject({ replayed: true, signature: null });
        expect(replay.apartmentQualification).not.toHaveBeenCalled();
        // Refused before any qualification or signature: a deposit above the cap, an unknown unit, a closed round.
        for (const [env, unitId, patch, refusal] of [
            [{ UGT_MCP_MAX_USDC_PER_ACTION: '0.1' }, 'u1', {}, /exceeds UGT_MCP_MAX_USDC_PER_ACTION/],
            [{}, 'u9', {}, /not offered/],
            [{}, 'u1', { status: 'Cancelled' }, /round .* is closed/]
        ]) {
            const refused = adapters();
            refused.readAgreementAccount = vi.fn(async () => ({ ...value, ...patch }));
            await expect(tools(refused, env).reserveApartment({ agreementCid: cid, unitId, confirm: true })).rejects.toThrow(refusal);
            expect(refused.apartmentQualification).not.toHaveBeenCalled();
            expect(refused.reserveApartment).not.toHaveBeenCalled();
        }
        await expect(tools(adapters(), { UGT_MCP_LIVE: '' }).reserveApartment({ agreementCid: cid, unitId: 'u1', confirm: true })).rejects.toThrow(/live actions are disabled/);
    });

    it('anchors the selected parcels with the panel\'s anchor id and metadata, stored through the app API', async () => {
        const geometry = { type: 'Polygon', coordinates: [[[15.97, 45.8], [15.9701, 45.8], [15.9701, 45.8001], [15.97, 45.8]]] };
        const posted = [];
        const fetchImpl = vi.fn(async (url, init = {}) => {
            const { pathname } = new URL(url);
            if (pathname === '/parcels') return json({ type: 'FeatureCollection', features: [{ type: 'Feature', id: '123',
                properties: { parcelId: '123', MATICNI_BROJ_KO: '335754', BROJ_CESTICE: '1234/2' }, geometry }] });
            if (pathname === '/metadata') { posted.push(JSON.parse(init.body)); return json({ metadataUrl: 'https://api.test/metadata/parcel.json' }); }
            throw new Error(`unexpected ${pathname}`);
        });
        const anchorParcels = vi.fn(async ({ parcels }) => ({ parcels: await Promise.all(parcels.map(async row => ({ anchorId: row.anchorId, anchor: 'A', uri: await row.metadataUri() }))) }));
        const result = await tools({ anchorParcels }, {}, fetchImpl).anchorParcels({ city: 'zagreb', parcelSourceId: 'oss-wfs', parcelIds: ['123'], confirm: true });
        expect(result.parcels).toEqual([{ anchorId: 'HR-335754-1234/2', anchor: 'A', uri: 'https://api.test/metadata/parcel.json' }]);
        expect(posted[0]).toMatchObject({ fileName: 'parcel-HR-335754-1234/2.json', metadata: { parcelId: 'HR-335754-1234/2', geometry,
            attributes: [{ value: 'HR-335754-1234/2' }, { value: keypair.publicKey.toBase58() }, { trait_type: 'Area (m²)' }] } });
        await expect(tools({ anchorParcels }, {}, fetchImpl).anchorParcels({ city: 'zagreb', parcelSourceId: 'oss-wfs', parcelIds: ['123'] })).rejects.toThrow(/confirm/);
    });

    it('takes a published property offer\'s chain steps with the named lens member\'s service and records them in the index', async () => {
        const cid = cidOfObject({ offer: 1 }), lens = Keypair.generate().publicKey.toBase58();
        const row = { cid, content: { schema: 'property-offer/v1', lens, proposer: keypair.publicKey.toBase58() }, onchain: null };
        const recorded = [];
        const fetchImpl = vi.fn(async (url, init = {}) => {
            const { pathname } = new URL(url);
            if (pathname === `/property-offers/${cid}`) return json(row);
            if (pathname === `/property-offers/${cid}/onchain`) { recorded.push({ body: JSON.parse(init.body), origin: init.headers.Origin }); return json({ cid }); }
            throw new Error(`unexpected ${pathname}`);
        });
        const fetchLensMembers = vi.fn(async () => [{ key: Keypair.generate().publicKey.toBase58(), serviceUrl: 'https://other.lens' }, { key: lens, serviceUrl: 'https://named.lens' }]);
        const step = name => vi.fn(async options => { await options.recordOnchain({ account: 'A', status: 'open' }, options.row.cid); return { step: name, ...options }; });
        const adapters = { createOfferOnChain: step('create'), acceptOffer: step('accept'), fundOffer: step('fund'), releaseOffer: step('release'), cancelOffer: step('cancel'), expireOffer: step('expire') };
        const live = tools({ ...adapters, fetchLensMembers }, {}, fetchImpl);
        const candidate = { buyer: 'b', seller: 's' };
        expect(await live.acceptPropertyOffer({ cid, candidate, confirm: true })).toMatchObject({ step: 'accept', lensServiceUrl: 'https://named.lens', candidate, row: { cid, content: row.content } });
        expect((await live.mintPropertyOffer({ cid, confirm: true })).lensServiceUrl).toBe('https://named.lens');
        for (const method of ['fundPropertyOffer', 'releasePropertyOffer', 'cancelPropertyOffer', 'expirePropertyOffer']) await live[method]({ cid, confirm: true });
        expect(adapters.fundOffer.mock.calls[0][0].keypair.publicKey.toBase58()).toBe(keypair.publicKey.toBase58());
        expect(fetchLensMembers).toHaveBeenCalledTimes(2);
        expect(recorded).toHaveLength(6);
        expect(recorded[0]).toEqual({ body: { account: 'A', status: 'open' }, origin: 'https://urbangametheory.xyz' });
        await expect(live.cancelPropertyOffer({ cid })).rejects.toThrow(/confirm must be true/);
    });
});
