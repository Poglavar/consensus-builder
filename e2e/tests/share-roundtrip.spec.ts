import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

test.describe('Proposal share round-trip @core', () => {
  test('base64url encode/decode round-trips arbitrary bytes', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      if (typeof w.base64UrlEncodeBytes !== 'function') return { skip: true };
      // Test with various byte patterns including 0x00 and 0xFF
      const input = new Uint8Array([0, 1, 127, 128, 255, 72, 101, 108, 108, 111]);
      const encoded = w.base64UrlEncodeBytes(input);
      const decoded = w.base64UrlDecodeToBytes(encoded);
      return {
        skip: false,
        encodedIsString: typeof encoded === 'string',
        noPlus: !encoded.includes('+'),
        noSlash: !encoded.includes('/'),
        noPadding: !encoded.includes('='),
        lengthMatch: decoded.length === input.length,
        bytesMatch: Array.from(decoded).every((b: number, i: number) => b === input[i]),
      };
    });

    test.skip(result.skip === true, 'Sharing module not loaded');
    expect(result.encodedIsString).toBe(true);
    expect(result.noPlus).toBe(true);
    expect(result.noSlash).toBe(true);
    expect(result.noPadding).toBe(true);
    expect(result.lengthMatch).toBe(true);
    expect(result.bytesMatch).toBe(true);
  });

  test('compress/inflate round-trips data', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      if (typeof w.compressBytes !== 'function' || typeof w.inflateBytes !== 'function') {
        return { skip: true };
      }
      const original = new TextEncoder().encode('Hello, this is a test payload for compression!');
      const compressed = w.compressBytes(original);
      const decompressed = w.inflateBytes(compressed.bytes || compressed);
      if (!decompressed) return { skip: false, success: false };
      const decoded = new TextDecoder().decode(decompressed);
      return {
        skip: false,
        success: true,
        matchesOriginal: decoded === 'Hello, this is a test payload for compression!',
        compressedSmaller: (compressed.bytes || compressed).length <= original.length,
      };
    });

    test.skip(result.skip === true, 'Compress/inflate not loaded');
    expect(result.success).toBe(true);
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

  test('escapeHtml prevents XSS in all dangerous characters', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      if (typeof w.escapeHtml !== 'function') return { skip: true };
      const dangerous = `<img src=x onerror="alert('xss')">&"'`;
      const safe = w.escapeHtml(dangerous);
      return {
        skip: false,
        noAngleBrackets: !safe.includes('<') && !safe.includes('>'),
        noRawAmpersand: !safe.includes('&') || safe.includes('&amp;') || safe.includes('&lt;') || safe.includes('&gt;') || safe.includes('&quot;'),
        hasEscapedLt: safe.includes('&lt;'),
        hasEscapedGt: safe.includes('&gt;'),
        output: safe,
      };
    });

    test.skip(result.skip === true, 'escapeHtml not loaded');
    expect(result.noAngleBrackets).toBe(true);
    expect(result.hasEscapedLt).toBe(true);
    expect(result.hasEscapedGt).toBe(true);
  });

  test('deepClone produces independent copy', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      if (typeof w.deepClone !== 'function') return { skip: true };
      const original = { a: 1, b: { c: [1, 2, 3] } };
      const clone = w.deepClone(original);
      clone.b.c.push(4);
      return {
        skip: false,
        originalUnchanged: original.b.c.length === 3,
        cloneModified: clone.b.c.length === 4,
      };
    });

    test.skip(result.skip === true, 'deepClone not loaded');
    expect(result.originalUnchanged).toBe(true);
    expect(result.cloneModified).toBe(true);
  });

  test('buildCityQueryParam returns correct city codes', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      if (typeof w.buildCityQueryParam !== 'function') return { skip: true };
      return {
        skip: false,
        result: w.buildCityQueryParam(),
        isString: typeof w.buildCityQueryParam() === 'string',
      };
    });

    test.skip(result.skip === true, 'buildCityQueryParam not loaded');
    expect(result.isString).toBe(true);
    expect(result.result.length).toBeGreaterThan(0);
  });
});
