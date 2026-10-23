// Loads model, photo and AI capabilities separately, and gives every entry point one mode owner.
(function (root) {
    'use strict';
    const groups = {
        model: [
            'js/building-height.js', 'js/proposals/gain.js', 'js/three-mesh-sanitize.js',
            'js/three-screen-door.js', 'js/three-smooth-transparency.js', 'js/three-building-display.js',
            'js/three-floor-plans.js', 'js/three-building-facades.js', 'js/three-resources.js',
            'js/three-scene-work.js', 'js/three-structure-refresh.js', 'js/three-square-paving.js',
            'js/three-snapshot-navigation.js', 'js/three-keyboard-context.js', 'js/three-parcel-emphasis.js',
            'js/elevated-rail-3d.js', 'js/three-focus-plan.js', 'js/three-click-plan.js', 'js/three-click-stack.js',
            'js/life/life-graph.js', 'js/life/life-surface.js', 'js/life/life-agents.js', 'js/three-life.js',
            'js/life/ground-geometry.js', 'js/three-ground.js',
            'vendor/suncalc-1.9.0/suncalc.js', 'vendor/tz-lookup-11.7.0/tz.js', 'js/sun-shadows.js', 'js/three-sun.js',
            'js/three-mode.js'
        ],
        photo: ['js/photoreal-frame.js', 'js/photoreal-ground.js', 'js/photoreal-seam.js',
            'js/photoreal-protect.js', 'js/photoreal-attribution.js', 'js/photoreal-parcels.js', 'js/photoreal-mode.js'],
        ai: ['js/ai-scene-frustum.js', 'js/ai-scene.js']
    };
    const scripts = new Map();
    const loading = new Map();
    function loadScript(path) {
        if (scripts.has(path)) return scripts.get(path);
        const promise = new Promise((resolve, reject) => {
            const tag = document.createElement('script');
            tag.src = root.appendBuildToken(path);
            tag.async = false;
            tag.onload = () => resolve(true);
            tag.onerror = () => { scripts.delete(path); tag.remove(); reject(new Error('Failed to load ' + path)); };
            document.head.appendChild(tag);
        });
        scripts.set(path, promise);
        return promise;
    }
    function loadGroup(name) {
        if (!loading.has(name)) {
            // Fetch concurrently, evaluate in dependency order, and stop at a failed dependency.
            for (const path of groups[name]) {
                const preload = document.createElement('link');
                preload.rel = 'preload'; preload.as = 'script'; preload.href = root.appendBuildToken(path);
                document.head.appendChild(preload);
            }
            const promise = groups[name].reduce((p, path) => p.then(() => loadScript(path)), Promise.resolve(true))
                .catch(error => { loading.delete(name); throw error; });
            loading.set(name, promise);
        }
        return loading.get(name);
    }
    root.__ensure3DModeStack = async () => {
        if (!await root.whenThreeReady()) return false;
        await loadGroup('model');
        root.__threeModeStackReady = true;
        return true;
    };
    root.__ensurePhotorealMode = () => loadGroup('photo');
    function paint(state) {
        root.__mapModeState = state;
        root.dispatchEvent(new CustomEvent('mapmodechange', { detail: state }));
        root.__pending3DMode = state.pending ? state.desired : null;
        if (root.updateModeButtonStates) root.updateModeButtonStates();
        else {
            for (const [mode, id] of [['2d', 'mode-2d-toggle'], ['model', 'mode-3d-toggle'], ['photo', 'mode-realistic-toggle']]) {
                const button = document.getElementById(id);
                if (!button) continue;
                // The selected view is aria-pressed; the strip's tiles take their look from it.
                button.setAttribute('aria-pressed', String(mode === state.desired));
                button.classList.toggle('mode-btn-loading', mode === state.desired && state.pending);
            }
        }
        paintModeLocks();
    }
    function canRequestMapMode(mode) {
        if (root.roadDrawingMode && mode !== '2d') return false;
        return !root.OnMapEditor || root.OnMapEditor.allowsMode(mode);
    }
    // While road drawing or an on-map editor holds the map, the views it cannot run in are refused
    // (canRequestMapMode). Their tiles say so: disabled, greyed by .map-mode-btn--locked, with a
    // tooltip naming the way out. This is the only writer of that lock, so nested editors (road
    // drawing with its cross-section editor) cannot restore each other's saved state out of order.
    // The AI render is a photo of the photo view, so it follows the photo tile.
    const LOCKABLE_TILES = [['2d', 'mode-2d-toggle'], ['model', 'mode-3d-toggle'], ['photo', 'mode-realistic-toggle'], ['photo', 'mode-ai-toggle']];
    function paintModeLocks() {
        for (const [mode, id] of LOCKABLE_TILES) {
            const button = document.getElementById(id);
            if (!button) continue;
            const locked = !canRequestMapMode(mode);
            const wasLocked = button.dataset.lockedDisabled !== undefined;
            if (locked) {
                if (!wasLocked) {
                    button.dataset.lockedDisabled = String(button.disabled);
                    button.dataset.lockedTitle = button.title || '';
                }
                // Reasserted on every paint: updateModeButtonStates rewrites the AI tile on a view change.
                button.classList.add('map-mode-btn--locked');
                button.disabled = true;
                const translated = root.i18n?.t?.('mapShell.modeLocked');
                button.title = translated && translated !== 'mapShell.modeLocked'
                    ? translated : 'Not available while you are editing — finish or cancel first';
            } else if (wasLocked) {
                button.classList.remove('map-mode-btn--locked');
                button.disabled = button.dataset.lockedDisabled === 'true';
                button.title = button.dataset.lockedTitle;
                delete button.dataset.lockedDisabled;
                delete button.dataset.lockedTitle;
            }
        }
    }
    root.syncMapModeLocks = paintModeLocks;
    // Editors announce themselves on <body> (map-edit-locked, on-map-editing); road drawing by event.
    document.addEventListener('corridor-drawing-mode-changed', paintModeLocks);
    if (typeof MutationObserver === 'function' && document.body) {
        new MutationObserver(paintModeLocks).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
    const controller = root.__mapModeTransition.createController({
        loadModel: root.__ensure3DModeStack,
        loadPhoto: root.__ensurePhotorealMode,
        enterModel: options => root.__threeModeDriver.enter(options),
        leaveModel: () => root.__threeModeDriver?.exit(),
        enterPhoto: options => root.PhotorealMode.activate(options),
        leavePhoto: options => root.PhotorealMode?.deactivate(options),
        onChange: paint,
        onError: (error, mode) => {
            console.error(`[${new Date().toISOString()}] [map-mode] Mode transition failed`, { mode, error });
            const key = 'mapShell.viewFailed';
            const translated = root.i18n?.t?.(key);
            const message = translated && translated !== key ? translated : 'This view could not start. You are back on the 2D map.';
            root.showEphemeralMessage?.(message, 8000, 'warning');
        }
    });
    root.requestMapMode = (mode, options) => {
        if (!canRequestMapMode(mode)) return Promise.resolve(false);
        return controller.request(mode, options);
    };
    root.enterThreeMode = options => root.requestMapMode('model', options);
    root.exitThreeMode = () => root.requestMapMode('2d');
    for (const [mode, id] of [['2d', 'mode-2d-toggle'], ['model', 'mode-3d-toggle'], ['photo', 'mode-realistic-toggle']]) {
        document.getElementById(id)?.addEventListener('click', () => root.requestMapMode(mode));
    }
    const aiButton = document.getElementById('mode-ai-toggle');
    aiButton?.addEventListener('click', function firstAiClick(event) {
        event.stopImmediatePropagation();
        loadGroup('ai').then(() => {
            aiButton.removeEventListener('click', firstAiClick, true);
            if (controller.getState().desired === 'photo') aiButton.click();
        }).catch(error => console.error('[map-mode] AI tools failed to load', error));
    }, true);
    if (new URLSearchParams(root.location.search).has('scene')) loadScript('js/ai-scene-follow.js');
    paint(controller.getState());
})(window);
