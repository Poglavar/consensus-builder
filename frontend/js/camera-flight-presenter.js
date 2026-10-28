// Playback presentation shared by the flight player and the editor preview: the score and voice
// lines, a remembered sound toggle, and in photo view a tile preload behind a cover before the
// flight starts, so it does not fly through half-loaded tiles.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CameraFlightPresenter = { create: options => api.create(root, options) };
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    function create(win, { session, getRecord, onStatus = () => {} }) {
        const t = (key, params = {}) => win.i18n.t('cameraFlight.' + key, params);
        const nextFrame = () => new Promise(resolve => {
            if (win.document.hidden) { resolve(); return; }
            win.invalidateThreeView?.(); win.requestAnimationFrame(() => resolve());
        });
        const audio = win.CameraFlightAudio.create({ createAudio: src => new win.Audio(src), url: path => win.appendBuildToken(path),
            language: win.i18n.getLanguage?.(), storage: win.PersistentStorage, nextFrame, now: () => win.performance.now() });
        let preloaded = false, abort = null, cover = null, starting = false;
        const photo = () => !!win.PhotorealMode?.isActive?.();
        const duration = () => win.CameraFlight.duration(getRecord());

        function showCover() {
            cover = win.document.createElement('div'); cover.className = 'flight-loading-cover'; cover.setAttribute('role', 'status');
            cover.textContent = t('loadingCity', { done: 0, total: '…' });
            (win.document.getElementById('three-container') || win.document.body).append(cover);
        }
        async function preload() {
            const tiles = win.PhotorealMode.getViewer?.(), started = win.performance.now();
            abort = new AbortController(); showCover();
            try {
                const times = win.CameraFlightPreload.sampleTimes(duration());
                const result = await win.CameraFlightPreload.preload({ times, seek: time => session.seek(time), nextFrame, now: () => win.performance.now(),
                    progress: () => Number(tiles?.loadProgress ?? 1),
                    signal: abort.signal, timeoutMs: 8000, onProgress: (done, total) => { if (cover) cover.textContent = t('loadingCity', { done, total }); } });
                console.log(`[${new Date().toISOString()}] [camera-flight] photo tiles preloaded at ${times.length} moments, `
                    + `${result.timeouts || 0} timed out, ${result.skipped || 0} skipped · ${((win.performance.now() - started) / 1000).toFixed(1)} s`);
                if (!result.aborted) preloaded = true;
                return !result.aborted;
            } finally { cover?.remove(); cover = null; abort = null; }
        }

        return {
            audio,
            // Inside the Play click: sound starts at once; in photo view the flight waits for tiles.
            async play() {
                const at = session.time >= duration() ? 0 : session.time;
                if (photo() && !preloaded) {
                    audio.prime(); onStatus(t('loadingCityHint'));
                    if (!await preload()) { audio.stop(); return; }
                    onStatus(''); await session.seek(at);
                }
                // session.play() seeks first, and the seek reports a pause: not one to silence the sound for.
                audio.play(at);
                starting = true;
                try { await session.play(); } finally { starting = false; }
                if (!session.playing) audio.pause();
            },
            pause() { abort?.abort(); audio.pause(); session.pause(); },
            stop() { abort?.abort(); audio.stop(); },
            // A pause the presenter did not ask for (scrubbing, hiding the page) silences the score too.
            sync(state = {}) { if (!starting && !state.playing && audio.state === 'playing' && session.time < duration() - 1e-6) audio.pause(); },
            end() { audio.finish(); },
            // Any edit can change what the camera sees, so photo tiles load again before the next play.
            invalidate() { preloaded = false; },
            soundButton(parent) {
                const node = win.document.createElement('button'); node.type = 'button'; node.className = 'btn'; node.dataset.flightAction = 'sound';
                node.textContent = t('sound');
                const paint = () => node.setAttribute('aria-pressed', String(!audio.muted));
                node.addEventListener('click', event => { event.stopPropagation(); audio.setMuted(!audio.muted); paint(); });
                paint(); parent.append(node); return node;
            },
            dispose() { abort?.abort(); cover?.remove(); audio.dispose(); }
        };
    }
    return Object.freeze({ create });
});
