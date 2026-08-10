// The status log is what a reload's progress is read from, and what gets pasted into a bug report.
// Two things stopped it being usable for either:
//
//   * every click inside the bar toggled it, including the MOUSEUP that ends a text selection — so
//     selecting a line closed the panel out from under the drag and there was nothing to copy;
//   * there was no way to take the whole log at once, only line-by-line hand-selection.
//
// And the longest silence in a reload — several seconds between "parcels loaded" and the first
// applied proposal — was the replay's per-member ground fetch, which said nothing at all.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const ui = read('../../frontend/js/ui-helpers.js');
const manager = read('../../frontend/js/proposal-manager.js');
const css = read('../../frontend/css/utilities.css');
const dictOf = locale => JSON.parse(read(`../../frontend/i18n/${locale}.json`));
const locales = ['en', 'hr', 'sr', 'es'];

describe('selecting text does not close the log', () => {
    const handler = ui.slice(
        ui.indexOf('    if (statusBar) {\n        let pressedAt = null;'),
        ui.indexOf('    // Clicking outside collapses')
    );

    it('ignores a click that ends a drag', () => {
        expect(handler).toContain("statusBar.addEventListener('mousedown'");
        expect(handler).toContain('Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4');
    });

    it('ignores a click that ends a selection, even one that never moved', () => {
        // A double-click selects a word without the pointer travelling anywhere.
        expect(handler).toContain('selection && !selection.isCollapsed');
    });

    it('never toggles from inside the log itself — that is where the text is', () => {
        expect(handler).toContain("e.target.closest('#status-log-expanded')");
        expect(handler).toContain("e.target.closest('[data-status-copy-all]')");
    });

    it('does not collapse when a selection dragged out of the bar is released outside it', () => {
        const outside = ui.slice(ui.indexOf('    // Clicking outside collapses'), ui.indexOf('const observer = new MutationObserver'));
        expect(outside).toContain('statusBar.contains(selection.anchorNode)');
    });

    it('lets the browser select the log at all', () => {
        expect(css).toContain('user-select: text;');
    });
});

describe('copy all', () => {
    it('copies exactly what is on screen, timestamp first', () => {
        expect(ui).toContain('const STATUS_LOG_VISIBLE_ENTRIES = 50;');
        expect(ui).toContain('function visibleStatusLogEntries()');
        expect(ui).toContain('`${entry.timestamp}\\t${entry.message}`');
        // The view and the button read the same helper, so the button cannot hand over something
        // other than what is displayed.
        expect(ui).toContain('const entriesToShow = visibleStatusLogEntries();');
    });

    it('reports how many lines went to the clipboard', () => {
        expect(ui).toContain('function copyStatusLog()');
        expect(ui).toContain("line${entries.length === 1 ? '' : 's'} copied");
        expect(ui).toContain("window.i18n.t('hud.statusLinesCopied', { count: entries.length })");
    });

    it('appears only while the log is expanded', () => {
        expect(ui).toContain('function ensureStatusCopyAllButton(statusBar)');
        expect(ui).toContain('ensureStatusCopyAllButton(statusBar);');
        expect(css).toContain('.status-bar:not(.expanded) .status-log-copy-all {');
    });

    it.each(locales)('%s can name the button and the confirmation', locale => {
        const hud = dictOf(locale).hud;
        expect(hud.copyStatusLog, `${locale} missing copyStatusLog`).toBeTruthy();
        expect(hud.statusLinesCopied, `${locale} missing statusLinesCopied`).toBeTruthy();
        expect(hud.statusLinesCopied).toContain('{{count}}');
    });
});

describe('the silence before the first proposal', () => {
    const loader = manager.slice(
        manager.indexOf('    async _loadReplayGround(appliedList) {'),
        manager.indexOf('    _replayGroundFetched: new Set(),')
    );

    it('says what it is doing, and how long it took', () => {
        expect(loader).toContain('_announceApply(`Loading ground for ${pendingMembers.length} proposal');
        expect(loader).toContain('_announceApply(`Ground loaded for ${pendingMembers.length} proposal');
        expect(loader).toContain('(elapsed / 1000).toFixed(1)');
    });

    it('counts only the members that still need fetching', () => {
        // Ground already on the map is never re-fetched, so announcing the whole list would
        // promise work that is not about to happen — and with nothing pending it says nothing.
        expect(loader).toContain('!this._replayGroundFetched.has(memo)');
        expect(loader).toContain('if (!pendingMembers.length) return _now() - started;');
    });
});

// A status LINE is superseded within a second on a busy reload, so by the time you look at the bar
// there is nothing left saying the app is still working. The spinner is the part that persists.
describe('the spinner', () => {
    it('is ref-counted, so overlapping work cannot switch it off early', () => {
        expect(ui).toContain('let statusActivityHolders = 0;');
        expect(ui).toContain('statusActivityHolders += 1;');
        expect(ui).toContain('if (statusActivityHolders > 0) return;');
    });

    it('hands back a release function, and is published for other modules', () => {
        expect(ui).toContain('return () => endStatusActivity();');
        expect(ui).toContain('window.beginStatusActivity = beginStatusActivity;');
        expect(ui).toContain('window.endStatusActivity = endStatusActivity;');
    });

    it('turns for the whole plan-wide derivation, and stops even if it throws', () => {
        const rebuild = manager.slice(
            manager.indexOf('    async rebuildAppliedFabric(options = {}) {'),
            manager.indexOf('    async _rebuildPass')
        );
        expect(rebuild).toContain('window.beginStatusActivity()');
        // In `finally` — a derivation that throws must not leave the bar spinning for ever.
        const tail = rebuild.slice(rebuild.lastIndexOf('} finally {'));
        expect(tail).toContain('spinnerHeld()');
    });

    it('keeps the mark when motion is reduced, because it is state and not decoration', () => {
        const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce) {'));
        expect(reduced.slice(0, 300)).toContain('.status-activity-spinner');
        expect(reduced.slice(0, 300)).toContain('animation: none;');
    });
});

// The replay used to ask for the ground one member at a time — 165 round trips, mostly re-fetching
// each other's parcels, because adjacent proposals share ground while the memo is per PROPOSAL. One
// MultiPolygon asks the same question once.
describe('the replay asks for its ground once', () => {
    const loader = manager.slice(
        manager.indexOf('    async _loadReplayGround(appliedList) {'),
        manager.indexOf('    _replayGroundFetched: new Set(),')
    );

    function loadHelper() {
        const start = manager.indexOf('function _multiPolygonOfFootprints(footprints) {');
        expect(start, '_multiPolygonOfFootprints not found').toBeGreaterThan(-1);
        const end = manager.indexOf('function _announceApply(message) {', start);
        // eslint-disable-next-line no-new-func
        return new Function(`${manager.slice(start, end)} return _multiPolygonOfFootprints;`)();
    }
    const asMultiPolygon = loadHelper();
    const poly = n => ({ type: 'Polygon', coordinates: [[[n, 0], [n + 1, 0], [n + 1, 1], [n, 1], [n, 0]]] });

    it('gathers many footprints into one geometry', () => {
        const out = asMultiPolygon([poly(0), { type: 'Feature', geometry: poly(10) }]);
        expect(out.type).toBe('MultiPolygon');
        expect(out.coordinates).toHaveLength(2);
    });

    it('flattens a MultiPolygon footprint rather than nesting it', () => {
        const multi = { type: 'MultiPolygon', coordinates: [poly(0).coordinates, poly(5).coordinates] };
        expect(asMultiPolygon([multi, poly(20)]).coordinates).toHaveLength(3);
    });

    it('is nothing when there is nothing to ask about', () => {
        expect(asMultiPolygon([])).toBeNull();
        expect(asMultiPolygon([null, { type: 'Point', coordinates: [1, 2] }])).toBeNull();
        expect(asMultiPolygon(null)).toBeNull();
    });

    it('sends bounded batches, then falls back per member for whatever they could not carry', () => {
        expect(loader).toContain('index += REPLAY_GROUND_BATCH_SIZE');
        expect(loader).toContain('_multiPolygonOfFootprints(entries.map(entry => entry.footprint))');
        // Over the cap or a transport failure: halve and retry, never lose the whole replay.
        expect(loader).toContain('const mid = Math.ceil(entries.length / 2);');
        expect(loader).toContain('const remaining = pendingMembers.filter(proposal => {');
        expect(loader).toContain('while (next < remaining.length) await loadOne(remaining[next++]);');
    });

    it('only remembers members the batch actually loaded', () => {
        // Memoising on a failed request would leave a formation permanently short of its ground.
        const batch = loader.slice(loader.indexOf('const loadBatch = async entries => {'), loader.indexOf('await loadBatch(batchable);'));
        expect(batch).toContain('if (!loaded) return;');
        expect(batch.indexOf('this._replayGroundFetched.add(memo)')).toBeGreaterThan(batch.indexOf('if (!loaded) return;'));
    });
});
