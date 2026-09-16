import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { buildAddressBook } from '../solana/address-book.js';
import { loadIdls, decodeParsedTransaction, decodeBase58, encodeBase58 } from '../solana/tx-decoder.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'solana-tx');
const IDL_DIR = path.join(__dirname, '..', '..', 'blockchain', 'solana', 'idl');

const TREASURY = 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ';
const TREASURY_USDC = '3kch82dBbEGMJhwjoT6X6xFuyfQLP7o8c6WTnA7Svpz9';
const PERSONA_WALLET = 'G4R6RCCcQHN9fLoExvTBBfhbw8BgvTEqhJezG3A1HvEg';
const PERSONA_USDC = '8VZjdVctk5LuyH7uSgmhKiyeW7S11UWrcZsQneTG3SW5';
const FACILITATOR = 'CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5';
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const MARKET_PROGRAM = 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB';
const PROPOSAL_PROGRAM = '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';

// Deterministic PDAs standing in for market accounts that do not exist on devnet yet.
const MARKET = 'LU6ENfBJU9BJSgsFJMoBNcafSaMkoZHrjY4bZ61Aim9';
const PROPOSAL = 'Gsvt9WiKUK7Jq3LMDZjrWZERKaaq4zy8UyjKRrCnQ6UT';
const POSITION = 'DDi6wgNuAR3GYu2Zirmys4HnB6Ee3DiHpY84bqauqQHH';
const VAULT = 'EVFpL5JVXmsWpJieChQRhXxAHSNCVh8v3KwWdsoniiwB';

const idls = loadIdls(IDL_DIR);
const book = buildAddressBook({
    env: { X402_PAY_TO: TREASURY },
    personas: { personas: [{ name: 'densifier-01', wallet: PERSONA_WALLET }] }
});

function fixture(name) {
    return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8'));
}

function decode(rpcTx) {
    return decodeParsedTransaction(rpcTx, { book, idls });
}

function rawIdl(name) {
    return JSON.parse(fs.readFileSync(path.join(IDL_DIR, `${name}.json`), 'utf8'));
}

function idlDiscriminatorHex(program, instruction) {
    const ix = rawIdl(program).instructions.find((entry) => entry.name === instruction);
    return Buffer.from(ix.discriminator).toString('hex');
}

// --- synthetic transaction builders -------------------------------------------------------------

function borsh(type, value) {
    if (type === 'u8') return Buffer.from([value]);
    if (type === 'u64') {
        const buf = Buffer.alloc(8);
        buf.writeBigUInt64LE(BigInt(value));
        return buf;
    }
    if (type === 'bool') return Buffer.from([value ? 1 : 0]);
    if (type === 'string') {
        const bytes = Buffer.from(String(value), 'utf8');
        const len = Buffer.alloc(4);
        len.writeUInt32LE(bytes.length);
        return Buffer.concat([len, bytes]);
    }
    if (type === 'pubkey') return new PublicKey(value).toBuffer();
    if (type && type.vec) {
        const len = Buffer.alloc(4);
        len.writeUInt32LE(value.length);
        return Buffer.concat([len, ...value.map((item) => borsh(type.vec, item))]);
    }
    throw new Error(`test encoder cannot write ${JSON.stringify(type)}`);
}

// Builds the base58 instruction data an Anchor client would send: the IDL's own discriminator
// followed by borsh-encoded args, so the decoder is matched against the real IDL bytes.
function anchorData(program, instruction, values) {
    const ix = rawIdl(program).instructions.find((entry) => entry.name === instruction);
    const parts = ix.args.map((arg) => borsh(arg.type, values[arg.name]));
    return encodeBase58(Buffer.concat([Buffer.from(ix.discriminator), ...parts]));
}

function tokenTransferChecked({ source, destination, authority, atomic, ui }) {
    return {
        parsed: {
            info: {
                authority,
                destination,
                mint: USDC,
                source,
                tokenAmount: { amount: atomic, decimals: 6, uiAmount: Number(ui), uiAmountString: ui }
            },
            type: 'transferChecked'
        },
        program: 'spl-token',
        programId: TOKEN_PROGRAM,
        stackHeight: 2
    };
}

function buildTx({ accountKeys, instructions, innerInstructions = [], tokenBalances = [], fee = 5000, err = null }) {
    return {
        blockTime: 1789600000,
        slot: 499500000,
        meta: {
            err,
            fee,
            innerInstructions,
            preTokenBalances: tokenBalances,
            postTokenBalances: tokenBalances,
            status: err ? { Err: err } : { Ok: null }
        },
        transaction: {
            message: { accountKeys, instructions, recentBlockhash: 'GKr575Cc1HgoDa82QeFHfeG1ADVMcvLFvL1FtT5m1ZFJ' },
            signatures: ['5ZbTestSignatureQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ']
        },
        version: 0
    };
}

function key(pubkey, { signer = false, writable = false } = {}) {
    return { pubkey, signer, source: 'transaction', writable };
}

const usdcBalances = (keys) => [
    { accountIndex: keys.indexOf(PERSONA_USDC), mint: USDC, owner: PERSONA_WALLET, programId: TOKEN_PROGRAM, uiTokenAmount: { amount: '5000000', decimals: 6, uiAmount: 5, uiAmountString: '5' } },
    { accountIndex: keys.indexOf(VAULT), mint: USDC, owner: MARKET, programId: TOKEN_PROGRAM, uiTokenAmount: { amount: '300000', decimals: 6, uiAmount: 0.3, uiAmountString: '0.3' } }
].filter((balance) => balance.accountIndex >= 0);

function marketTx(instruction, { values = {}, accounts, inner = [] }) {
    const keys = [
        key(PERSONA_WALLET, { signer: true, writable: true }),
        key(TREASURY, { signer: true, writable: true }),
        key(PERSONA_USDC, { writable: true }),
        key(MARKET, { writable: true }),
        key(PROPOSAL, { writable: true }),
        key(POSITION, { writable: true }),
        key(VAULT, { writable: true }),
        key(USDC),
        key(TOKEN_PROGRAM),
        key(SYSTEM_PROGRAM),
        key('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
        key(MARKET_PROGRAM)
    ];
    return buildTx({
        accountKeys: keys,
        instructions: [{
            accounts,
            data: anchorData('proposal_market', instruction, values),
            programId: MARKET_PROGRAM,
            stackHeight: 1
        }],
        innerInstructions: inner.length ? [{ index: 0, instructions: inner }] : [],
        tokenBalances: usdcBalances(keys.map((entry) => entry.pubkey))
    });
}

// --- base58 helpers pinned against @solana/web3.js -----------------------------------------------

describe('base58 helpers', () => {
    it('decodes a base58 address to the same bytes as PublicKey', () => {
        expect(decodeBase58(TREASURY).equals(new PublicKey(TREASURY).toBuffer())).toBe(true);
    });

    it('decodes leading ones as leading zero bytes', () => {
        const decoded = decodeBase58(SYSTEM_PROGRAM);
        expect(decoded).toHaveLength(32);
        expect(decoded.equals(new PublicKey(SYSTEM_PROGRAM).toBuffer())).toBe(true);
    });

    it('encodes bytes back to the same base58 string as PublicKey', () => {
        expect(encodeBase58(new PublicKey(TREASURY).toBuffer())).toBe(TREASURY);
        expect(encodeBase58(new PublicKey(SYSTEM_PROGRAM).toBuffer())).toBe(SYSTEM_PROGRAM);
    });

    it('rejects characters outside the base58 alphabet', () => {
        expect(decodeBase58('not valid base58 0OIl')).toBeNull();
        expect(decodeBase58('')).toBeNull();
    });
});

describe('loadIdls', () => {
    it('indexes the three programs by address and by name', () => {
        expect([...idls.byName.keys()].sort()).toEqual(['parcel_nft', 'proposal_market', 'proposal_nft']);
        expect(idls.byAddress.get(PROPOSAL_PROGRAM).name).toBe('proposal_nft');
        expect(idls.byAddress.get(MARKET_PROGRAM).name).toBe('proposal_market');
        expect(idls.byAddress.get('4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1').name).toBe('parcel_nft');
    });

    it('indexes instructions by their discriminator hex with account names in order', () => {
        const stake = idls.byName.get('proposal_market').instructions.get(idlDiscriminatorHex('proposal_market', 'stake'));
        expect(stake.name).toBe('stake');
        expect(stake.accounts).toEqual(['market', 'proposal', 'position', 'vault', 'staker_token_account', 'staker', 'token_program', 'system_program']);
        expect(stake.args).toEqual([{ name: 'side', type: 'u8' }, { name: 'amount', type: 'u64' }]);
    });
});

// --- recorded devnet fixtures --------------------------------------------------------------------

describe('decodeParsedTransaction: x402 settlement (recorded devnet tx)', () => {
    const decoded = decode(fixture('x402-settlement-transfer-checked'));

    it('reports the transaction header', () => {
        expect(decoded.signature).toBe('3qzwHhFzEMzVNjCpsePnVwRM2NUdNNqjggoSrWrGSviqCnSxBtaYfiJDWZrEvpjfcyvf5zCumeKXRMmCvG6DHsds');
        expect(decoded.slot).toBe(499439818);
        expect(decoded.blockTime).toBe(1789586329);
        expect(decoded.time).toBe('2026-09-16T19:18:49.000Z');
        expect(decoded.status).toBe('success');
        expect(decoded.error).toBeNull();
        expect(decoded.feeLamports).toBe(10001);
        expect(decoded.feeSol).toBe('0.000010001');
    });

    it('labels the x402 facilitator as the fee payer', () => {
        expect(decoded.feePayer).toEqual({
            address: FACILITATOR,
            label: 'x402 facilitator (fee payer)',
            kind: 'fee-payer',
            short: 'CKPK…WYp5'
        });
    });

    it('lists the meaningful program and action, leaving compute-budget and memo out', () => {
        expect(decoded.programs).toEqual(['spl-token']);
        expect(decoded.actions).toEqual(['transferChecked']);
    });

    it('resolves the token amount and both owners', () => {
        expect(decoded.amounts).toEqual([{
            kind: 'token',
            mint: USDC,
            symbol: 'USDC',
            decimals: 6,
            amount: '0.05',
            amountAtomic: '50000',
            from: {
                address: PERSONA_USDC,
                label: 'agent densifier-01 USDC account',
                kind: 'token-account',
                short: '8VZj…3SW5',
                owner: { address: PERSONA_WALLET, label: 'agent densifier-01', kind: 'wallet', short: 'G4R6…HvEg' }
            },
            to: {
                address: TREASURY_USDC,
                label: 'treasury USDC account',
                kind: 'token-account',
                short: '3kch…vpz9',
                owner: { address: TREASURY, label: 'treasury wallet', kind: 'wallet', short: 'AMbs…mkoQ' }
            }
        }]);
    });

    it('writes the x402 settlement summary', () => {
        expect(decoded.summary).toBe('agent densifier-01 paid 0.05 USDC to treasury wallet (x402 settlement, fee paid by x402 facilitator)');
    });

    it('keeps every instruction including compute budget and the memo', () => {
        expect(decoded.instructions).toHaveLength(4);
        expect(decoded.instructions[0].program.name).toBe('compute-budget');
        expect(decoded.instructions[0].action).toBeNull();
        expect(decoded.instructions[0].data).toBe('EuxTsD');
        expect(decoded.instructions[3].action).toBe('memo');
        expect(decoded.instructions[3].args).toEqual({ memo: '64f75d45d351392e2197c36fed001a9a' });
    });

    it('names the transferChecked accounts by their parsed roles', () => {
        const transfer = decoded.instructions[2];
        expect(transfer).toMatchObject({ index: 2, inner: false, parentIndex: null, action: 'transferChecked' });
        expect(transfer.program).toEqual({ address: TOKEN_PROGRAM, label: 'SPL Token', kind: 'program', short: 'Toke…Q5DA', name: 'spl-token' });
        expect(transfer.accounts).toEqual([
            { role: 'authority', address: PERSONA_WALLET, label: 'agent densifier-01', kind: 'wallet', short: 'G4R6…HvEg', signer: true, writable: false },
            { role: 'destination', address: TREASURY_USDC, label: 'treasury USDC account', kind: 'token-account', short: '3kch…vpz9', signer: false, writable: true },
            { role: 'mint', address: USDC, label: 'USDC (devnet)', kind: 'mint', short: '4zMM…ncDU', signer: false, writable: false },
            { role: 'source', address: PERSONA_USDC, label: 'agent densifier-01 USDC account', kind: 'token-account', short: '8VZj…3SW5', signer: false, writable: true }
        ]);
    });

    it('accepts the raw rpc envelope as well as the result object', () => {
        expect(decode(fixture('x402-settlement-transfer-checked').result).summary).toBe(decoded.summary);
    });
});

describe('decodeParsedTransaction: USDC funding (recorded devnet tx)', () => {
    const decoded = decode(fixture('usdc-funding-create-ata-transfer'));

    it('summarises the primary action, which is the account creation', () => {
        expect(decoded.summary).toBe('created USDC account for agent densifier-01');
        expect(decoded.programs).toEqual(['spl-associated-token-account', 'spl-token']);
        expect(decoded.actions).toEqual(['createIdempotent', 'transferChecked']);
    });

    it('flattens inner instructions with their parent index', () => {
        const inner = decoded.instructions.filter((instruction) => instruction.inner);
        expect(inner.map((instruction) => instruction.action)).toEqual([
            'getAccountDataSize', 'createAccount', 'initializeImmutableOwner', 'initializeAccount3'
        ]);
        expect(inner.every((instruction) => instruction.parentIndex === 0)).toBe(true);
        expect(inner[1].program.name).toBe('system');
    });

    it('records the 5 USDC top up from the treasury to the agent', () => {
        expect(decoded.amounts).toHaveLength(1);
        expect(decoded.amounts[0]).toMatchObject({
            kind: 'token',
            symbol: 'USDC',
            amount: '5',
            amountAtomic: '5000000'
        });
        expect(decoded.amounts[0].from.owner.label).toBe('treasury wallet');
        expect(decoded.amounts[0].to.owner.label).toBe('agent densifier-01');
    });

    it('does not claim the transaction was paid by the facilitator', () => {
        expect(decoded.feePayer.label).toBe('treasury wallet');
        expect(decoded.summary).not.toContain('x402 facilitator');
    });
});

describe('decodeParsedTransaction: proposal_nft mint_and_fund (recorded devnet tx)', () => {
    const decoded = decode(fixture('proposal-nft-mint-and-fund'));
    const anchor = decoded.instructions.find((instruction) => instruction.program.name === 'proposal_nft');

    it('maps the instruction data to the IDL discriminator', () => {
        expect(anchor.discriminator).toBe(idlDiscriminatorHex('proposal_nft', 'mint_and_fund'));
        expect(anchor.action).toBe('mint_and_fund');
    });

    it('decodes every arg type the instruction uses', () => {
        expect(anchor.args).toEqual({
            parcel_ids: ['HR-335649-507'],
            is_conditional: false,
            image_uri: 'ipfs://Qmf1jfw1qUwpncooxMezq6rDrtkmUVyJjBFn2jo541aGD4',
            sol_amount: '0',
            lens: ['8ErKUqcQR3bvuZx2Rt9ke7u38vQBwPPSXWrXJD8YUPyw']
        });
        expect(anchor.argsError).toBeUndefined();
    });

    it('names the accounts in IDL order with signer and writable flags', () => {
        expect(anchor.accounts).toEqual([
            { role: 'proposal', address: '6NPKGcQQ6yDzFLyPejeegsjrArHDQcAkHGvX8runxkjB', label: null, kind: null, short: '6NPK…xkjB', signer: false, writable: true },
            { role: 'proposal_counter', address: '2kVqTDdSZG9sTzuvDRUmNgtzJyUmKFF4gytJiv2LmBog', label: null, kind: null, short: '2kVq…mBog', signer: false, writable: true },
            { role: 'owner', address: '8ErKUqcQR3bvuZx2Rt9ke7u38vQBwPPSXWrXJD8YUPyw', label: null, kind: null, short: '8ErK…UPyw', signer: true, writable: true },
            { role: 'system_program', address: SYSTEM_PROGRAM, label: 'System Program', kind: 'program', short: '1111…1111', signer: false, writable: false }
        ]);
        expect(anchor.accountsWarning).toBeUndefined();
    });

    it('writes the mint summary from the owner, parcels and funding', () => {
        expect(decoded.summary).toBe('8ErK…UPyw minted proposal for parcels HR-335649-507 funded with 0 SOL');
        expect(decoded.programs).toEqual(['proposal_nft']);
        expect(decoded.actions).toEqual(['mint_and_fund']);
    });
});

describe('decodeParsedTransaction: proposal_nft accept_proposal (recorded devnet tx)', () => {
    const decoded = decode(fixture('proposal-nft-accept-proposal'));
    const anchor = decoded.instructions.find((instruction) => instruction.program.name === 'proposal_nft');

    it('maps the instruction data to the IDL discriminator and decodes the arg', () => {
        expect(anchor.discriminator).toBe(idlDiscriminatorHex('proposal_nft', 'accept_proposal'));
        expect(anchor.action).toBe('accept_proposal');
        expect(anchor.args).toEqual({ parcel_id: 'HR-335649-507' });
    });

    it('refuses to name accounts when the deployed program passed fewer than the IDL declares', () => {
        expect(anchor.accountsWarning).toBe('IDL declares 4 accounts, instruction supplied 2 — roles not assigned');
        expect(anchor.accounts.map((account) => account.role)).toEqual([null, null]);
    });

    it('falls back to the instruction signer for the actor in the summary', () => {
        expect(decoded.summary).toBe('8ErK…UPyw accepted parcel HR-335649-507');
    });
});

describe('decodeParsedTransaction: program deploy (recorded devnet tx)', () => {
    const decoded = decode(fixture('proposal-market-deploy'));

    it('names the deploy rather than the system createAccount that precedes it', () => {
        expect(decoded.summary).toBe('program proposal_market deployed by treasury wallet');
    });

    it('decodes the BPF upgradeable loader instruction', () => {
        const loader = decoded.instructions.find((instruction) => instruction.program.name === 'bpf-upgradeable-loader');
        expect(loader.action).toBe('deployWithMaxDataLen');
        expect(loader.program.label).toBe('BPF Upgradeable Loader');
        expect(loader.args.programAccount).toBe(MARKET_PROGRAM);
        expect(loader.accounts.find((account) => account.role === 'programAccount').label).toBe('proposal_market program');
    });
});

// --- failure ------------------------------------------------------------------------------------

describe('decodeParsedTransaction: failed transaction', () => {
    it('reports the failure status, the serialized error and marks the summary', () => {
        const raw = fixture('x402-settlement-transfer-checked').result;
        raw.meta.err = { InstructionError: [2, { Custom: 1 }] };
        raw.meta.status = { Err: raw.meta.err };

        const decoded = decode(raw);

        expect(decoded.status).toBe('failed');
        expect(decoded.error).toBe('{"InstructionError":[2,{"Custom":1}]}');
        expect(decoded.summary).toBe('agent densifier-01 paid 0.05 USDC to treasury wallet (x402 settlement, fee paid by x402 facilitator) (failed)');
    });
});

// --- proposal_market instructions (no devnet history yet, so built from the IDL) -----------------

describe('decodeParsedTransaction: proposal_market instructions', () => {
    it('summarises a stake with its side and the inner token transfer', () => {
        const decoded = decode(marketTx('stake', {
            values: { side: 1, amount: '300000' },
            accounts: [MARKET, PROPOSAL, POSITION, VAULT, PERSONA_USDC, PERSONA_WALLET, TOKEN_PROGRAM, SYSTEM_PROGRAM],
            inner: [tokenTransferChecked({ source: PERSONA_USDC, destination: VAULT, authority: PERSONA_WALLET, atomic: '300000', ui: '0.3' })]
        }));

        const anchor = decoded.instructions[0];
        expect(anchor.discriminator).toBe(idlDiscriminatorHex('proposal_market', 'stake'));
        expect(anchor.action).toBe('stake');
        expect(anchor.args).toEqual({ side: 1, amount: '300000' });
        expect(anchor.accounts.map((account) => account.role)).toEqual([
            'market', 'proposal', 'position', 'vault', 'staker_token_account', 'staker', 'token_program', 'system_program'
        ]);
        expect(decoded.summary).toBe('agent densifier-01 staked 0.3 USDC on YES in market LU6E…Aim9');
        expect(decoded.amounts).toHaveLength(1);
        expect(decoded.amounts[0].amount).toBe('0.3');
    });

    it('says NO for side 0 and falls back to the arg when there is no inner transfer', () => {
        const decoded = decode(marketTx('stake', {
            values: { side: 0, amount: '250000' },
            accounts: [MARKET, PROPOSAL, POSITION, VAULT, PERSONA_USDC, PERSONA_WALLET, TOKEN_PROGRAM, SYSTEM_PROGRAM]
        }));

        expect(decoded.summary).toBe('agent densifier-01 staked 0.25 USDC on NO in market LU6E…Aim9');
        expect(decoded.amounts).toEqual([]);
    });

    it('summarises create_market with the proposal and the vault', () => {
        const decoded = decode(marketTx('create_market', {
            accounts: [MARKET, PROPOSAL, USDC, VAULT, TREASURY, TOKEN_PROGRAM, 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', SYSTEM_PROGRAM]
        }));

        expect(decoded.instructions[0].action).toBe('create_market');
        expect(decoded.instructions[0].args).toEqual({});
        expect(decoded.summary).toBe('treasury wallet opened a market on proposal Gsvt…Q6UT (vault EVFp…iiwB)');
    });

    it('summarises resolve', () => {
        const decoded = decode(marketTx('resolve', { accounts: [MARKET, PROPOSAL] }));

        expect(decoded.instructions[0].action).toBe('resolve');
        expect(decoded.summary).toBe('market LU6E…Aim9 resolved');
    });

    it('summarises a claim with the amount from the inner transfer', () => {
        const decoded = decode(marketTx('claim', {
            accounts: [MARKET, POSITION, VAULT, PERSONA_USDC, PERSONA_WALLET, TOKEN_PROGRAM],
            inner: [tokenTransferChecked({ source: VAULT, destination: PERSONA_USDC, authority: MARKET, atomic: '900000', ui: '0.9' })]
        }));

        expect(decoded.summary).toBe('agent densifier-01 claimed 0.9 USDC from market LU6E…Aim9');
    });
});

// --- system transfer, unknown programs, unknown arg types ---------------------------------------

describe('decodeParsedTransaction: plain SOL transfer', () => {
    it('summarises a system transfer between labelled wallets', () => {
        const decoded = decode(buildTx({
            accountKeys: [key(TREASURY, { signer: true, writable: true }), key(PERSONA_WALLET, { writable: true }), key(SYSTEM_PROGRAM)],
            instructions: [{
                parsed: { info: { destination: PERSONA_WALLET, lamports: 200000000, source: TREASURY }, type: 'transfer' },
                program: 'system',
                programId: SYSTEM_PROGRAM,
                stackHeight: 1
            }]
        }));

        expect(decoded.summary).toBe('treasury wallet sent 0.2 SOL to agent densifier-01');
        expect(decoded.amounts).toEqual([{
            kind: 'sol',
            mint: null,
            symbol: 'SOL',
            decimals: 9,
            amount: '0.2',
            amountAtomic: '200000000',
            from: { address: TREASURY, label: 'treasury wallet', kind: 'wallet', short: 'AMbs…mkoQ', owner: null },
            to: { address: PERSONA_WALLET, label: 'agent densifier-01', kind: 'wallet', short: 'G4R6…HvEg', owner: null }
        }]);
    });
});

describe('decodeParsedTransaction: unknown programs and args', () => {
    const UNKNOWN_PROGRAM = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

    it('keeps the raw data and reports no action for an unknown program', () => {
        const decoded = decode(buildTx({
            accountKeys: [key(TREASURY, { signer: true, writable: true }), key(UNKNOWN_PROGRAM)],
            instructions: [{ accounts: [TREASURY], data: 'EuxTsD', programId: UNKNOWN_PROGRAM, stackHeight: 1 }]
        }));

        const instruction = decoded.instructions[0];
        expect(instruction.action).toBeNull();
        expect(instruction.data).toBe('EuxTsD');
        expect(instruction.program).toEqual({ address: UNKNOWN_PROGRAM, label: null, kind: null, short: '9WzD…AWWM', name: null });
        expect(instruction.accounts).toEqual([
            { role: null, address: TREASURY, label: 'treasury wallet', kind: 'wallet', short: 'AMbs…mkoQ', signer: true, writable: true }
        ]);
        expect(decoded.programs).toEqual([]);
        expect(decoded.summary).toBe('treasury wallet sent a transaction to 9WzD…AWWM');
    });

    it('reports an unknown program instruction of ours as an undecoded discriminator', () => {
        const decoded = decode(buildTx({
            accountKeys: [key(TREASURY, { signer: true, writable: true }), key(MARKET_PROGRAM)],
            instructions: [{ accounts: [TREASURY], data: encodeBase58(Buffer.alloc(16, 7)), programId: MARKET_PROGRAM, stackHeight: 1 }]
        }));

        expect(decoded.instructions[0].action).toBeNull();
        expect(decoded.instructions[0].discriminator).toBe('0707070707070707');
        expect(decoded.summary).toBe('treasury wallet sent a transaction to proposal_market');
    });

    it('nulls the args and reports argsError for an IDL type it cannot read', () => {
        const discriminator = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
        const fakeIdls = {
            byAddress: new Map([[MARKET_PROGRAM, {
                name: 'proposal_market',
                address: MARKET_PROGRAM,
                instructions: new Map([[discriminator.toString('hex'), {
                    name: 'exotic',
                    accounts: ['market'],
                    args: [{ name: 'config', type: { defined: 'ExoticConfig' } }]
                }]])
            }]])
        };

        const decoded = decodeParsedTransaction(buildTx({
            accountKeys: [key(TREASURY, { signer: true, writable: true }), key(MARKET, { writable: true }), key(MARKET_PROGRAM)],
            instructions: [{ accounts: [MARKET], data: encodeBase58(discriminator), programId: MARKET_PROGRAM, stackHeight: 1 }]
        }), { book, idls: fakeIdls });

        expect(decoded.instructions[0].action).toBe('exotic');
        expect(decoded.instructions[0].args).toBeNull();
        expect(decoded.instructions[0].argsError).toContain('unsupported IDL arg type');
        expect(decoded.summary).toBe('treasury wallet called exotic on proposal_market');
    });

    it('returns null for a transaction that has no message', () => {
        expect(decodeParsedTransaction(null, { book, idls })).toBeNull();
        expect(decodeParsedTransaction({}, { book, idls })).toBeNull();
    });
});

// @solana/web3.js hands back PublicKey objects where the raw JSON-RPC response has base58 strings.
// A decoder that only understands the raw shape silently loses every label and every IDL match,
// which is exactly what happened on the first live devnet run.
describe('decodeParsedTransaction: hydrated @solana/web3.js shape', () => {
    function hydrate(tx) {
        const message = tx.transaction.message;
        const hydrateInstruction = (instruction) => ({
            ...instruction,
            programId: new PublicKey(instruction.programId),
            ...(instruction.accounts ? { accounts: instruction.accounts.map((account) => new PublicKey(account)) } : {})
        });
        return {
            ...tx,
            meta: {
                ...tx.meta,
                innerInstructions: (tx.meta.innerInstructions || []).map((entry) => ({
                    ...entry,
                    instructions: entry.instructions.map(hydrateInstruction)
                }))
            },
            transaction: {
                ...tx.transaction,
                message: {
                    ...message,
                    accountKeys: message.accountKeys.map((key) => ({ ...key, pubkey: new PublicKey(key.pubkey) })),
                    instructions: message.instructions.map(hydrateInstruction)
                }
            }
        };
    }

    it('decodes an spl-token settlement identically to the raw json shape', () => {
        const raw = decode(fixture('x402-settlement-transfer-checked'));
        const hydrated = decode(hydrate(fixture('x402-settlement-transfer-checked').result));

        expect(hydrated.summary).toBe(raw.summary);
        expect(hydrated.feePayer).toEqual(raw.feePayer);
        expect(hydrated.programs).toEqual(raw.programs);
        expect(hydrated.amounts).toEqual(raw.amounts);
        expect(hydrated.instructions).toEqual(raw.instructions);
    });

    it('still matches our anchor IDLs when the program id is a PublicKey', () => {
        const hydrated = decode(hydrate(fixture('proposal-nft-mint-and-fund').result));
        const anchor = hydrated.instructions.find((instruction) => instruction.program.name === 'proposal_nft');

        expect(anchor.action).toBe('mint_and_fund');
        expect(anchor.accounts.map((account) => account.role)).toEqual(['proposal', 'proposal_counter', 'owner', 'system_program']);
        expect(hydrated.summary).toBe('8ErK…UPyw minted proposal for parcels HR-335649-507 funded with 0 SOL');
    });
});

describe("Anchor's built-in IDL-account instruction", () => {
    it('is named anchor_idl and summarised as an IDL write instead of an opaque call', () => {
        const raw = fixture('proposal-market-deploy');
        const tx = raw.result ?? raw;
        const feePayer = tx.transaction.message.accountKeys[0].pubkey;
        // sha256("anchor:idl")[..8] reversed, then any payload — every on-chain IDL write starts this way.
        const data = encodeBase58(Buffer.concat([Buffer.from('40f4bc78a7e9690a', 'hex'), Buffer.from([1, 2, 3])]));
        tx.transaction.message.instructions = [{ programId: MARKET_PROGRAM, accounts: [feePayer], data }];
        tx.meta.innerInstructions = [];

        const decoded = decodeParsedTransaction(tx, { book, idls });

        expect(decoded.instructions[0].action).toBe('anchor_idl');
        expect(decoded.instructions[0].program.name).toBe('proposal_market');
        expect(decoded.actions).toEqual(['anchor_idl']);
        expect(decoded.summary).toBe('treasury wallet wrote the on-chain IDL of proposal_market (Anchor idl instruction)');
    });
});

describe('program deploy buffer chunks', () => {
    it('names a loader write as a program chunk upload into the deploy buffer', () => {
        const raw = fixture('proposal-market-deploy');
        const tx = raw.result ?? raw;
        tx.transaction.message.instructions = [{
            program: 'bpf-upgradeable-loader',
            programId: 'BPFLoaderUpgradeab1e11111111111111111111111',
            parsed: { type: 'write', info: { account: '5BvU98fP4M3muYuSasH81a36d7965BQ7k1oVxN8w7Yq1', authority: TREASURY, bytes: 'CgAAAAYAAAAooQMAAAAAAAoAAAAGAA', offset: '288960' } }
        }];
        tx.meta.innerInstructions = [];

        const decoded = decodeParsedTransaction(tx, { book, idls });

        expect(decoded.actions).toEqual(['write']);
        expect(decoded.summary).toBe('treasury wallet uploaded a program chunk to deploy buffer 5BvU…7Yq1');
    });
});

