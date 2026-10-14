// Pure annotation document helpers shared by the review UI and focused node tests.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.NovogradnjePlanAnnotations = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const SCHEMA = 'novogradnje.plan-annotations.v1', MAX_SHAPES = 200, MAX_SHAPE_NOTE = 500, MAX_NOTE = 2000;
    const TYPES = new Set(['wall', 'opening', 'remove', 'note']);
    const finite = n => typeof n === 'number' && Number.isFinite(n);
    function pointFromClient(clientX, clientY, rect) {
        if (![clientX, clientY, rect?.left, rect?.top, rect?.width, rect?.height].every(finite) || rect.width <= 0 || rect.height <= 0) return null;
        const x = (clientX - rect.left) / rect.width, y = (clientY - rect.top) / rect.height;
        if (x < 0 || x > 1 || y < 0 || y > 1) return null;
        return [x, y];
    }
    function sourcePointToClient(point, rect) {
        if (!Array.isArray(point) || point.length !== 2 || !point.every(finite) || point.some(n => n < 0 || n > 1)
            || ![rect?.left, rect?.top, rect?.width, rect?.height].every(finite)) return null;
        return { x: rect.left + point[0] * rect.width, y: rect.top + point[1] * rect.height };
    }
    function validateDocument(value, expected = {}) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Annotation document must be an object.');
        if (value.schema !== SCHEMA) throw new TypeError('Unsupported annotation schema.');
        for (const key of ['unitId', 'sourceSha256', 'draftId']) {
            if (typeof value[key] !== 'string' || !value[key].trim()) throw new TypeError(`Missing ${key}.`);
            if (expected[key] !== undefined && value[key] !== expected[key]) throw new TypeError(`${key} does not match this draft.`);
        }
        if (value.unitId.length > 128 || value.draftId.length > 128) throw new TypeError('Draft identity is too long.');
        if (!/^[a-f0-9]{64}$/.test(value.sourceSha256)) throw new TypeError('Invalid source SHA-256.');
        if (!Number.isInteger(value.page) || value.page < 1 || (expected.page !== undefined && value.page !== expected.page)) throw new TypeError('Unsupported source page.');
        if (!Number.isInteger(value.revision) || value.revision < 0) throw new TypeError('Invalid annotation revision.');
        if (!Array.isArray(value.shapes) || value.shapes.length > MAX_SHAPES) throw new TypeError('Invalid annotation shape count.');
        if (typeof value.note !== 'string' || value.note.length > MAX_NOTE) throw new TypeError('Invalid document note.');
        const ids = new Set();
        for (const shape of value.shapes) {
            if (!shape || typeof shape.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(shape.id) || ids.has(shape.id)) throw new TypeError('Invalid or duplicate shape id.');
            ids.add(shape.id);
            if (!TYPES.has(shape.type)) throw new TypeError('Invalid shape type.');
            const required = shape.type === 'note' ? 1 : 2;
            if (!Array.isArray(shape.points) || shape.points.length !== required || shape.points.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(finite) || p.some(n => n < 0 || n > 1))) throw new TypeError('Invalid normalized shape points.');
            if (typeof shape.note !== 'string' || shape.note.length > MAX_SHAPE_NOTE) throw new TypeError('Invalid shape note.');
        }
        return true;
    }
    function newDocument(metadata) {
        const value = { schema: SCHEMA, unitId: metadata.unitId, sourceSha256: metadata.sourceSha256,
            page: metadata.page ?? 1, draftId: metadata.draftId, revision: 0, shapes: [], note: '' };
        validateDocument(value, metadata);
        return value;
    }
    function restoreContent(current, previous) {
        validateDocument(current); validateDocument(previous);
        if (current.unitId !== previous.unitId || current.sourceSha256 !== previous.sourceSha256
            || current.page !== previous.page || current.draftId !== previous.draftId) throw new TypeError('Undo history belongs to another draft.');
        return { ...previous, revision: current.revision, ...(current.updatedAt === undefined ? {} : { updatedAt: current.updatedAt }) };
    }
    function exportDocument(document) {
        validateDocument(document);
        return JSON.stringify(document, null, 2) + '\n';
    }
    async function flushChanges({ isBusy, isDirty, persist, wait }) {
        // A save can finish while newer edits are still pending in the same page.
        do {
            while (isBusy()) await wait();
            if (isDirty() && !await persist()) return false;
        } while (isDirty());
        return true;
    }
    return { SCHEMA, MAX_SHAPES, MAX_SHAPE_NOTE, MAX_NOTE, pointFromClient, sourcePointToClient, validateDocument, newDocument, restoreContent, exportDocument, flushChanges };
});
