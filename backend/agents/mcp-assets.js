// Import through the app's own authoring modules; render private content without image publication.
import { createRequire } from 'node:module';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { appTurf as turf, corridorRuntime } from './mcp-geometry.js';
import { cidOfObject, designObject } from './agreement-objects.js';
import { previewArtifact } from './mcp-preview.js';
import { parcelSourceIdOf } from './mcp-read-tools.js';
import { createMcpNamedPlanTools } from './mcp-named-plans.js';
import { createPublicSourceFetch, validatePublicSourceUrl } from '../parcels/public-source-fetch.js';
import { renderMapPreview, PREVIEW_WIDTH, PREVIEW_HEIGHT } from '../thumbnails/map-preview.js';
import { renderProposalThumbnailSet } from '../thumbnails/tile-stitch.js';
const require = createRequire(import.meta.url);
const imports = require('../../frontend/js/corridor-import.js');
const modelGeometry = require('../../frontend/js/building-model-geometry.js');
const singleGeometry = require('../../frontend/js/single-building-geometry.js');
const MAX_BYTES = 10 * 1024 * 1024;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const SPACE_KINDS = ['park', 'square', 'lake'];

// GLTFLoader is the exact app version. CPU footprint extraction skips texture decoding only.
async function parseModelBytes(bytes, args) {
    let json;
    try {
        if (bytes.toString('ascii', 0, 4) === 'glTF') {
            if (bytes.length < 20 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length
                || bytes.readUInt32LE(16) !== 0x4e4f534a || bytes.readUInt32LE(12) > bytes.length - 20) throw new Error();
            json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8'));
        } else json = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    } catch { fail('model-data-invalid', 'Use a valid glTF 2.0 GLB or self-contained glTF model.'); }
    if (json?.asset?.version !== '2.0') fail('model-data-invalid', 'Only glTF 2.0 models are supported.');
    const check = value => {
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) {
            if (key === 'uri' && (typeof child !== 'string' || !/^data:[^,]*;base64,[A-Za-z0-9+/]*={0,2}$/.test(child)))
                fail('model-external-resource', 'The model must embed every buffer and texture; external resources are not fetched.');
            check(child);
        }
    };
    check(json);
    if ((json.nodes?.length || 0) > 10_000 || (json.meshes?.length || 0) > 1000 || (json.accessors?.length || 0) > 4096
        || (json.accessors || []).some(accessor => !Number.isSafeInteger(accessor.count) || accessor.count < 0 || accessor.count > modelGeometry.MAX_FOOTPRINT_TRIANGLES * 3)
        || (json.buffers || []).some(buffer => !Number.isSafeInteger(buffer.byteLength) || buffer.byteLength < 0 || buffer.byteLength > MAX_BYTES))
        fail('model-complexity-limit', 'The model exceeds the supported CPU mesh or buffer limits. Export one simpler building.');
    const center = Array.isArray(args.center) ? { lng: args.center[0], lat: args.center[1] } : args.anchor;
    if (!center || !Number.isFinite(center.lng) || !Number.isFinite(center.lat) || Math.abs(center.lng) > 180 || Math.abs(center.lat) > 85)
        fail('model-center-required', 'Supply a WGS84 center [longitude, latitude] or anchor {lng,lat}.');
    const loader = new GLTFLoader();
    loader.register(parser => {
        // Decode embedded buffers directly, avoiding browser-only progress events and all network IO.
        parser.fileLoader.load = (uri, onLoad, _progress, onError) => {
            try {
                if (!/^data:[^,]*;base64,/.test(uri)) fail('model-external-resource', 'External model buffers are not fetched.');
                const value = Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64');
                onLoad(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
            } catch (error) { onError(error); }
        };
        return { name: 'UGT_CPU_FOOTPRINT', loadTexture: () => Promise.resolve(null) };
    });
    let parsed;
    try { parsed = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), ''); }
    catch { fail('model-parse-failed', 'The shared glTF parser could not load this model. Compressed meshes need an uncompressed export.'); }
    try {
        const box = new THREE.Box3().setFromObject(parsed.scene);
        const dimensions = modelGeometry.dimensionsFromBounds(box);
        if (box.isEmpty() || !dimensions) fail('model-geometry-unavailable', 'The model contains no measurable mesh.');
        const triangles = modelGeometry.modelTriangles(parsed.scene, box.getCenter(new THREE.Vector3()), THREE);
        const footprint = modelGeometry.projectedFootprint(triangles, turf.union).geometry;
        const placed = singleGeometry.placeModelFootprint(footprint, center, args.rotation ?? 0);
        if (!placed) fail('model-placement-invalid', 'The model footprint could not be placed.');
        return { footprint: placed.geometry, ...dimensions };
    } finally {
        parsed.scene.traverse(node => { node.geometry?.dispose(); const materials = Array.isArray(node.material) ? node.material : [node.material]; for (const material of materials) material?.dispose(); });
    }
}

export function createMcpAssetTools({ read, drafts, appOrigin, resolveDraftReference, plans, apiBase,
    fetchImpl = fetch, publicFetch = createPublicSourceFetch({ maxBytes: MAX_BYTES }), render2d, render3d, tileUrl, parseModel = parseModelBytes } = {}) {
    plans ||= createMcpNamedPlanTools({ read, drafts, appOrigin, resolveDraftReference });
    async function dataOf({ data, url }) {
        if ((data != null) === Boolean(url)) fail('import-input-required', 'Supply exactly one of data or a public HTTPS URL.');
        if (url) {
            validatePublicSourceUrl(url);
            const response = await publicFetch(url, { redirect: 'error' });
            if (!response.ok) fail('import-source-unavailable', `Import source returned HTTP ${response.status}.`);
            const bytes = Buffer.from(await response.arrayBuffer());
            if (bytes.length > MAX_BYTES) fail('import-too-large', 'Import exceeds 10 MiB.');
            return bytes;
        }
        const bytes = Buffer.isBuffer(data) ? data : data instanceof Uint8Array ? Buffer.from(data)
            : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
        if (bytes.length > MAX_BYTES) fail('import-too-large', 'Import exceeds 10 MiB.');
        return bytes;
    }
    async function privateResult(content, source) {
        const checked = designObject({ ...content, createdAt: content.authoredAt });
        const binding = await read.request('/designs/binding', {}, {
            site: read.siteOfDesign(checked.content), city: checked.content.city, toleranceM: checked.content.toleranceM, parcelSourceId: source
        });
        if (binding.binding?.coverage === 'unknown' || binding.binding?.unknownM2 > 0) fail('ground-unavailable', 'The imported design ground binding is unknown.');
        const parcelSourceId = parcelSourceIdOf(binding) || source;
        return { design: checked.content, cid: checked.cid, parcelSourceId, binding: binding.binding,
            publication: 'private', ...await previewArtifact({ design: checked.content, parcelSourceId }) };
    }
    async function importDesign(args) {
        const bytes = await dataOf(args), text = bytes.toString('utf8'), format = args.format;
        const createdAt = args.authoredAt || new Date().toISOString();
        if (args.kind === 'space' && !SPACE_KINDS.includes(args.spaceKind)) fail('space-kind-required', 'A space import needs spaceKind park, square or lake.');
        const designs = []; let warnings = [], placement = 'georeference';
        // Road files, and GeoJSON centrelines, go through the site's own corridor import: the format's
        // parser makes the OSM form and recordsFromImport makes one record per road.
        async function corridorDesigns(parsed, source) {
            const records = imports.recordsFromImport(parsed, { author: args.author, description: args.description, createdAt, source, fallbackTitle: args.title || 'Imported road' });
            if (!records.length) fail('import-empty', 'The file contains no road supported by the app importer.');
            for (const record of records) {
                const definition = record.roadProposal.definition;
                const material = corridorRuntime.footprint.materialize(definition);
                record.site = material.polygon;
                record.city = args.city;
                record.toleranceM = args.toleranceM;
                record.roadProposal.definition = corridorRuntime.osm.toRecord(definition);
                const content = designObject(record).content;
                designs.push(await privateResult(content, args.parcelSourceId));
            }
        }
        if (['osm', 'opendrive'].includes(format)) {
            const parsed = imports.FORMATS.find(entry => entry.id === format).parse(text, { anchor: args.anchor });
            await corridorDesigns(parsed, format);
            warnings = parsed.warnings || []; placement = parsed.placement;
        } else if (format === 'geojson') {
            let input;
            try { input = JSON.parse(text); } catch { fail('import-invalid-json', 'GeoJSON must be valid JSON.'); }
            const features = input.type === 'FeatureCollection' ? input.features : [input.type === 'Feature' ? input : { type: 'Feature', geometry: input, properties: {} }];
            if (!Array.isArray(features) || !features.length || features.length > 100) fail('import-feature-limit', 'Import between 1 and 100 GeoJSON features.');
            // GeoJSON polygons are inputs to the existing intent builders, not a second construction
            // engine; its centrelines are read by the site's GeoJSON road parser after them.
            const lines = [];
            for (const feature of features) {
                const geometry = feature?.geometry, properties = feature?.properties || {};
                const common = { ...args, authoredAt: createdAt, title: args.title || properties.name, description: args.description };
                if (['LineString', 'MultiLineString'].includes(geometry?.type)) lines.push(feature);
                else if (['Polygon', 'MultiPolygon'].includes(geometry?.type)) {
                    if (args.kind === 'space') designs.push(await drafts.draftSpace({ ...common, outline: geometry }));
                    else designs.push(await drafts.draftBuilding({ ...common, outline: geometry, footprint: geometry,
                        height: args.height ?? properties.height, floors: args.floors ?? properties.floors }));
                } else fail('import-geometry-unsupported', 'GeoJSON import accepts LineString, MultiLineString, Polygon or MultiPolygon features.');
            }
            if (lines.length) {
                const parsed = imports.parseGeoJson(JSON.stringify({ type: 'FeatureCollection', features: lines }));
                await corridorDesigns(parsed, format);
                warnings = parsed.warnings || [];
            }
        } else fail('import-format-unsupported', 'Use geojson, osm or opendrive.');
        return { designs, publication: 'private', warnings, import: { format, placement, count: designs.length, parser: format === 'geojson' ? 'app-intent-builders+app-corridor-import' : 'app-corridor-import' } };
    }
    async function importModel(args) {
        const kind = args.kind ?? 'building';
        if (kind !== 'building' && !SPACE_KINDS.includes(kind)) fail('model-kind-invalid', 'A model is attached to a building, park, square or lake.');
        if (args.confirmAssetUpload !== true) fail('model-upload-confirmation-required', 'Set confirmAssetUpload only after the user agrees to upload a durable, publicly served model asset. The resulting design remains private.');
        if (args.modelData != null && (args.data != null || args.url)) fail('import-input-required', 'Supply exactly one of modelData, data or a public HTTPS URL.');
        if (typeof args.modelData === 'string' && args.modelData.length > 14_000_000) fail('model-size-invalid', 'The model data URL exceeds the upload size limit.');
        if (!parseModel) fail('model-parser-unavailable', 'The shared model parser is unavailable in this runtime.');
        const bytes = args.modelData ? (() => {
            const match = /^data:[^;,]*;base64,([A-Za-z0-9+/]+={0,2})$/.exec(args.modelData);
            if (!match) fail('model-data-invalid', 'modelData must be a base64 data URL.');
            return Buffer.from(match[1], 'base64');
        })() : await dataOf(args);
        if (!bytes.length || bytes.length > MAX_BYTES) fail('model-size-invalid', 'A model must contain 1 byte to 10 MiB.');
        const parsed = await parseModel(bytes, args);
        const { footprint, height } = parsed;
        if (!footprint || !Number.isFinite(height) || height <= 0) fail('model-geometry-unavailable', 'The model has no measurable building footprint and height.');
        const authoredAt = args.authoredAt || new Date().toISOString();
        // A park, square or lake takes the same placed footprint as its structure polygon; the model is
        // drawn stretched onto that polygon's bounds in its rotation frame at the model's own height.
        const result = kind === 'building' ? await drafts.draftBuilding({ ...args, outline: footprint, footprint, height, authoredAt })
            : await drafts.draftSpace({ ...args, spaceKind: kind, outline: footprint, authoredAt });
        const uploaded = await read.request('/models', {}, { fileName: args.fileName || 'model.glb', modelData: `data:model/gltf-binary;base64,${bytes.toString('base64')}` });
        if (typeof uploaded.modelUrl !== 'string' || !uploaded.modelUrl) fail('model-upload-invalid-response', 'The model endpoint returned no served asset URL.');
        const url = new URL(uploaded.modelUrl, apiBase || appOrigin);
        if (url.origin !== new URL(apiBase || appOrigin).origin) fail('model-upload-invalid-response', 'The model endpoint returned an asset outside the configured API origin.');
        const content = structuredClone(result.design);
        const model = { source: 'upload', modelUrl: url.href, modelName: args.fileName || 'Imported model', rotation: args.rotation ?? 0 };
        if (kind === 'building') for (const building of content.geometry.buildings) Object.assign(building.properties, model);
        else {
            // Same as the site's upload: a park or square starts with an explicit empty furniture design so no
            // generated layout is laid over the model (frontend/js/proposals/apply/structures.js). Lakes have none.
            const empty = kind === 'park' ? { trees: [], flowerbeds: [], ponds: [], paths: [], benches: [], version: 3 }
                : (kind === 'square' ? { fountains: [], trees: [], benches: [], stalls: [], statues: [], version: 2 } : null);
            Object.assign(content.structureProposal, { ...model, modelName: model.modelName.slice(0, 120) }, empty ? { decorationDesign: empty } : {});
        }
        return { ...result, design: content, cid: cidOfObject(content), publication: 'private',
            ...await previewArtifact({ design: content, parcelSourceId: result.parcelSourceId }), asset: { modelUrl: url.href, public: true, durable: true, footprint: 'projected-model-triangles', kind } };
    }
    async function renderDefault(rows) {
        let rendered;
        const tileSource = { async getTileBytes({ url, timeoutMs }) {
            const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
            if (!response.ok) fail('preview-basemap-unavailable', 'The preview basemap could not be loaded.');
            return Buffer.from(await response.arrayBuffer());
        } };
        const buffer = await renderMapPreview(rows, { render: async options => {
            rendered = await renderProposalThumbnailSet({ ...options, tileSource, ...(tileUrl ? { tileUrl } : {}) }); return rendered;
        } });
        return { buffer, width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT, tiles: rendered.tiles };
    }
    async function renderPreview({ design, plan, view = '2d' }) {
        if (Boolean(design) === Boolean(plan)) fail('preview-subject-required', 'Supply exactly one design or named plan.');
        if (!['2d', '3d'].includes(view)) fail('preview-view-invalid', 'Choose 2d or 3d.');
        if (view === '3d' && !render3d) fail('preview-3d-unavailable', 'This runtime has no ready 3D renderer. Use 2d or open the exact draft preview in the app.');
        const rows = plan ? (await plans.getPlan({ plan })).designs : [{ content: await drafts.resolveDesign(design) }];
        const cids = rows.map(row => cidOfObject(row.content));
        const rendered = await (view === '3d' ? render3d : render2d || renderDefault)(rows);
        if (!Buffer.isBuffer(rendered.buffer) || !rendered.buffer.length || (view === '3d' && rendered.ready !== true)
            || (rendered.tiles && (!rendered.tiles.loaded || rendered.tiles.loaded !== rendered.tiles.total))) fail('preview-not-ready', 'The preview renderer did not finish the complete scene. Retry after its sources are available.');
        return { image: { type: 'image', mimeType: 'image/png', data: rendered.buffer.toString('base64') },
            ready: true, publication: 'private', provenance: { renderer: view === '2d' ? 'app-map-preview-2d' : 'app-scene-3d', designCids: cids, persisted: false },
            metrics: { width: rendered.width, height: rendered.height, designCount: rows.length, tiles: rendered.tiles || null, ...(rendered.metrics || {}) } };
    }
    return { importDesign, importModel, renderPreview };
}
