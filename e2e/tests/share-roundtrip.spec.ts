import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

/**
 * Share-link round-trip — the compression half, which is the half that needs a browser.
 *
 * compressBytes()/inflateBytes() delegate to `pako`, which the app loads from a CDN and which is not
 * an npm dependency; in node they take their no-compression fallback path, so a unit test there
 * would prove nothing. These two tests therefore stay in Chromium, where the real pako is loaded.
 *
 * Four tests were dropped from this file — base64url round-trip, escapeHtml, deepClone and
 * buildCityQueryParam are pure functions with no browser dependency at all. They now run in node
 * (backend/test/proposals-sharing-utils.test.js), with more cases than they had here.
 */

test.describe('Proposal share round-trip @core', () => {
  test('compress/inflate round-trips data through the real pako', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      if (typeof w.compressBytes !== 'function' || typeof w.inflateBytes !== 'function') {
        return { skip: true };
      }
      const text = 'Hello, this is a test payload for compression!';
      const original = new TextEncoder().encode(text);
      const compressed = w.compressBytes(original);
      const decompressed = w.inflateBytes(compressed.bytes || compressed);
      if (!decompressed) return { skip: false, success: false };
      return {
        skip: false,
        success: true,
        // pako must have actually engaged — otherwise this is the silent fallback path.
        didCompress: compressed.compressed === true,
        matchesOriginal: new TextDecoder().decode(decompressed) === text,
      };
    });

    test.skip(result.skip === true, 'Compress/inflate not loaded');
    expect(result.success).toBe(true);
    expect(result.didCompress, 'pako must be loaded — a silent no-compression fallback is a failure here').toBe(true);
    expect(result.matchesOriginal).toBe(true);
  });

  test('full share payload encode/decode round-trip', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      if (typeof w.base64UrlEncodeBytes !== 'function' || typeof w.compressBytes !== 'function') {
        return { skip: true };
      }

      // Simulate a proposal payload
      const payload = {
        version: 1,
        proposals: [{
          name: 'Test Road',
          type: 'road',
          parcels: ['HR-335754-1234', 'HR-335754-1235'],
        }],
        city: 'zagreb',
      };
      const jsonStr = JSON.stringify(payload);
      const bytes = new TextEncoder().encode(jsonStr);

      // Compress
      const compressed = w.compressBytes(bytes);
      const compressedBytes = compressed.bytes || compressed;

      // Encode
      const encoded = 'z.' + w.base64UrlEncodeBytes(compressedBytes);

      // Decode
      const rawEncoded = encoded.startsWith('z.') ? encoded.slice(2) : encoded;
      const decoded = w.base64UrlDecodeToBytes(rawEncoded);
      const inflated = w.inflateBytes(decoded);
      if (!inflated) return { skip: false, success: false, error: 'inflate failed' };
      const jsonOut = new TextDecoder().decode(inflated);
      const parsed = JSON.parse(jsonOut);

      return {
        skip: false,
        success: true,
        nameMatch: parsed.proposals[0].name === 'Test Road',
        cityMatch: parsed.city === 'zagreb',
        parcelCount: parsed.proposals[0].parcels.length,
      };
    });

    test.skip(result.skip === true, 'Sharing encoding modules not loaded');
    expect(result.success).toBe(true);
    expect(result.nameMatch).toBe(true);
    expect(result.cityMatch).toBe(true);
    expect(result.parcelCount).toBe(2);
  });
});
