// Protect unavailable-source ownership UI without breaking simulated game ownership.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const ownershipTypeSource = readFileSync(
    new URL('../../frontend/js/parcels/ownership-type.js', import.meta.url),
    'utf8'
);
const source = readFileSync(
    new URL('../../frontend/js/parcels/ownership-ui.js', import.meta.url),
    'utf8'
);

function loadOwnershipUi({ ownership = false, gameRunning = false } = {}) {
    const target = { innerHTML: '' };
    const count = { textContent: '', removeAttribute: vi.fn() };
    const typeClasses = new Set();
    const typeLabel = {
        style: { display: 'inline-block' },
        classList: {
            add: value => typeClasses.add(value),
            remove: (...values) => values.forEach(value => typeClasses.delete(value))
        }
    };
    const document = {
        getElementById: id => id === 'parcel-owner-value' ? target : id === 'parcel-owners-count' ? count : null,
        querySelector: () => typeLabel
    };
    const scope = {
        document,
        console,
        fetch: vi.fn(),
        tParcel: (key, _params, fallback) => ({
            'common.unknownOwner': 'Unknown owner',
            'common.unknown': 'Unknown'
        }[key] || fallback || key),
        formatPercentValue: value => `${value}%`,
        formatSharePercent: value => value,
        gameState: { isRunning: gameRunning },
        getCurrentDataSource: () => 'api.urbangametheory.xyz',
        CityConfigManager: { getCurrentCityConfig: () => ({ parcels: { ownership } }) }
    };
    scope.window = scope;
    const context = createContext(scope);
    runInContext(ownershipTypeSource, context);
    runInContext(source, context);
    return { ui: scope.ParcelsOwnershipUi, target, count, typeLabel, typeClasses, scope };
}

describe('geometry-only parcel ownership UI', () => {
    it('shows unknown ownership without placeholder owners, shares, counts, or lookup requests', async () => {
        const { ui, target, count, typeLabel, scope } = loadOwnershipUi();

        expect(ui.shouldUseRealParcelOwners()).toBe(false);
        expect(ui.mapOwnerRecordsToSlots('GEOM-1')).toEqual([]);
        expect(ui.getParcelOwnerSlots('GEOM-1')).toEqual([]);
        expect(await ui.getRealParcelOwners('GEOM-1')).toEqual([]);
        expect(await ui.fetchOwnerDataForParcel('GEOM-1')).toEqual({ owners: [], slots: [] });
        expect(await ui.ensureParcelOwnerSlots('GEOM-1')).toEqual([]);

        ui.fetchAndDisplayRealOwners('GEOM-1');

        expect(target.innerHTML).toContain('Unknown owner');
        expect(target.innerHTML).not.toMatch(/Single owner|100%/);
        expect(count.textContent).toBe('Unknown');
        expect(typeLabel.style.display).toBe('none');
        expect(scope.fetch).not.toHaveBeenCalled();
        expect(ui.buildRealOwnerRowsHtml([])).toContain('Unknown owner');
        expect(ui.buildRealOwnerRowsHtml([])).not.toContain('100%');
    });

    it('preserves real owner and share rendering for sources that support ownership', () => {
        const { ui } = loadOwnershipUi({ ownership: true });

        expect(ui.buildRealOwnerRowsHtml([{ name: 'A. Example', actualShareText: '50%' }]))
            .toContain('A. Example');
        expect(ui.buildRealOwnerRowsHtml([{ name: 'A. Example', actualShareText: '50%' }]))
            .toContain('50%');
    });

    it('keeps an adapter-provided canonical ownerType in the rendered badge', async () => {
        const { ui, typeLabel, typeClasses, scope } = loadOwnershipUi({ ownership: true });
        scope.getBackendBase = () => 'http://backend.test';
        scope.__parcelOwnershipRequest = {
            parcelSourceIdFor: () => 'parcel-nyc',
            ownershipRequestPath: () => '/parcel-ownership/parcel-nyc/US-NY-1',
            ownersFromOwnershipRecord: record => record.owners
        };
        scope.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                owners: [{ name: 'Acme Holdings LLC', ownerType: 'company', sharePercent: 100 }]
            })
        });

        ui.fetchAndDisplayRealOwners('US-NY-1');

        await vi.waitFor(() => expect(typeClasses.has('ownership-type-company')).toBe(true));
        expect(typeLabel.textContent).toBe('Company');
        expect(typeClasses.has('ownership-type-individual')).toBe(false);
    });

    it('says "No owner data" when a source with ownership answers with no owners, instead of inventing a single owner', async () => {
        const { ui, target, count, scope } = loadOwnershipUi({ ownership: true });
        scope.tParcel = (key, _params, fallback) => ({ 'common.unknown': 'Unknown' }[key] || fallback || key);
        scope.getBackendBase = () => 'http://backend.test';
        scope.__parcelOwnershipRequest = {
            parcelSourceIdFor: () => 'parcel-bg',
            ownershipRequestPath: (sourceId, parcelId) => `/parcel-ownership/${sourceId}/${parcelId}`,
            ownersFromOwnershipRecord: record => record.owners
        };
        scope.fetch.mockResolvedValue({ ok: true, json: async () => ({ owners: [] }) });

        expect(await ui.getRealParcelOwners('SR-703648-1119/1')).toEqual([]);
        ui.fetchAndDisplayRealOwners('SR-703648-1119/2');
        await vi.waitFor(() => expect(target.innerHTML).toContain('No owner data'));
        expect(target.innerHTML).not.toMatch(/Single owner|100%/);
        expect(count.textContent).toBe('Unknown');
        expect(scope.fetch).toHaveBeenCalledWith('http://backend.test/parcel-ownership/parcel-bg/SR-703648-1119/1', expect.anything());
    });

    it('translates its strings through the page i18n when no tParcel helper exists (the app defines none)', async () => {
        const { ui, target, count, scope } = loadOwnershipUi({ ownership: false });
        delete scope.tParcel;
        scope.i18n = { t: key => ({ 'common.unknownOwner': 'Nepoznat vlasnik', 'common.unknown': 'Nepoznato' }[key] || key) };

        ui.fetchAndDisplayRealOwners('GEOM-1');

        expect(target.innerHTML).toContain('Nepoznat vlasnik');
        expect(count.textContent).toBe('Nepoznato');
    });

    it('keeps simulated owner slots available in game mode when the city source has no ownership data', async () => {
        const { ui, scope } = loadOwnershipUi({ ownership: false, gameRunning: true });

        expect(ui.shouldUseRealParcelOwners()).toBe(false);
        expect(ui.getParcelOwnerSlots('GEOM-1')).toEqual([expect.objectContaining({
            displayName: 'Single owner',
            shareText: '100%',
            type: 'unknown',
            placeholder: true
        })]);
        const data = await ui.fetchOwnerDataForParcel('GEOM-1');
        expect(data.owners).toEqual([]);
        expect(data.slots).toHaveLength(1);
        expect(await ui.ensureParcelOwnerSlots('GEOM-1')).toHaveLength(1);
        expect(ui.buildRealOwnerRowsHtml([])).toContain('Single owner');
        expect(scope.fetch).not.toHaveBeenCalled();
    });
});
