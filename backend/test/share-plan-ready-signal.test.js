/* "Share the whole plan instead" used to close its dialog immediately and drop the user on a bare
   map while the panel built behind it. Now the dialog is held open, with a spinner, until the panel
   signals ready — which trades a cosmetic flicker for a much worse failure: an exit path that
   forgets to signal leaves the user stuck behind a spinning dialog with no way forward.

   So two things are pinned here. First the signal itself, executed: settle-once, idempotent, and
   the promise really resolves. Second the wiring in the three browser files, read from source,
   because the guarantee is structural — the settle lives in a `finally`, so any `return` added to
   that function later is covered without anyone remembering to. If that structure is edited away,
   this test says so. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const { createReadySignal } = require('../../frontend/js/proposals/ready-signal.js');
const dialogShare = read('../../frontend/js/proposals/dialog-share.js');
const sharingRoutes = read('../../frontend/js/proposals/sharing-routes.js');
const dialogUpload = read('../../frontend/js/proposals/dialog-upload.js');
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

    it('settles on the happy path before the slow upload checks, not after', () => {
        const settle = body.indexOf("readySignal.settle('ready')");
        const checks = body.indexOf('await initializeUploadChecks()');
        expect(settle).toBeGreaterThan(-1);
        expect(checks).toBeGreaterThan(settle);
    });

    it('keeps a backstop in the async finally for a cancelled or failed build', () => {
        expect(body).toMatch(/finally\s*{[\s\S]{0,220}readySignal\.settle\('incomplete'\)/);
    });

    it('returns the promise', () => {
        expect(body).toContain('return readySignal.promise');
    });
});

describe('the dialog holds itself open until the panel is ready', () => {
    it('no longer closes before starting the work', () => {
        // The old shape closed every share modal and THEN called shareAppliedProposals.
        const close = dialogUpload.indexOf('closeThisDialog');
        const call = dialogUpload.indexOf('shareAppliedProposals(');
        expect(close).toBeGreaterThan(-1);
        expect(call).toBeGreaterThan(-1);
        // The close must be reachable only through the promise settling.
        expect(dialogUpload).toMatch(/ready\.then\(closeThisDialog,\s*closeThisDialog\)/);
    });

    it('closes on failure too, so a stuck panel cannot trap the user', () => {
        // Both arms of .then are the close — success and rejection alike.
        const match = dialogUpload.match(/ready\.then\(([^)]*)\)/);
        expect(match).not.toBeNull();
        const [onOk, onFail] = match[1].split(',').map(s => s.trim());
        expect(onOk).toBe('closeThisDialog');
        expect(onFail).toBe('closeThisDialog');
    });

    it('falls back to closing when the panel returns nothing thenable', () => {
        expect(dialogUpload).toMatch(/else\s+closeThisDialog\(\);/);
    });

    it('shows the panel progress on the button instead of a mute spinner', () => {
        expect(dialogUpload).toContain('onProgress');
        expect(dialogUpload).toMatch(/label\.textContent = text/);
    });

    it('closes only its own modal, never every share modal on the page', () => {
        // The wait is now seconds rather than two frames, which is long enough for the user to
        // dismiss this dialog and open another. Closing that one would look like a lost place.
        const closer = dialogUpload.slice(
            dialogUpload.indexOf('const closeThisDialog'),
            dialogUpload.indexOf('const go =')
        );
        expect(closer).toContain('ownOverlay');
        expect(closer).not.toMatch(/querySelectorAll\('\.share-modal-overlay/);
    });

    it('does nothing when its modal is already gone', () => {
        const closer = dialogUpload.slice(
            dialogUpload.indexOf('const closeThisDialog'),
            dialogUpload.indexOf('const go =')
        );
        expect(closer).toMatch(/isConnected/);
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
