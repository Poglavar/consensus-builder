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
        setConfirmEnabled: vi.fn(), uploadModel: () => response, close: vi.fn() };
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
});
