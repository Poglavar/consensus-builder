/**
 * Guards shared-plan replay against synthetic-id drift and overly aggressive
 * road remainder filtering that drops valid descendant parcels.
 */
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

test.describe('Proposal synthetic regressions @core', () => {
  test('strips inherited synthetic suffixes before composing child ids', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      if (typeof w._composeSyntheticParcelId !== 'function' || typeof w._composeSyntheticParcelNumber !== 'function') {
        return { skip: true };
      }

      return {
        skip: false,
        parcelId: w._composeSyntheticParcelId('HR-335649-371/1#p-1ov46hnuoy5-10', 'p-21bi0202nac', 1),
        parcelNumber: w._composeSyntheticParcelNumber('371#p-1ov46hnuoy5-10', 'p-21bi0202nac', 1),
      };
    });

    test.skip(result.skip, 'Synthetic id composition helpers are unavailable');
    expect(result.parcelId).toBe('HR-335649-371/1#p-21bi0202nac-1');
    expect(result.parcelNumber).toBe('371#p-21bi0202nac-1');
  });

  test('assigns canonical synthetic ids from synthetic parent metadata', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      const pm = w.ProposalManager;
      if (!pm || typeof pm._assignSyntheticChildIdentities !== 'function') {
        return { skip: true };
      }

      const feature = {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]],
        },
        properties: {
          parentParcelId: 'HR-335649-371/1#p-1ov46hnuoy5-10',
          parentParcelNumber: '371#p-1ov46hnuoy5-10',
        },
      };

      pm._assignSyntheticChildIdentities('p-21bi0202nac', [feature]);

      return {
        skip: false,
        parcelId: feature.properties.parcelId,
        parcelNumber: feature.properties.BROJ_CESTICE,
        rootParcelId: feature.properties.rootParcelId,
        rootParcelNumber: feature.properties.rootParcelNumber,
      };
    });

    test.skip(result.skip, 'ProposalManager synthetic id helpers are unavailable');
    expect(result.parcelId).toBe('HR-335649-371/1#p-21bi0202nac-1');
    expect(result.parcelNumber).toBe('371#p-21bi0202nac-1');
    expect(result.rootParcelId).toBe('HR-335649-371/1');
    expect(result.rootParcelNumber).toBe('371');
  });

  test('reapplies canonical child ids from shared payload over regenerated ids', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      const pm = w.ProposalManager;
      const applyCanonical = w._applyCanonicalChildParcelIds;
      if (!pm || typeof pm._assignSyntheticChildIdentities !== 'function' || typeof applyCanonical !== 'function') {
        return { skip: true };
      }

      const features = [
        {
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]],
          },
          properties: {
            rootParcelId: 'HR-335649-5501/1',
            rootParcelNumber: '5501',
          },
        },
        {
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [[[1, 1], [1, 2], [2, 2], [1, 1]]],
          },
          properties: {
            rootParcelId: 'HR-335649-5501/1',
            rootParcelNumber: '5501',
          },
        },
      ];

      pm._assignSyntheticChildIdentities('p-local-stale', features);
      const applied = applyCanonical(features, [
        'HR-335649-5501/1#p-bikxa7o1hf-1',
        'HR-335649-5501/1#p-bikxa7o1hf-2',
      ]);

      return {
        skip: false,
        applied,
        ids: features.map((feature: any) => feature.properties.parcelId),
        numbers: features.map((feature: any) => feature.properties.BROJ_CESTICE),
      };
    });

    test.skip(result.skip, 'Canonical child-id override helpers are unavailable');
    expect(result.applied).toBe(true);
    expect(result.ids).toEqual([
      'HR-335649-5501/1#p-bikxa7o1hf-1',
      'HR-335649-5501/1#p-bikxa7o1hf-2',
    ]);
    expect(result.numbers).toEqual([
      '5501#p-bikxa7o1hf-1',
      '5501#p-bikxa7o1hf-2',
    ]);
  });

  test('keeps valid remainders when a small road cut affects a large parcel', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      const shouldSkip = w._shouldSkipUncutRemainder;
      if (typeof shouldSkip !== 'function') {
        return { skip: true };
      }

      return {
        skip: false,
        exactMatch: shouldSkip(1000, 1000),
        tinyDelta: shouldSkip(1000, 999.6),
        realCut: shouldSkip(267277.4099292392, 267166.3595310262),
      };
    });

    test.skip(result.skip, 'Uncut remainder guard helper is unavailable');
    expect(result.exactMatch).toBe(true);
    expect(result.tinyDelta).toBe(true);
    expect(result.realCut).toBe(false);
  });
});
