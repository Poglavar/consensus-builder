// Sun and shadows in the 3D model view: the scene's directional light becomes the sun over the
// scene's own location at a local date and time, and casts shadows. It is on by default and plays
// the day — a full 24 h every DAY_CYCLE_MS, round and round — so the shadows move; the light steps
// every PLAY_STEP_MINUTES, and a view with nothing else moving draws only those frames. The sun button
// (index.html #sun-button, slot 1 of the mode strip in model view) shows a sun whose colour follows
// its height, or a moon at night, and opens #sun-sheet to switch it off, pause, or pick the time and
// date. Times are the place's wall clock (its IANA zone from tz-lookup), not the viewer's.
// three-mode.js attaches it to each scene, runs the day from a frame hook and calls beforeRender()
// every frame; the maths lives in sun-shadows.js. Photo view keeps its own lighting.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__threeSun = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';

    const STORAGE_KEY = 'cb_3d_sun_enabled';
    const FLAG_SWEEP_MS = 1000;          // new meshes pick up shadow flags within a second
    const MIN_CASTER_HEIGHT_M = 0.3;     // flat ground receives shadows but does not cast them
    const DAY_CYCLE_MS = 60000;          // one full day of sun per minute while playing
    const MAX_FRAME_DT_MS = 500;         // a stalled tab never jumps the sun forward by hours
    const PLAY_STEP_MINUTES = 3;         // while playing, the light and shadows move in steps this long (~7 Hz)
    const STEP_MARGIN_MS = 20;           // asked on top of a step's wait, so the frame lands past the boundary
    const NOW_REFRESH_MS = 60000;        // a sun standing at "now" follows the real clock this often

    // Browser globals, or the same files required in node tests.
    const core = () => (root && root.__sunShadows) || require('./sun-shadows.js');
    const sunCalc = () => (root && root.SunCalc) || require('../vendor/suncalc-1.9.0/suncalc.js');
    const tzlookup = () => (root && root.tzlookup) || require('../vendor/tz-lookup-11.7.0/tz.js');
    const t = (key, fallback, params) => {
        const api = root && root.i18n;
        if (api && typeof api.t === 'function') {
            try { const value = api.t(key, params || {}); if (value && value !== key) return value; } catch (_) { /* fallback */ }
        }
        return fallback;
    };

    // What the person chose. date/minutes null mean "today" and "now" at the scene's place, resolved
    // when the sun is computed, so they follow the scene to another city. Reduced motion starts paused.
    const state = { enabled: loadEnabled(), playing: !(root && root.__reducedMotion), dateISO: null, minutes: null };
    let attached = null;

    function loadEnabled() {
        try {
            const storage = root && root.PersistentStorage;
            const value = storage ? storage.getItem(STORAGE_KEY) : null;
            return value !== '0';
        } catch (_) { return true; }
    }

    function saveEnabled(enabled) {
        try { root.PersistentStorage?.setItem(STORAGE_KEY, enabled ? '1' : '0'); } catch (_) { /* preference only */ }
    }

    // ---- Shadow flags ----
    const LIT = ['isMeshLambertMaterial', 'isMeshPhongMaterial', 'isMeshStandardMaterial', 'isMeshPhysicalMaterial', 'isMeshToonMaterial'];
    const materialsOf = mesh => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).filter(Boolean);
    const isLit = material => LIT.some(flag => material[flag]);
    // Ghosted buildings are drawn translucent but stand in the city all the same, so they cast; only
    // near-invisible surfaces do not.
    const MIN_CASTER_OPACITY = 0.15;
    const isSolidEnough = material => material.visible !== false
        && (!material.transparent || (typeof material.opacity === 'number' ? material.opacity : 1) >= MIN_CASTER_OPACITY);

    function isTall(mesh) {
        const geometry = mesh.geometry;
        if (!geometry) return false;
        const cached = mesh.userData.__sunTall;
        if (cached && cached.geometry === geometry.uuid) return cached.tall;
        if (!geometry.boundingBox) geometry.computeBoundingBox();
        const box = geometry.boundingBox;
        const height = box ? (box.max.z - box.min.z) * Math.abs(mesh.scale.z || 1) : 0;
        const tall = mesh.isInstancedMesh || height >= MIN_CASTER_HEIGHT_M;
        mesh.userData.__sunTall = { geometry: geometry.uuid, tall };
        return tall;
    }

    // Lit meshes receive shadows; lit meshes with height cast them, ghosted ones included. Unlit
    // overlays (labels, highlights, symbols, depth pre-passes) and the excluded roots (moving life,
    // whose shadow map is not re-rendered on its animation-only frames) take no part.
    function applyShadowFlags(object, enabled, skip) {
        if (skip.has(object)) return;
        if (object.isMesh) {
            const materials = materialsOf(object);
            const lit = materials.length > 0 && materials.every(isLit);
            object.receiveShadow = enabled && lit;
            object.castShadow = enabled && lit && materials.every(isSolidEnough) && isTall(object);
        }
        const children = object.children;
        for (let i = 0; i < children.length; i++) applyShadowFlags(children[i], enabled, skip);
    }

    // ---- The place ----
    function placeOf(origin) {
        if (!origin || typeof origin.lat !== 'number' || typeof origin.lng !== 'number') return null;
        const key = `${origin.lat.toFixed(3)},${origin.lng.toFixed(3)}`;
        if (attached && attached.place && attached.place.key === key) return attached.place;
        return { key, lat: origin.lat, lng: origin.lng, timeZone: tzlookup()(origin.lat, origin.lng) };
    }

    // The resolved moment: the chosen (or default) local date and time at the place, its daylight
    // window, and the sun there.
    let dayCache = null;
    function resolveSun(place, now = new Date()) {
        const c = core();
        const today = c.localDateISO(now, place.timeZone);
        const dateISO = state.dateISO || today;
        const dayKey = `${place.key}|${dateISO}`;
        if (!dayCache || dayCache.key !== dayKey) {
            dayCache = { key: dayKey, day: c.daylight(sunCalc(), dateISO, place.lat, place.lng, place.timeZone) };
        }
        const day = dayCache.day;
        const minutes = state.minutes !== null ? state.minutes
            : dateISO === today ? c.initialMinutes(c.localMinutes(now, place.timeZone), day, state.playing) : day.solarNoon;
        // A playing day runs on from wherever it starts.
        if (state.playing) state.minutes = minutes;
        const instant = c.localToInstant(dateISO, minutes, place.timeZone);
        const position = sunCalc().getPosition(instant, place.lat, place.lng);
        return { dateISO, minutes, day, instant, altitude: position.altitude, azimuth: position.azimuth };
    }

    // ---- The sheet and the button ----
    const el = id => (root && root.document ? root.document.getElementById(id) : null);
    const shown = {};   // what the DOM already says, so a playing day writes only what changed
    const write = (key, node, apply, value) => {
        if (!node || shown[key] === value) return;
        shown[key] = value;
        apply(node, value);
    };
    const setText = (node, value) => { node.textContent = value; };

    // The button: a sun whose colour runs from dawn orange to noon yellow with its height (the
    // --sun-glow custom property, css/three-sun.css), a moon at night, a dim sun when switched off.
    function renderButton(sun) {
        const button = el('sun-button');
        if (!button) return;
        const phase = !state.enabled ? 'off' : !sun ? 'day' : sun.altitude > 0 ? 'day' : 'night';
        write('phase', button, (node, value) => { node.dataset.sun = value; }, phase);
        write('icon', button.querySelector('i'), (node, value) => {
            node.classList.toggle('fa-sun', value === 'sun');
            node.classList.toggle('fa-moon', value === 'moon');
        }, phase === 'night' ? 'moon' : 'sun');
        const glow = sun ? Math.round(core().sunGlow(sun.altitude) * 20) / 20 : 1;
        write('glow', button, (node, value) => { node.style.setProperty('--sun-glow', String(value)); }, glow);
    }

    // The parts of the sheet that move with the clock. Every row keeps its height whatever it says.
    function renderLive() {
        const sun = attached && attached.sun;
        renderButton(sun);
        if (!sun) return;
        const c = core();
        const clock = c.formatMinutes(sun.minutes);
        write('clock', el('sun-time-value'), setText, clock);
        write('slider', el('sun-time'), (node, value) => {
            node.value = String(value);
            node.setAttribute('aria-valuetext', clock);
        }, Math.floor(sun.minutes));
        const status = sun.altitude > 0 ? ''
            : t('threeMode.sun.belowHorizon', 'Night: the sun is below the horizon.');
        write('status', el('sun-status'), setText, status);
    }

    function renderSheet() {
        write('enabled', el('sun-enabled'), (node, value) => { node.checked = value; }, state.enabled);
        write('controls', el('sun-controls'), (node, value) => { node.disabled = value; }, !state.enabled);
        write('playing', el('sun-play'), (node, playing) => {
            node.setAttribute('aria-pressed', String(playing));
            const label = playing ? t('threeMode.sun.pause', 'Pause the day') : t('threeMode.sun.play', 'Play the day');
            node.title = label;
            node.setAttribute('aria-label', label);
            const icon = node.querySelector('i');
            if (icon) {
                icon.classList.toggle('fa-pause', playing);
                icon.classList.toggle('fa-play', !playing);
            }
        }, state.playing);
        renderLive();
        const place = attached && attached.place;
        const sun = attached && attached.sun;
        // The slider's label: whose clock it is, once the scene's place is known (three-sun owns
        // this text, so it carries no data-i18n-key for the page translator to overwrite).
        write('zone', el('sun-zone'), setText, place
            ? t('threeMode.sun.zone', `Local time, ${place.timeZone}`, { zone: place.timeZone })
            : t('threeMode.sun.time', 'Time of day'));
        if (!place || !sun) return;
        const c = core();
        const date = el('sun-date');
        if (date && date !== root.document.activeElement) write('date', date, (node, value) => { node.value = value; }, sun.dateISO);
        const day = sun.day;
        const daylightText = day.polar === 'day' ? t('threeMode.sun.polarDay', 'The sun does not set')
            : day.polar === 'night' ? t('threeMode.sun.polarNight', 'The sun does not rise')
                : t('threeMode.sun.daylight', `Daylight ${c.formatMinutes(day.sunrise)}–${c.formatMinutes(day.sunset)}`,
                    { rise: c.formatMinutes(day.sunrise), set: c.formatMinutes(day.sunset) });
        write('daylight', el('sun-daylight-text'), setText, daylightText);
        // The daylight band under the slider: where the day starts and ends, in percent of 24 h.
        const percent = minutes => `${(minutes / c.MINUTES_PER_DAY * 100).toFixed(2)}%`;
        const band = day.polar === 'day' ? ['0%', '100%'] : day.polar === 'night' ? ['0%', '0%']
            : [percent(day.sunrise), percent(day.sunset)];
        write('band', el('sun-daylight'), (node, value) => {
            const [rise, set] = value.split('|');
            node.style.setProperty('--sun-rise', rise);
            node.style.setProperty('--sun-set', set);
        }, band.join('|'));
    }

    function changed() {
        if (attached) {
            // Resolve now, so the sheet's readout follows the slider without waiting for a frame.
            if (attached.place) attached.sun = resolveSun(attached.place);
            attached.sunDirty = true;
            syncPlayback();
            attached.invalidate();
        }
        renderSheet();
    }

    function bindSheet() {
        if (!root || !root.document) return;
        el('sun-enabled')?.addEventListener('change', event => {
            state.enabled = !!event.target.checked;
            saveEnabled(state.enabled);
            changed();
        });
        // Taking the slider stops the day where it is put.
        el('sun-time')?.addEventListener('input', event => {
            state.playing = false;
            state.minutes = Number(event.target.value);
            changed();
        });
        el('sun-play')?.addEventListener('click', () => {
            state.playing = !state.playing;
            changed();
        });
        el('sun-date')?.addEventListener('change', event => {
            state.dateISO = /^\d{4}-\d{2}-\d{2}$/.test(event.target.value) ? event.target.value : null;
            changed();
        });
        el('sun-now')?.addEventListener('click', () => {
            state.dateISO = null;
            state.minutes = null;
            changed();
        });
        root.document.addEventListener('mapshell:sheetopened', event => {
            if (event.detail && event.detail.id === 'sun-sheet') renderSheet();
        });
        renderSheet();
    }

    // ---- Playing the day ----
    // A frame hook keeps three-mode's loop running while the day plays, and only then: a paused or
    // switched-off sun leaves the scene to render on demand. The clock advances every frame, but the
    // light (and with it the shadow pass) moves only when it crosses a PLAY_STEP_MINUTES boundary, and
    // the hook answers with the milliseconds until that next step: when nothing else animates, the
    // loop draws only those frames (about 8 a second) instead of running at its hook rate.
    let lastTick = null;
    function onFrame(nowMs) {
        const a = attached;
        if (!a || !state.playing || !state.enabled || a.isPhotoActive() || state.minutes === null) {
            lastTick = null;
            return false;
        }
        const elapsed = lastTick === null ? 0 : Math.min(MAX_FRAME_DT_MS, Math.max(0, nowMs - lastTick));
        lastTick = nowMs;
        const minutesPerMs = 1440 / DAY_CYCLE_MS;
        if (elapsed > 0) {
            const before = Math.floor(state.minutes / PLAY_STEP_MINUTES);
            state.minutes = core().advanceMinutes(state.minutes, elapsed, DAY_CYCLE_MS);
            if (Math.floor(state.minutes / PLAY_STEP_MINUTES) !== before) a.sunDirty = true;
        }
        const toNextStep = PLAY_STEP_MINUTES - (state.minutes % PLAY_STEP_MINUTES);
        // One display frame past the boundary: the frame timestamp the hook is given can be a whole
        // vsync earlier than the timer that scheduled it, and a clock that lands just short of the
        // step costs a second frame.
        return Math.max(1, Math.ceil(toNextStep / minutesPerMs) + STEP_MARGIN_MS);
    }
    // A sun standing at "now" follows the real clock: one re-read and one frame a minute.
    let nowTimer = null;
    function syncNowRefresh() {
        const wanted = !!attached && state.enabled && !state.playing && state.minutes === null;
        if (wanted && !nowTimer) {
            nowTimer = setInterval(() => {
                const a = attached;
                if (!a || !state.enabled || state.playing || state.minutes !== null) return;
                a.sunDirty = true;
                a.invalidate();
            }, NOW_REFRESH_MS);
        } else if (!wanted && nowTimer) {
            clearInterval(nowTimer);
            nowTimer = null;
        }
    }

    function syncPlayback() {
        const a = attached;
        if (!a || !a.addFrameHook) return;
        const run = state.playing && state.enabled;
        if (run && !a.hooked) { a.addFrameHook(onFrame); a.hooked = true; }
        else if (!run && a.hooked) { a.removeFrameHook(onFrame); a.hooked = false; lastTick = null; }
        syncNowRefresh();
    }

    // ---- The scene ----
    // options: { THREE, scene, renderer, light, hemi, getOrigin, getK, getCamera, getTarget,
    //            isPhotoActive, invalidate, excludedRoots, addFrameHook, removeFrameHook }
    function attach(options) {
        detach();
        const { renderer, light, hemi } = options;
        const defaults = {
            position: light.position.clone(),
            intensity: light.intensity,
            hemiIntensity: hemi ? hemi.intensity : null,
            targetParent: light.target.parent
        };
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = options.THREE.PCFShadowMap;
        renderer.shadowMap.autoUpdate = false;
        const coarse = !!(root && root.matchMedia && root.matchMedia('(pointer: coarse)').matches);
        const maxTexture = renderer.capabilities && renderer.capabilities.maxTextureSize || 4096;
        const mapSize = Math.min(maxTexture, coarse ? 2048 : 4096);
        light.shadow.mapSize.set(mapSize, mapSize);
        light.shadow.bias = 0;
        // The light's target must be in the scene for its world matrix to follow our updates.
        if (!light.target.parent) options.scene.add(light.target);

        attached = {
            ...options, defaults, mapSize, place: null, sun: null, sunDirty: true, frame: null,
            showingSun: null, lastSweep: 0, hooked: false
        };
        syncPlayback();
        renderSheet();
        return { beforeRender, detach, onFrame, syncObjects };
    }

    // Newly rebuilt subtrees must join the next shadow draw immediately, rather than waiting
    // for the periodic scene sweep (an on-demand view may not render again after that sweep).
    function syncObjects(object) {
        const a = attached;
        if (!a || !object) return;
        applyShadowFlags(object, state.enabled && !a.isPhotoActive(),
            new Set((a.excludedRoots() || []).filter(Boolean)));
        a.renderer.shadowMap.needsUpdate = true;
    }

    function detach() {
        if (!attached) return;
        const { light, defaults, scene } = attached;
        if (attached.hooked) attached.removeFrameHook(onFrame);
        lastTick = null;
        if (nowTimer) { clearInterval(nowTimer); nowTimer = null; }
        restoreDefaults(attached);
        if (!defaults.targetParent && light.target.parent === scene) scene.remove(light.target);
        attached = null;
    }

    function restoreDefaults(a) {
        a.light.position.copy(a.defaults.position);
        a.light.target.position.set(0, 0, 0);
        a.light.target.updateMatrixWorld();
        a.light.intensity = a.defaults.intensity;
        a.light.castShadow = false;
        if (a.hemi && a.defaults.hemiIntensity !== null) a.hemi.intensity = a.defaults.hemiIntensity;
        a.showingSun = false;
    }

    // Called by three-mode before each render. The shadow map is re-rendered when the sun moves, when
    // its frame follows the camera, and on `sceneChanged` frames (something in the scene changed);
    // frames that only orbit the camera or animate a hook keep it. `fullFrame` is kept for callers.
    function beforeRender({ fullFrame, sceneChanged = false }, now = new Date()) {
        const a = attached;
        if (!a) return;
        const wanted = state.enabled && !a.isPhotoActive();
        if (!wanted) {
            if (a.showingSun !== false) {
                restoreDefaults(a);
                a.renderer.shadowMap.needsUpdate = true;
                renderButton(null);
            }
            return;
        }
        const place = placeOf(a.getOrigin());
        if (!place) return;
        if (place !== a.place) { a.place = place; a.sunDirty = true; Object.keys(shown).forEach(key => { delete shown[key]; }); }
        if (a.sunDirty || !a.sun) {
            a.sun = resolveSun(place, now);
            a.sunDirty = false;
            a.showingSun = null;
            renderLive();
        }
        const sun = a.sun;
        const c = core();
        const strength = c.sunStrength(sun.altitude);
        const direction = c.sunDirection(sun.altitude, sun.azimuth, a.getK());
        const camera = a.getCamera();
        const target = a.getTarget();
        if (!camera || !target || !direction) return;
        const frame = c.shadowFrame({
            targetX: target.x, targetY: target.y, distance: camera.position.distanceTo(target), mapSize: a.mapSize
        });
        const frameChanged = !a.frame || frame.halfExtent !== a.frame.halfExtent
            || frame.centerX !== a.frame.centerX || frame.centerY !== a.frame.centerY;
        if (frameChanged || a.showingSun !== true) {
            const { light } = a;
            light.target.position.set(frame.centerX, frame.centerY, target.z || 0);
            light.target.updateMatrixWorld();
            light.position.set(
                frame.centerX + direction.x * frame.lightDistance,
                frame.centerY + direction.y * frame.lightDistance,
                (target.z || 0) + direction.z * frame.lightDistance);
            const shadowCamera = light.shadow.camera;
            shadowCamera.left = -frame.halfExtent;
            shadowCamera.right = frame.halfExtent;
            shadowCamera.top = frame.halfExtent;
            shadowCamera.bottom = -frame.halfExtent;
            shadowCamera.near = 1;
            shadowCamera.far = frame.far;
            shadowCamera.updateProjectionMatrix();
            // Offsets along the surface normal by about a texel: removes acne without detaching
            // shadows from the walls that cast them.
            light.shadow.normalBias = frame.texel * 1.5;
            light.intensity = a.defaults.intensity * strength;
            light.castShadow = strength > 0;
            if (a.hemi && a.defaults.hemiIntensity !== null) {
                // Night is readable but darker than day: sky light alone, dimmed.
                a.hemi.intensity = a.defaults.hemiIntensity * (0.6 + 0.4 * strength);
            }
            a.frame = frame;
            a.showingSun = true;
            a.renderer.shadowMap.needsUpdate = true;
        }
        if (now.getTime() - a.lastSweep >= FLAG_SWEEP_MS) {
            a.lastSweep = now.getTime();
            applyShadowFlags(a.scene, true, new Set((a.excludedRoots() || []).filter(Boolean)));
        }
        if (sceneChanged) a.renderer.shadowMap.needsUpdate = true;
    }

    // The sun's altitude in degrees as the scene last resolved it, or null while the sun is off, photo
    // mode is showing or nothing is attached. Read-only: lamps glow from it at night.
    function currentAltitudeDeg() {
        const a = attached;
        if (!a || !state.enabled || a.isPhotoActive() || !a.sun) return null;
        return a.sun.altitude * 180 / Math.PI;
    }

    bindSheet();

    return { attach, detach, state, applyShadowFlags, resolveSun, placeOf, currentAltitudeDeg, DAY_CYCLE_MS };
});
