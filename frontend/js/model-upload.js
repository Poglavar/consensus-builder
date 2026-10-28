// Shared glTF upload helpers: read a .glb/.gltf File with THREE.GLTFLoader, summarize what it costs to
// draw (triangles, texture sizes, bytes) and POST its bytes to the backend's /models endpoint.
// UMD: window.ModelUpload in the browser (loaded on demand by optional-tools-loader.js), require()-able in node.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ModelUpload = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
    'use strict';

    // Material slots whose images are uploaded to the GPU with the model.
    const TEXTURE_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap',
        'alphaMap', 'bumpMap', 'displacementMap', 'lightMap', 'specularMap'];

    function meshTriangles(geometry) {
        if (!geometry) return 0;
        const count = geometry.index ? geometry.index.count : geometry.attributes?.position?.count;
        return Number.isFinite(count) ? Math.floor(count / 3) : 0;
    }

    // { triangles, textures: [{ width, height }], bytes } for a parsed scene (any object tree with
    // children, isMesh, geometry and material(s)); the input FurnitureModels.validateModelSummary takes.
    function modelSummary(scene, bytes) {
        let triangles = 0;
        const textures = [];
        const seen = new Set();
        const visit = node => {
            if (!node) return;
            if (node.isMesh) {
                triangles += meshTriangles(node.geometry);
                const materials = Array.isArray(node.material) ? node.material : [node.material];
                materials.forEach(material => TEXTURE_SLOTS.forEach(slot => {
                    const image = material?.[slot]?.image;
                    if (!image || seen.has(image)) return;
                    seen.add(image);
                    textures.push({ width: Number(image.width || image.naturalWidth) || 0, height: Number(image.height || image.naturalHeight) || 0 });
                }));
            }
            (node.children || []).forEach(visit);
        };
        visit(scene);
        return { triangles, textures, bytes: Number(bytes) || 0 };
    }

    function disposeScene(scene) {
        const visit = node => {
            if (!node) return;
            node.geometry?.dispose?.();
            (Array.isArray(node.material) ? node.material : [node.material]).forEach(material => {
                if (!material) return;
                TEXTURE_SLOTS.forEach(slot => material[slot]?.dispose?.());
                material.dispose?.();
            });
            (node.children || []).forEach(visit);
        };
        visit(scene);
    }

    // THREE (with GLTFLoader) comes from index.html's ESM bootstrap; wait for it rather than loading
    // a second copy. Rejects with code 'engine' when the parser is unavailable.
    async function ensureLoader() {
        if (typeof root.THREE === 'undefined' && typeof root.whenThreeReady === 'function') await root.whenThreeReady();
        if (typeof root.THREE?.GLTFLoader !== 'function') throw Object.assign(new Error('GLTFLoader unavailable'), { code: 'engine' });
        return root.THREE.GLTFLoader;
    }

    function readFile(file, asText) {
        return new Promise((resolve, reject) => {
            const reader = new root.FileReader();
            reader.onerror = () => reject(reader.error || new Error('read failed'));
            reader.onload = () => resolve(reader.result);
            if (asText) reader.readAsText(file);
            else reader.readAsArrayBuffer(file);
        });
    }

    // Parses a File into its glTF scene. Rejects with code 'parse' when the file is not a valid,
    // self-contained glTF/GLB.
    async function parseModelFile(file) {
        const Loader = await ensureLoader();
        const data = await readFile(file, /\.gltf$/i.test(file?.name || ''));
        return new Promise((resolve, reject) => {
            const fail = error => reject(Object.assign(new Error('Could not parse model'), { code: 'parse', cause: error }));
            try {
                new Loader().parse(data, '', gltf => {
                    const scene = gltf?.scene || gltf?.scenes?.[0] || null;
                    if (scene) resolve(scene);
                    else fail(new Error('no scene'));
                }, fail);
            } catch (error) { fail(error); }
        });
    }

    function fileToDataUrl(file) {
        return new Promise((resolve, reject) => {
            const reader = new root.FileReader();
            reader.onerror = () => reject(reader.error || new Error('read failed'));
            reader.onload = () => resolve(reader.result);
            reader.readAsDataURL(file);
        });
    }

    // Uploads the raw model bytes to the backend; returns the served modelUrl.
    async function uploadModel(file) {
        const base = (typeof root.getBackendBase === 'function')
            ? root.getBackendBase() : 'http://localhost:3000';
        const dataUrl = await fileToDataUrl(file);
        const resp = await root.fetch(base.replace(/\/$/, '') + '/models', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ modelData: dataUrl, fileName: file.name })
        });
        if (!resp.ok) {
            const error = new Error('models endpoint returned ' + resp.status);
            error.status = resp.status;
            throw error;
        }
        const json = await resp.json();
        if (!json || !json.modelUrl) throw new Error('models endpoint returned no modelUrl');
        return json.modelUrl;
    }

    return { modelSummary, parseModelFile, disposeScene, uploadModel };
});
