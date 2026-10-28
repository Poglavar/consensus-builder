// Flight sound: one looping CC0 score under the flight, a voice line as it starts and another as it
// ends, the score ducking under the voice. Started from Play (a user gesture), so browsers allow it;
// mute is remembered on this device. The audio element factory and storage are injected.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CameraFlightAudio = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const MUSIC = .45, DUCKED = .15, FADE_MS = 2000, KEY = 'cb_camera_flight_muted', LANGUAGES = ['en', 'hr', 'es', 'sr'];

    function create({ createAudio, url = path => path, base = 'audio/camera-flight/', language = 'en', storage = null,
        nextFrame, now = () => Date.now(), log = console }) {
        const lang = LANGUAGES.includes(language) ? language : 'en';
        const make = (name, loop) => { const a = createAudio(url(base + name)); a.preload = 'none'; a.loop = loop; return a; };
        const score = make('score.mp3', true), intro = make(`intro-${lang}.mp3`, false), outro = make(`outro-${lang}.mp3`, false);
        const all = [score, intro, outro];
        let muted = false, state = 'idle', fading = 0;
        try { muted = storage?.getItem(KEY) === '1'; } catch { muted = false; }
        score.volume = MUSIC; all.forEach(a => { a.muted = muted; });
        // A refused start (autoplay policy, missing file) must not stop the flight, but is reported.
        const start = a => {
            try { Promise.resolve(a.play()).catch(error => log.warn(`[${new Date().toISOString()}] [camera-flight] sound did not start`, error)); }
            catch (error) { log.warn(`[${new Date().toISOString()}] [camera-flight] sound did not start`, error); }
        };
        const rewind = a => { a.pause(); try { a.currentTime = 0; } catch { /* not loaded yet: starts at 0 anyway */ } };
        const duck = () => { if (!fading) score.volume = DUCKED; };
        const unduck = () => { if (!fading) score.volume = MUSIC; };
        const listeners = [[intro, 'playing', duck], [intro, 'ended', unduck], [intro, 'pause', unduck],
            [outro, 'playing', duck], [outro, 'ended', () => fadeOut()]];
        listeners.forEach(([a, type, fn]) => a.addEventListener(type, fn));

        async function fadeOut() {
            const run = ++fading, from = score.volume, started = now();
            while (run === fading) {
                const t = Math.min(1, (now() - started) / FADE_MS);
                score.volume = from * (1 - t);
                if (t >= 1) { rewind(score); score.volume = MUSIC; fading = 0; state = 'idle'; return; }
                await nextFrame();
            }
        }
        const cancelFade = () => { if (fading) { fading = 0; score.volume = MUSIC; } };

        return {
            get state() { return state; },
            get muted() { return muted; },
            setMuted(value) {
                muted = !!value; all.forEach(a => { a.muted = muted; });
                try { storage?.setItem(KEY, muted ? '1' : '0'); } catch { /* the choice lasts this visit */ }
            },
            // Call inside the Play click when the flight itself starts later (photo view loads tiles
            // first): the score starts now and the voice elements are unlocked for the later start.
            prime() {
                cancelFade(); if (state === 'idle' || state === 'finishing') rewind(score);
                start(score); state = 'loading';
            },
            // The flight starts or resumes at `time`; from the beginning the intro speaks.
            play(time) {
                cancelFade();
                const fresh = time < .5 || state === 'idle' || state === 'finishing';
                if (fresh) { rewind(outro); rewind(intro); if (state !== 'loading') rewind(score); start(intro); }
                start(score); state = 'playing';
            },
            pause() { if (state !== 'playing' && state !== 'loading') return; score.pause(); intro.pause(); state = 'paused'; },
            // The flight reached its end: the outro speaks over the score, which then fades out.
            finish() {
                if (state === 'finishing' || state === 'idle') return;
                cancelFade(); intro.pause(); rewind(outro); start(outro); start(score); state = 'finishing';
            },
            stop() { fading = 0; all.forEach(rewind); score.volume = MUSIC; state = 'idle'; },
            dispose() {
                this.stop(); listeners.forEach(([a, type, fn]) => a.removeEventListener(type, fn));
                all.forEach(a => { a.removeAttribute?.('src'); a.load?.(); });
            }
        };
    }
    return Object.freeze({ create, LANGUAGES, KEY });
});
