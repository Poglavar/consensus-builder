// A read-only (secondary) tab must not write the SHARED key, and must say so.
//
// Why it exists: all tabs share one IndexedDB blob with no cross-tab merge, so multi-tab-guard.js
// marks every tab but the first read-only and proposalStorage._persist skips writing. It used to
// skip in complete silence, which made a read-only tab indistinguishable from a working one —
// proposals could be created, applied and rendered, and were simply gone after a reload with
// nothing in the console to explain it. That cost a real debugging session chasing a persistence
// bug that did not exist.
//
// It no longer LOSES that work: warning that work might be lost was never a licence to delete it.
// The proposals are parked under a private recovery key and offered back on the next primary load
// (see proposal-readonly-recovery.test.js). Only the shared key stays untouched — that is the one
// whose write would clobber the other tab.
//
// proposals/data.js is a classic browser script with no exports, so it is evaluated in THIS realm
// behind stubs, the same way urban-rule-manual-simplify.test.js loads building-blocks.js.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let storage;
let written;

beforeAll(() => {
    written = [];
    const noop = () => { };
    global.PersistentStorage = {
        getItem: () => null,
        setItem: (key, value) => written.push({ key, value }),
        removeItem: noop,
        forEach: noop,
        atomicWrite: async change => { (change.puts || new Map()).forEach((value, key) => written.push({ key, value })); }
    };
    global.document = { getElementById: () => null, createElement: () => ({ style: {}, classList: { add: noop, remove: noop }, addEventListener: noop, setAttribute: noop, appendChild: noop }), addEventListener: noop, querySelector: () => null, querySelectorAll: () => [] };
    global.window = {
        document: global.document,
        addEventListener: noop,
        __cbSecondaryTab: false,
        __formationDepth: { stripDerivedRecordData: record => structuredClone(record) }
    };
    global.L = undefined;
    global.turf = undefined;

    const scriptPath = join(dirname(fileURLToPath(import.meta.url)), '../../frontend/js/proposals/data.js');
    let src = readFileSync(scriptPath, 'utf8');
    src += '\nglobalThis.__capData = { proposalStorage };';
    // eslint-disable-next-line no-eval
    (0, eval)(src);
    storage = globalThis.__capData.proposalStorage;
});

beforeEach(() => {
    written.length = 0;
    global.window.__cbSecondaryTab = false;
    storage._blockedWriteCount = 0;
});

describe('proposalStorage._persist in a read-only tab', () => {
    it('writes normally when this tab owns the store', () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => { });
        storage._persist();
        expect(written.length).toBeGreaterThan(0);
        expect(errors).not.toHaveBeenCalled();
        errors.mockRestore();
    });

    it('never writes the shared key when the app is open in another tab', () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => { });
        global.window.__cbSecondaryTab = true;
        storage.proposals.set('p-1', {
            proposalId: 'p-1', title: 'parked', cadastreParcelIds: ['HR-PARKED-1']
        });
        storage._persist();
        // Scoped to the SHARED key on purpose: a bare `written === []` passed only because the store
        // happened to be empty, and would have quietly forbidden the recovery write that now keeps
        // the user's work.
        expect(written.filter(entry => entry.key.startsWith('proposal:') || entry.key === 'cadastre_proposals_manifest' || entry.key === 'cadastre_proposals')).toEqual([]);
        expect(written.map(entry => entry.key)).toContain('cadastre_proposals_recovery');
        storage.proposals.clear();
        errors.mockRestore();
    });

    it('reports every dropped write loudly instead of failing silently', () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => { });
        global.window.__cbSecondaryTab = true;

        storage._persist();
        storage._persist();

        expect(errors).toHaveBeenCalledTimes(2);
        const message = String(errors.mock.calls[0][0]);
        expect(message).toContain('read-only');
        // It must NOT say "NOT SAVED" any more — the work is parked, and telling someone their work
        // is gone when it is recoverable is its own kind of wrong.
        expect(message).not.toContain('NOT SAVED');
        expect(message).toContain('parked');
        // The count makes repeated loss visible rather than looking like one stray warning.
        expect(String(errors.mock.calls[1][0])).toContain('dropped writes: 2');
        errors.mockRestore();
    });

    it('tells the multi-tab guard, so a dismissed banner comes back', () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => { });
        global.window.__cbSecondaryTab = true;
        let reported = 0;
        global.window.__cbReportSecondaryWriteBlocked = () => { reported += 1; };

        storage._persist();

        expect(reported).toBe(1);
        delete global.window.__cbReportSecondaryWriteBlocked;
        errors.mockRestore();
    });
});
