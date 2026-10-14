// Covers bounded, view-aware traffic ambience and gesture-gated Web Audio setup.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { mix, Sound, MAX_GAIN } = require('../../frontend/traffic/audio.js');

const viewport = {
    center: { x: 0, y: 0 },
    extent: { minX: -100, minY: -100, maxX: 100, maxY: 100 }
};

describe('traffic ambience audio', () => {
    it('keeps a busy view quiet and below the master gain cap', () => {
        const cars = Array.from({ length: 500 }, (_, i) => ({
            pose: { x: (i % 10) - 5, y: Math.floor(i / 10) % 10 }, speed: 10
        }));
        const value = mix(cars, viewport);

        expect(value.gain).toBe(MAX_GAIN);
        expect(value.gain).toBeLessThanOrEqual(.05);
        expect(value.rolling).toBeGreaterThan(0);
    });

    it('returns silence while paused or with no cars inside the viewport', () => {
        const car = [{ x: 0, y: 0, speed: 8 }];
        expect(mix(car, viewport, false)).toEqual({ gain: 0, rumble: 0, rolling: 0 });
        expect(mix([{ x: 101, y: 0, speed: 8 }], viewport)).toEqual({ gain: 0, rumble: 0, rolling: 0 });
    });

    it('adds rolling texture as nearby cars move faster', () => {
        const stopped = mix([{ pose: { x: 0, y: 0 }, speed: 0 }], viewport);
        const moving = mix([{ pose: { x: 0, y: 0 }, speed: 12 }], viewport);

        expect(moving.rolling).toBeGreaterThan(stopped.rolling);
        expect(moving.rumble).toBeLessThan(stopped.rumble);
    });

    it('creates shared audio nodes only on start and keeps output bounded', async () => {
        const param = () => ({ value: 0, cancelScheduledValues() {}, setTargetAtTime(value) { this.value = value; },
            setValueAtTime(value) { this.value = value; } });
        const node = () => ({ gain: param(), frequency: param(), Q: param(), connect(next) { return next; }, start() {} });
        let created = 0, nodesCreated = 0;
        class FakeAudioContext {
            constructor() { created++; this.sampleRate = 8000; this.currentTime = 0; this.state = 'suspended'; this.destination = {}; }
            createGain() { nodesCreated++; return node(); }
            createBiquadFilter() { nodesCreated++; return Object.assign(node(), { type: '' }); }
            createBuffer(_channels, length) { return { getChannelData: () => new Float32Array(length) }; }
            createBufferSource() { nodesCreated++; return Object.assign(node(), { loop: false }); }
            createOscillator() { nodesCreated++; return Object.assign(node(), { type: '' }); }
            async resume() { this.state = 'running'; }
            async suspend() { this.state = 'suspended'; }
            async close() { this.state = 'closed'; }
        }
        const sound = new Sound({ AudioContext: FakeAudioContext });

        expect(created).toBe(0);
        await sound.start();
        expect(created).toBe(1);
        const context = sound.context;
        const initialNodeCount = nodesCreated;
        sound.update({ gain: 1, rumble: 1, rolling: 1 });
        expect(sound.nodes.master.gain.value).toBe(MAX_GAIN);
        expect(sound.nodes.noiseGain.gain.value).toBeCloseTo(.9);
        expect(sound.nodes.toneGain.gain.value).toBeCloseTo(.3);
        await sound.stop();
        expect(sound.nodes.master.gain.value).toBe(0);
        expect(sound.nodes.noiseGain.gain.value).toBe(0);
        expect(context.state).toBe('suspended');
        sound.update({ gain: MAX_GAIN, rumble: 1, rolling: 1 });
        expect(sound.nodes.master.gain.value).toBe(0);
        await sound.start();
        expect(sound.context).toBe(context);
        expect(nodesCreated).toBe(initialNodeCount);
        expect(sound.nodes.master.gain.value).toBe(MAX_GAIN);
        await sound.stop();
        await sound.dispose();
    });
});
