import { describe, expect, it } from 'vitest';
import {
    buildAddressBook,
    watchedAddresses,
    legendAddresses,
    deriveAssociatedTokenAddress,
    shortAddress,
    WATCHED_KINDS,
    DEVNET_USDC_MINT,
    DEFAULT_X402_FEE_PAYER
} from '../solana/address-book.js';

const TREASURY = 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ';
// Derived from the treasury / persona wallets on devnet — these exact accounts appear in the
// recorded transactions under test/fixtures/solana-tx.
const TREASURY_USDC = '3kch82dBbEGMJhwjoT6X6xFuyfQLP7o8c6WTnA7Svpz9';
const PERSONA_WALLET = 'G4R6RCCcQHN9fLoExvTBBfhbw8BgvTEqhJezG3A1HvEg';
const PERSONA_USDC = '8VZjdVctk5LuyH7uSgmhKiyeW7S11UWrcZsQneTG3SW5';

const personas = { personas: [{ name: 'densifier-01', wallet: PERSONA_WALLET }] };

function makeBook(overrides = {}) {
    return buildAddressBook({ env: { X402_PAY_TO: TREASURY }, personas, ...overrides });
}

describe('shortAddress', () => {
    it('shortens a base58 address to first four and last four characters', () => {
        expect(shortAddress(DEFAULT_X402_FEE_PAYER)).toBe('CKPK…WYp5');
        expect(shortAddress(TREASURY)).toBe('AMbs…mkoQ');
    });

    it('leaves short strings alone', () => {
        expect(shortAddress('abc')).toBe('abc');
        expect(shortAddress(null)).toBeNull();
    });
});

describe('deriveAssociatedTokenAddress', () => {
    it('derives the USDC associated token account of a wallet', () => {
        expect(deriveAssociatedTokenAddress(TREASURY, DEVNET_USDC_MINT)).toBe(TREASURY_USDC);
        expect(deriveAssociatedTokenAddress(PERSONA_WALLET, DEVNET_USDC_MINT)).toBe(PERSONA_USDC);
    });
});

describe('buildAddressBook', () => {
    it('labels our three programs', () => {
        const book = makeBook();

        expect(book.labelFor('4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1')).toEqual({
            address: '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1',
            label: 'parcel_nft program',
            kind: 'program',
            short: '4zad…tkV1'
        });
        expect(book.labelFor('3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg').label).toBe('proposal_nft program');
        expect(book.labelFor('GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB').label).toBe('proposal_market program');
    });

    it('labels the solana system programs', () => {
        const book = makeBook();

        expect(book.labelFor('11111111111111111111111111111111').label).toBe('System Program');
        expect(book.labelFor('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').label).toBe('SPL Token');
        expect(book.labelFor('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL').label).toBe('Associated Token Program');
        expect(book.labelFor('ComputeBudget111111111111111111111111111111').label).toBe('Compute Budget Program');
        expect(book.labelFor('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr').label).toBe('Memo Program');
        expect(book.labelFor('BPFLoaderUpgradeab1e11111111111111111111111').label).toBe('BPF Upgradeable Loader');
    });

    it('records the devnet USDC mint with its symbol and decimals', () => {
        const book = makeBook();

        expect(book.labelFor(DEVNET_USDC_MINT).kind).toBe('mint');
        expect(book.mintFor(DEVNET_USDC_MINT)).toEqual({ symbol: 'USDC', decimals: 6 });
        expect(book.mintFor(TREASURY)).toBeNull();
    });

    it('labels the treasury wallet and its USDC account from X402_PAY_TO', () => {
        const book = makeBook();

        expect(book.labelFor(TREASURY)).toEqual({
            address: TREASURY,
            label: 'treasury wallet',
            kind: 'wallet',
            short: 'AMbs…mkoQ'
        });
        expect(book.labelFor(TREASURY_USDC)).toEqual({
            address: TREASURY_USDC,
            label: 'treasury USDC account',
            kind: 'token-account',
            short: '3kch…vpz9'
        });
        expect(book.entryFor(TREASURY_USDC).owner).toBe(TREASURY);
        expect(book.treasury).toBe(TREASURY);
    });

    it('omits the treasury entries when X402_PAY_TO is not configured', () => {
        const book = buildAddressBook({ env: {}, personas });

        expect(book.treasury).toBeNull();
        expect(book.labelFor(TREASURY).label).toBeNull();
        expect(book.labelFor(TREASURY_USDC).label).toBeNull();
    });

    it('labels the x402 facilitator fee payer', () => {
        const book = makeBook();

        expect(book.labelFor(DEFAULT_X402_FEE_PAYER)).toEqual({
            address: DEFAULT_X402_FEE_PAYER,
            label: 'x402 facilitator (fee payer)',
            kind: 'fee-payer',
            short: 'CKPK…WYp5'
        });
        expect(book.feePayer).toBe(DEFAULT_X402_FEE_PAYER);
    });

    it('labels each persona wallet and its USDC account', () => {
        const book = makeBook();

        expect(book.labelFor(PERSONA_WALLET).label).toBe('agent densifier-01');
        expect(book.labelFor(PERSONA_WALLET).kind).toBe('wallet');
        expect(book.labelFor(PERSONA_USDC).label).toBe('agent densifier-01 USDC account');
        expect(book.labelFor(PERSONA_USDC).kind).toBe('token-account');
        expect(book.entryFor(PERSONA_USDC).owner).toBe(PERSONA_WALLET);
    });

    it('accepts a bare personas array as well as the personas.json object', () => {
        const book = buildAddressBook({ env: { X402_PAY_TO: TREASURY }, personas: personas.personas });

        expect(book.labelFor(PERSONA_WALLET).label).toBe('agent densifier-01');
    });

    it('skips personas without a name or wallet', () => {
        const book = buildAddressBook({
            env: {},
            personas: { personas: [{ name: 'no-wallet' }, { wallet: PERSONA_WALLET }] }
        });

        expect(book.labelFor(PERSONA_WALLET).label).toBeNull();
        expect(book.entries.some((entry) => entry.persona)).toBe(false);
    });

    it('returns a null label and a short form for an unknown address', () => {
        const book = makeBook();

        expect(book.labelFor('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')).toEqual({
            address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
            label: null,
            kind: null,
            short: '9WzD…AWWM'
        });
        expect(book.entryFor('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')).toBeNull();
    });

    it('uses a caller-supplied fee payer over the default', () => {
        const book = buildAddressBook({ env: {}, personas: [], x402FeePayer: PERSONA_WALLET });

        expect(book.labelFor(PERSONA_WALLET).label).toBe('x402 facilitator (fee payer)');
        expect(book.labelFor(DEFAULT_X402_FEE_PAYER).label).toBeNull();
    });
});

describe('watchedAddresses', () => {
    it('scans our programs, wallets and token accounts but never the facilitator fee payer', () => {
        const book = makeBook();

        // The fee payer signs every x402 payment on devnet by anyone; scanning it would pull
        // strangers' payments into our history. It stays a label (see legendAddresses).
        expect(watchedAddresses(book)).toEqual([
            '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1',
            '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg',
            'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB',
            TREASURY,
            TREASURY_USDC,
            PERSONA_WALLET,
            PERSONA_USDC
        ]);
        expect(legendAddresses(book)).toContain(DEFAULT_X402_FEE_PAYER);
        expect(legendAddresses(book)).toEqual(expect.arrayContaining(watchedAddresses(book)));
    });

    it('never watches solana system programs or the mint', () => {
        const watched = watchedAddresses(makeBook());

        expect(watched).not.toContain('11111111111111111111111111111111');
        expect(watched).not.toContain('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
        expect(watched).not.toContain('ComputeBudget111111111111111111111111111111');
        expect(watched).not.toContain(DEVNET_USDC_MINT);
    });

    it('only lists the watched kinds', () => {
        const book = makeBook();
        const kinds = new Set(watchedAddresses(book).map((address) => book.labelFor(address).kind));

        for (const kind of kinds) expect(WATCHED_KINDS).toContain(kind);
    });

    it('tolerates a missing book', () => {
        expect(watchedAddresses(undefined)).toEqual([]);
    });
});
