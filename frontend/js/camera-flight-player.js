// Shared flights load a small read-only player; the authoring interface is requested separately.
(function (win) {
    'use strict';
    let active = null;
    const t = (key, params = {}) => win.i18n.t('cameraFlight.' + key, params);
    async function open({ record }) {
        await active?.close();
        let session, closed = false, apartmentTools = null, walking = false, closePromise = Promise.resolve();
        const panel = document.createElement('section'); panel.id = 'camera-flight-panel'; panel.className = 'flight-panel flight-player';
        panel.setAttribute('aria-label', record.title); panel.dataset.flightState = 'paused';
        const header = document.createElement('header'); header.className = 'flight-header';
        const title = document.createElement('h2'); title.textContent = record.title; header.append(title);
        const body = document.createElement('div'); body.className = 'flight-body';
        const actions = document.createElement('div'); actions.className = 'flight-actions';
        const timeline = document.createElement('input'); timeline.id = 'camera-flight-time'; timeline.type = 'range'; timeline.min = '0'; timeline.step = '.01'; timeline.className = 'flight-range'; timeline.max = String(win.CameraFlight.duration(record)); timeline.setAttribute('aria-label', t('lookTime'));
        const status = document.createElement('p'); status.className = 'flight-notice'; status.dataset.flightStatus = ''; status.setAttribute('aria-live', 'polite'); status.textContent = t('readonly');
        const output = document.createElement('output'); output.className = 'flight-time';
        const buttons = new Map();
        function error(e) { status.textContent = e.message; status.classList.add('flight-notice--error'); console.error('[camera-flight]', e); }
        const run = fn => Promise.resolve().then(fn).catch(error);
        function button(parent, action, key, fn) {
            const node = document.createElement('button'); node.type = 'button'; node.className = 'btn'; node.dataset.flightAction = action; node.textContent = t(key);
            node.addEventListener('click', () => run(fn)); parent.append(node); buttons.set(action, node); return node;
        }
        button(header, 'close', 'close', () => close());
        button(actions, 'play', 'play', () => session.play());
        button(actions, 'pause', 'pause', () => session.pause());
        button(actions, 'stop', 'stop', async () => { session.pause(); await session.seek(0); });
        button(actions, 'copy', 'editorCopy', () => win.openCameraFlightEditor({ record }));
        const explore = button(actions, 'explore', 'explore', async () => {
            session.pause(); await win.ensureCameraFlightApartment();
            const choices = record.interiors.flatMap(entry => win.CameraFlightInteriors.listUnits(entry.feature, { geometry: win.__buildingFloorPlans, turf: win.turf }).map(unit => ({ unit, feature: entry.feature })));
            apartmentTools ||= win.CameraFlightApartment.browser(win, session, { host: panel,
                labels: win.cameraFlightWalkingLabels() });
            const choice = apartmentTools.chooseAtCamera(choices); if (!choice) throw new Error(t('noApartment'));
            await apartmentTools.explore(choice, { preservePose: true }); walking = true; sync({ walking, time: session.time }); status.textContent = t('walkingHint');
        }); explore.hidden = !record.interiors.length;
        button(actions, 'back-to-flight', 'backToFlight', () => { apartmentTools?.exit(); walking = false; sync({ time: session.time }); });
        function sync(state = {}) {
            if (closed) return;
            walking = state.walking ?? walking; panel.dataset.flightState = state.playing ? 'playing' : 'paused';
            timeline.value = String(state.time ?? session?.time ?? 0); timeline.disabled = walking;
            output.textContent = Number(timeline.value).toFixed(1) + ' / ' + win.CameraFlight.duration(record).toFixed(1) + ' s';
            buttons.get('play').disabled = walking || !!state.playing; buttons.get('pause').disabled = walking || !state.playing;
            buttons.get('stop').disabled = walking; buttons.get('copy').disabled = walking; buttons.get('explore').disabled = walking; buttons.get('back-to-flight').hidden = !walking;
        }
        timeline.addEventListener('input', () => run(() => session.seek(Number(timeline.value))));
        body.append(actions, output, timeline, status); panel.append(header, body); document.body.append(panel);
        function close() { if (closed) return closePromise; closed = true; apartmentTools?.exit(); closePromise = Promise.resolve(session?.dispose()); panel.remove(); if (active?.panel === panel) active = null; return closePromise; }
        try {
            session = win.CameraFlightSession.create(win, record, { onUpdate: sync, onClose: close, onError: error });
            const instance = { panel, session, getRecord: () => JSON.parse(JSON.stringify(record)), seek: time => session.seek(time), close };
            active = instance;
            await session.seek(0); if (closed || active !== instance) return null;
            sync({ time: 0 }); return instance;
        } catch (e) { await close(); throw e; }
    }
    win.CameraFlightPlayer = { open, get active() { return active; } };
})(window);
