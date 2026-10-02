import { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** In-memory boundary for proposals published by one page and consumed by another. */
export interface SharedProposalServer {
  records: Map<string, Record<string, any>>;
  requests: Array<{ method: string; path: string }>;
  nextId: number;
}

export function createSharedProposalServer(): SharedProposalServer {
  return { records: new Map(), requests: [], nextId: 7001 };
}

/**
 * Model the public proposal API contract used by publishing and shared-plan imports. The same
 * server object can be attached to pages in separate browser contexts to model another device.
 */
export async function attachSharedProposalServer(page: Page, server: SharedProposalServer): Promise<void> {
  await page.route('**/proposals**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/\/$/, '');

    // The local static server has no production-style SPA rewrite. Serve the real app shell for a
    // proposal deep-link document request so its actual pathname reaches the app router. Never
    // serve JSON for a browser navigation, and leave chain-proposal or unrelated paths alone.
    if (request.isNavigationRequest()) {
      if (request.method() === 'GET' && /^\/proposals\/[0-9,]+$/.test(path)) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: readFileSync(resolve(__dirname, '../../../frontend/index.html'), 'utf8'),
        });
      } else {
        await route.fallback();
      }
      return;
    }

    // This helper is an API data boundary. It must not capture HTML, scripts, styles or images
    // whose URL happens to contain the word "proposals".
    if (request.resourceType() !== 'fetch' && request.resourceType() !== 'xhr') {
      await route.fallback();
      return;
    }

    const rootIndex = path.lastIndexOf('/proposals');
    const suffix = rootIndex >= 0 ? path.slice(rootIndex + '/proposals'.length).replace(/^\//, '') : null;
    if (suffix === null || !['', 'batch', 'binding', 'count', 'summary'].includes(suffix)
        && !/^\d+$/.test(suffix) && !/^p-[a-z0-9]+$/i.test(suffix)) {
      await route.fallback();
      return;
    }
    server.requests.push({ method: request.method(), path });

    if (path.endsWith('/proposals/batch') && request.method() === 'POST') {
      const body = request.postDataJSON() as { ids?: string[] };
      const items = (Array.isArray(body.ids) ? body.ids : []).map(rawId => {
        const id = String(rawId);
        const proposal = server.records.get(id);
        return proposal ? { id, proposal } : { id, proposal: null };
      });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items }) });
      return;
    }

    // A publish asks the proposal API which cadastral parcels the authored site touches. Unknown
    // coverage is a valid contract response: it leaves the proposal's declared parcel ids intact.
    if (path.endsWith('/proposals/binding') && request.method() === 'POST') {
      const body = request.postDataJSON() as { toleranceM?: number };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ binding: {
          parcels: [], touched: [], toleranceM: Number(body.toleranceM) || 0,
          coverage: 'unknown', unsurveyedM2: 0, siteM2: 0, source: 'server:mock-unavailable-cadastre',
        } }),
      });
      return;
    }

    if (!suffix && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, any>;
      const id = String(server.nextId++);
      const record = { ...body, id: Number(id) };
      server.records.set(id, record);
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: Number(id), proposalId: id }) });
      return;
    }

    if (suffix === 'count' && request.method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: server.records.size }) });
      return;
    }
    if (suffix === 'summary' && request.method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ proposals: [...server.records.values()], total: server.records.size }) });
      return;
    }

    if (suffix && /^\d+$/.test(suffix)) {
      const record = server.records.get(suffix);
      if (request.method() === 'HEAD') {
        await route.fulfill({ status: record ? 200 : 404, body: '' });
        return;
      }
      if (request.method() === 'GET') {
        await route.fulfill(record
          ? { status: 200, contentType: 'application/json', body: JSON.stringify(record) }
          : { status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Proposal not found' }) });
        return;
      }
    }

    // Locally authored proposals use p-* hashes before publishing. The default mock API returns a
    // generic proposal list for every GET, which falsely tells the share panel these hashes are
    // already uploaded. They are absent from this server until the real Upload control POSTs them.
    if (suffix && /^p-[a-z0-9]+$/i.test(suffix) && (request.method() === 'GET' || request.method() === 'HEAD')) {
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Proposal not found' }) });
      return;
    }

    // The default mock API owns unrelated endpoints and any unsupported proposal operation.
    await route.fallback();
  });
}
