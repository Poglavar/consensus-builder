// Ownership and price belong to the same live ground. Moving along it shares the calculation.
import { expect, it, vi } from 'vitest';
import { loadRoadDrawing } from './helpers/road-drawing-env.js';

it('shares the displayed acquisition cost and invalidates it when ground or membership changes', () => {
    const env = loadRoadDrawing();
    try {
        let revision = 1;
        env.fabric.revision = () => revision;
        const aggregate = vi.spyOn(globalThis.ParcelPriceModel, 'aggregate');
        const parcels = [{ id: 'A', area: 80 }];
        env.api.updateRoadAcquisitionDisplays(parcels);
        env.api.updateRoadAcquisitionDisplays([{ ...parcels[0] }]);
        expect(aggregate).toHaveBeenCalledTimes(1);
        revision++;
        env.api.updateRoadAcquisitionDisplays(parcels);
        env.api.updateRoadAcquisitionDisplays([...parcels, { id: 'B', area: 40 }]);
        expect(aggregate).toHaveBeenCalledTimes(3);
        expect(env.element('road-market-price').textContent).toBeTruthy();
        expect(env.element('road-acquire-difficulty').textContent).toBeTruthy();
    } finally { env.dispose(); }
});
