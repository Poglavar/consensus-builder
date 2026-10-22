// Sun and shadows in the 3D model view: the scene's directional light becomes the sun over the
// scene's own location at a chosen local date and time, and casts shadows. It is on by default; the
// sun button (index.html #sun-button, slot 1 of the mode strip in model view) opens #sun-sheet to
// switch it off or pick the time and date. Times are the place's wall clock (its IANA zone from
// tz-lookup), not the viewer's. three-mode.js attaches it to each scene and calls beforeRender()
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

    // What the person chose. date/minutes null mean "today" and "now (or noon at night)" at the
    // scene's place, resolved when the sun is computed, so they follow the scene to another city.
    const state = { enabled: loadEnabled(), dateISO: null, minutes: null };
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
    function resolveSun(place, now = new Date()) {
        const c = core();
        const today = c.localDateISO(now, place.timeZone);
        const dateISO = state.dateISO || today;
        const day = c.daylight(sunCalc(), dateISO, place.lat, place.lng, place.timeZone);
        const minutes = state.minutes !== null ? state.minutes
            : dateISO === today ? c.initialMinutes(c.localMinutes(now, place.timeZone), day) : day.solarNoon;
        const instant = c.localToInstant(dateISO, minutes, place.timeZone);
        const position = sunCalc().getPosition(instant, place.lat, place.lng);
        return { dateISO, minutes, day, instant, altitude: position.altitude, azimuth: position.azimuth };
    }

    // ---- The sheet ----
    const el = id => (root && root.document ? root.document.getElementById(id) : null);

    function renderSheet() {
        const button = el('sun-button');
        if (button) button.dataset.sun = state.enabled ? 'on' : 'off';
        const enabled = el('sun-enabled');
        if (enabled) enabled.checked = state.enabled;
        const controls = el('sun-controls');
        if (controls) controls.disabled = !state.enabled;
        const place = attached && attached.place;
        const sun = attached && attached.sun;
        if (!place || !sun) return;
        const c = core();
        const slider = el('sun-time');
        if (slider) {
            slider.min = String(sun.day.min);
            slider.max = String(sun.day.max);
            slider.value = String(Math.min(sun.day.max, Math.max(sun.day.min, sun.minutes)));
            slider.setAttribute('aria-valuetext', c.formatMinutes(sun.minutes));
        }
        const value = el('sun-time-value');
        if (value) value.textContent = c.formatMinutes(sun.minutes);
        const date = el('sun-date');
        if (date && date !== root.document.activeElement) date.value = sun.dateISO;
        const rise = el('sun-sunrise');
        if (rise) rise.textContent = sun.day.sunrise === null ? '00:00'
            : t('threeMode.sun.sunrise', `Sunrise ${c.formatMinutes(sun.day.sunrise)}`, { time: c.formatMinutes(sun.day.sunrise) });
        const set = el('sun-sunset');
        if (set) set.textContent = sun.day.sunset === null ? '23:59'
            : t('threeMode.sun.sunset', `Sunset ${c.formatMinutes(sun.day.sunset)}`, { time: c.formatMinutes(sun.day.sunset) });
        const zone = el('sun-zone');
        if (zone) zone.textContent = t('threeMode.sun.zone', `Local time at this place (${place.timeZone})`, { zone: place.timeZone });
        const status = el('sun-status');
        if (status) {
            status.textContent = sun.altitude > 0 ? '' : t('threeMode.sun.belowHorizon', 'The sun is below the horizon at this time.');
            status.hidden = sun.altitude > 0;
        }
    }

    function changed() {
        if (attached) {
            // Resolve now, so the sheet's readout follows the slider without waiting for a frame.
            if (attached.place) attached.sun = resolveSun(attached.place);
            attached.sunDirty = true;
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
        el('sun-time')?.addEventListener('input', event => {
            state.minutes = Number(event.target.value);
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

    // ---- The scene ----
    // options: { THREE, scene, renderer, light, hemi, getOrigin, getK, getCamera, getTarget,
    //            isPhotoActive, invalidate, excludedRoots }
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
            showingSun: null, lastSweep: 0
        };
        renderSheet();
        return { beforeRender, detach };
    }

    function detach() {
        if (!attached) return;
        const { light, defaults, scene } = attached;
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

    // Called by three-mode before each render. `fullFrame` is false on frames that only animate the
    // life layer: the shadow map is re-rendered on every other frame, and not on those.
    function beforeRender({ fullFrame }, now = new Date()) {
        const a = attached;
        if (!a) return;
        const wanted = state.enabled && !a.isPhotoActive();
        if (!wanted) {
            if (a.showingSun !== false) {
                restoreDefaults(a);
                a.renderer.shadowMap.needsUpdate = true;
            }
            return;
        }
        const place = placeOf(a.getOrigin());
        if (!place) return;
        if (place !== a.place) { a.place = place; a.sunDirty = true; }
        if (a.sunDirty || !a.sun) {
            a.sun = resolveSun(place, now);
            a.sunDirty = false;
            a.showingSun = null;
            renderSheet();
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
        if (fullFrame) a.renderer.shadowMap.needsUpdate = true;
    }

    bindSheet();

    return { attach, detach, state, applyShadowFlags, resolveSun, placeOf };
});
