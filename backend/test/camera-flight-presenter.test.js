// The presenter keeps flight sound in step with playback: a Play's own seek does not silence it, a
// real pause does, the end speaks the outro, and photo view loads tiles before the flight starts.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const Presenter = require('../../frontend/js/camera-flight-presenter.js');
const Preload = require('../../frontend/js/camera-flight-preload.js');

function setup({ photo = false } = {}) {
    const audio = { state: 'idle', calls: [], muted: false };
    for (const name of ['prime', 'play', 'pause', 'finish', 'stop', 'dispose', 'setMuted']) {
        audio[name] = (...args) => { audio.calls.push(name); if (name === 'play') audio.state = 'playing'; if (name === 'pause') audio.state = 'paused'; if (name === 'prime') audio.state = 'loading'; };
    }
    let presenter;
    const session = { time: 0, playing: false, seeks: [],
        async seek(t) { this.seeks.push(t); this.time = t; this.playing = false; presenter.sync({ playing: false }); },
        async play() { await this.seek(this.time); this.playing = true; presenter.sync({ playing: true }); },
        pause() { this.playing = false; presenter.sync({ playing: false }); } };
    const nodes = [];
    const document = { hidden: true, getElementById: () => null, body: { append: node => nodes.push(node) },
        createElement: () => ({ setAttribute() {}, remove() { nodes.splice(nodes.indexOf(this), 1); }, addEventListener() {}, dataset: {}, append() {} }) };
    let progressReads = 0;
    const win = { document, performance: { now: () => progressReads * 16 }, i18n: { t: key => key, getLanguage: () => 'en' }, appendBuildToken: p => p,
        PersistentStorage: null, Audio: function () {}, CameraFlightAudio: { create: () => audio }, CameraFlightPreload: Preload,
        CameraFlight: { duration: () => 10 },
        PhotorealMode: { isActive: () => photo, getViewer: () => ({ get loadProgress() { progressReads++; return 1; } }) } };
    presenter = Presenter.create(win, { session, getRecord: () => ({}) });
    return { presenter, session, audio, nodes };
}

describe('camera flight presenter', () => {
    it('keeps the sound playing through the seek that starts playback', async () => {
        const { presenter, session, audio } = setup();
        await presenter.play();
        expect(session.playing).toBe(true); expect(audio.state).toBe('playing'); expect(audio.calls).toEqual(['play']);
    });
    it('silences the sound when playback pauses for another reason, and speaks the outro at the end', async () => {
        const { presenter, session, audio } = setup();
        await presenter.play(); session.time = 4; session.pause();
        expect(audio.state).toBe('paused');
        await presenter.play(); session.time = 10; session.pause(); presenter.end();
        expect(audio.calls).toEqual(['play', 'pause', 'play', 'finish']);
    });
    it('in photo view visits the flight behind a cover before playing, once until an edit', async () => {
        const { presenter, session, audio, nodes } = setup({ photo: true });
        await presenter.play();
        expect(audio.calls.slice(0, 2)).toEqual(['prime', 'play']);
        expect(session.seeks.slice(0, 7)).toEqual([0, 2, 4, 6, 8, 10, 0]); expect(nodes).toHaveLength(0);
        session.pause(); const before = session.seeks.length;
        await presenter.play(); expect(session.seeks.length).toBe(before + 1);
        presenter.invalidate(); session.pause(); await presenter.play(); expect(session.seeks.length).toBeGreaterThan(before + 7);
    });
});
