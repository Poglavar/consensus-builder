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

  // A shared proposal arrives ALREADY marked applied, carrying the SENDER's childParcelIds —
  // slice ids this browser never generated. isParcelReplacedByChildren must not treat the parent
  // as consumed on the strength of those foreign ids alone: ten call sites key off it (the
  // shared-link parcel fetcher, the recovery paths, ingest), and every one of them drops the
  // parent when it answers yes. With the parent gone and the slices never generated, the proposal
  // still draws — its visuals are interactive:false and come from proposal data — over a
  // parcel-shaped hole with nothing to click. That is the "visible after reload, but dead" bug.
  test('a parent is replaced only when a replacement slice exists on THIS device', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      if (typeof w.isParcelReplacedByChildren !== 'function'
        || !w.proposalStorage
        || typeof w.getParcelLayerIdMap !== 'function') {
        return { skip: true };
      }

      const layerIndex = w.getParcelLayerIdMap();
      const parcelId = 'HR-000000-9999';
      const sliceId = `${parcelId}#p-sharedfromelsewhere-1`;

      w.proposalStorage.importProposal({
        proposalId: 'p-sharedfromelsewhere',
        title: 'Shared from another device',
        status: 'Applied',
        goal: 'road',
        parentParcelIds: [parcelId],
        childParcelIds: [sliceId],
        roadProposal: { status: 'applied', parentParcelIds: [parcelId], childParcelIds: [sliceId] },
      }, { overwrite: true, preserveStatus: true });
      w.proposalStorage._indexProposal?.(w.proposalStorage.getProposal('p-sharedfromelsewhere'));

      // The sender's slice was never generated here -> the parent must survive.
      const replacedWithoutSlice = w.isParcelReplacedByChildren(parcelId);

      // Once a replacement slice really is on this device, the parent is genuinely superseded.
      // (The predicate only scans the index's keys, so a placeholder entry is enough.)
      layerIndex.set(sliceId, { __testPlaceholder: true });
      const replacedWithSlice = w.isParcelReplacedByChildren(parcelId);

      layerIndex.delete(sliceId);

      return { skip: false, replacedWithoutSlice, replacedWithSlice };
    });

    test.skip(result.skip === true, 'Proposal storage / parcel index not loaded');
    expect(result.replacedWithoutSlice, 'parent must NOT be replaced when its slices are absent here').toBe(false);
    expect(result.replacedWithSlice, 'parent MUST still be replaced once a slice exists here').toBe(true);
  });
});
