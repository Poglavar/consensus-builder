// Explicit ownership for Three.js resources attached to objects.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__threeResources = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const OWNED = '__cbOwnedThreeResources';
    const CACHED_RESOURCES = new WeakMap();

    function retainCachedResource(resource) {
        if (!resource || typeof resource !== 'object') return;
        CACHED_RESOURCES.set(resource, (CACHED_RESOURCES.get(resource) || 0) + 1);
    }

    function releaseCachedResource(resource) {
        if (!resource || typeof resource !== 'object') return;
        const count = CACHED_RESOURCES.get(resource) || 0;
        if (count <= 1) CACHED_RESOURCES.delete(resource);
        else CACHED_RESOURCES.set(resource, count - 1);
    }

    function retainSharedSubtreeResources(root) {
        const resources = new Set();
        const visited = new Set();
        const collectTextures = value => {
            if (!value || typeof value !== 'object' || visited.has(value)) return;
            visited.add(value);
            if (value.isTexture) { resources.add(value); return; }
            if (Array.isArray(value)) value.forEach(collectTextures);
            else Object.keys(value).forEach(key => collectTextures(value[key]));
        };
        const visit = object => {
            if (!object) return;
            if (object.geometry) resources.add(object.geometry);
            (Array.isArray(object.material) ? object.material : [object.material])
                .filter(Boolean).forEach(collectTextures);
            if (object.skeleton?.boneTexture) resources.add(object.skeleton.boneTexture);
            (object.children || []).forEach(visit);
        };
        (Array.isArray(root) ? root : [root]).forEach(visit);
        resources.forEach(retainCachedResource);
        return Array.from(resources);
    }

    function markOwned(object, kind, resource) {
        if (!object || !resource || (kind !== 'geometries' && kind !== 'materials')) return resource;
        object.userData = object.userData || {};
        const owned = object.userData[OWNED] || (object.userData[OWNED] = { geometries: [], materials: [] });
        if (!owned[kind].includes(resource)) owned[kind].push(resource);
        return resource;
    }

    function markOwnedMaterials(object, material) {
        (Array.isArray(material) ? material : [material]).forEach(value => markOwned(object, 'materials', value));
    }

    function disposeOwnedSubtree(root, options = {}) {
        if (!root) return { geometries: 0, materials: 0 };
        const geometries = new Set();
        const materials = new Set();
        const preserve = typeof options.preserve === 'function' ? options.preserve : null;
        const visit = (object, facadeOwned) => {
            if (!object) return;
            const skip = facadeOwned || !!object.userData?.cbFacadeOwned;
            if (!skip && (!preserve || !preserve(object))) {
                const owned = object.userData?.[OWNED];
                (owned?.geometries || []).forEach(resource => geometries.add(resource));
                (owned?.materials || []).forEach(resource => materials.add(resource));
            }
            (object.children || []).forEach(child => visit(child, skip));
        };
        (Array.isArray(root) ? root : [root]).forEach(object => visit(object, false));
        geometries.forEach(resource => { try { resource.dispose?.(); } catch (_) { } });
        materials.forEach(resource => { try { resource.dispose?.(); } catch (_) { } });
        return { geometries: geometries.size, materials: materials.size };
    }

    function disposeSharedSubtree(root) {
        const geometries = new Set();
        const materials = new Set();
        const textures = new Set();
        const sceneObjects = new Set();
        const objects = new Set();
        const collectTextures = value => {
            if (!value || typeof value !== 'object' || objects.has(value)) return;
            objects.add(value);
            if (value.isTexture) {
                textures.add(value);
                return;
            }
            if (Array.isArray(value)) value.forEach(collectTextures);
            else Object.keys(value).forEach(key => collectTextures(value[key]));
        };
        const visit = object => {
            if (!object || sceneObjects.has(object)) return;
            sceneObjects.add(object);
            if (object.geometry && !CACHED_RESOURCES.has(object.geometry)) geometries.add(object.geometry);
            if (object.isInstancedMesh && typeof object.dispose === 'function') {
                try { object.dispose(); } catch (_) { }
            }
            const entries = Array.isArray(object.material) ? object.material : [object.material];
            entries.filter(Boolean).forEach(material => {
                if (!CACHED_RESOURCES.has(material)) materials.add(material);
                collectTextures(material);
            });
            if (object.skeleton?.boneTexture) textures.add(object.skeleton.boneTexture);
            (object.children || []).forEach(visit);
        };
        (Array.isArray(root) ? root : [root]).forEach(visit);
        geometries.forEach(resource => { if (!CACHED_RESOURCES.has(resource)) { try { resource.dispose?.(); } catch (_) { } } });
        materials.forEach(resource => { if (!CACHED_RESOURCES.has(resource)) { try { resource.dispose?.(); } catch (_) { } } });
        textures.forEach(resource => { if (!CACHED_RESOURCES.has(resource)) { try { resource.dispose?.(); } catch (_) { } } });
        return { geometries: geometries.size, materials: materials.size, textures: textures.size };
    }

    function createSceneCache(disposeScene) {
        if (typeof disposeScene !== 'function') throw new TypeError('A scene disposer is required.');
        const entries = new Map();
        let generation = 0;
        const release = entry => {
            if (!entry || entry.disposed || !entry.hasValue || !entry.value) return;
            entry.disposed = true;
            (entry.cacheResources || []).forEach(releaseCachedResource);
            entry.cacheResources = [];
            try { disposeScene(entry.value); } catch (_) { }
        };
        return {
            load(key, loader) {
                if (entries.has(key)) return entries.get(key).promise;
                const token = generation;
                const entry = { hasValue: false, value: null, disposed: false, evicted: false, promise: null };
                entry.promise = Promise.resolve().then(loader).then(value => {
                    entry.value = value;
                    entry.hasValue = true;
                    entry.cacheResources = retainSharedSubtreeResources(value);
                    if (entry.evicted || token !== generation) {
                        release(entry);
                        return null;
                    }
                    return value;
                }, error => {
                    if (entries.get(key) === entry) entries.delete(key);
                    throw error;
                });
                entries.set(key, entry);
                return entry.promise;
            },
            clear() {
                generation++;
                const oldEntries = Array.from(entries.values());
                entries.clear();
                oldEntries.forEach(entry => {
                    entry.evicted = true;
                    release(entry);
                });
            },
            get size() { return entries.size; }
        };
    }

    function measureSceneBytes(root) {
        const geometries = new Set();
        const textures = new Set();
        const visited = new Set();
        const collectTextures = value => {
            if (!value || typeof value !== 'object' || visited.has(value)) return;
            visited.add(value);
            if (value.isTexture) { textures.add(value); return; }
            if (Array.isArray(value)) value.forEach(collectTextures);
            else Object.keys(value).forEach(key => collectTextures(value[key]));
        };
        const visit = object => {
            if (!object) return;
            if (object.geometry) geometries.add(object.geometry);
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            materials.filter(Boolean).forEach(collectTextures);
            if (object.skeleton?.boneTexture) textures.add(object.skeleton.boneTexture);
            (object.children || []).forEach(visit);
        };
        (Array.isArray(root) ? root : [root]).forEach(visit);
        let geometryBytes = 0;
        geometries.forEach(geometry => {
            const attributes = Object.values(geometry.attributes || {});
            if (geometry.index) attributes.push(geometry.index);
            attributes.forEach(attribute => { geometryBytes += attribute.array?.byteLength || 0; });
        });
        let textureBytes = 0;
        textures.forEach(texture => {
            const image = texture.image || texture.source?.data;
            const data = image?.data;
            textureBytes += data?.byteLength || (Number(image?.width) * Number(image?.height) * 4 || 0);
        });
        return { geometries: geometryBytes, textures: textureBytes, total: geometryBytes + textureBytes };
    }

    function stableSerialize(value) {
        const normalize = item => {
            if (Array.isArray(item)) return item.map(normalize);
            if (!item || typeof item !== 'object') return item;
            const result = {};
            Object.keys(item).sort().forEach(key => { result[key] = normalize(item[key]); });
            return result;
        };
        return JSON.stringify(normalize(value));
    }

    function geometryByteLength(geometry) {
        let bytes = 0;
        const attributes = Object.values(geometry?.attributes || {});
        if (geometry?.index) attributes.push(geometry.index);
        attributes.forEach(attribute => { bytes += attribute.array?.byteLength || 0; });
        return bytes;
    }

    function createTrackedSet(source) {
        const values = source instanceof Set ? source : new Set();
        let capture = null;
        const tracked = {
            has(value) { return values.has(value); },
            add(value) {
                if (!values.has(value)) {
                    values.add(value);
                    if (capture) capture.push(value);
                }
                return tracked;
            },
            clear() { values.clear(); },
            get size() { return values.size; },
            [Symbol.iterator]() { return values[Symbol.iterator](); },
            startCapture() { capture = []; },
            finishCapture() { const result = capture || []; capture = null; return result; },
            replay(items) {
                const previous = capture;
                capture = null;
                items.forEach(value => tracked.add(value));
                capture = previous;
            }
        };
        return tracked;
    }

    function createBuildingGeometryCache(options = {}) {
        const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes >= 0
            ? options.maxBytes : 64 * 1024 * 1024;
        const disposeGeometry = typeof options.disposeGeometry === 'function'
            ? options.disposeGeometry
            : geometry => geometry?.dispose?.();
        const arrayIds = new WeakMap();
        let nextArrayId = 1;
        let passKey = null;
        let entries = [];
        let bytes = 0;

        const arrayId = value => {
            if (!value || typeof value !== 'object') return 0;
            if (!arrayIds.has(value)) arrayIds.set(value, nextArrayId++);
            return arrayIds.get(value);
        };
        const keyFor = pass => JSON.stringify([
            arrayId(pass.buildings),
            pass.buildings?.length || 0,
            stableSerialize(pass.carveRecords || []),
            stableSerialize(pass.structureRegions || []),
            stableSerialize({
                showSurviving: pass.visibility?.showSurviving !== false,
                showDemolished: pass.visibility?.showDemolished !== false
            }),
            pass.xrayEnabled === true,
            pass.suggestedPlansEnabled === true,
            pass.suggestedExistingEnabled === true,
            stableSerialize(pass.origin || null)
        ]);
        const release = () => {
            const disposed = new Set();
            entries.forEach(entry => {
                if (entry?.geometry && !disposed.has(entry.geometry)) {
                    disposed.add(entry.geometry);
                    releaseCachedResource(entry.geometry);
                    try { disposeGeometry(entry.geometry); } catch (_) { }
                }
            });
            entries = [];
            bytes = 0;
        };
        const ensureTrackedSet = (state, key) => {
            const value = state[key];
            if (!value || typeof value.has !== 'function' || typeof value.add !== 'function') {
                state[key] = createTrackedSet();
            } else if (typeof value.startCapture !== 'function') {
                state[key] = createTrackedSet(value);
            }
            return state[key];
        };

        return {
            beginPass(pass) {
                const nextKey = keyFor(pass || {});
                if (nextKey !== passKey) {
                    release();
                    passKey = nextKey;
                }
                const state = {
                    seenFaceKeys: createTrackedSet(),
                    seenTriangleKeys: createTrackedSet(),
                    geometryCacheSession: null
                };
                let nextEntry = 0;
                const session = {
                    beginEntry(dedupeState) {
                        const index = nextEntry++;
                        const faceKeys = ensureTrackedSet(dedupeState, 'seenFaceKeys');
                        const triangleKeys = ensureTrackedSet(dedupeState, 'seenTriangleKeys');
                        const cached = entries[index];
                        if (cached?.cacheable) {
                            faceKeys.replay(cached.faceDelta);
                            triangleKeys.replay(cached.triangleDelta);
                            return { hit: true, geometry: cached.geometry, finish() { return true; } };
                        }
                        faceKeys.startCapture();
                        triangleKeys.startCapture();
                        let finished = false;
                        return {
                            hit: false,
                            geometry: null,
                            finish(geometry) {
                                if (finished) return false;
                                finished = true;
                                const faceDelta = faceKeys.finishCapture();
                                const triangleDelta = triangleKeys.finishCapture();
                                // Another same-key scene pass may have completed this slot while
                                // this caller was building. Keep its retained entry and let this
                                // caller own its fresh geometry instead of orphaning the cache's.
                                if (entries[index]?.cacheable) return false;
                                const geometryBytes = geometryByteLength(geometry);
                                const deltaBytes = [...faceDelta, ...triangleDelta]
                                    .reduce((sum, key) => sum + String(key).length * 2, 0);
                                const entryBytes = geometryBytes + deltaBytes;
                                const cacheable = bytes + entryBytes <= maxBytes;
                                entries[index] = {
                                    cacheable,
                                    geometry: cacheable ? geometry : null,
                                    faceDelta,
                                    triangleDelta,
                                    bytes: entryBytes
                                };
                                if (cacheable) {
                                    if (geometry) retainCachedResource(geometry);
                                    bytes += entryBytes;
                                }
                                return cacheable;
                            }
                        };
                    }
                };
                state.geometryCacheSession = session;
                return state;
            },
            clear() {
                release();
                passKey = null;
            },
            get bytes() { return bytes; },
            get entryCount() { return entries.length; },
            get maxBytes() { return maxBytes; }
        };
    }

    return {
        markOwned,
        markOwnedMaterials,
        disposeOwnedSubtree,
        disposeSharedSubtree,
        createSceneCache,
        measureSceneBytes,
        createBuildingGeometryCache
    };
});
