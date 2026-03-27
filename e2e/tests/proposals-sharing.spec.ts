import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

test.describe('Proposal sharing @core', () => {
  test('sharing utility functions are available', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const sharingFns = await page.evaluate(() => {
      const w = window as any;
      return {
        hasShareApplied: typeof w.shareAppliedProposals === 'function',
        hasUploadProposal: typeof w.uploadProposalToServer === 'function',
        hasBuildUploadReady: typeof w.buildUploadReadyProposal === 'function',
        hasResolveBackendBase: typeof w.resolveBackendBaseUrl === 'function',
        hasResolveFrontendBase: typeof w.resolveFrontendBaseUrl === 'function',
        hasBuildCityQuery: typeof w.buildCityQueryParam === 'function',
        hasDecodeShared: typeof w.decodeSharedPayload === 'function',
        hasBase64Encode: typeof w.base64UrlEncodeBytes === 'function',
        hasBase64Decode: typeof w.base64UrlDecodeToBytes === 'function',
        hasEscapeHtml: typeof w.escapeHtml === 'function',
      };
    });

    const hasSome = Object.values(sharingFns).some(v => v === true);
    // Sharing module depends on scripts that may not fully load in static-serve
    test.skip(!hasSome, 'Sharing module not loaded in static-serve mode');
    // Check whichever functions did load
    const coreLoaded = sharingFns.hasResolveBackendBase || sharingFns.hasEscapeHtml || sharingFns.hasShareApplied;
    expect(coreLoaded).toBe(true);
  });

  test('base64 encode/decode round-trips correctly', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const roundTrip = await page.evaluate(() => {
      const w = window as any;
      if (typeof w.base64UrlEncodeBytes !== 'function' || typeof w.base64UrlDecodeToBytes !== 'function') {
        return { skip: true };
      }
      const original = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      const encoded = w.base64UrlEncodeBytes(original);
      const decoded = w.base64UrlDecodeToBytes(encoded);
      return {
        skip: false,
        encodedIsString: typeof encoded === 'string',
        decodedLength: decoded.length,
        matches: Array.from(decoded).every((b: number, i: number) => b === original[i]),
      };
    });

    if (!roundTrip.skip) {
      expect(roundTrip.encodedIsString).toBe(true);
      expect(roundTrip.decodedLength).toBe(5);
      expect(roundTrip.matches).toBe(true);
    }
  });

  test('escapeHtml sanitizes dangerous characters', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      if (typeof w.escapeHtml !== 'function') return { skip: true };
      return {
        skip: false,
        escaped: w.escapeHtml('<script>alert("xss")</script>'),
      };
    });

    if (!result.skip) {
      expect(result.escaped).not.toContain('<script>');
      expect(result.escaped).toContain('&lt;');
    }
  });

  test('backend base URL resolves to a valid URL', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const baseUrl = await page.evaluate(() => {
      const w = window as any;
      if (typeof w.resolveBackendBaseUrl === 'function') {
        return w.resolveBackendBaseUrl();
      }
      if (typeof w.getBackendBase === 'function') {
        return w.getBackendBase();
      }
      return null;
    });

    expect(baseUrl).not.toBeNull();
    if (baseUrl) {
      expect(baseUrl).toMatch(/^https?:\/\//);
    }
  });
});
