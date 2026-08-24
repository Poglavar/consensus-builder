// Applying a plan redraws the map once per member, and each redraw is a full teardown:
// updateProposedBuildingsLayer removes its layer and rebuilds from the whole list, and parks,
// lakes, squares, reparcellizations and parcel styles do the same. 299 members meant 299 teardowns
// of the same layers — which is why coordinate reprojection dominated a CPU profile of the replay.
//
// The hold coalesces them into one. What matters is that it coalesces (not "does nothing"), that it
// still refreshes exactly once afterwards, and above all that a throw cannot leave the hold stuck
// on — a stuck hold means the map silently stops redrawing for the rest of the session.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = readFileSync(fileURLToPath(new URL('../../frontend/js/proposal-manager.js', import.meta.url)), 'utf8');

// The hold is three small module-level functions plus the guard inside the refresh. Lift the
// mechanism out and drive it against a counting manager.
function loadHold() {
    const pieces = [
        'let _uiRefreshHeld = 0;',
        'let _uiRefreshMissed = false;',
        'let _uiRefreshLastProposal = null;'
    ];
    for (const piece of pieces) {
        if (!source.includes(piece)) throw new Error(`proposal-manager.js no longer declares: ${piece}`);
    }
    const grab = (name) => {
        let start = source.indexOf(`function ${name}(`);
        if (start < 0) throw new Error(`proposal-manager.js no longer declares ${name}`);
        // Keep an `async` prefix: slicing from `function` alone drops it, and the body then fails
        // to parse on its own await — which looked like a broken hold rather than a broken lift.
        if (source.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
        const end = source.indexOf('\n}\n', start);
        return source.slice(start, end + 2);
    };

    const refreshCalls = [];
    const sandbox = {
        console: { warn() {}, log() {} },
        refreshCalls,
        ProposalManager: {
            _refreshUIAfterProposalChange(proposal) {
                // Mirrors the real guard at the top of the method.
                if (sandbox.__held() > 0) { sandbox.__miss(proposal); return; }
                refreshCalls.push(proposal ? (proposal.id || 'proposal') : null);
            }
        }
    };
    const context = vm.createContext(sandbox);
    vm.runInContext(
        [
            ...pieces,
            grab('_holdUIRefresh'),
            grab('_releaseUIRefresh'),
            grab('withProposalUIRefreshHeld'),
            'globalThis.__held = () => _uiRefreshHeld;',
            'globalThis.__miss = (p) => { _uiRefreshMissed = true; if (p) _uiRefreshLastProposal = p; };',
            'globalThis.__hold = _holdUIRefresh;',
            'globalThis.__release = _releaseUIRefresh;',
            'globalThis.__with = withProposalUIRefreshHeld;'
        ].join('\n'),
        context,
        { filename: 'ui-refresh-hold.js' }
    );
    return sandbox;
}

// The tests below lift the real _holdUIRefresh/_releaseUIRefresh/withProposalUIRefreshHeld, but the
// guard that makes them matter lives inside _refreshUIAfterProposalChange and has to be REIMPLEMENTED
// in the sandbox to drive them. So it is pinned here from the source: without this, deleting the
// real guard leaves every test below green while the map redraws 299 times again.
describe('the refresh itself honours the hold', () => {
    it('consults the hold before doing any work', () => {
        const start = source.indexOf('_refreshUIAfterProposalChange(proposalData) {');
        expect(start, 'proposal-manager.js no longer declares _refreshUIAfterProposalChange').toBeGreaterThan(0);
        const head = source.slice(start, start + 700);

        expect(head, 'the refresh no longer checks _uiRefreshHeld — the hold is decorative')
            .toMatch(/if \(_uiRefreshHeld > 0\)/);
        // …and records that one is owed, or the final redraw never happens.
        expect(head).toMatch(/_uiRefreshMissed = true/);

        // The guard must come before the layer teardowns it is meant to skip. Indices are taken
        // from the whole source rather than a fixed-size window, which was long enough to hold the
        // guard but not the first teardown — so the check compared against -1 and failed on
        // correct code.
        const guardAt = source.indexOf('_uiRefreshHeld', start);
        const teardownAt = source.indexOf('updateProposalLayer', start);
        expect(teardownAt, 'no layer teardown found after the guard').toBeGreaterThan(-1);
        expect(guardAt, 'the guard comes after work it was meant to skip').toBeLessThan(teardownAt);
    });

    it('is actually held around the bulk apply paths', () => {
        const sharing = readFileSync(
            fileURLToPath(new URL('../../frontend/js/proposals/sharing-routes.js', import.meta.url)), 'utf8');
        expect(source, 'the fabric replay no longer holds the refresh').toMatch(/_holdUIRefresh\(\);/);
        expect(source, 'the replay must release it in a finally').toMatch(/_releaseUIRefresh\(this\);/);
        expect(sharing, 'the shared-plan apply no longer holds the refresh').toMatch(/holdRefresh\(/);
    });
});

describe('the post-apply UI refresh, held across bulk work', () => {
    it('collapses a run of applies into a single refresh', async () => {
        const s = loadHold();
        await s.__with(async () => {
            for (let i = 0; i < 299; i++) s.ProposalManager._refreshUIAfterProposalChange({ id: `p${i}` });
            expect(s.refreshCalls, 'redrew while held').toEqual([]);
        });

        expect(s.refreshCalls).toEqual(['p298']);
    });

    it('refreshes nothing when nothing changed', async () => {
        const s = loadHold();
        await s.__with(async () => { /* no applies */ });
        expect(s.refreshCalls).toEqual([]);
    });

    it('redraws normally when not held', () => {
        const s = loadHold();
        s.ProposalManager._refreshUIAfterProposalChange({ id: 'a' });
        s.ProposalManager._refreshUIAfterProposalChange({ id: 'b' });
        expect(s.refreshCalls).toEqual(['a', 'b']);
    });

    // The one that matters: a stuck hold is worse than no hold, because the map stops redrawing
    // for the rest of the session and nothing says why.
    it('releases the hold when the work throws', async () => {
        const s = loadHold();
        await expect(s.__with(async () => {
            s.ProposalManager._refreshUIAfterProposalChange({ id: 'x' });
            throw new Error('apply blew up');
        })).rejects.toThrow('apply blew up');

        expect(s.__held(), 'hold stuck on after a throw').toBe(0);
        expect(s.refreshCalls, 'the owed refresh was dropped').toEqual(['x']);

        s.ProposalManager._refreshUIAfterProposalChange({ id: 'after' });
        expect(s.refreshCalls).toEqual(['x', 'after']);
    });

    it('nests, and only the outermost release redraws', async () => {
        const s = loadHold();
        await s.__with(async () => {
            await s.__with(async () => {
                s.ProposalManager._refreshUIAfterProposalChange({ id: 'inner' });
            });
            expect(s.refreshCalls, 'an inner release redrew').toEqual([]);
            s.ProposalManager._refreshUIAfterProposalChange({ id: 'outer' });
        });

        expect(s.refreshCalls).toEqual(['outer']);
    });
});
