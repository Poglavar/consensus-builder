/* The share panel answers its opener with a promise that settles once the panel is worth looking at
   (rows listed, map framed), so a caller can hold its own UI until then. That trades a cosmetic
   flicker for a much worse failure: an exit path that forgets to signal leaves the caller waiting
   forever with no way forward.

   So two things are pinned here. First the signal itself, executed: settle-once, idempotent, and
   the promise really resolves. Second the wiring in the browser files, read from source, because
   the guarantee is structural — the settle lives in a `finally`, so any `return` added to that
   function later is covered without anyone remembering to. If that structure is edited away, this
   test says so. (The upload modal that held itself open on this promise went with M2's design
   publishing; the sidebar's Share button is the opener now.) */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const { createReadySignal } = require('../../frontend/js/proposals/ready-signal.js');
const dialogShare = read('../../frontend/js/proposals/dialog-share.js');
const sharingRoutes = read('../../frontend/js/proposals/sharing-routes.js');
const indexHtml = read('../../frontend/index.html');

describe('the ready signal', () => {
    it('resolves its promise with the settled value', async () => {
        const signal = createReadySignal();
        signal.settle('ready');
        await expect(signal.promise).resolves.toBe('ready');
    });

    it('settles once — a backstop after the fact changes nothing', async () => {
        const signal = createReadySignal();
        expect(signal.settle('ready')).toBe(true);
        expect(signal.settle('incomplete')).toBe(false);
        expect(signal.outcome).toBe('ready');
        await expect(signal.promise).resolves.toBe('ready');
    });

    it('reports whether it has settled', () => {
        const signal = createReadySignal();
        expect(signal.settled).toBe(false);
        signal.settle('not-shown');
        expect(signal.settled).toBe(true);
    });

    it('is still awaitable when it settles before anyone awaits', async () => {
        const signal = createReadySignal();
        signal.settle('ready');
        // The dialog awaits after two animation frames, so the signal routinely lands first.
        await new Promise(resolve => setImmediate(resolve));
        await expect(signal.promise).resolves.toBe('ready');
    });
});

describe('showSharePlanPanel can never leave a caller waiting', () => {
    const body = dialogShare.slice(dialogShare.indexOf('function showSharePlanPanel'));

    it('settles every synchronous exit from one finally, not one per return', () => {
        // The whole point of the `finally`: an early return added later is covered for free.
        expect(body).toMatch(/finally\s*{[^}]*if\s*\(!fillStarted\)\s*readySignal\.settle\(/);
    });

    it('marks the async fill as started before handing over', () => {
        const started = body.indexOf('fillStarted = true');
        const iife = body.indexOf('(async () => {');
        expect(started).toBeGreaterThan(-1);
        expect(iife).toBeGreaterThan(started);
    });

    it('knows publication before signaling that the rows are ready', () => {
        // Which rows are published is filled in after the panel is up, in plain sight.
        const settle = body.indexOf("readySignal.settle('ready')");
        const checks = body.indexOf('window.DesignSync.publishedCid(proposal)');
        expect(settle).toBeGreaterThan(-1);
        expect(checks).toBeGreaterThan(-1);
        expect(checks).toBeLessThan(settle);
    });

    it('keeps a backstop in the async finally for a cancelled or failed build', () => {
        expect(body).toMatch(/finally\s*{[\s\S]{0,220}readySignal\.settle\('incomplete'\)/);
    });

    it('returns the promise', () => {
        expect(body).toContain('return readySignal.promise');
    });
});

describe('the pieces are actually wired together', () => {
    it('shareAppliedProposals returns the panel promise', () => {
        expect(sharingRoutes).toMatch(/return new Promise/);
        expect(sharingRoutes).toContain('showSharePlanPanel(options)');
        expect(sharingRoutes).toMatch(/resolve\(ready\)/);
    });

    it('passes the caller options through', () => {
        expect(sharingRoutes).toMatch(/function shareAppliedProposals\(options\)/);
    });

    it('mirrors progress to the opener', () => {
        expect(dialogShare).toMatch(/if \(onProgress\)/);
    });

    it('loads ready-signal.js before the files that use it', () => {
        const signal = indexHtml.indexOf('js/proposals/ready-signal.js');
        const share = indexHtml.indexOf('js/proposals/dialog-share.js');
        expect(signal, 'ready-signal.js is not in the module list').toBeGreaterThan(-1);
        expect(share).toBeGreaterThan(signal);
    });

    it('exposes the helper under a namespace, not a bare global', () => {
        const source = read('../../frontend/js/proposals/ready-signal.js');
        expect(source).toContain('root.__readySignal');
        // A bare `function createReadySignal` at top level of a classic script would be a global
        // that any other file could shadow.
        expect(source).not.toMatch(/^function createReadySignal/m);
    });
});
