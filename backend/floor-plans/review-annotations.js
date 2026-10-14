import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const { newDocument, validateDocument } = require('../../frontend/novogradnje/review/annotations.js');

export class AnnotationError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

function cleanDocument(value) {
    return {
        schema: value.schema, unitId: value.unitId, sourceSha256: value.sourceSha256,
        page: value.page, draftId: value.draftId, revision: value.revision,
        shapes: value.shapes.map(shape => ({ id: shape.id, type: shape.type,
            points: shape.points.map(point => [...point]), note: shape.note })),
        note: value.note,
    };
}

// One bounded document per source/draft. Revisions prevent overwriting another tab's edits.
// A changed draft gets a separate file so a preview refresh cannot erase older annotations.
export function createAnnotationStore({ directory, drafts, now = () => new Date().toISOString() }) {
    const units = new Map(), writes = new Map();
    for (const draft of drafts) {
        const metadata = { unitId: draft.unitId, sourceSha256: draft.sourceSha256,
            page: draft.page, draftId: draft.draftId };
        newDocument(metadata);
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(metadata.unitId)
            || !/^[A-Za-z0-9_-]{1,128}$/.test(metadata.draftId)
            || units.has(metadata.unitId)) throw new Error('Invalid or duplicate review draft identity');
        units.set(metadata.unitId, metadata);
    }
    function metadataFor(unit) {
        const metadata = units.get(unit);
        if (!metadata) throw new AnnotationError(404, 'Unknown apartment.');
        return metadata;
    }
    const filename = metadata => join(directory, createHash('sha256').update(JSON.stringify(metadata)).digest('hex') + '.json');
    async function read(unit) {
        const metadata = metadataFor(unit);
        try {
            const saved = JSON.parse(await readFile(filename(metadata), 'utf8'));
            validateDocument(saved, metadata);
            return { ...cleanDocument(saved), updatedAt: saved.updatedAt };
        } catch (error) {
            if (error.code === 'ENOENT') return newDocument(metadata);
            throw error;
        }
    }
    async function write(unit, value) {
        const metadata = metadataFor(unit);
        try { validateDocument(value, metadata); }
        catch (error) { throw new AnnotationError(400, error.message); }
        // Copy before awaiting the lock; callers cannot mutate an in-flight save.
        const clean = cleanDocument(value);
        const previous = writes.get(unit) || Promise.resolve();
        const pending = previous.catch(() => {}).then(async () => {
            const current = await read(unit);
            if (clean.revision !== current.revision) throw new AnnotationError(409,
                'This drawing was changed in another tab. Download your changes, then reload.');
            const saved = { ...clean, revision: current.revision + 1, updatedAt: now() };
            await mkdir(directory, { recursive: true });
            const target = filename(metadata), temporary = `${target}.${randomUUID()}.tmp`;
            try {
                await writeFile(temporary, JSON.stringify(saved, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
                await rename(temporary, target);
            } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
            // Return what was persisted, not a pre-write success sentinel.
            return read(unit);
        });
        writes.set(unit, pending);
        try { return await pending; }
        finally { if (writes.get(unit) === pending) writes.delete(unit); }
    }
    return { read, write, has: unit => units.has(unit) };
}
