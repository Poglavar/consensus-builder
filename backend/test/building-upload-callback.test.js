// A model upload may finish after dismissal; it must not mutate a closed editor or a newer file.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../../frontend/js/building-upload.js', import.meta.url), 'utf8');
const confirm = source.slice(source.indexOf('async function confirmUpload()'), source.indexOf('function disposeScene()'));

function pendingUpload() {
    let finish;
    const response = new Promise(resolve => { finish = resolve; });
    const custom = vi.fn(() => true), fallback = vi.fn(() => true);
    const env = { console, modalEl: {}, loadVersion: 1, loadedFile: { name: 'model.glb' },
        loadedDims: { width: 16, length: 20, height: 16 }, loadedName: 'model.glb',
        currentContext: { parcelIds: ['source-ground'] }, onConfirmCb: null, onUseCb: custom,
        window: { createSingleBuildingFromUpload: fallback }, setStatus: vi.fn(), t: (_key, value) => value,
        setConfirmEnabled: vi.fn(), uploadModel: () => response, close: vi.fn(),
        isStructureUpload: () => ['park', 'square', 'lake'].includes(env.currentContext?.kind) };
    vm.runInNewContext(confirm, env);
    return { env, custom, fallback, finish };
}
describe('model import consumers', () => {
    it('delivers a parsed uploaded model to the current editor consumer instead of opening another editor', async () => {
        const r = pendingUpload();
        const done = r.env.confirmUpload();
        r.finish('/models/new.glb'); await done;
        expect(r.custom).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ width: 16, length: 20, height: 16, modelUrl: '/models/new.glb' }));
        expect(r.fallback).not.toHaveBeenCalled();
        expect(r.env.close).toHaveBeenCalledOnce();
    });
    it.each(['close', 'new-file'])('ignores a response after %s', async action => {
        const r = pendingUpload();
        const done = r.env.confirmUpload();
        r.env.loadVersion++;
        if (action === 'close') r.env.modalEl = null;
        r.finish('/models/late.glb'); await done;
        expect(r.custom).not.toHaveBeenCalled();
        expect(r.fallback).not.toHaveBeenCalled();
        expect(r.env.close).not.toHaveBeenCalled();
    });
    it('keeps the import dialog open when the selected footprint cannot accept the model', async () => {
        const r = pendingUpload();
        r.custom.mockReturnValue(false);
        const done = r.env.confirmUpload();
        r.finish('/models/new.glb'); await done;
        expect(r.env.close).not.toHaveBeenCalled();
        expect(r.env.setConfirmEnabled).toHaveBeenLastCalledWith(true);
    });

    it('aborts editor creation after an upload failure and keeps the selected model retryable', async () => {
        const r = pendingUpload();
        r.env.uploadModel = vi.fn().mockRejectedValue(new Error('connection refused'));
        await r.env.confirmUpload();
        expect(r.env.uploadModel).toHaveBeenCalledOnce();
        expect(r.custom).not.toHaveBeenCalled();
        expect(r.fallback).not.toHaveBeenCalled();
        expect(r.env.close).not.toHaveBeenCalled();
        expect(r.env.setStatus).toHaveBeenLastCalledWith(
            'The model could not be uploaded. Check the connection and try again; your file is still selected.', true
        );
        expect(r.env.setConfirmEnabled).toHaveBeenLastCalledWith(true);
        expect(r.env.loadedFile).toMatchObject({ name: 'model.glb' });
        expect(r.env.currentContext).toMatchObject({ parcelIds: ['source-ground'] });
        expect(r.env.modalEl).toBeTruthy();
    });

    it.each([
        ['returns false', () => false],
        ['throws', () => { throw new Error('editor failed'); }]
    ])('keeps the dialog retryable when the editor callback %s', async (_description, callback) => {
        const r = pendingUpload();
        r.custom.mockImplementation(callback);
        const done = r.env.confirmUpload();
        r.finish('/models/new.glb');
        await done;
        expect(r.custom).toHaveBeenCalledOnce();
        expect(r.fallback).not.toHaveBeenCalled();
        expect(r.env.close).not.toHaveBeenCalled();
        expect(r.env.setStatus).toHaveBeenLastCalledWith(
            'Could not open the building editor. Your file is still selected; try again.', true
        );
        expect(r.env.setConfirmEnabled).toHaveBeenLastCalledWith(true);
        expect(r.env.loadedFile).toMatchObject({ name: 'model.glb' });
        expect(r.env.currentContext).toMatchObject({ parcelIds: ['source-ground'] });
        expect(r.env.modalEl).toBeTruthy();
    });

    it('waits for a structure model consumer that finishes asynchronously, with model wording on failure', async () => {
        const r = pendingUpload();
        r.env.currentContext = { kind: 'park' };
        let place;
        r.custom.mockImplementation(() => new Promise(resolve => { place = resolve; }));
        const done = r.env.confirmUpload();
        r.finish('/models/park.glb');
        await vi.waitFor(() => expect(r.custom).toHaveBeenCalledOnce());
        expect(r.env.close).not.toHaveBeenCalled();
        place(false);
        await done;
        expect(r.env.close).not.toHaveBeenCalled();
        expect(r.env.setStatus).toHaveBeenLastCalledWith('Could not place this model. Your file is still selected; try again.', true);
    });
});
