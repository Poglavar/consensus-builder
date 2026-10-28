// Granular edits of the same authored JSON the site persists. No mutation reaches publication.
import { createRequire } from 'node:module';
import { appTurf as turf, intentEditing } from './mcp-geometry.js';
import { cidOfObject, designObject } from './agreement-objects.js';
import { validateTrackDesign } from './mcp-constructors.js';
const require = createRequire(import.meta.url);
const layoutValidation = require('../../frontend/js/parcel-layout-validation.js');
const goals = require('../../frontend/js/proposals/design-goals.js');
const FurnitureModels = require('../../frontend/js/furniture-models.js');
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const protectedFields = new Set(['schema', 'origin', 'authoredAt']);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const equal = (a, b) => {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
};

function tokens(path) {
    if (typeof path !== 'string' || (path && !path.startsWith('/')) || /~(?![01])/u.test(path)) fail('invalid-pointer', 'Use an RFC 6901 JSON Pointer.');
    const keys = path ? path.slice(1).split('/').map(key => key.replace(/~1/g, '/').replace(/~0/g, '~')) : [];
    if (keys.length > 80 || keys.some(key => forbidden.has(key))) fail('invalid-pointer', 'This pointer is not allowed.');
    return keys;
}
function keyOf(parent, key, add = false) {
    if (!Array.isArray(parent)) return key;
    if (add && key === '-') return parent.length;
    if (!/^(0|[1-9][0-9]*)$/.test(key)) fail('invalid-pointer', 'An array pointer needs an index, or - for append.');
    const n = Number(key);
    if (n > parent.length || (!add && n === parent.length)) fail('pointer-not-found', 'Array index is outside this revision.');
    return n;
}
export function valueAt(document, path) {
    let value = document;
    for (const part of tokens(path)) {
        if (!value || typeof value !== 'object' || !Object.hasOwn(value, keyOf(value, part))) fail('pointer-not-found', `No value at ${path}.`);
        value = value[keyOf(value, part)];
    }
    return value;
}
function safeValue(value, depth = 0) {
    if (depth > 80 || (typeof value === 'number' && !Number.isFinite(value))) fail('invalid-patch-value', 'Patch values must be bounded finite JSON.');
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
        if (forbidden.has(key)) fail('invalid-patch-value', 'Prototype keys are not editable.');
        safeValue(child, depth + 1);
    }
}
function write(document, path, value, op) {
    const keys = tokens(path);
    if (!keys.length || protectedFields.has(keys[0])) fail('protected-field', 'Schema, lineage and revision time are managed by the editor; edit authored fields below the root.');
    const target = keys.length === 1 ? document : valueAt(document, '/' + keys.slice(0, -1).map(k => k.replace(/~/g, '~0').replace(/\//g, '~1')).join('/'));
    if (!target || typeof target !== 'object') fail('pointer-not-found', `No container for ${path}.`);
    const key = keyOf(target, keys.at(-1), op === 'add');
    if (op !== 'add' && !Object.hasOwn(target, key)) fail('pointer-not-found', `No value at ${path}.`);
    if (Array.isArray(target)) target.splice(key, op === 'add' ? 0 : 1, ...(op === 'remove' ? [] : [value]));
    else if (op === 'remove') delete target[key]; else target[key] = value;
}

export function patchDocument(original, edits) {
    const document = structuredClone(original);
    if (!Array.isArray(edits) || !edits.length || edits.length > 200) fail('invalid-patch', 'Supply 1–200 ordered edits.');
    for (const edit of edits) {
        tokens(edit.path);
        if (edit.op === 'test') { if (!equal(valueAt(document, edit.path), edit.value)) fail('patch-test-failed', `The test at ${edit.path} failed; no edit was applied.`); continue; }
        if (['copy', 'move'].includes(edit.op)) {
            if (edit.op === 'move' && edit.path.startsWith(edit.from + '/')) fail('invalid-patch', 'Cannot move a value inside itself.');
            const value = structuredClone(valueAt(document, edit.from));
            if (edit.op === 'move') write(document, edit.from, null, 'remove');
            write(document, edit.path, value, 'add'); continue;
        }
        if (edit.op === 'transform') {
            write(document, edit.path, intentEditing.transform(valueAt(document, edit.path), edit), 'replace'); continue;
        }
        if (['union', 'difference', 'intersection', 'buffer'].includes(edit.op)) {
            const originalValue = valueAt(document, edit.path), left = layoutValidation.polygon(originalValue, turf);
            const right = edit.from ? layoutValidation.polygon(valueAt(document, edit.from), turf) : null;
            if (edit.op !== 'buffer' && !right) fail('invalid-patch', 'A polygon operation needs a from pointer in this design.');
            if (edit.op === 'buffer' && (typeof edit.metres !== 'number' || !Number.isFinite(edit.metres) || Math.abs(edit.metres) > 1000)) fail('invalid-patch', 'Buffer must be within ±1000 metres.');
            const result = edit.op === 'buffer' ? turf.buffer(left, edit.metres, { units: 'meters' })
                : turf[edit.op === 'intersection' ? 'intersect' : edit.op](left, right);
            if (!result) fail('empty-geometry', 'This operation removes all geometry. Use an explicit remove edit instead.');
            write(document, edit.path, originalValue.type === 'Feature' ? { ...originalValue, geometry: result.geometry } : result.geometry, 'replace'); continue;
        }
        if (!['add', 'remove', 'replace'].includes(edit.op)) fail('invalid-patch', 'Unknown edit operation.');
        if (edit.op !== 'remove' && !Object.hasOwn(edit, 'value')) fail('invalid-patch-value', 'add and replace need a JSON value.');
        safeValue(edit.value);
        write(document, edit.path, structuredClone(edit.value), edit.op);
    }
    return document;
}

function validateGeometryTree(value) {
    if (!value || typeof value !== 'object') return;
    if (['Polygon', 'MultiPolygon'].includes(value.type)) { layoutValidation.polygon(value, turf); return; }
    if (value.type === 'Feature') { if (!value.geometry) fail('invalid-geometry', 'A feature needs geometry.'); validateGeometryTree(value.geometry); validateGeometryTree(value.properties); return; }
    if (['Point', 'MultiPoint', 'LineString', 'MultiLineString'].includes(value.type)) {
        const points = value.type === 'Point' ? [value.coordinates] : value.type === 'MultiLineString' ? value.coordinates.flat() : value.coordinates;
        if (!Array.isArray(points) || !points.length || points.some(p => !Array.isArray(p) || p.length < 2 || p.some(n => typeof n !== 'number' || !Number.isFinite(n)) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90)) fail('invalid-geometry', 'Coordinates must be finite WGS84 longitude/latitude.');
        return;
    }
    for (const child of Object.values(value)) validateGeometryTree(child);
}

function validatePayload(record) {
    if (!goals.get(record.goal)) fail('invalid-goal', 'Use a supported design goal and its corresponding payload.');
    const structures = goals.structureKeys.includes(record.goal);
    const payload = record.goal === 'road-track' ? 'roadProposal' : record.goal === 'parcel-layout' ? 'parcelLayout' : structures ? 'structureProposal' : 'buildingProposal';
    if (!record[payload] || typeof record[payload] !== 'object' || Array.isArray(record[payload])) fail('invalid-payload', `The ${record.goal} goal needs its ${payload}.`);
    if (payload === 'roadProposal' && !record.roadProposal.definition?.osm) fail('invalid-road', 'A road needs its canonical definition.osm; edit its elements or remove the whole design.');
    if (structures && !['Polygon', 'MultiPolygon'].includes(record.structureProposal.geometry?.type)) fail('invalid-structure', 'A structure needs its polygon geometry; remove the whole design instead of its required drawing.');
    if (['single', 'buildings', 'row', 'parcelBased'].includes(record.goal)) {
        const items = record.geometry?.buildings;
        if (!Array.isArray(items) || !items.length || items.some(b => b?.type !== 'Feature' || !['Polygon', 'MultiPolygon'].includes(b.geometry?.type))) fail('invalid-building', 'A building design needs polygon building features. Remove the design when removing its last building.');
    }
}

// Per-kind furniture models, lamps and market stalls on a park or square, normalized by the same shared rules the
// site uses (frontend/js/furniture-models.js), so a patched record equals one the structure editor saves.
// A model kind or lamp the structure does not offer is refused rather than silently dropped.
const furniturePoint = point => Array.isArray(point) && point.length >= 2 && point.slice(0, 2).every(Number.isFinite)
    && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90 ? [point[0], point[1]] : null;
export function normalizeSpaceFurniture(record) {
    const space = record?.structureProposal, decorations = space?.decorationDesign;
    if (!decorations || typeof decorations !== 'object') return record;
    const allowed = FurnitureModels.kindsFor(space.kind);
    const refuse = kind => fail('furniture-kind-not-allowed', `A ${space.kind} has no ${kind} furniture; use one of: ${allowed.join(', ') || 'none'}.`);
    if (Object.hasOwn(decorations, 'models')) {
        const models = decorations.models;
        if (!models || typeof models !== 'object' || Array.isArray(models)) fail('invalid-decoration', 'decorationDesign.models maps a furniture kind to {url, name}.');
        for (const kind of Object.keys(models)) if (!allowed.includes(kind)) refuse(kind);
        const normalized = FurnitureModels.normalizeModels(models, space.kind);
        if (Object.keys(models).length !== Object.keys(normalized || {}).length) fail('invalid-decoration', 'Each decorationDesign.models entry needs a url string; upload the asset with ugt_import_model kind furniture.');
        if (normalized) decorations.models = normalized; else delete decorations.models;
    }
    // Pavement trees (a tree with a pit in the paving) belong to squares; a park's trees stand on lawn.
    if (space.kind !== 'square' && Array.isArray(decorations.trees) && decorations.trees.some(tree => tree && !Array.isArray(tree) && tree.pit != null)) {
        fail('invalid-tree', `A ${space.kind} has no paving for a tree pit; only a square's trees take pit.`);
    }
    // Lamps {coordinate, bearing} and stalls {coordinate, bearing, color?}; an invalid stall colour is dropped.
    for (const [key, kind, normalize] of [['lamps', 'lamp', FurnitureModels.normalizeLamps], ['stalls', 'stall', FurnitureModels.normalizeStalls]]) {
        if (!Object.hasOwn(decorations, key)) continue;
        if (!allowed.includes(kind)) refuse(kind);
        if (!Array.isArray(decorations[key])) fail('invalid-decoration', `${key} must be an array.`);
        const items = normalize(decorations[key], furniturePoint);
        if (items.length !== decorations[key].length) fail('invalid-decoration', `A ${kind} needs coordinate [longitude, latitude] and an optional bearing in degrees.`);
        decorations[key] = items;
    }
    return record;
}

export function editedDesign(original, expectedCid, edits) {
    const currentCid = cidOfObject(original);
    if (currentCid !== expectedCid) throw Object.assign(new Error('Inspect the intended design revision before editing.'), {
        code: 'design-revision-mismatch', currentCid, expectedCid,
        next: { tool: 'ugt_inspect_design', arguments: { design: currentCid }, action: 'Inspect the original reference and retry with its currentCid; retain a private draftRef for unpublished designs.' } });
    const draft = patchDocument(original, edits);
    safeValue(draft);
    validatePayload(draft);
    validateGeometryTree(draft);
    intentEditing.reconcile(draft, original, edits, turf);
    normalizeSpaceFurniture(draft);
    validateTrackDesign(draft, original);
    validateGeometryTree(draft);
    if (draft.parcelLayout) {
        const result = layoutValidation.validate(draft.parcelLayout, { turf, site: draft.site });
        if (!result.valid) fail('invalid-layout', result.errors.map(e => e.message).join('; '));
    }
    draft.origin = { cid: expectedCid }; draft.authoredAt = new Date().toISOString();
    const checked = designObject({ ...draft, createdAt: draft.authoredAt });
    if (!equal(checked.content, draft)) fail('non-authored-edit', 'The edit includes runtime or noncanonical fields. Inspect the canonical design and edit its authored fields.');
    return checked.content;
}
