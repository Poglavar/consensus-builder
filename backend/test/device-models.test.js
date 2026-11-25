// Device-only models (frontend/js/device-models.js): finding and replacing their references in records,
// and the once-per-publish choice to upload them or publish without them.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const load = () => {
    delete require.cache[require.resolve('../../frontend/js/device-models.js')];
    return require('../../frontend/js/device-models.js');
};

const record = () => ({
    proposalId: 'p1',
    geometry: { buildings: [{ properties: { modelUrl: 'device-model:sha256-aa', height: 9 } }, { properties: { modelUrl: '/uploads/models/b.glb' } }] },
    structureProposal: { decorationDesign: { models: { bench: { url: 'device-model:sha256-bb', name: 'Bench' } } } }
});

describe('device-only model references', () => {
    it('finds each reference once, wherever a record keeps it', () => {
        const DeviceModels = load();
        expect(DeviceModels.deviceModelRefs([record(), record()])).toEqual(['device-model:sha256-aa', 'device-model:sha256-bb']);
        expect(DeviceModels.isDeviceModel('/uploads/models/b.glb')).toBe(false);
    });

    it('replaces the named references in place and leaves the rest', () => {
        const DeviceModels = load();
        const item = record();
        DeviceModels.replaceDeviceModels(item, new Map([['device-model:sha256-aa', 'https://api.example/uploads/models/a.glb']]));
        expect(item.geometry.buildings.map(building => building.properties.modelUrl)).toEqual(['https://api.example/uploads/models/a.glb', '/uploads/models/b.glb']);
        expect(item.structureProposal.decorationDesign.models.bench.url).toBe('device-model:sha256-bb');
    });
});

describe('publishing device-only models', () => {
    // The module reads its globals from the window it is loaded into; each case lends one.
    it('asks nothing when there is nothing to ask about', async () => {
        const DeviceModels = load();
        expect(await DeviceModels.chooseForPublish([{ geometry: { buildings: [] } }])).toEqual(new Map());
    });

    it('publishes without the models when asked to, for that publish only: the next publish asks again', async () => {
        globalThis.window = { CbDialog: { choice: vi.fn(async () => 'keep') } };
        try {
            const DeviceModels = load();
            expect(await DeviceModels.chooseForPublish([record()])).toEqual(new Map());
            expect(await DeviceModels.chooseForPublish([record()])).toEqual(new Map());
            expect(window.CbDialog.choice).toHaveBeenCalledTimes(2);
            const [, options] = window.CbDialog.choice.mock.calls[0];
            expect(options.map(option => option.value)).toEqual(['upload', 'keep', 'cancel']);
            // Cancel is the safe default.
            expect(options.find(option => option.primary).value).toBe('cancel');
        } finally { delete globalThis.window; }
    });

    it('rejects as cancelled when the person cancels', async () => {
        globalThis.window = { CbDialog: { choice: vi.fn(async () => null) } };
        try {
            const DeviceModels = load();
            await expect(DeviceModels.chooseForPublish([record()])).rejects.toMatchObject({ code: 'cancelled', cancelled: true });
        } finally { delete globalThis.window; }
    });
});
