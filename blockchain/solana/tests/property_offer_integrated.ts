// End-to-end property-offer acceptance through the real lens HTTP verifier and sas-lib issuer.
// Run against an isolated local validator with the actual SAS program cloned from devnet.
import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { createRequire } from 'node:module';
import { expect } from 'chai';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const backendRequire = createRequire(pathToFileURL(resolve(__dirname, '../../../backend/package.json')));
const importFile = (file: string) => dynamicImport(pathToFileURL(resolve(__dirname, file)).href);
const importBackendPackage = (name: string) => dynamicImport(pathToFileURL(backendRequire.resolve(name)).href);
const cidOf = (content: any) => importFile('../../../backend/cid.js').then(m => m.cidOf(m.canonicalBytes(content)));
const hash = (value: Buffer) => createHash('sha256').update(value).digest();
const signMessage = (keypair: Keypair, message: string) => sign(null, Buffer.from(message), createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(keypair.secretKey).subarray(0, 32)]), format: 'der', type: 'pkcs8'
})).toString('base64');
const payoutHash = (payouts: { recipient: PublicKey; lamports: number }[]) => hash(Buffer.concat(payouts.map(p => {
    const amount = Buffer.alloc(8); amount.writeBigUInt64LE(BigInt(p.lamports)); return Buffer.concat([p.recipient.toBuffer(), amount]);
})));
const unix = async (connection: anchor.web3.Connection) => Number((await connection.getAccountInfo(anchor.web3.SYSVAR_CLOCK_PUBKEY))!.data.readBigInt64LE(32));
const airdrop = async (connection: anchor.web3.Connection, key: PublicKey, amount = 1 * anchor.web3.LAMPORTS_PER_SOL) => {
    const sig = await connection.requestAirdrop(key, amount); await connection.confirmTransaction(sig, 'confirmed');
};

const rpcUrl = process.env.ANCHOR_PROVIDER_URL || 'http://127.0.0.1:18991';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(rpcUrl).hostname)) throw new Error('This integration test requires an isolated local validator.');

describe('property_offer integrated lens/SAS lifecycle', () => {
    const testWallet = Keypair.generate();
    const wallet = {
        publicKey: testWallet.publicKey,
        payer: testWallet,
        async signTransaction(transaction: any) { transaction.partialSign(testWallet); return transaction; },
        async signAllTransactions(transactions: any[]) { for (const transaction of transactions) transaction.partialSign(testWallet); return transactions; }
    } as any;
    const provider = new anchor.AnchorProvider(new anchor.web3.Connection(rpcUrl, 'confirmed'), wallet, { commitment: 'confirmed', preflightCommitment: 'confirmed' });
    const program = new Program(require('../target/idl/property_offer.json'), provider);

    it('settles parcel consents and lens-qualified apartment bids and listings with exact payouts', async () => {
        const [{ createLensMember }, { createLensMemberApp }, { createMemoryStore }, { LENS_SCHEMAS }, { createOfferChain }, sas, kit] = await Promise.all([
            importFile('../../../backend/lens/member.js'), importFile('../../../backend/lens/server.js'), importFile('../../../backend/lens/store.js'),
            importFile('../../../backend/oracle/lens-schemas.js'), importFile('../../../backend/property-offers/onchain.js'), importBackendPackage('sas-lib'), importBackendPackage('@solana/kit')
        ]) as any;
        await airdrop(provider.connection, provider.wallet.publicKey, 3 * anchor.web3.LAMPORTS_PER_SOL);
        const lensKeys = Keypair.generate(); await airdrop(provider.connection, lensKeys.publicKey, 3 * anchor.web3.LAMPORTS_PER_SOL);
        const kitSigner = await kit.createKeyPairSignerFromBytes(Uint8Array.from(lensKeys.secretKey));
        const [credential] = await sas.deriveCredentialPda({ authority: kitSigner.address, name: 'LensMember' });
        const [schema] = await sas.deriveSchemaPda({ credential, name: 'PropertyOfferDecision', version: 2 });
        const toInstruction = (ix: any) => new TransactionInstruction({
            programId: new PublicKey(ix.programAddress),
            keys: ix.accounts.map((a: any) => ({ pubkey: new PublicKey(a.address), isSigner: a.role >= 2, isWritable: (a.role & 1) === 1 })),
            data: Buffer.from(ix.data)
        });
        const send = async (ix: any) => {
            const transaction = new anchor.web3.Transaction().add(toInstruction(ix));
            transaction.feePayer = lensKeys.publicKey;
            const latest = await provider.connection.getLatestBlockhash('confirmed');
            transaction.recentBlockhash = latest.blockhash;
            const signature = await provider.connection.sendTransaction(transaction, [lensKeys]);
            await provider.connection.confirmTransaction({ signature, ...latest }, 'confirmed');
            return signature;
        };
        const credentialInfo = await provider.connection.getAccountInfo(new PublicKey(credential));
        if (!credentialInfo) await send(sas.getCreateCredentialInstruction({ payer: kitSigner, credential: kit.address(credential), authority: kitSigner, name: 'LensMember', signers: [kitSigner.address] }));
        const { planRegistration, registerSchema } = await importFile('../../../backend/scripts/register-lens-schemas.mjs');
        const [definition] = planRegistration({ authority: lensKeys.publicKey.toBase58(), credentialName: 'LensMember', kinds: ['propertyOffer'] }).schemas;
        await registerSchema({ credential, signer: kitSigner, schema: definition, send,
            exists: async (address: string) => Boolean(await provider.connection.getAccountInfo(new PublicKey(address), 'confirmed')) });
        const propertyOfferClient = require('../../../frontend/js/solana/property-offer-client.js');
        propertyOfferClient.configure({ web3: require('@solana/web3.js') });
        const [registeredCredential, registeredSchema] = await Promise.all([
            provider.connection.getAccountInfo(new PublicKey(credential), 'confirmed'),
            provider.connection.getAccountInfo(new PublicKey(schema), 'confirmed')
        ]);
        expect(propertyOfferClient.validateDecisionSchema({ credential, authority: lensKeys.publicKey.toBase58(), credentialInfo: registeredCredential, schemaInfo: registeredSchema })).eq(true);

        const { loadSasIssuer } = await importFile('../../../backend/lens/issuers.js');
        const issuer = await loadSasIssuer({ keypair: lensKeys, rpcUrl: rpcUrl });
        const ownerSetsByUid = new Map<string, any[]>();
        const identity = { kind: 'integrated-test', ownerSets: async (uids: string[]) => new Map(uids.map(uid => [uid, ownerSetsByUid.get(uid) || []])) };
        const member = createLensMember({ keypair: lensKeys, issuer, store: createMemoryStore(), identity });
        const offers = new Map<string, any>();
        const chainReader = createOfferChain('localnet', { SOLANA_LOCALNET_RPC_URL: rpcUrl });
        const operatorToken = 'integration-lens-operator';
        const makeApp = () => createLensMemberApp({ member, operatorToken, pricing: { mode: 'dry-run', enabled: false }, propertyOffers: {
            load: async (cid: string) => offers.get(cid)?.indexed ?? null,
            account: async (offer: any) => chainReader.read(offer)
        }, clock: { nowSeconds: () => Math.floor(Date.now() / 1000) } });
        const openServer = async () => new Promise<any>(resolveServer => { const s = makeApp().listen(0, '127.0.0.1', () => resolveServer(s)); });
        let base = '';

        async function journey(direction: 'buy' | 'sell', parcelCount: 1 | 2, ownersPerParcel: 1 | 2, sharedOwners = true, apartment = false) {
            const owners = Array.from({ length: sharedOwners ? ownersPerParcel : parcelCount * ownersPerParcel }, () => Keypair.generate());
            const parcelOwners = Array.from({ length: parcelCount }, (_, i) => sharedOwners ? owners : owners.slice(i * ownersPerParcel, (i + 1) * ownersPerParcel));
            for (const owner of owners) await airdrop(provider.connection, owner.publicKey);
            const buyerKey = direction === 'buy' ? null : Keypair.generate();
            const buyer = direction === 'buy' ? provider.wallet.publicKey : buyerKey!.publicKey;
            const proposer = direction === 'buy' ? provider.wallet.publicKey : owners[0].publicKey;
            if (direction === 'sell') await airdrop(provider.connection, buyer);
            const parcels = Array.from({ length: parcelCount }, (_, i) => ({ sourceId: 'integrated-test', id: `${direction}-${parcelCount}-${ownersPerParcel}-${i + 1}` }));
            const expiresAtSeconds = (await unix(provider.connection)) + 1800;
            const createdAt = new Date((await unix(provider.connection) - 60) * 1000).toISOString();
            const price = owners.length * 100_000;
            const orderedOwners = [...owners].sort((a, b) => a.publicKey.toBase58().localeCompare(b.publicKey.toBase58()));
            const sourceObservedAt = await unix(provider.connection) - 10;
            const salePayouts = orderedOwners.map(owner => ({ recipient: owner.publicKey.toBase58(), lamports: String(price / owners.length) }));
            const rawContent: any = { schema: 'property-offer/v1', city: apartment ? 'zagreb' : 'Integration test', createdAt, expiresAt: new Date(expiresAtSeconds * 1000).toISOString(), direction,
                proposer: proposer.toBase58(), buyer: direction === 'buy' ? proposer.toBase58() : null, seller: direction === 'sell' ? proposer.toBase58() : null,
                lens: lensKeys.publicKey.toBase58(), ...(apartment ? { apartment: {
                    xrayBuilding: 'zagreb::gdi-3d::148972', unit: '6::A4-C-23', at: '45.7665258,15.9722279,19' } } : { parcels }), priceLamports: String(price), ...(direction === 'sell' ? { payouts: salePayouts } : {}) };
            const OfferRecord = require('../../../frontend/js/property-offer-record.js');
            const content = OfferRecord.published(rawContent);
            if (!apartment) parcels.forEach((parcel, i) => ownerSetsByUid.set(JSON.stringify([parcel.sourceId, parcel.id, null]), parcelOwners[i].map(owner => ({ owner: owner.publicKey.toBase58(), ownerCount: ownersPerParcel, establishedAt: sourceObservedAt }))));
            const checked = await fetch(`${base}/lens/property-offers/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }) });
            const checkedBody = await checked.json();
            expect(checked.status, JSON.stringify(checkedBody)).eq(200);
            if (apartment) expect(checkedBody).to.include({ qualification: 'selected-lens' }).and.not.have.property('ownershipHash');
            const { ownershipHash } = checkedBody as { ownershipHash: string };
            const cid = await cidOf(content); const termsHash = hash((await importFile('../../../backend/cid.js')).canonicalBytes(content));
            const maker = direction === 'buy' ? provider.wallet.publicKey : owners[0].publicKey;
            const offer = PublicKey.findProgramAddressSync([Buffer.from('property-offer'), maker.toBuffer(), hash(Buffer.from(cid))], program.programId)[0];
            const chainPayouts = direction === 'sell' ? orderedOwners.map(owner => ({ recipient: owner.publicKey, lamports: new anchor.BN(price / owners.length) })) : [];
            const makerSigners = direction === 'sell' ? [owners[0]] : [];
            const createInstruction = await program.methods.create(cid, lensKeys.publicKey, direction === 'buy' ? { buy: {} } : { sell: {} }, [...termsHash], new anchor.BN(price), new anchor.BN(expiresAtSeconds), chainPayouts)
                .accountsStrict({ offer, maker, systemProgram: SystemProgram.programId }).instruction();
            const createTx = new anchor.web3.Transaction();
            if (apartment) {
                const anchors = require('../../../frontend/js/solana/parcel-client.js').configure({ web3: anchor.web3 });
                createTx.add(anchors.buildMintApartmentIx({ identityHash: OfferRecord.apartmentHash(content.apartment), payer: maker }).instruction);
            }
            createTx.add(createInstruction);
            createTx.feePayer = provider.wallet.publicKey;
            createTx.recentBlockhash = (await provider.connection.getLatestBlockhash('confirmed')).blockhash;
            await provider.sendAndConfirm(createTx, makerSigners);
            const payoutsForAttestation = direction === 'sell' ? chainPayouts : orderedOwners.map(owner => ({ recipient: owner.publicKey, lamports: new anchor.BN(price / owners.length) }));
            const candidatePayouts = payoutsForAttestation.map((p: any) => ({ recipient: p.recipient.toBase58(), lamports: p.lamports.toString() }));
            const scheduleHash = payoutHash(payoutsForAttestation.map((p: any) => ({ recipient: p.recipient, lamports: Number(p.lamports.toString()) })));
            const seller = owners[0];
            const consentModule = await importFile('../../../frontend/js/property-offer-consent.js');
            const consentApi = consentModule.default || consentModule;
            const candidate: any = { ownershipHash, buyer: buyer.toBase58(), seller: seller.publicKey.toBase58(), payouts: candidatePayouts,
                consents: apartment ? [] : owners.map(owner => ({ owner: owner.publicKey.toBase58(), signature: signMessage(owner, consentApi.sellerConsentMessage({
                    cid, offer: offer.toBase58(), termsHash: termsHash.toString('hex'), payoutsHash: scheduleHash.toString('hex'), ownershipHash, buyer: buyer.toBase58(), seller: owner.publicKey.toBase58()
                })) })) };
            const termsHex = termsHash.toString('hex'); const requestMessage = consentApi.requestMessage({ cid, offer: offer.toBase58(), termsHash: termsHex,
                payoutsHash: scheduleHash.toString('hex'), ownershipHash, buyer: buyer.toBase58(), seller: seller.publicKey.toBase58(), consents: candidate.consents });
            candidate.requester = direction === 'buy' ? seller.publicKey.toBase58() : buyer.toBase58();
            candidate.signature = signMessage(direction === 'buy' ? seller : buyerKey!, requestMessage);
            const scheduleOnchain = payoutsForAttestation.map((p: any) => ({ recipient: p.recipient, lamports: p.lamports }));
            const indexed = { cid, content };
            offers.set(cid, { indexed });

            if (apartment) {
                const path = `${base}/lens/property-offers/${cid}`;
                const headers = { 'content-type': 'application/json' };
                const pending = await fetch(`${path}/decision`, { method: 'POST', headers, body: JSON.stringify(candidate) });
                expect(pending.status, await pending.text()).eq(409);
                const body = JSON.stringify({ buyer: candidate.buyer, seller: candidate.seller, payouts: candidate.payouts });
                const unauthorized = await fetch(`${path}/qualify`, { method: 'POST', headers, body });
                expect(unauthorized.status).eq(401);
                const qualified = await fetch(`${path}/qualify`, { method: 'POST', headers: { ...headers, 'x-lens-operator-token': operatorToken }, body });
                expect(qualified.status, await qualified.text()).eq(201);
            }
            const response = await fetch(`${base}/lens/property-offers/${cid}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(candidate) });
            const responseText = await response.text();
            expect(response.status, responseText).eq(apartment ? 200 : 201);
            const attestation = JSON.parse(responseText);
            const chainPayoutsForAccept = direction === 'buy' ? scheduleOnchain : [];
            const counterparty = direction === 'buy' ? seller.publicKey : buyer;
            const tx = await program.methods.accept(chainPayoutsForAccept).accountsStrict({ offer, counterparty, attestation: new PublicKey(attestation.address), credential: member.credential }).signers(direction === 'buy' ? [seller] : [buyerKey!]).rpc();
            expect(tx).to.be.a('string');
            await program.methods.fund().accountsStrict({ offer, buyer, systemProgram: SystemProgram.programId }).signers(direction === 'buy' ? [] : [buyerKey!]).rpc();
            expect(Number((await (program.account as any).propertyOffer.fetch(offer)).escrowLamports)).eq(price);
            const before = await Promise.all(owners.map(o => provider.connection.getBalance(o.publicKey)));
            await program.methods.execute().accountsStrict({ offer }).remainingAccounts(scheduleOnchain.map((p: any) => ({ pubkey: p.recipient, isSigner: false, isWritable: true }))).rpc();
            const after = await Promise.all(owners.map(o => provider.connection.getBalance(o.publicKey)));
            expect(after.map((v, i) => v - before[i])).deep.eq(owners.map(() => price / owners.length));
            const final: any = await (program.account as any).propertyOffer.fetch(offer);
            expect(final.status.settled).to.not.equal(undefined);
            expect(Number(final.escrowLamports)).eq(0);
            expect(final.payoutsReleased).eq(owners.length);
            expect(final.paidBitmap).eq((1 << owners.length) - 1);
        }

        for (const direction of ['buy', 'sell'] as const) {
            const apartmentServer = await openServer();
            base = `http://127.0.0.1:${apartmentServer.address().port}`;
            try { await journey(direction, 1, 1, true, true); }
            finally { await new Promise<void>(done => apartmentServer.close(() => done())); }
            for (const parcelCount of [1, 2] as const) {
                for (const ownersPerParcel of [1, 2] as const) {
                    const cases = [true, ...(parcelCount === 2 && ownersPerParcel === 2 ? [false] : [])];
                    for (const sharedOwners of cases) {
                        const server = await openServer();
                        base = `http://127.0.0.1:${server.address().port}`;
                        try { await journey(direction, parcelCount, ownersPerParcel, sharedOwners); }
                        finally { await new Promise<void>(resolveClose => server.close(() => resolveClose())); }
                    }
                }
            }
        }
    });
});
