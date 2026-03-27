import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

test.describe('Proposal reload persistence @core', () => {
  test('proposal data stored in PersistentStorage survives reload', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    // Store a proposal payload
    await page.evaluate(async () => {
      const w = window as any;
      await w.PersistentStorage.ready;
      const proposal = {
        id: 'e2e-persist-road',
        name: 'E2E Persistence Road',
        type: 'road',
        status: 'applied',
        parcels: ['HR-335754-1234', 'HR-335754-1235'],
        geometry: {
          type: 'Polygon',
          coordinates: [[[15.98, 45.80], [15.99, 45.80], [15.99, 45.81], [15.98, 45.81], [15.98, 45.80]]],
        },
      };
      w.PersistentStorage.setItem('e2e_test_proposal_persist', JSON.stringify(proposal));
    });

    // Reload the page
    await page.reload();
    await waitForMapReady(page);

    // Verify data survived
    const result = await page.evaluate(async () => {
      const w = window as any;
      await w.PersistentStorage.ready;
      const raw = w.PersistentStorage.getItem('e2e_test_proposal_persist');
      w.PersistentStorage.removeItem('e2e_test_proposal_persist');
      if (!raw) return { survived: false };
      const p = JSON.parse(raw);
      return {
        survived: true,
        name: p.name,
        type: p.type,
        parcelCount: p.parcels?.length,
      };
    });

    expect(result.survived).toBe(true);
    expect(result.name).toBe('E2E Persistence Road');
    expect(result.type).toBe('road');
    expect(result.parcelCount).toBe(2);
  });

  test('multiple proposals persist independently', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    await page.evaluate(async () => {
      const w = window as any;
      await w.PersistentStorage.ready;
      w.PersistentStorage.setItem('e2e_proposal_A', JSON.stringify({ name: 'Road A', type: 'road' }));
      w.PersistentStorage.setItem('e2e_proposal_B', JSON.stringify({ name: 'Park B', type: 'park' }));
      w.PersistentStorage.setItem('e2e_proposal_C', JSON.stringify({ name: 'Building C', type: 'building' }));
    });

    await page.reload();
    await waitForMapReady(page);

    const result = await page.evaluate(async () => {
      const w = window as any;
      await w.PersistentStorage.ready;
      const a = JSON.parse(w.PersistentStorage.getItem('e2e_proposal_A') || 'null');
      const b = JSON.parse(w.PersistentStorage.getItem('e2e_proposal_B') || 'null');
      const c = JSON.parse(w.PersistentStorage.getItem('e2e_proposal_C') || 'null');
      w.PersistentStorage.removeItem('e2e_proposal_A');
      w.PersistentStorage.removeItem('e2e_proposal_B');
      w.PersistentStorage.removeItem('e2e_proposal_C');
      return {
        aName: a?.name,
        bName: b?.name,
        cName: c?.name,
      };
    });

    expect(result.aName).toBe('Road A');
    expect(result.bName).toBe('Park B');
    expect(result.cName).toBe('Building C');
  });

  test('city selection persists across reload', async ({ mockApi: page }) => {
    await page.goto('/?city=bg');
    await waitForMapReady(page);

    const cityBefore = await page.evaluate(() => {
      const w = window as any;
      return w.CityConfigManager?.getCurrentCityId?.() ?? '';
    });

    await page.reload();
    await waitForMapReady(page);

    const cityAfter = await page.evaluate(() => {
      const w = window as any;
      return w.CityConfigManager?.getCurrentCityId?.() ?? '';
    });

    expect(cityBefore).toBe('belgrade');
    expect(cityAfter).toBe('belgrade');
  });

  test('language selection persists across reload', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    await page.evaluate(() => {
      const w = window as any;
      w.i18n?.setLanguage?.('hr');
    });

    await page.reload();
    await waitForMapReady(page);

    const lang = await page.evaluate(() => {
      const w = window as any;
      return w.i18n?.getLanguage?.() ?? '';
    });

    expect(lang).toBe('hr');
  });
});
