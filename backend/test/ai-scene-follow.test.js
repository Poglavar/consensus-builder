// Shared AI scene links (frontend/js/ai-scene-follow.js): the saved camera pose must be restored
// whichever arrives first, the scene fetch or the lazily loaded model view.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it } from 'vitest';

const source = readFileSync(new URL('../../frontend/js/ai-scene-follow.js', import.meta.url), 'utf8');
const view = { targetLng: 15.9822, targetLat: 45.80025, headingDeg: 35, pitchRad: -0.78, range: 120 };

function loadFollow({ modelActive }) {
    const events = new EventTarget();
    const applied = [];
    const context = {
        URLSearchParams,
        console,
        setTimeout: () => 0,
        location: { search: '?scene=fixture-shared' },
        document: { createElement() { throw new Error('the render card is not under test'); }, body: {} },
        fetch: async () => ({ ok: true, json: async () => ({ view }) }),
        addEventListener: (type, listener, options) => events.addEventListener(type, listener, options),
        dispatch: type => events.dispatchEvent(new Event(type)),
        applied
    };
    context.window = context;
    if (modelActive) {
        context.isThreeModeActive = () => true;
        context.applyThree3DGeoView = pose => { applied.push(pose); return true; };
    }
    vm.runInNewContext(source, context);
    return context;
}

it('applies the pose at once when the model view is already up', async () => {
    const page = loadFollow({ modelActive: true });
    await page.__aiScenePromise;
    expect(page.applied).toEqual([view]);
});

it('applies the pose when the model view comes up after the scene arrived', async () => {
    const page = loadFollow({ modelActive: false });
    await page.__aiScenePromise;
    expect(page.applied).toEqual([]);
    // map-mode-loader.js has now loaded three-mode.js and the URL entry finished.
    page.isThreeModeActive = () => true;
    page.applyThree3DGeoView = pose => { page.applied.push(pose); return true; };
    page.dispatch('threeModeReady');
    page.dispatch('threeModeReady');
    expect(page.applied).toEqual([view]);
});
