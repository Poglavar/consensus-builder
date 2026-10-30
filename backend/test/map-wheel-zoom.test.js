// Continuous wheel zoom (frontend/js/map-wheel-zoom.js): a trackpad and a pinch move the zoom on the
// next frame by what they moved, a mouse notch eases there, and the gesture ends once, after input stops.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createModel, RATES } = require('../../frontend/js/map-wheel-zoom.js');

// Feeds events at their times and runs a frame every 16 ms until `until`, returning each frame's result.
function play(model, events, { zoom = 17, until = 1000, min = 2, max = 23 } = {}) {
    const frames = [];
    const queue = [...events];
    for (let now = 0; now <= until; now += 16) {
        while (queue.length && queue[0].at <= now) {
            const { at, ...event } = queue.shift();
            model.input({ deltaMode: 0, ctrlKey: false, shiftKey: false, ...event }, at);
        }
        const step = model.frame(now, zoom, min, max);
        if (step.zoom !== null) zoom = step.zoom;
        frames.push({ now, zoom, done: step.done });
        if (step.done && !queue.length && now > 0) break;
    }
    return frames;
}

const last = frames => frames[frames.length - 1];

describe('map wheel zoom', () => {
    it('moves a trackpad nudge by a small, exact amount on the next frame', () => {
        const frames = play(createModel(), [{ at: 0, deltaY: -2 }]);
        expect(frames[0].zoom).toBeCloseTo(17 + 2 * RATES.trackpad, 10);
        expect(last(frames).zoom - 17).toBeLessThan(0.02);
    });

    it('follows a two-finger scroll frame by frame, several levels for a full swipe', () => {
        const swipe = Array.from({ length: 40 }, (_, i) => ({ at: 100 + i * 8, deltaY: 3 }));
        const frames = play(createModel(), swipe);
        const during = frames.filter(frame => frame.now > 100 && frame.now < 420).map(frame => frame.zoom);
        // every frame of the swipe zooms out a little more: no step, no wait
        for (let i = 1; i < during.length; i++) expect(during[i]).toBeLessThan(during[i - 1]);
        expect(last(frames).zoom).toBeCloseTo(17 - 120 * RATES.trackpad, 10);
    });

    it('follows a pinch exactly: fingers doubling apart zoom in one level', () => {
        const step = -100 * Math.LN2 / 10;
        const pinch = Array.from({ length: 10 }, (_, i) => ({ at: i * 10, deltaY: step, ctrlKey: true }));
        expect(last(play(createModel(), pinch)).zoom).toBeCloseTo(18, 10);
    });

    it('eases a mouse notch to half a level, and a fast spin further', () => {
        const frames = play(createModel(), [{ at: 0, deltaY: -100 }]);
        // held while it could still be a trackpad, then eased: between the two zooms on the way
        expect(frames.find(frame => frame.now === 16).zoom).toBe(17);
        const middle = frames.find(frame => frame.now === 112).zoom;
        expect(middle).toBeGreaterThan(17.1);
        expect(middle).toBeLessThan(17.5);
        expect(last(frames).zoom).toBeCloseTo(17.5, 10);
        expect(last(play(createModel(), [{ at: 0, deltaY: -300 }])).zoom).toBeCloseTo(18.5, 10);
        // a runaway delta is capped
        expect(last(play(createModel(), [{ at: 0, deltaY: -5000 }])).zoom).toBeCloseTo(19, 10);
    });

    it('jumps a notch without easing when motion is reduced', () => {
        const frames = play(createModel({ easeMs: 0 }), [{ at: 0, deltaY: -100 }]);
        expect(frames.find(frame => frame.now === 48).zoom).toBeCloseTo(17.5, 10);
    });

    it('ends the gesture once, after input has stopped', () => {
        const swipe = Array.from({ length: 10 }, (_, i) => ({ at: i * 16, deltaY: 2 }));
        const frames = play(createModel(), swipe);
        expect(frames.filter(frame => frame.done)).toHaveLength(1);
        expect(last(frames).now).toBeGreaterThanOrEqual(144 + 150);
    });

    it('stops at the map\'s zoom limits', () => {
        const pinch = Array.from({ length: 30 }, (_, i) => ({ at: i * 10, deltaY: -50, ctrlKey: true }));
        expect(last(play(createModel(), pinch, { max: 20 })).zoom).toBe(20);
    });
});
