// Unit tests for frontend/js/tx-explorer.js — the pure model behind the standalone devnet
// transaction explorer (frontend/tx-explorer.html). The page is an ops surface for tracing agent
// payments, so the parts worth testing are the ones that decide what a row SAYS: which rows survive
// the filters, how an amount reads, where a link points, and how the who-is-who legend is grouped.
// Loaded the same way gain.test.js loads its classic script: createRequire, no DOM, no browser.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
    applyFilters,
    formatTime,
    explorerLinks,
    addressLink,
    renderRowModel,
    groupWatched,
    sortNewestFirst,
    resolveBackendBase
} = require('../../frontend/js/tx-explorer.js');

const EXPLORER = {
    tx: 'https://explorer.solana.com/tx/{sig}?cluster=devnet',
    address: 'https://explorer.solana.com/address/{addr}?cluster=devnet',
    solscanTx: 'https://solscan.io/tx/{sig}?cluster=devnet',
    solscanAddress: 'https://solscan.io/account/{addr}?cluster=devnet'
};

// Two transactions that differ in every filterable dimension: program, action, labels, signature.
function settlementTx() {
    return {
        signature: 'SIG_SETTLEMENT_0001',
        slot: 499439818,
        blockTime: 1789586329,
        time: '2026-09-16T19:18:49.000Z',
        status: 'success',
        error: null,
        feePayer: { address: 'CKPKfacilitator1111111111111111111111111111', label: 'x402 facilitator (fee payer)', kind: 'fee-payer', short: 'CKPK…1111' },
        feeLamports: 10001,
        feeSol: '0.000010001',
        programs: ['spl-token'],
        actions: ['transferChecked'],
        summary: 'agent densifier-01 paid 0.05 USDC to treasury wallet (x402 settlement)',
        amounts: [{
            kind: 'token',
            mint: 'MINTusdc11111111111111111111111111111111111',
            symbol: 'USDC',
            decimals: 6,
            amount: '0.05',
            amountAtomic: '50000',
            from: { address: 'AGENTata1111111111111111111111111111111111', label: 'agent densifier-01 USDC account', kind: 'token-account', owner: { address: 'AGENTwallet11111111111111111111111111111111', label: 'agent densifier-01' } },
            to: { address: 'TREASURYata1111111111111111111111111111111', label: 'treasury USDC account', kind: 'token-account', owner: null }
        }],
        instructions: [{
            index: 0,
            inner: false,
            parentIndex: null,
            program: { address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', label: 'SPL Token', name: 'spl-token' },
            action: 'transferChecked',
            args: { amount: '50000', decimals: 6 },
            accounts: [{ role: 'owner', address: 'AGENTwallet11111111111111111111111111111111', label: 'agent densifier-01', signer: true, writable: false }]
        }]
    };
}

function stakeTx() {
    return {
        signature: 'SIG_STAKE_0002',
        slot: 499439455,
        blockTime: 1789586102,
        time: '2026-09-16T19:15:02.000Z',
        status: 'success',
        error: null,
        feePayer: { address: 'AGENTwallet11111111111111111111111111111111', label: 'agent densifier-01', kind: 'wallet' },
        feeLamports: 5000,
        feeSol: '0.000005',
        programs: ['proposal-market', 'spl-token'],
        actions: ['stake', 'transfer'],
        summary: 'agent densifier-01 staked 0.3 USDC on YES in the proposal market',
        amounts: [],
        instructions: [
            {
                index: 0, inner: false, parentIndex: null,
                program: { address: 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB', label: 'proposal market program', name: 'proposal-market' },
                action: 'stake',
                args: { side: 1, amount: '300000' },
                accounts: [{ role: 'staker', address: 'AGENTwallet11111111111111111111111111111111', label: 'agent densifier-01', signer: true, writable: true }]
            },
            {
                index: 0, inner: true, parentIndex: 0,
                program: { address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', label: 'SPL Token', name: 'spl-token' },
                action: 'transfer',
                args: { amount: '300000' },
                accounts: []
            }
        ]
    };
}

describe('applyFilters', () => {
    const list = [settlementTx(), stakeTx()];

    it('with no filters returns every transaction (a copy, not the input array)', () => {
        const out = applyFilters(list, {});
        expect(out).toHaveLength(2);
        expect(out).not.toBe(list);
        expect(applyFilters(list, { text: '', programs: [], actions: [] })).toHaveLength(2);
    });

    it('matches on a label found only deep inside the transaction', () => {
        // "treasury USDC account" appears nowhere but the amount's `to.label`.
        const out = applyFilters(list, { text: 'treasury usdc account' });
        expect(out.map(tx => tx.signature)).toEqual(['SIG_SETTLEMENT_0001']);
    });

    it('matches on the signature and on the summary, case-insensitively', () => {
        expect(applyFilters(list, { text: 'sig_stake' }).map(tx => tx.signature)).toEqual(['SIG_STAKE_0002']);
        expect(applyFilters(list, { text: 'staked 0.3 usdc' }).map(tx => tx.signature)).toEqual(['SIG_STAKE_0002']);
    });

    it('matches on an address', () => {
        expect(applyFilters(list, { text: 'CKPKfacilitator' }).map(tx => tx.signature)).toEqual(['SIG_SETTLEMENT_0001']);
    });

    it('returns nothing when the text matches nothing', () => {
        expect(applyFilters(list, { text: 'no such thing' })).toEqual([]);
    });

    it('filters by program chip, ORing within the facet', () => {
        expect(applyFilters(list, { programs: ['proposal-market'] }).map(tx => tx.signature)).toEqual(['SIG_STAKE_0002']);
        // spl-token is in both transactions.
        expect(applyFilters(list, { programs: ['spl-token'] })).toHaveLength(2);
        expect(applyFilters(list, { programs: ['proposal-market', 'system'] }).map(tx => tx.signature)).toEqual(['SIG_STAKE_0002']);
    });

    it('filters by action chip', () => {
        expect(applyFilters(list, { actions: ['transferChecked'] }).map(tx => tx.signature)).toEqual(['SIG_SETTLEMENT_0001']);
        expect(applyFilters(list, { actions: ['stake'] }).map(tx => tx.signature)).toEqual(['SIG_STAKE_0002']);
    });

    it('accepts a Set for the chip facets (the page holds selections in a Set)', () => {
        expect(applyFilters(list, { programs: new Set(['proposal-market']) }).map(tx => tx.signature)).toEqual(['SIG_STAKE_0002']);
    });

    it('ANDs across facets: text AND program AND action', () => {
        expect(applyFilters(list, { text: 'densifier', programs: ['spl-token'], actions: ['stake'] })
            .map(tx => tx.signature)).toEqual(['SIG_STAKE_0002']);
        // Same text and program, but an action neither of those rows has.
        expect(applyFilters(list, { text: 'densifier', programs: ['spl-token'], actions: ['claim'] })).toEqual([]);
        // Program and action that exist, but in DIFFERENT transactions -> no row satisfies both.
        expect(applyFilters(list, { programs: ['proposal-market'], actions: ['transferChecked'] })).toEqual([]);
    });

    it('survives junk input', () => {
        expect(applyFilters(null, { text: 'x' })).toEqual([]);
        expect(applyFilters(list, null)).toHaveLength(2);
    });
});

describe('renderRowModel', () => {
    it('reads a token amount as "<amount> <symbol> · <from> → <to>" using labels', () => {
        const model = renderRowModel(settlementTx());
        expect(model.amounts).toHaveLength(1);
        expect(model.amounts[0].text)
            .toBe('0.05 USDC · agent densifier-01 USDC account → treasury USDC account');
        expect(model.amounts[0].from.owner).toBe('agent densifier-01');
        expect(model.amounts[0].to.owner).toBe('');
    });

    it('falls back to a short address when an amount party has no label', () => {
        const tx = settlementTx();
        tx.amounts[0].from = { address: 'AGENTata1111111111111111111111111111111111', label: null };
        tx.amounts[0].to = { address: 'TREASURYata1111111111111111111111111111111', label: null, short: 'TREA…1111' };
        const model = renderRowModel(tx);
        // from: short computed locally (first 4 … last 4); to: the short the backend supplied.
        expect(model.amounts[0].text).toBe('0.05 USDC · AGEN…1111 → TREA…1111');
    });

    it('reads a SOL amount, and infers the SOL symbol when the payload omits it', () => {
        const tx = settlementTx();
        tx.amounts = [{
            kind: 'sol',
            mint: null,
            amount: '0.5',
            amountAtomic: '500000000',
            from: { address: 'OPERATORwallet1111111111111111111111111111', label: 'operator wallet' },
            to: { address: 'AGENTwallet11111111111111111111111111111111', label: 'agent densifier-01' }
        }];
        expect(renderRowModel(tx).amounts[0].text)
            .toBe('0.5 SOL · operator wallet → agent densifier-01');
    });

    it('says "unknown" rather than dropping a side when an amount has only one party', () => {
        const tx = settlementTx();
        tx.amounts[0].from = null;
        expect(renderRowModel(tx).amounts[0].text)
            .toBe('0.05 USDC · unknown → treasury USDC account');
    });

    it('carries the row basics: summary, tags, fee payer, short signature, status', () => {
        const model = renderRowModel(settlementTx());
        expect(model.summary).toBe('agent densifier-01 paid 0.05 USDC to treasury wallet (x402 settlement)');
        expect(model.tags).toEqual([
            { kind: 'program', text: 'spl-token' },
            { kind: 'action', text: 'transferChecked' }
        ]);
        expect(model.feePayer.label).toBe('x402 facilitator (fee payer)');
        expect(model.feeSol).toBe('0.000010001');
        expect(model.signatureShort).toBe('SIG_…0001');
        expect(model.status).toBe('success');
        expect(model.failed).toBe(false);
    });

    it('marks a failed transaction and stringifies its error', () => {
        const tx = settlementTx();
        tx.status = 'failed';
        tx.error = { InstructionError: [0, 'Custom'] };
        const model = renderRowModel(tx);
        expect(model.failed).toBe(true);
        expect(model.statusLabel).toBe('failed');
        expect(model.error).toBe('{"InstructionError":[0,"Custom"]}');
    });

    it('labels an inner instruction with the instruction it came from, and lists decoded args', () => {
        const model = renderRowModel(stakeTx());
        expect(model.instructions.map(ix => ix.indexLabel)).toEqual(['#0', '#0 (inner of #0)']);
        expect(model.instructions[0].programLabel).toBe('proposal market program');
        expect(model.instructions[0].action).toBe('stake');
        expect(model.instructions[0].args).toEqual([
            { key: 'side', value: '1' },
            { key: 'amount', value: '300000' }
        ]);
        expect(model.instructions[0].accounts[0]).toMatchObject({
            role: 'staker', label: 'agent densifier-01', signer: true, writable: true, flags: ['signer', 'writable']
        });
    });

    it('collects programs and actions from the instruction list when the top-level arrays are missing', () => {
        const tx = stakeTx();
        delete tx.programs;
        delete tx.actions;
        const model = renderRowModel(tx);
        expect(model.programs).toEqual(['proposal-market', 'spl-token']);
        expect(model.actions).toEqual(['stake', 'transfer']);
    });

    it('does not throw on an empty transaction', () => {
        const model = renderRowModel({});
        expect(model.summary).toBe('(no summary)');
        expect(model.amounts).toEqual([]);
        expect(model.instructions).toEqual([]);
    });
});

describe('explorerLinks / addressLink', () => {
    it('substitutes the signature into both templates', () => {
        expect(explorerLinks(EXPLORER, 'SIG_STAKE_0002')).toEqual({
            explorer: 'https://explorer.solana.com/tx/SIG_STAKE_0002?cluster=devnet',
            solscan: 'https://solscan.io/tx/SIG_STAKE_0002?cluster=devnet'
        });
    });

    it('substitutes the address into both templates', () => {
        expect(addressLink(EXPLORER, 'AGENTwallet11111111111111111111111111111111')).toEqual({
            explorer: 'https://explorer.solana.com/address/AGENTwallet11111111111111111111111111111111?cluster=devnet',
            solscan: 'https://solscan.io/account/AGENTwallet11111111111111111111111111111111?cluster=devnet'
        });
    });

    it('returns null instead of a broken URL when a template or the value is missing', () => {
        expect(explorerLinks(EXPLORER, '')).toEqual({ explorer: null, solscan: null });
        expect(explorerLinks({}, 'SIG')).toEqual({ explorer: null, solscan: null });
        expect(explorerLinks(null, 'SIG')).toEqual({ explorer: null, solscan: null });
        expect(addressLink({ address: 'https://x/{addr}' }, 'ADDR'))
            .toEqual({ explorer: 'https://x/ADDR', solscan: null });
    });
});

describe('groupWatched', () => {
    const watched = [
        { address: 'MINT1', label: 'USDC (devnet)', kind: 'mint' },
        { address: 'WALLET1', label: 'agent densifier-01', kind: 'wallet' },
        { address: 'PROG1', label: 'SPL Token', kind: 'program' },
        { address: 'WALLET2', label: 'treasury wallet', kind: 'wallet' },
        { address: 'FEE1', label: 'x402 facilitator', kind: 'fee-payer' },
        { address: 'ATA1', label: 'treasury USDC account', kind: 'token-account' }
    ];

    it('groups by kind in a fixed order, keeping the payload order inside a group', () => {
        const groups = groupWatched(watched);
        expect(groups.map(g => g.kind)).toEqual(['wallet', 'program', 'mint', 'token-account', 'fee-payer']);
        expect(groups[0].label).toBe('Wallets');
        expect(groups[0].entries.map(e => e.label)).toEqual(['agent densifier-01', 'treasury wallet']);
    });

    it('computes a short form and keeps an unknown label null', () => {
        const groups = groupWatched([{ address: 'G4R6RCCcQHN9fLoExvTBBfhbw8BgvTEqhJezG3A1HvEg', kind: 'wallet' }]);
        expect(groups[0].entries[0]).toEqual({
            address: 'G4R6RCCcQHN9fLoExvTBBfhbw8BgvTEqhJezG3A1HvEg',
            label: null,
            kind: 'wallet',
            short: 'G4R6…HvEg'
        });
    });

    it('puts an unrecognised kind last, and drops entries with no address', () => {
        const groups = groupWatched([
            { address: 'X1', kind: 'oracle' },
            { address: 'W1', kind: 'wallet' },
            { label: 'nameless', kind: 'wallet' }
        ]);
        expect(groups.map(g => g.kind)).toEqual(['wallet', 'oracle']);
        expect(groups[0].entries).toHaveLength(1);
        expect(groups[1].label).toBe('oracle');
    });

    it('returns an empty list for junk', () => {
        expect(groupWatched(null)).toEqual([]);
        expect(groupWatched([])).toEqual([]);
    });
});

describe('sortNewestFirst', () => {
    it('puts the newest block time first whatever order the API sent', () => {
        const older = { signature: 'OLD', blockTime: 1789585240 };
        const newer = { signature: 'NEW', blockTime: 1789586329 };
        expect(sortNewestFirst([older, newer]).map(tx => tx.signature)).toEqual(['NEW', 'OLD']);
        expect(sortNewestFirst([newer, older]).map(tx => tx.signature)).toEqual(['NEW', 'OLD']);
    });

    it('sorts a transaction with no block time last instead of treating it as epoch 0', () => {
        const pending = { signature: 'PENDING', blockTime: null };
        const settled = { signature: 'SETTLED', blockTime: 1789586329 };
        expect(sortNewestFirst([pending, settled]).map(tx => tx.signature)).toEqual(['SETTLED', 'PENDING']);
    });

    it('is stable on ties and does not mutate the input', () => {
        const list = [{ signature: 'A', blockTime: 10 }, { signature: 'B', blockTime: 10 }];
        expect(sortNewestFirst(list).map(tx => tx.signature)).toEqual(['A', 'B']);
        expect(list.map(tx => tx.signature)).toEqual(['A', 'B']);
        expect(sortNewestFirst(list)).not.toBe(list);
        expect(sortNewestFirst(null)).toEqual([]);
    });
});

describe('formatTime', () => {
    it('renders a valid ISO time as local wall clock and keeps the ISO for the title attribute', () => {
        const out = formatTime('2026-09-16T19:18:49.000Z');
        expect(out.valid).toBe(true);
        expect(out.iso).toBe('2026-09-16T19:18:49.000Z');
        expect(out.local).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
        // The local string must be the SAME INSTANT as the ISO one, whatever the runner's timezone:
        // "2026-09-16T21:18:49" without a Z parses as local time, so the two must be equal to the
        // second. This is what catches a formatter that prints UTC parts and calls them local.
        expect(new Date(out.local.replace(' ', 'T')).getTime()).toBe(new Date(out.iso).getTime());
    });

    it('handles null, undefined, empty and unparseable times without throwing', () => {
        for (const bad of [null, undefined, '', '   ', 'not a date', {}, NaN]) {
            const out = formatTime(bad);
            expect(out.valid).toBe(false);
            expect(out.local).toBe('unknown time');
            expect(out.iso).toBe('');
        }
    });
});

describe('resolveBackendBase', () => {
    function fakeStorage(initial) {
        const map = new Map(Object.entries(initial || {}));
        return {
            getItem: key => (map.has(key) ? map.get(key) : null),
            setItem: (key, value) => map.set(key, String(value)),
            _map: map
        };
    }

    it('uses the production API off localhost', () => {
        expect(resolveBackendBase({ hostname: 'urbangametheory.xyz', protocol: 'https:', search: '' }, fakeStorage()))
            .toBe('https://api.urbangametheory.xyz');
    });

    it('uses localhost:3000 on localhost and on file://', () => {
        expect(resolveBackendBase({ hostname: 'localhost', protocol: 'http:', search: '' }, fakeStorage()))
            .toBe('http://localhost:3000');
        expect(resolveBackendBase({ hostname: '', protocol: 'file:', search: '' }, fakeStorage()))
            .toBe('http://localhost:3000');
        expect(resolveBackendBase({ hostname: '127.0.0.1', protocol: 'http:', search: '' }, fakeStorage()))
            .toBe('http://127.0.0.1:3000');
    });

    it('honours ?backend= on localhost and persists it for the next load', () => {
        const storage = fakeStorage();
        expect(resolveBackendBase({ hostname: 'localhost', protocol: 'http:', search: '?backend=http://localhost:3012/' }, storage))
            .toBe('http://localhost:3012');
        // Stored RAW and stripped on the way out — exactly what data-source.js does, so both pages
        // read the same localStorage key without one of them normalising it behind the other's back.
        expect(storage.getItem('cb_dev_backend_base')).toBe('http://localhost:3012/');
        expect(resolveBackendBase({ hostname: 'localhost', protocol: 'http:', search: '' }, storage))
            .toBe('http://localhost:3012');
    });

    it('ignores ?backend= off localhost, so it can never repoint production', () => {
        expect(resolveBackendBase({ hostname: 'urbangametheory.xyz', protocol: 'https:', search: '?backend=http://evil.example' }, fakeStorage()))
            .toBe('https://api.urbangametheory.xyz');
    });
});

describe('the shipped offline fixture', () => {
    const file = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../frontend/data/tx-explorer-sample.json');
    const sample = JSON.parse(readFileSync(file, 'utf8'));

    it('matches the contract the page renders against', () => {
        expect(sample.cluster).toBe('devnet');
        expect(sample.transactions).toHaveLength(3);
        expect(sample.count).toBe(sample.transactions.length);
        expect(Object.keys(sample.explorer).sort()).toEqual(['address', 'solscanAddress', 'solscanTx', 'tx']);
    });

    it('renders every fixture row, and the three flows read as intended', () => {
        const models = sample.transactions.map(renderRowModel);
        models.forEach(model => {
            expect(model.signature).not.toBe('');
            expect(model.time.valid).toBe(true);
            expect(explorerLinks(sample.explorer, model.signature).explorer).toContain(model.signature);
        });
        expect(models[0].amounts[0].text)
            .toBe('0.05 USDC · agent densifier-01 USDC account → treasury USDC account');
        expect(models[1].instructions.map(ix => ix.indexLabel)).toEqual(['#0', '#0 (inner of #0)']);
        expect(models[2].amounts[0].text)
            .toBe('0.5 SOL · operator wallet → agent densifier-01');
    });

    it('is filterable by every chip the page will derive from it', () => {
        const txs = sample.transactions;
        expect(applyFilters(txs, { programs: ['proposal-market'] })).toHaveLength(1);
        expect(applyFilters(txs, { actions: ['transfer'] })).toHaveLength(2);
        expect(applyFilters(txs, { text: 'x402' })).toHaveLength(1);
    });
});
