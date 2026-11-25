// Device-only 3D models: an imported model kept in this browser's IndexedDB and referenced from a
// design as `device-model:sha256-<hex>` instead of a public /uploads/models URL. Only this browser
// can draw it. Publishing asks once whether to upload such models publicly or to publish without
// them (others then see the plain block). UMD: window.DeviceModels; the reference helpers are
// require()-able in node.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.DeviceModels = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';

    const PREFIX = 'device-model:';
    const STORE = 'models';

    function t(key, fallback) {
        const translated = root?.i18n?.t?.(key);
        return translated && translated !== key ? translated : fallback;
    }

    const isDeviceModel = value => typeof value === 'string' && value.startsWith(PREFIX);

    // Every device-model reference in a value (records, design content, lists of them), once each.
    function deviceModelRefs(value) {
        const found = new Set();
        const visit = item => {
            if (isDeviceModel(item)) found.add(item);
            else if (Array.isArray(item)) item.forEach(visit);
            else if (item && typeof item === 'object') Object.values(item).forEach(visit);
        };
        visit(value);
        return [...found];
    }

    // Replaces, in place, each device-model reference that replacements (Map ref → url) names.
    function replaceDeviceModels(value, replacements) {
        if (Array.isArray(value)) {
            value.forEach((item, index) => {
                if (isDeviceModel(item) && replacements.has(item)) value[index] = replacements.get(item);
                else replaceDeviceModels(item, replacements);
            });
        } else if (value && typeof value === 'object') {
            for (const [key, item] of Object.entries(value)) {
                if (isDeviceModel(item) && replacements.has(item)) value[key] = replacements.get(item);
                else replaceDeviceModels(item, replacements);
            }
        }
        return value;
    }

    // ---- Storage: one IndexedDB database per saved workspace (persistent-storage.js names), so
    // wiping local data removes the models too. The name has '::' after the prefix, so the workspace
    // never mistakes it for a legacy city database.
    let opening = null;
    async function open() {
        if (!opening) {
            opening = (async () => {
                const workspace = root.BrowserWorkspace;
                if (workspace?.ready) await workspace.ready;
                const name = workspace?.databaseName ? workspace.databaseName('__device-models') : 'consensus-builder-storage::device::models';
                return new Promise((resolve, reject) => {
                    const request = root.indexedDB.open(name, 1);
                    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'ref' });
                    request.onsuccess = () => {
                        const db = request.result;
                        db.onversionchange = () => { db.close(); opening = null; };
                        resolve(db);
                    };
                    request.onerror = () => reject(request.error);
                    request.onblocked = () => reject(Object.assign(new Error('Model storage is blocked by another tab.'), { code: 'indexeddb-open-blocked' }));
                });
            })().catch(error => { opening = null; throw error; });
        }
        return opening;
    }

    async function transact(mode, run) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE, mode);
            const request = run(transaction.objectStore(STORE));
            transaction.oncomplete = () => resolve(request.result);
            transaction.onerror = transaction.onabort = () => reject(transaction.error);
        });
    }

    // Keeps a model file on this device → its reference. The same bytes keep one copy.
    async function save(file) {
        const bytes = await file.arrayBuffer();
        const digest = new Uint8Array(await root.crypto.subtle.digest('SHA-256', bytes));
        const ref = `${PREFIX}sha256-${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`;
        await transact('readwrite', store => store.put({ ref, blob: new Blob([bytes], { type: 'model/gltf-binary' }),
            name: String(file.name || 'model.glb').slice(0, 255), bytes: bytes.byteLength, savedAt: new Date().toISOString() }));
        // Ask the browser not to evict the site's storage under pressure (it may decline).
        root.navigator?.storage?.persist?.().catch(() => {});
        return ref;
    }

    // { ref, blob, name, bytes, savedAt } for a reference, or null when this device does not hold it.
    async function load(ref) {
        return isDeviceModel(ref) ? (await transact('readonly', store => store.get(ref))) || null : null;
    }

    // A blob: URL for drawing a device model, or null when this device does not hold it.
    const objectUrls = new Map();
    function objectUrl(ref) {
        if (!objectUrls.has(ref)) {
            objectUrls.set(ref, load(ref).then(row => (row ? root.URL.createObjectURL(row.blob) : null),
                error => { objectUrls.delete(ref); throw error; }));
        }
        return objectUrls.get(ref);
    }

    // ---- Publishing ----
    // References the person chose to publish without, for the rest of this page's life: the plan or
    // agreement that publishes several designs asks once.
    const keptOnDevice = new Set();

    // Before records are published: asks once whether to upload their device-only models publicly or
    // publish without them. Resolves a Map ref → public URL of the uploaded ones (empty when kept or
    // when there are none); rejects with code 'cancelled' (cancelled: true) when the person cancels.
    async function chooseForPublish(records) {
        const refs = deviceModelRefs(records).filter(ref => !keptOnDevice.has(ref));
        if (!refs.length) return new Map();
        const choice = await root.CbDialog.choice(t('deviceModels.publishMessage',
            'Imported 3D models in what you are publishing are kept only on this device. Upload them so others see them, or publish without them and others see a plain block. An uploaded model is public: anyone with a link to the design can download it.'), [
            { value: 'upload', label: t('deviceModels.upload', 'Upload the models and publish') },
            { value: 'keep', label: t('deviceModels.keep', 'Publish without the models') },
            { value: 'cancel', label: t('deviceModels.cancel', 'Cancel'), primary: true }
        ], { title: t('deviceModels.publishTitle', 'Models on this device only') });
        if (choice === 'keep') {
            refs.forEach(ref => keptOnDevice.add(ref));
            return new Map();
        }
        if (choice !== 'upload') throw Object.assign(new Error(t('deviceModels.cancelled', 'Nothing was published.')), { code: 'cancelled', cancelled: true });
        await root.ensureOptionalTool('modelUpload');
        const uploaded = new Map();
        for (const ref of refs) {
            const row = await load(ref);
            if (!row) throw Object.assign(new Error(t('deviceModels.missing', 'A model is no longer stored on this device. Import it again, or publish without it.')), { code: 'device-model-missing' });
            try {
                uploaded.set(ref, await root.ModelUpload.uploadModel(new File([row.blob], row.name, { type: 'model/gltf-binary' })));
            } catch (error) {
                throw Object.assign(new Error(t('deviceModels.uploadFailed', 'A model could not be uploaded, so nothing was published. Try again, or publish without the models.')),
                    { code: 'device-model-upload-failed', status: error?.status, cause: error });
            }
        }
        return uploaded;
    }

    return { PREFIX, isDeviceModel, deviceModelRefs, replaceDeviceModels, save, load, objectUrl, chooseForPublish };
});
