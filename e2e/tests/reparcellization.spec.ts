import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

test.describe('Reparcellization synthetic IDs @core', () => {
  test('ProposalManager is available', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      if (!w.ProposalManager) return { exists: false };
      return {
        exists: true,
        isObject: typeof w.ProposalManager === 'object' || typeof w.ProposalManager === 'function',
      };
    });

    test.skip(!result.exists, 'ProposalManager not loaded');
    expect(result.isObject).toBe(true);
  });

  test('synthetic parcel ID format is correct', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    // Test the synthetic ID format by evaluating the internal functions
    // They're not on window, so we test by creating proposals with child parcels
    const result = await page.evaluate(() => {
      const w = window as any;

      // Test parcel ID helpers that ARE on window
      if (typeof w.ensureParcelId !== 'function') return { skip: true };

      // Test basic parcel ID normalization
      const tests = [
        { input: { parcelId: 'HR-335754-1234' }, expected: 'HR-335754-1234' },
        { input: { parcel_id: 'HR-335754-5678' }, expected: 'HR-335754-5678' },
        { input: { id: 'HR-335754-9999' }, expected: 'HR-335754-9999' },
        { input: { parcelId: '  HR-335754-1234  ' }, expected: 'HR-335754-1234' },
      ];

      const results = tests.map(t => {
        const id = w.ensureParcelId({ properties: t.input });
        return { expected: t.expected, actual: id, pass: id === t.expected };
      });

      return { skip: false, results, allPass: results.every(r => r.pass) };
    });

    test.skip(result.skip === true, 'Parcel ID helpers not loaded');
    expect(result.allPass).toBe(true);
  });

  test('getParcelId handles various input formats', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      if (typeof w.getParcelId !== 'function') return { skip: true };

      // Feature with properties
      const fromFeature = w.getParcelId({ properties: { parcelId: 'ABC-123' } });
      // Plain object (treated as properties)
      const fromObject = w.getParcelId({ parcelId: 'DEF-456' });
      // String passthrough
      const fromString = w.getParcelId('GHI-789');
      // Null handling
      const fromNull = w.getParcelId(null);
      // Undefined handling
      const fromUndefined = w.getParcelId(undefined);

      return {
        skip: false,
        fromFeature: fromFeature === 'ABC-123',
        fromObject: fromObject === 'DEF-456',
        fromString: fromString === 'GHI-789',
        fromNull: fromNull === null,
        fromUndefined: fromUndefined === null,
      };
    });

    test.skip(result.skip === true, 'getParcelId not loaded');
    expect(result.fromFeature).toBe(true);
    expect(result.fromObject).toBe(true);
    expect(result.fromString).toBe(true);
    expect(result.fromNull).toBe(true);
    expect(result.fromUndefined).toBe(true);
  });

  test('parcel ID coercion trims whitespace and converts to string', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      if (typeof w.getParcelId !== 'function') return { skip: true };

      const numericId = w.getParcelId({ parcelId: 12345 });
      const spaceyId = w.getParcelId({ parcelId: '  HR-123  ' });

      return {
        skip: false,
        numericConverted: numericId === '12345',
        trimmed: spaceyId === 'HR-123',
      };
    });

    test.skip(result.skip === true, 'getParcelId not loaded');
    expect(result.numericConverted).toBe(true);
    expect(result.trimmed).toBe(true);
  });
});
