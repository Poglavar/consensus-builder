// Flight playback, authoring and apartment walking are separate on-demand capabilities.
(function (win, doc) {
    'use strict';
    const loaded = new Map();
    let opening = Promise.resolve(), openVersion = 0;
    win.cameraFlightWalkingLabels = () => {
        const t = key => win.i18n.t('cameraFlight.' + key);
        return { people: [t('camera'), t('apartment')], firstPerson: t('explore'), personView: () => t('explore'),
            back: t('backToFlight'), overview: t('overview'), choosePerson: t('walkingHint'), walkStick: t('freeCamera'),
            walkHint: () => t('walkingHint'), noRoute: t('placementFailed') };
    };
    function script(path) {
        if (!loaded.has(path)) loaded.set(path, new Promise((resolve, reject) => {
            const tag = doc.createElement('script'); tag.src = win.appendBuildToken(path); tag.async = false;
            tag.onload = resolve; tag.onerror = () => { loaded.delete(path); tag.remove(); reject(new Error('Could not load ' + path)); };
            doc.head.append(tag);
        }));
        return loaded.get(path);
    }
    let css;
    function styles() {
        if (!css) css = new Promise((resolve, reject) => {
            const link = doc.createElement('link'); link.rel = 'stylesheet'; link.href = win.appendBuildToken('css/camera-flight.css');
            link.onload = resolve; link.onerror = () => { css = null; link.remove(); reject(new Error('Could not load camera flight styles.')); }; doc.head.append(link);
        });
        return css;
    }
    const sequence = paths => paths.reduce((chain, path) => chain.then(() => script(path)), Promise.resolve());
    win.ensureCameraFlight = () => Promise.all([styles(), sequence(['js/camera-flight.js', 'js/camera-flight-camera.js', 'js/camera-flight-session.js', 'js/camera-flight-player.js'])]);
    win.ensureCameraFlightApartment = () => sequence(['js/camera-flight-interiors.js', 'js/camera-flight-apartment.js']);
    win.ensureInteriorViewer = () => script('vendor/interior-viewer/interior-viewer.js');
    win.openCameraFlightEditor = async function (options = {}) {
        const version = ++openVersion;
        if (!win.isThreeModeActive?.()) {
            if (!await win.requestMapMode('model', { restoreView: options.record?.view.camera })) throw new Error('The model view could not be opened.');
        }
        await win.ensureCameraFlight();
        if (!options.readOnly) await sequence(['js/camera-flight-edit.js', 'js/camera-flight-interiors.js', 'js/camera-flight-apartment.js', 'js/camera-flight-auto.js', 'js/camera-flight-scene.js', 'js/camera-flight-editor.js']);
        const task = opening.catch(() => {}).then(async () => {
            if (version !== openVersion) return null;
            await win.CameraFlightEditor?.active?.close();
            await win.CameraFlightPlayer?.active?.close();
            if (version !== openVersion) return null;
            const instance = await (options.readOnly ? win.CameraFlightPlayer : win.CameraFlightEditor).open(options);
            if (version !== openVersion) { await instance?.close(); return null; }
            return instance;
        });
        opening = task; return task;
    };
    const button = doc.getElementById('camera-flight-open');
    button?.addEventListener('click', () => win.openCameraFlightEditor().catch(error => {
        console.error('[camera-flight]', error);
        win.showEphemeralMessage?.(error.message, 8000, 'error');
    }));
    function paint() { if (button) button.hidden = win.__mapModeState?.desired !== 'model' || !!win.__mapModeState?.pending; }
    win.addEventListener('mapmodechange', paint); paint();
})(window, document);
