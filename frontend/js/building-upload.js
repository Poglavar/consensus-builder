// Building upload modal: lets a proposer upload a glTF 2.0 (.glb/.gltf) building model,
// preview it in a three.js scene, and turn its footprint + height into a single-building
// placement (via window.createSingleBuildingFromUpload). Review the asset here, then place
// its editable footprint on the main map; the saved model reference supplies its 3D mesh.

(function () {
    let modalEl = null;
    let onConfirmCb = null;
    let onUseCb = null;
    let unregisterEscape = null;
    let currentContext = null;

    // Preview scene state
    const preview = {
        renderer: null,
        scene: null,
        camera: null,
        controls: null,
        modelGroup: null,
        frameId: null,
        container: null,
        resizeHandler: null,
        animate: null
    };

    // Dimensions (meters) derived from the loaded model's bounding box; null until a valid load.
    let loadedDims = null;
    let loadedName = null;
    let loadedFile = null;
    let loadVersion = 0;

    function t(key, fallback, params = {}) {
        const api = (typeof window !== 'undefined' && window.i18n) ? window.i18n : null;
        if (api && typeof api.t === 'function') {
            try { const translated = api.t(key, params); if (translated !== key) return translated; } catch (_) { /* fall through */ }
        }
        return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) =>
            Object.prototype.hasOwnProperty.call(params, k) ? params[k] : m);
    }

    // THREE (incl. OrbitControls + GLTFLoader) comes from index.html's ESM bootstrap — never
    // script-load a second copy here, an old UMD build would clobber the r184 global.
    async function ensureThree() {
        if (typeof window.THREE === 'undefined' && typeof window.whenThreeReady === 'function') {
            await window.whenThreeReady();
        }
        const ok = typeof window.THREE !== 'undefined' && typeof window.THREE.GLTFLoader !== 'undefined';
        if (!ok) console.warn('[building-upload] THREE bootstrap missing — model parser unavailable');
        return ok;
    }

    function setStatus(text, isError = false) {
        const el = modalEl && modalEl.querySelector('#building-upload-status');
        if (!el) return;
        el.textContent = text || '';
        if (isError) el.dataset.tone = 'error';
        else delete el.dataset.tone;
    }

    function setConfirmEnabled(enabled) {
        const btn = modalEl && modalEl.querySelector('#building-upload-confirm');
        if (btn) btn.disabled = !enabled;
    }

    function buildModal() {
        const text = {
            title: t('modal.buildingUpload.title', 'Upload a building model'),
            closeLabel: t('modal.buildingUpload.closeLabel', 'Close upload modal'),
            previewLabel: t('modal.buildingUpload.previewLabel', '3D Preview'),
            chooseFile: t('modal.buildingUpload.chooseFile', 'Choose a model file'),
            hint: t('modal.buildingUpload.hint', 'Supported: glTF 2.0 (.glb or .gltf).'),
            noFile: t('modal.buildingUpload.noFile', 'No model loaded yet.'),
            cancel: t('modal.buildingUpload.cancel', 'Cancel'),
            confirm: t('modal.buildingUpload.confirm', 'Use this building')
        };

        const modal = document.createElement('div');
        modal.id = 'building-upload-modal';
        // The standard dialog (.cb-dialog, primitives.css); its contents are styled in css/modals.css.
        modal.className = 'cb-dialog-overlay';

        modal.innerHTML = `
            <div id="building-upload-container" class="cb-dialog cb-dialog--md building-upload-dialog" role="dialog" aria-modal="true" aria-labelledby="building-upload-title">
                <div class="cb-dialog__header">
                    <h2 id="building-upload-title" class="cb-dialog__title">${text.title}</h2>
                    <button id="building-upload-close" type="button" class="close-circle-btn close-circle-btn--lg" aria-label="${text.closeLabel}">×</button>
                </div>
                <div class="cb-dialog__body">
                    <label class="building-upload-file">
                        <span class="btn">${text.chooseFile}</span>
                        <input id="building-upload-file" type="file" accept=".glb,.gltf,model/gltf-binary,model/gltf+json" hidden>
                    </label>
                    <p class="building-upload-hint">${text.hint}</p>
                    <div class="cb-kicker">${text.previewLabel}</div>
                    <div id="building-upload-3d" class="building-upload-preview" role="status" aria-live="polite"></div>
                    <div id="building-upload-status" class="building-upload-status" role="status" aria-live="polite">${text.noFile}</div>
                </div>
                <div class="cb-dialog__footer">
                    <button id="building-upload-cancel" type="button" class="btn">${text.cancel}</button>
                    <button id="building-upload-confirm" type="button" class="btn btn-primary" disabled>${text.confirm}</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        modalEl = modal;
        unregisterEscape = window.ModalEscape?.register(modal, close) || null;

        modal.querySelector('#building-upload-close').addEventListener('click', close);
        modal.querySelector('#building-upload-cancel').addEventListener('click', close);
        modal.querySelector('#building-upload-confirm').addEventListener('click', confirmUpload);
        modal.querySelector('#building-upload-file').addEventListener('change', onFileChosen);
        modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

        preview.container = modal.querySelector('#building-upload-3d');
    }

    function initScene() {
        if (preview.renderer || !preview.container) return;
        const w = preview.container.clientWidth || 480;
        const h = preview.container.clientHeight || 300;

        const scene = new THREE.Scene();
        preview.scene = scene;
        scene.background = new THREE.Color(0xeef2f7);

        const camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 5000);
        preview.camera = camera;
        camera.position.set(30, 24, 30);

        const renderer = new THREE.WebGLRenderer({ antialias: true });
        preview.renderer = renderer;
        renderer.setPixelRatio(window.devicePixelRatio || 1);
        renderer.setSize(w, h);
        preview.container.appendChild(renderer.domElement);
        renderer.domElement.addEventListener('webglcontextlost', showPreviewUnavailable);

        // ×π: three r155+ dropped the implicit π factor legacy lighting applied.
        scene.add(new THREE.AmbientLight(0xffffff, 0.7 * Math.PI));
        const dir = new THREE.DirectionalLight(0xffffff, 0.8 * Math.PI);
        dir.position.set(40, 60, 25);
        scene.add(dir);
        scene.add(new THREE.GridHelper(120, 24, 0xbac4d0, 0xd5dce5));

        const OrbitCtor = THREE.OrbitControls || (typeof window !== 'undefined' ? window.OrbitControls : null);
        const controls = OrbitCtor
            ? new OrbitCtor(camera, renderer.domElement)
            : { update: () => {}, dispose: () => {}, target: new THREE.Vector3() };
        if (controls.enableDamping !== undefined) controls.enableDamping = true;

        const modelGroup = new THREE.Group();
        scene.add(modelGroup);

        preview.controls = controls;
        preview.modelGroup = modelGroup;

        preview.resizeHandler = () => {
            if (!preview.container || !preview.renderer) return;
            const cw = preview.container.clientWidth || w;
            const ch = preview.container.clientHeight || h;
            preview.camera.aspect = cw / ch;
            preview.camera.updateProjectionMatrix();
            preview.renderer.setSize(cw, ch);
        };
        window.addEventListener('resize', preview.resizeHandler);

        const animate = () => {
            try {
                if (preview.controls && preview.controls.update) preview.controls.update();
                preview.renderer.render(preview.scene, preview.camera);
                preview.frameId = requestAnimationFrame(animate);
            } catch (error) {
                showPreviewUnavailable(error);
            }
        };
        preview.animate = animate;
    }

    function clearModelGroup() {
        if (!preview.modelGroup) return;
        for (let i = preview.modelGroup.children.length - 1; i >= 0; i--) {
            const child = preview.modelGroup.children[i];
            preview.modelGroup.remove(child);
            disposeModel(child);
        }
    }

    function disposeModel(object) {
        object && object.traverse && object.traverse((node) => {
            if (node.geometry && node.geometry.dispose) node.geometry.dispose();
            if (node.material) {
                const mats = Array.isArray(node.material) ? node.material : [node.material];
                mats.forEach((m) => m && m.dispose && m.dispose());
            }
        });
    }

    // CPU-only bounds: parsing and import readiness never depend on a renderer or camera.
    function measureModel(object) {
        const box = new THREE.Box3().setFromObject(object);
        if (box.isEmpty()) return null;
        const dimensions = window.BuildingModelGeometry.dimensionsFromBounds(box);
        if (!dimensions) return null;
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);
        // glTF is Y-up with units in meters: footprint is X by Z, height is Y.
        return { box, size, center, dimensions };
    }

    // Center the model on the ground plane and frame the optional preview camera to it.
    function placeAndFrame(object, { box, size, center }) {
        // Recenter horizontally at origin, sit the base on y = 0.
        object.position.x -= center.x;
        object.position.z -= center.z;
        object.position.y -= box.min.y;

        const radius = Math.max(size.x, size.y, size.z) || 10;
        const dist = radius * 2.2 + 5;
        preview.camera.position.set(dist, dist * 0.8, dist);
        if (preview.controls && preview.controls.target) {
            preview.controls.target.set(0, size.y / 2, 0);
            if (preview.controls.update) preview.controls.update();
        } else {
            preview.camera.lookAt(0, size.y / 2, 0);
        }
        preview.camera.far = dist * 10;
        preview.camera.updateProjectionMatrix();
    }

    function showPreviewUnavailable(error) {
        console.warn('[building-upload] 3D preview unavailable; model import remains available', error);
        disposeScene();
        if (!preview.container) return;
        preview.container.dataset.state = 'unavailable';
        preview.container.textContent = t('modal.buildingUpload.previewUnavailable',
            '3D preview unavailable. You can still use this building.');
    }

    async function onFileChosen(event) {
        const file = event.target && event.target.files && event.target.files[0];
        if (!file) return;
        const version = ++loadVersion;
        const isCurrent = () => version === loadVersion && !!modalEl;
        disposeScene();
        preview.container.textContent = '';
        delete preview.container.dataset.state;
        loadedDims = null;
        loadedName = file.name;
        loadedFile = file;
        setConfirmEnabled(false);
        setStatus(t('modal.buildingUpload.loading', 'Loading model…'));

        let ok;
        try {
            ok = await ensureThree();
        } catch (error) {
            if (isCurrent()) setStatus(t('modal.buildingUpload.errorEngine', 'Could not load the model parser.'), true);
            return;
        }
        if (!isCurrent()) return;
        if (!ok) {
            setStatus(t('modal.buildingUpload.errorEngine', 'Could not load the model parser.'), true);
            return;
        }

        const isText = /\.gltf$/i.test(file.name);
        const reader = new FileReader();
        reader.onerror = () => {
            if (isCurrent()) setStatus(t('modal.buildingUpload.errorParse',
                'Could not read this file as glTF/GLB.'), true);
        };
        reader.onload = () => {
            if (!isCurrent()) return;
            const loader = new THREE.GLTFLoader();
            const onParsed = (gltf) => {
                const root = gltf.scene || (gltf.scenes && gltf.scenes[0]);
                if (!isCurrent()) { disposeModel(root); return; }
                if (!root) {
                    setStatus(t('modal.buildingUpload.errorEmpty', 'The model contains no visible geometry.'), true);
                    return;
                }
                const measurement = measureModel(root);
                if (!measurement) {
                    disposeModel(root);
                    setStatus(t('modal.buildingUpload.errorEmpty', 'The model contains no visible geometry.'), true);
                    return;
                }
                const dims = measurement.dimensions;
                loadedDims = dims;
                setStatus(t('modal.buildingUpload.loaded', 'Loaded: {{name}}', { name: file.name })
                    + ' — ' + t('modal.buildingUpload.dimensions',
                        'Footprint {{width}}m × {{length}}m, height {{height}}m',
                        { width: dims.width, length: dims.length, height: dims.height }));
                setConfirmEnabled(true);
                try {
                    initScene();
                    preview.modelGroup.add(root);
                    placeAndFrame(root, measurement);
                    preview.animate();
                } catch (error) {
                    if (!root.parent) disposeModel(root);
                    showPreviewUnavailable(error);
                }
            };
            const onErr = () => {
                if (isCurrent()) {
                    loadedDims = null;
                    setConfirmEnabled(false);
                    setStatus(t('modal.buildingUpload.errorParse',
                        'Could not read this file as glTF/GLB. Make sure it is a valid, self-contained .glb or .gltf export.'), true);
                }
            };
            try {
                loader.parse(reader.result, '', onParsed, onErr);
            } catch (_) {
                onErr();
            }
        };
        if (isText) reader.readAsText(file);
        else reader.readAsArrayBuffer(file);
    }

    function fileToDataUrl(file) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onerror = () => reject(r.error || new Error('read failed'));
            r.onload = () => resolve(r.result);
            r.readAsDataURL(file);
        });
    }

    // Uploads the raw model bytes to the backend; returns the served modelUrl.
    async function uploadModel(file) {
        const base = (typeof window.getBackendBase === 'function')
            ? window.getBackendBase() : 'http://localhost:3000';
        const dataUrl = await fileToDataUrl(file);
        const resp = await fetch(base.replace(/\/$/, '') + '/models', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ modelData: dataUrl, fileName: file.name })
        });
        if (!resp.ok) throw new Error('models endpoint returned ' + resp.status);
        const json = await resp.json();
        if (!json || !json.modelUrl) throw new Error('models endpoint returned no modelUrl');
        return json.modelUrl;
    }

    // Named so it does not shadow the browser's own confirm().
    async function confirmUpload() {
        if (!loadedDims || !currentContext || !loadedFile) return;
        if (!onUseCb && typeof window.createSingleBuildingFromUpload !== 'function') {
            setStatus('Single building pipeline is unavailable.', true);
            return;
        }
        setConfirmEnabled(false);
        setStatus(t('modal.buildingUpload.uploading', 'Uploading model…'));
        const version = loadVersion;
        const use = onUseCb || window.createSingleBuildingFromUpload;
        const input = {
            ...currentContext, ...loadedDims, modelName: loadedName, onConfirm: onConfirmCb
        };

        // Persist the mesh so the main-map 3D view can render it. If this fails the
        // proposal is still created, just with a plain extruded box instead of the mesh.
        let modelUrl = null;
        try {
            modelUrl = await uploadModel(loadedFile);
        } catch (e) {
            if (version !== loadVersion || !modalEl) return;
            console.warn('Building model upload failed; falling back to footprint box', e);
            setStatus(t('modal.buildingUpload.uploadFailed',
                'Model upload failed; the building will use a plain box.'), true);
        }

        if (version !== loadVersion || !modalEl) return;
        const created = use({ ...input, modelUrl });
        if (!created) { setConfirmEnabled(true); return; } // single-building.js surfaces its own status
        close();
    }

    function disposeScene() {
        if (preview.frameId) cancelAnimationFrame(preview.frameId);
        if (preview.resizeHandler) window.removeEventListener('resize', preview.resizeHandler);
        clearModelGroup();
        if (preview.controls && preview.controls.dispose) preview.controls.dispose();
        if (preview.renderer) {
            preview.renderer.domElement.removeEventListener('webglcontextlost', showPreviewUnavailable);
            preview.renderer.dispose();
            if (preview.renderer.domElement && preview.renderer.domElement.parentNode) {
                preview.renderer.domElement.parentNode.removeChild(preview.renderer.domElement);
            }
        }
        preview.renderer = preview.scene = preview.camera = preview.controls = null;
        preview.modelGroup = preview.frameId = preview.resizeHandler = preview.animate = null;
    }

    function close() {
        loadVersion++;
        unregisterEscape?.();
        unregisterEscape = null;
        disposeScene();
        preview.container = null;
        if (modalEl && modalEl.parentNode) modalEl.parentNode.removeChild(modalEl);
        modalEl = null;
        onConfirmCb = null;
        onUseCb = null;
        currentContext = null;
        loadedDims = null;
        loadedName = null;
        loadedFile = null;
    }

    // context: { parcelIds: string[], site?: Polygon | MultiPolygon, blockName: string }
    function open(context, options = {}) {
        if (modalEl) close();
        currentContext = context || {};
        onConfirmCb = typeof options.onConfirm === 'function' ? options.onConfirm : null;
        onUseCb = typeof options.onUse === 'function' ? options.onUse : null;
        buildModal();
    }

    window.BuildingUpload = { open, close };
})();
