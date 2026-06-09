// Building upload modal: lets a proposer upload a glTF 2.0 (.glb/.gltf) building model,
// preview it in a three.js scene, and turn its footprint + height into a single-building
// proposal (via window.createSingleBuildingFromUpload). The mesh is shown for review here;
// the proposal itself stores the standard footprint box that flows through the building pipeline.

(function () {
    const THREE_VERSION = '0.147.0';
    const CDN = (path) => `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/${path}`;

    let modalEl = null;
    let onConfirmCb = null;
    let currentContext = null;
    let threeLoadPromise = null;

    // Preview scene state
    const preview = {
        renderer: null,
        scene: null,
        camera: null,
        controls: null,
        modelGroup: null,
        frameId: null,
        container: null,
        resizeHandler: null
    };

    // Dimensions (meters) derived from the loaded model's bounding box; null until a valid load.
    let loadedDims = null;
    let loadedName = null;
    let loadedFile = null;

    function t(key, fallback, params = {}) {
        const api = (typeof window !== 'undefined' && window.i18n) ? window.i18n : null;
        if (api && typeof api.t === 'function') {
            try { return api.t(key, params); } catch (_) { /* fall through */ }
        }
        return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) =>
            Object.prototype.hasOwnProperty.call(params, k) ? params[k] : m);
    }

    function loadScript(src) {
        return new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = src;
            script.async = true;
            script.onload = () => resolve(true);
            script.onerror = () => resolve(false);
            document.head.appendChild(script);
        });
    }

    // Ensure THREE core, OrbitControls and GLTFLoader are present (matches the rest of the app's CDN pattern).
    async function ensureThree() {
        if (typeof THREE === 'undefined') {
            if (!threeLoadPromise) threeLoadPromise = loadScript(CDN('build/three.min.js'));
            await threeLoadPromise;
        }
        if (typeof THREE === 'undefined') return false;
        if (typeof THREE.OrbitControls === 'undefined') {
            await loadScript(CDN('examples/js/controls/OrbitControls.js'));
        }
        if (typeof THREE.GLTFLoader === 'undefined') {
            await loadScript(CDN('examples/js/loaders/GLTFLoader.js'));
        }
        return typeof THREE !== 'undefined' && typeof THREE.GLTFLoader !== 'undefined';
    }

    function setStatus(text, isError = false) {
        const el = modalEl && modalEl.querySelector('#building-upload-status');
        if (!el) return;
        el.textContent = text || '';
        el.style.color = isError ? '#b91c1c' : '#4b5563';
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
        modal.style.cssText = 'position:fixed; inset:0; width:100%; height:100%; background:rgba(0,0,0,0.5);'
            + ' z-index:12070; display:flex; align-items:center; justify-content:center;';

        modal.innerHTML = `
            <div id="building-upload-container" style="background:#fff; border-radius:12px; width:min(560px, 94vw);
                max-height:92vh; display:flex; flex-direction:column; overflow:hidden; box-shadow:0 12px 40px rgba(0,0,0,0.3);">
                <div style="display:flex; align-items:center; justify-content:space-between; padding:14px 18px; border-bottom:1px solid #eee;">
                    <h2 style="margin:0; font-size:18px;">${text.title}</h2>
                    <button id="building-upload-close" type="button" class="close-circle-btn close-circle-btn--lg" aria-label="${text.closeLabel}">×</button>
                </div>
                <div style="padding:16px 18px; overflow:auto;">
                    <label style="display:inline-flex; align-items:center; gap:10px; cursor:pointer; margin-bottom:10px;">
                        <span class="btn btn-light" style="padding:8px 14px;">${text.chooseFile}</span>
                        <input id="building-upload-file" type="file" accept=".glb,.gltf,model/gltf-binary,model/gltf+json" style="display:none;">
                    </label>
                    <p style="font-size:12px; color:#6b7280; margin:0 0 12px;">${text.hint}</p>
                    <div style="font-size:12px; font-weight:600; color:#374151; margin-bottom:6px;">${text.previewLabel}</div>
                    <div id="building-upload-3d" style="width:100%; height:300px; background:#eef2f7; border-radius:8px; overflow:hidden;"></div>
                    <div id="building-upload-status" style="font-size:13px; color:#4b5563; margin-top:10px; min-height:18px;">${text.noFile}</div>
                </div>
                <div style="display:flex; gap:10px; justify-content:flex-end; padding:12px 18px; border-top:1px solid #eee;">
                    <button id="building-upload-cancel" type="button" class="btn btn-light">${text.cancel}</button>
                    <button id="building-upload-confirm" type="button" class="btn btn-proposal" disabled>${text.confirm}</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        modalEl = modal;

        modal.querySelector('#building-upload-close').addEventListener('click', close);
        modal.querySelector('#building-upload-cancel').addEventListener('click', close);
        modal.querySelector('#building-upload-confirm').addEventListener('click', confirm);
        modal.querySelector('#building-upload-file').addEventListener('change', onFileChosen);
        modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

        preview.container = modal.querySelector('#building-upload-3d');
    }

    function initScene() {
        if (preview.renderer || !preview.container) return;
        const w = preview.container.clientWidth || 480;
        const h = preview.container.clientHeight || 300;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0xeef2f7);

        const camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 5000);
        camera.position.set(30, 24, 30);

        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(window.devicePixelRatio || 1);
        renderer.setSize(w, h);
        preview.container.appendChild(renderer.domElement);

        scene.add(new THREE.AmbientLight(0xffffff, 0.7));
        const dir = new THREE.DirectionalLight(0xffffff, 0.8);
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

        preview.scene = scene;
        preview.camera = camera;
        preview.renderer = renderer;
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
            preview.frameId = requestAnimationFrame(animate);
            if (preview.controls && preview.controls.update) preview.controls.update();
            preview.renderer.render(preview.scene, preview.camera);
        };
        animate();
    }

    function clearModelGroup() {
        if (!preview.modelGroup) return;
        for (let i = preview.modelGroup.children.length - 1; i >= 0; i--) {
            const child = preview.modelGroup.children[i];
            preview.modelGroup.remove(child);
            child.traverse && child.traverse((node) => {
                if (node.geometry && node.geometry.dispose) node.geometry.dispose();
                if (node.material) {
                    const mats = Array.isArray(node.material) ? node.material : [node.material];
                    mats.forEach((m) => m && m.dispose && m.dispose());
                }
            });
        }
    }

    // Center the model on the ground plane and frame the camera to it.
    function placeAndFrame(object) {
        const box = new THREE.Box3().setFromObject(object);
        if (box.isEmpty()) return null;
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);

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

        // glTF is Y-up with units in meters: footprint is X by Z, height is Y.
        return {
            width: Math.max(1, +size.x.toFixed(1)),
            length: Math.max(1, +size.z.toFixed(1)),
            height: Math.max(1, +size.y.toFixed(1))
        };
    }

    async function onFileChosen(event) {
        const file = event.target && event.target.files && event.target.files[0];
        if (!file) return;
        loadedDims = null;
        loadedName = file.name;
        loadedFile = file;
        setConfirmEnabled(false);
        setStatus(t('modal.buildingUpload.loading', 'Loading model…'));

        const ok = await ensureThree();
        if (!ok) {
            setStatus(t('modal.buildingUpload.errorParse', 'Could not load the 3D engine.'), true);
            return;
        }
        initScene();

        const isText = /\.gltf$/i.test(file.name);
        const reader = new FileReader();
        reader.onerror = () => setStatus(t('modal.buildingUpload.errorParse',
            'Could not read this file as glTF/GLB.'), true);
        reader.onload = () => {
            const loader = new THREE.GLTFLoader();
            const onParsed = (gltf) => {
                clearModelGroup();
                const root = gltf.scene || (gltf.scenes && gltf.scenes[0]);
                if (!root) {
                    setStatus(t('modal.buildingUpload.errorEmpty', 'The model contains no visible geometry.'), true);
                    return;
                }
                preview.modelGroup.add(root);
                const dims = placeAndFrame(root);
                if (!dims) {
                    setStatus(t('modal.buildingUpload.errorEmpty', 'The model contains no visible geometry.'), true);
                    return;
                }
                loadedDims = dims;
                setStatus(t('modal.buildingUpload.loaded', 'Loaded: {{name}}', { name: file.name })
                    + ' — ' + t('modal.buildingUpload.dimensions',
                        'Footprint {{width}}m × {{length}}m, height {{height}}m',
                        { width: dims.width, length: dims.length, height: dims.height }));
                setConfirmEnabled(true);
            };
            const onErr = () => setStatus(t('modal.buildingUpload.errorParse',
                'Could not read this file as glTF/GLB. Make sure it is a valid, self-contained .glb or .gltf export.'), true);
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

    async function confirm() {
        if (!loadedDims || !currentContext || !loadedFile) return;
        if (typeof window.createSingleBuildingFromUpload !== 'function') {
            setStatus('Single building pipeline is unavailable.', true);
            return;
        }
        setConfirmEnabled(false);
        setStatus(t('modal.buildingUpload.uploading', 'Uploading model…'));

        // Persist the mesh so the main-map 3D view can render it. If this fails the
        // proposal is still created, just with a plain extruded box instead of the mesh.
        let modelUrl = null;
        try {
            modelUrl = await uploadModel(loadedFile);
        } catch (e) {
            console.warn('Building model upload failed; falling back to footprint box', e);
            setStatus(t('modal.buildingUpload.uploadFailed',
                'Model upload failed; the building will use a plain box.'), true);
        }

        const created = window.createSingleBuildingFromUpload({
            blockName: currentContext.blockName,
            parcels: currentContext.parcels,
            width: loadedDims.width,
            length: loadedDims.length,
            height: loadedDims.height,
            modelName: loadedName,
            modelUrl
        });
        if (!created) { setConfirmEnabled(true); return; } // single-building.js surfaces its own status
        const cb = onConfirmCb;
        close();
        if (typeof cb === 'function') cb();
    }

    function disposeScene() {
        if (preview.frameId) cancelAnimationFrame(preview.frameId);
        if (preview.resizeHandler) window.removeEventListener('resize', preview.resizeHandler);
        clearModelGroup();
        if (preview.controls && preview.controls.dispose) preview.controls.dispose();
        if (preview.renderer) {
            preview.renderer.dispose();
            if (preview.renderer.domElement && preview.renderer.domElement.parentNode) {
                preview.renderer.domElement.parentNode.removeChild(preview.renderer.domElement);
            }
        }
        preview.renderer = preview.scene = preview.camera = preview.controls = null;
        preview.modelGroup = preview.frameId = preview.resizeHandler = preview.container = null;
    }

    function close() {
        disposeScene();
        if (modalEl && modalEl.parentNode) modalEl.parentNode.removeChild(modalEl);
        modalEl = null;
        onConfirmCb = null;
        currentContext = null;
        loadedDims = null;
        loadedName = null;
        loadedFile = null;
    }

    // context: { parcels: <leaflet layers[]>, blockName: string }
    function open(context, options = {}) {
        if (modalEl) close();
        currentContext = context || {};
        onConfirmCb = typeof options.onConfirm === 'function' ? options.onConfirm : null;
        buildModal();
    }

    window.BuildingUpload = { open, close };
})();
