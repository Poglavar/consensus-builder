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
            'js/elevated-rail-3d.js', 'js/three-mode.js'
        ],
        photo: ['js/photoreal-frame.js', 'js/photoreal-ground.js', 'js/photoreal-seam.js',
            'js/photoreal-protect.js', 'js/photoreal-attribution.js', 'js/photoreal-mode.js'],
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
        root.__pending3DMode = state.pending ? state.desired : null;
        if (root.updateModeButtonStates) { root.updateModeButtonStates(); return; }
        for (const [mode, id] of [['2d', 'mode-2d-toggle'], ['model', 'mode-3d-toggle'], ['photo', 'mode-realistic-toggle']]) {
            const button = document.getElementById(id);
            if (!button) continue;
            button.classList.toggle('active', mode === state.desired);
            button.setAttribute('aria-pressed', String(mode === state.desired));
            button.classList.toggle('mode-btn-loading', mode === state.desired && state.pending);
        }
    }
    const controller = root.__mapModeTransition.createController({
        loadModel: root.__ensure3DModeStack,
        loadPhoto: root.__ensurePhotorealMode,
        enterModel: options => root.__threeModeDriver.enter(options),
        leaveModel: () => root.__threeModeDriver?.exit(),
        enterPhoto: options => root.PhotorealMode.activate(options),
        leavePhoto: options => root.PhotorealMode?.deactivate(options),
        onChange: paint,
        onError: error => console.error('[map-mode] Mode transition failed', error)
    });
    root.requestMapMode = controller.request;
    root.enterThreeMode = options => controller.request('model', options);
    root.exitThreeMode = () => controller.request('2d');
    for (const [mode, id] of [['2d', 'mode-2d-toggle'], ['model', 'mode-3d-toggle'], ['photo', 'mode-realistic-toggle']]) {
        document.getElementById(id)?.addEventListener('click', () => controller.request(mode));
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
