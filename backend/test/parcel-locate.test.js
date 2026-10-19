// locateParcelById (frontend/js/parcels/ui/locate.js): the core of the old Locate box, now behind
// the search box's parcel results. Ask the ground service for the id, select the parcel when its
// layer exists, and report why not otherwise — never select on a miss.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { locateParcelById } = require('../../frontend/js/parcels/ui/locate.js');

function fakePage({ present = [], ensureFails = false, numbersShown = true } = {}) {
    const known = new Set();
    const checkbox = { checked: numbersShown };
    const page = {
        document: { getElementById: id => (id === 'showParcelNumbers' ? checkbox : null) },
        toggleParcelNumbers: vi.fn(),
        selectParcel: vi.fn(),
        CadastralParcelRepository: {
            ensureIds: vi.fn(async ids => {
                if (ensureFails) throw new Error('backend down');
                ids.filter(id => present.includes(id)).forEach(id => known.add(id));
                return { features: [] };
            })
        },
        LiveParcelFabric: { get: id => (known.has(id) ? { id } : null) },
        ParcelPresenter: {
            getLayer: id => ({ layerOf: id }),
            getIdForLayer: layer => layer.layerOf
        }
    };
    return { page, checkbox };
}

describe('locateParcelById', () => {
    it('loads the id through the ground service and selects the parcel', async () => {
        const { page } = fakePage({ present: ['HR-335550-1813/6'] });
        const result = await locateParcelById('  HR-335550-1813/6 ', page);
        expect(result).toEqual({ ok: true, parcelId: 'HR-335550-1813/6' });
        expect(page.CadastralParcelRepository.ensureIds).toHaveBeenCalledWith(['HR-335550-1813/6']);
        expect(page.selectParcel).toHaveBeenCalledWith('HR-335550-1813/6');
    });

    it('reports a parcel the cadastre does not have, without selecting anything', async () => {
        const { page } = fakePage({ present: [] });
        const result = await locateParcelById('HR-1-1', page);
        expect(result).toMatchObject({ ok: false, reason: 'notFound', message: 'Parcel not found' });
        expect(page.selectParcel).not.toHaveBeenCalled();
    });

    it('reports a failed lookup as not found instead of throwing', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => { });
        const { page } = fakePage({ ensureFails: true });
        await expect(locateParcelById('HR-1-1', page)).resolves.toMatchObject({ ok: false, reason: 'notFound' });
        expect(page.selectParcel).not.toHaveBeenCalled();
        info.mockRestore();
    });

    it('says so when the parcel machinery has not loaded', async () => {
        const { page } = fakePage();
        delete page.LiveParcelFabric;
        await expect(locateParcelById('HR-1-1', page)).resolves.toMatchObject({ ok: false, reason: 'notLoaded' });
    });

    it('ignores an empty query', async () => {
        const { page } = fakePage();
        await expect(locateParcelById('   ', page)).resolves.toMatchObject({ ok: false, reason: 'empty' });
        expect(page.CadastralParcelRepository.ensureIds).not.toHaveBeenCalled();
    });

    it('turns parcel ids on, since that is what the person is looking for', async () => {
        const { page, checkbox } = fakePage({ present: ['X'], numbersShown: false });
        await locateParcelById('X', page);
        expect(checkbox.checked).toBe(true);
        expect(page.toggleParcelNumbers).toHaveBeenCalledOnce();
    });
});
