import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const chainRequire = createRequire(new URL('../../blockchain/solana/package.json', import.meta.url));
const anchor = chainRequire('@coral-xyz/anchor');
const lmsr = require('../../frontend/js/solana/lmsr-client.js');
lmsr.configure({ web3 });
const IDL = JSON.parse(readFileSync(new URL('../../blockchain/solana/idl/proposal_market.json', import.meta.url), 'utf8'));

const program = new web3.PublicKey(lmsr.constants.PROGRAM_ID);
const creator = web3.Keypair.generate().publicKey;
const owner = web3.Keypair.generate().publicKey;
const proposal = web3.Keypair.generate().publicKey;
const mint = web3.Keypair.generate().publicKey;
const other = web3.Keypair.generate().publicKey;
const hash = seed => Uint8Array.from({ length: 32 }, (_, i) => (seed + i) & 255);
const zeroHash = new Uint8Array(32);
const dataBytes = data => Buffer.from(data);
const instructionName = (ix, names) => ix.keys.map((account, index) => ({
    name: names[index], pubkey: account.pubkey.toBase58(), signer: account.isSigner, writable: account.isWritable
}));
const meta = (pubkey, signer = false, writable = false) => ({ pubkey: pubkey.toBase58(), signer, writable });
const named = (names, values) => values.map((value, index) => ({ name: names[index], ...value }));
const disc = (kind, name) => [...createHash('sha256').update(`${kind}:${name}`).digest().subarray(0, 8)];
const u64Buffer = value => { const out = Buffer.alloc(8); out.writeBigUInt64LE(BigInt(value)); return out; };
const i64Buffer = value => { const out = Buffer.alloc(8); out.writeBigInt64LE(BigInt(value)); return out; };
const u32Buffer = value => { const out = Buffer.alloc(4); out.writeUInt32LE(value); return out; };
const expectedData = (name, ...args) => Buffer.concat([Buffer.from(disc('global', name)), ...args]);

function marketData({ kind = 0, subject = proposal, creatorKey = creator, mintKey = mint, address } = {}) {
    const market = address || (kind === 0
        ? lmsr.getMarketPda(subject, creatorKey)[0]
        : lmsr.getExternalMarketPda(hash(70), creatorKey)[0]);
    const out = Buffer.alloc(496);
    Buffer.from(lmsr.ACCOUNT_DISCRIMINATORS.LmsrMarket).copy(out, 0);
    let p = 8;
    out.writeUInt8(kind, p++);
    (kind === 0 ? subject : web3.PublicKey.default).toBuffer().copy(out, p); p += 32;
    creatorKey.toBuffer().copy(out, p); p += 32;
    mintKey.toBuffer().copy(out, p); p += 32;
    lmsr.getVaultAddress(market, mintKey).toBuffer().copy(out, p); p += 32;
    out.writeBigUInt64LE(1000n, p); p += 8;
    out.writeBigUInt64LE(12n, p); p += 8;
    out.writeBigUInt64LE(9n, p); p += 8;
    out.writeBigUInt64LE(694n, p); p += 8;
    out.writeBigInt64LE(1900000000n, p); p += 8;
    out.writeUInt32LE(300, p); p += 4;
    out.writeBigUInt64LE(50n, p); p += 8;
    const recipeHash = kind === 1 ? hash(70) : zeroHash;
    for (const h of [recipeHash, hash(1), hash(2), hash(3)]) { Buffer.from(h).copy(out, p); p += 32; }
    for (const k of [other, mintKey, other]) { k.toBuffer().copy(out, p); p += 32; }
    out.writeUInt8(0, p++); out.writeUInt8(0, p++); out.writeBigInt64LE(0n, p); p += 8;
    web3.PublicKey.default.toBuffer().copy(out, p); p += 32;
    Buffer.from(zeroHash).copy(out, p); p += 32;
    out.writeBigUInt64LE(0n, p); p += 8; out.writeUInt8(253, p);
    return { market, out };
}

function positionData(market, ownerKey = owner, side = 1) {
    const out = Buffer.alloc(83);
    Buffer.from(lmsr.ACCOUNT_DISCRIMINATORS.Position).copy(out, 0);
    market.toBuffer().copy(out, 8); ownerKey.toBuffer().copy(out, 40);
    out.writeUInt8(side, 72); out.writeBigUInt64LE(9007199254740993n, 73); out.writeUInt8(0, 81); out.writeUInt8(252, 82);
    return out;
}

afterEach(() => lmsr.configure({ web3, programId: null }));

describe('Solana LMSR client codec', () => {
    it('pins all instruction and account discriminators to Anchor SHA-256', () => {
        for (const [name, value] of Object.entries(lmsr.IX_DISCRIMINATORS)) {
            expect(value).toEqual(disc('global', name));
            expect(value).toEqual(IDL.instructions.find(instruction => instruction.name === name).discriminator);
        }
        for (const [name, value] of Object.entries(lmsr.ACCOUNT_DISCRIMINATORS)) expect(value).toEqual(disc('account', name));
    });

    it('uses creator-bound, disjoint market PDA namespaces and the shared position namespace', () => {
        const [kind0] = lmsr.getMarketPda(proposal, creator);
        const expected0 = web3.PublicKey.findProgramAddressSync([Buffer.from('lmsr'), proposal.toBuffer(), creator.toBuffer()], program)[0];
        expect(kind0.equals(expected0)).toBe(true);
        const recipeHash = hash(31);
        const [kind1] = lmsr.getExternalMarketPda(recipeHash, creator);
        const expected1 = web3.PublicKey.findProgramAddressSync([Buffer.from('lmsr_recipe'), Buffer.from(recipeHash), creator.toBuffer()], program)[0];
        expect(kind1.equals(expected1)).toBe(true);
        expect(lmsr.getMarketPda(proposal, owner)[0].equals(kind0)).toBe(false);
        expect(lmsr.getExternalMarketPda(recipeHash, owner)[0].equals(kind1)).toBe(false);
        expect(kind0.equals(lmsr.getExternalMarketPda(proposal.toBytes(), creator)[0])).toBe(false);
        expect(lmsr.getPositionPda(kind0, owner, 1)[0].equals(web3.PublicKey.findProgramAddressSync(
            [Buffer.from('lmsr_position'), kind0.toBuffer(), owner.toBuffer(), Buffer.from([1])], program
        )[0])).toBe(true);
    });

    it('builds every LMSR instruction with exact bytes, account order, and signer flags', () => {
        const recipeHash = hash(33); const subjectHash = hash(66); const yesValueHash = hash(99); const noValueHash = hash(132);
        const trustedAttester = other; const credential = mint; const schema = other;
        const market0 = lmsr.getMarketPda(proposal, creator)[0];
        const market1 = lmsr.getExternalMarketPda(recipeHash, creator)[0];
        const position = lmsr.getPositionPda(market0, owner, 1)[0];
        const vault0 = lmsr.getVaultAddress(market0, mint); const ownerAta = lmsr.getAssociatedTokenAddress(owner, mint);
        const creatorAta = lmsr.getAssociatedTokenAddress(creator, mint);
        const instructions = [
            ['create_lmsr_market', lmsr.buildCreateLmsrMarketIx({ proposal, creator, stakeMint: mint, b: 1000n, closesAt: 1900000000n, graceSeconds: 20, maxPosition: 90n }),
                ['market', 'proposal', 'stake_mint', 'vault', 'creator_token_account', 'creator', 'token_program', 'associated_token_program', 'system_program'],
                [meta(market0, false, true), meta(proposal), meta(mint), meta(vault0, false, true), meta(creatorAta, false, true), meta(creator, true, true), meta(new web3.PublicKey(lmsr.constants.TOKEN_PROGRAM_ID)), meta(new web3.PublicKey(lmsr.constants.ASSOCIATED_TOKEN_PROGRAM_ID)), meta(web3.SystemProgram.programId)]],
            ['create_lmsr_external_market', lmsr.buildCreateLmsrExternalMarketIx({ recipeHash, subjectHash, yesValueHash, noValueHash, trustedAttester, creator, stakeMint: mint, credential, schema, b: 1000n, closesAt: 1900000000n, graceSeconds: 20, maxPosition: 90n }),
                ['market', 'stake_mint', 'vault', 'credential', 'schema', 'creator_token_account', 'creator', 'token_program', 'associated_token_program', 'system_program'],
                [meta(market1, false, true), meta(mint), meta(lmsr.getVaultAddress(market1, mint), false, true), meta(credential), meta(schema), meta(creatorAta, false, true), meta(creator, true, true), meta(new web3.PublicKey(lmsr.constants.TOKEN_PROGRAM_ID)), meta(new web3.PublicKey(lmsr.constants.ASSOCIATED_TOKEN_PROGRAM_ID)), meta(web3.SystemProgram.programId)]],
            ['buy', lmsr.buildBuyIx({ market: market0, proposal, owner, stakeMint: mint, side: 1, shares: 7n, maxCost: 8n }),
                ['market', 'proposal', 'position', 'vault', 'trader_token_account', 'trader', 'token_program', 'system_program'],
                [meta(market0, false, true), meta(proposal), meta(position, false, true), meta(vault0, false, true), meta(ownerAta, false, true), meta(owner, true, true), meta(new web3.PublicKey(lmsr.constants.TOKEN_PROGRAM_ID)), meta(web3.SystemProgram.programId)]],
            ['sell', lmsr.buildSellIx({ market: market0, proposal, owner, stakeMint: mint, side: 1, shares: 7n, minReturn: 4n }),
                ['market', 'proposal', 'position', 'vault', 'trader_token_account', 'trader', 'token_program'],
                [meta(market0, false, true), meta(proposal), meta(position, false, true), meta(vault0, false, true), meta(ownerAta, false, true), meta(owner, true), meta(new web3.PublicKey(lmsr.constants.TOKEN_PROGRAM_ID))]],
            ['resolve_lmsr', lmsr.buildResolveLmsrIx({ market: market0, proposal, schema: web3.SystemProgram.programId, evidence: [other] }),
                ['market', 'proposal', 'schema', 'evidence'],
                [meta(market0, false, true), meta(proposal), meta(web3.SystemProgram.programId), meta(other)]],
            ['claim_lmsr', lmsr.buildClaimLmsrIx({ market: market0, owner, stakeMint: mint, side: 1 }),
                ['market', 'position', 'vault', 'claimer_token_account', 'claimer', 'token_program'],
                [meta(market0, false, true), meta(position, false, true), meta(vault0, false, true), meta(ownerAta, false, true), meta(owner, true), meta(new web3.PublicKey(lmsr.constants.TOKEN_PROGRAM_ID))]],
            ['reclaim_seed', lmsr.buildReclaimSeedIx({ market: market0, creator, stakeMint: mint }),
                ['market', 'vault', 'creator_token_account', 'creator', 'token_program'],
                [meta(market0), meta(vault0, false, true), meta(creatorAta, false, true), meta(creator, true), meta(new web3.PublicKey(lmsr.constants.TOKEN_PROGRAM_ID))]]
        ];
        const expectedArgs = [
            expectedData('create_lmsr_market', u64Buffer(1000), i64Buffer(1900000000), u32Buffer(20), u64Buffer(90)),
            expectedData('create_lmsr_external_market', Buffer.from(recipeHash), Buffer.from(subjectHash), Buffer.from(yesValueHash), Buffer.from(noValueHash), trustedAttester.toBuffer(), u64Buffer(1000), i64Buffer(1900000000), u32Buffer(20), u64Buffer(90)),
            expectedData('buy', Buffer.from([1]), u64Buffer(7), u64Buffer(8)),
            expectedData('sell', Buffer.from([1]), u64Buffer(7), u64Buffer(4)),
            expectedData('resolve_lmsr'), expectedData('claim_lmsr'), expectedData('reclaim_seed')
        ];
        for (const [name, ix, names, expected] of instructions) {
            expect(ix.programId.toBase58(), name).toBe(program.toBase58());
            const idlAccounts = IDL.instructions.find(instruction => instruction.name === name).accounts;
            expect(names.slice(0, idlAccounts.length), name).toEqual(idlAccounts.map(account => account.name));
            expect(instructionName(ix, names), name).toEqual(named(names, expected).map((account, index) => ({
                ...account,
                signer: index < idlAccounts.length ? Boolean(idlAccounts[index].signer) : account.signer,
                writable: index < idlAccounts.length ? Boolean(idlAccounts[index].writable) : account.writable
            })));
            expect(Buffer.from(ix.data), name).toEqual(expectedArgs[instructions.findIndex(item => item[0] === name)]);
        }
        const create0 = dataBytes(instructions[0][1].data);
        expect(create0.length).toBe(36); expect(create0.readBigUInt64LE(8)).toBe(1000n); expect(create0.readBigInt64LE(16)).toBe(1900000000n);
        const create1 = dataBytes(instructions[1][1].data);
        expect(create1.length).toBe(196); expect([...create1.slice(8, 40)]).toEqual([...recipeHash]); expect(create1.readBigUInt64LE(168)).toBe(1000n);
        expect(dataBytes(instructions[2][1].data).readBigUInt64LE(9)).toBe(7n);
        expect(dataBytes(instructions[3][1].data).readBigUInt64LE(17)).toBe(4n);
        const boundCreate = lmsr.buildCreateLmsrExternalMarketIx({ recipeHash, subjectHash, yesValueHash, noValueHash, trustedAttester, creator, stakeMint: mint, credential, schema, b: 1000n, closesAt: 1900000000n, proposal });
        expect(boundCreate.keys).toHaveLength(IDL.instructions.find(instruction => instruction.name === 'create_lmsr_external_market').accounts.length + 1);
        expect(boundCreate.keys.at(-1)).toMatchObject({ pubkey: proposal, isSigner: false, isWritable: false });
        expect(() => lmsr.buildBuyIx({ market: market0, proposal, owner, stakeMint: mint, side: 1, shares: 0n, maxCost: 1n })).toThrow(/positive/);
        expect(() => lmsr.buildCreateLmsrMarketIx({ proposal, creator, stakeMint: mint, b: 10000000000000001n, closesAt: 1900000000n })).toThrow(/liquidity/);
    });

    it('decodes independent market and position fixtures and validates owner plus PDA bindings', async () => {
        const { market, out } = marketData();
        expect(lmsr.decodeMarket(out)).toMatchObject({ kind: 0, proposal: proposal.toBase58(), creator: creator.toBase58(),
            stakeMint: mint.toBase58(), b: 1000n, qYes: 12n, qNo: 9n, seed: 694n, closesAt: 1900000000n,
            graceSeconds: 300, maxPosition: 50n, resolved: false, outcome: 0, bump: 253 });
        const accountInfo = { data: out, owner: program };
        const found = await lmsr.readMarket({ getAccountInfo: async address => address.equals(market) ? accountInfo : null }, market);
        expect(found.creator).toBe(creator.toBase58());
        await expect(lmsr.readMarket({ getAccountInfo: async () => ({ data: out, owner: other }) }, market)).rejects.toThrow(/another program/);
        const badPda = lmsr.getMarketPda(proposal, other)[0];
        await expect(lmsr.readMarket({ getAccountInfo: async () => accountInfo }, badPda)).rejects.toThrow(/address does not match/);
        const external = marketData({ kind: 1 });
        expect(lmsr.decodeMarket(external.out).kind).toBe(1);
        expect(await lmsr.readMarket({ getAccountInfo: async () => ({ data: external.out, owner: program }) }, external.market)).toMatchObject({ kind: 1 });

        const zeroLiquidity = Buffer.from(out); zeroLiquidity.writeBigUInt64LE(0n, 137);
        expect(() => lmsr.decodeMarket(zeroLiquidity)).toThrow(/liquidity/);
        const excessiveLiquidity = Buffer.from(out); excessiveLiquidity.writeBigUInt64LE(10000000000000001n, 137);
        expect(() => lmsr.decodeMarket(excessiveLiquidity)).toThrow(/liquidity/);
        const invalidKind = Buffer.from(out); invalidKind[8] = 2;
        expect(() => lmsr.decodeMarket(invalidKind)).toThrow(/kind/);
        const invalidBool = Buffer.from(out); invalidBool[413] = 2;
        expect(() => lmsr.decodeMarket(invalidBool)).toThrow(/bool/);
        const invalidOutcome = Buffer.from(out); invalidOutcome[414] = 3;
        expect(() => lmsr.decodeMarket(invalidOutcome)).toThrow(/outcome/);

        const position = positionData(market);
        expect(lmsr.decodePosition(position)).toMatchObject({ market: market.toBase58(), owner: owner.toBase58(), side: 1, amount: 9007199254740993n, claimed: false, bump: 252 });
        expect(lmsr.readPositionAccount({ data: position, owner: program }, market, owner, 1)).toMatchObject({ amount: 9007199254740993n });
        expect(() => lmsr.readPositionAccount({ data: position, owner: other }, market, owner, 1)).toThrow(/another program/);
        expect(await lmsr.readPosition({ getAccountInfo: async () => ({ data: position, owner: program }) }, market, owner, 1)).toMatchObject({ side: 1 });
        expect(() => lmsr.decodeMarket(Buffer.alloc(496))).toThrow(/discriminator/);
        expect(() => lmsr.decodePosition(Buffer.alloc(82))).toThrow(/expected at least/);
    });

    it('decodes account bytes serialized by Anchor’s Borsh account coder', async () => {
        const coder = new anchor.BorshAccountsCoder(IDL);
        const market = lmsr.getMarketPda(proposal, creator)[0];
        const marketBytes = await coder.encode('LmsrMarket', {
            kind: 0, proposal, creator, stake_mint: mint, vault: lmsr.getVaultAddress(market, mint),
            b: new anchor.BN(1000), q_yes: new anchor.BN(12), q_no: new anchor.BN(9), seed: new anchor.BN(694),
            closes_at: new anchor.BN(1900000000), grace_seconds: 300, max_position: new anchor.BN(50),
            recipe_hash: zeroHash, subject_hash: hash(1), yes_value_hash: hash(2), no_value_hash: hash(3),
            credential: other, schema: mint, trusted_attester: other, resolved: false, outcome: 0,
            resolved_at: new anchor.BN(0), evidence: web3.PublicKey.default, evidence_hash: zeroHash,
            paid_out: new anchor.BN(0), bump: 253
        });
        const decodedMarket = lmsr.decodeMarket(marketBytes);
        expect(decodedMarket).toMatchObject({ kind: 0, proposal: proposal.toBase58(), creator: creator.toBase58(),
            stakeMint: mint.toBase58(), b: 1000n, qYes: 12n, qNo: 9n, seed: 694n, closesAt: 1900000000n,
            graceSeconds: 300, maxPosition: 50n, bump: 253 });
        const positionBytes = await coder.encode('Position', {
            market, owner, side: 1, amount: new anchor.BN('9007199254740993'), claimed: false, bump: 252
        });
        expect(lmsr.decodePosition(positionBytes)).toMatchObject({ market: market.toBase58(), owner: owner.toBase58(),
            side: 1, amount: 9007199254740993n, claimed: false, bump: 252 });
    });
});
