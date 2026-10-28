import type { Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Use the hosted service's object store and transport envelope; never put geometry in a URL.
export async function privatePreview(page: Page, origin: string, artifact: Record<string, unknown>): Promise<string> {
  const { createPreviewLinks } = await import('../../backend/agents/mcp-preview-links.js');
  const storeDirectory = mkdtempSync(join(tmpdir(), 'ugt-e2e-private-preview-'));
  const store = createPreviewLinks({ origin, appOrigin: origin, storeDirectory });
  page.once('close', () => {
    store.dispose();
    rmSync(storeDirectory, { recursive: true, force: true });
  });
  const preview = store.create({ parcelSourceId: 'oss-wfs', ...artifact });
  if (!preview.previewUrl) throw new Error('The private preview fixture could not be stored');
  await page.route(url => url.origin === new URL(origin).origin && url.pathname.startsWith('/mcp/previews/'), route => {
    const row = store.get(new URL(route.request().url()).pathname.split('/').at(-1));
    return route.fulfill({ status: row ? 200 : 410, json: row || { code: 'preview-expired' } });
  });
  return preview.previewUrl;
}
