// Flight sound: the intro speaks only from the start, the score ducks under voices, the outro plays at
// the end before the score fades out, and mute is remembered.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const Audio = require('../../frontend/js/camera-flight-audio.js');

function fakes() {
    const made = new Map();
    const createAudio = src => {
        const listeners = new Map();
        const a = { src, volume: 1, muted: false, loop: false, preload: 'auto', currentTime: 0, paused: true, plays: 0,
            play() { this.paused = false; this.plays++; return Promise.resolve(); }, pause() { this.paused = true; },
            addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
            removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).filter(f => f !== fn)); },
            emit(type) { (listeners.get(type) || []).forEach(fn => fn()); }, removeAttribute() {}, load() {} };
        made.set(src.split('/').pop(), a); return a;
    };
    const store = new Map(), storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    let t = 0; const nextFrame = async () => { t += 100; };
    return { made, createAudio, storage, nextFrame, now: () => t, store };
}

describe('camera flight sound', () => {
    it('loads the language clips lazily and falls back to English', () => {
        const f = fakes(); Audio.create({ ...f, language: 'hr' });
        expect([...f.made.keys()]).toEqual(['score.mp3', 'intro-hr.mp3', 'outro-hr.mp3']);
        expect([...f.made.values()].every(a => a.preload === 'none')).toBe(true);
        expect(f.made.get('score.mp3').loop).toBe(true);
        const g = fakes(); Audio.create({ ...g, language: 'ar' }); expect(g.made.has('intro-en.mp3')).toBe(true);
    });
    it('speaks the intro from the start only, ducking the score while it speaks', () => {
        const f = fakes(), sound = Audio.create(f), score = f.made.get('score.mp3'), intro = f.made.get('intro-en.mp3');
        sound.play(0);
        expect(score.paused).toBe(false); expect(intro.plays).toBe(1); expect(sound.state).toBe('playing');
        intro.emit('playing'); expect(score.volume).toBeLessThan(.2);
        intro.emit('ended'); expect(score.volume).toBeCloseTo(.45);
        sound.pause(); expect(score.paused).toBe(true);
        sound.play(12); expect(intro.plays).toBe(1); expect(score.paused).toBe(false);
    });
    it('plays the outro at the end and then fades the score out', async () => {
        const f = fakes(), sound = Audio.create(f), score = f.made.get('score.mp3'), outro = f.made.get('outro-en.mp3');
        sound.play(0); sound.finish();
        expect(outro.plays).toBe(1); expect(score.paused).toBe(false); expect(sound.state).toBe('finishing');
        outro.emit('ended');
        for (let i = 0; i < 30 && sound.state !== 'idle'; i++) await f.nextFrame();
        await new Promise(resolve => setImmediate(resolve));
        expect(sound.state).toBe('idle'); expect(score.paused).toBe(true); expect(score.volume).toBeCloseTo(.45);
        sound.play(0); expect(f.made.get('intro-en.mp3').plays).toBe(2);
    });
    it('starts the score while tiles load and speaks when the flight starts', () => {
        const f = fakes(), sound = Audio.create(f), score = f.made.get('score.mp3'), intro = f.made.get('intro-en.mp3');
        sound.prime(); expect(score.paused).toBe(false); expect(intro.plays).toBe(0); expect(sound.state).toBe('loading');
        sound.play(0); expect(intro.plays).toBe(1);
    });
    it('remembers mute on this device', () => {
        const f = fakes(), sound = Audio.create(f);
        sound.setMuted(true); expect([...f.made.values()].every(a => a.muted)).toBe(true);
        expect(f.store.get(Audio.KEY)).toBe('1');
        const again = Audio.create({ ...f, createAudio: f.createAudio }); expect(again.muted).toBe(true);
    });
    it('reports a refused start without throwing', async () => {
        const f = fakes(), warnings = [];
        const sound = Audio.create({ ...f, createAudio: src => Object.assign(f.createAudio(src), { play: () => Promise.reject(new Error('NotAllowedError')) }),
            log: { warn: (...args) => warnings.push(args) } });
        expect(() => sound.play(0)).not.toThrow();
        await new Promise(resolve => setImmediate(resolve));
        expect(warnings.length).toBe(2);
    });
});
