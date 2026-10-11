import { Page } from '@playwright/test';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** In-memory boundary for proposals published by one page and consumed by another. */
export interface SharedProposalServer {
  records: Map<string, Record<string, any>>;
  requests: Array<{ method: string; path: string }>;
  nextId: number;
  /** Signed preparations handed out by POST /proposals/prepare, by preparation id (stored nowhere). */
  issued: Map<string, { signature: string; artifact: Record<string, any> }>;
  /** Artifacts stored beside their published record, by preparation id (consensus.proposal_prepared). */
  prepared: Map<string, Record<string, any>>;
  /** A refusal POST /proposals/prepare answers instead of preparing, e.g. a site in another city. */
  prepareRefusal: { status: number; body: Record<string, any> } | null;
}

export function createSharedProposalServer(): SharedProposalServer {
  return { records: new Map(), requests: [], nextId: 7001, issued: new Map(), prepared: new Map(), prepareRefusal: null };
}

// The protocol of backend/proposals/prepare.js, with a fixed test key: the artifact's digest is the
// sha256 of its JSON, its id the digest's prefix, and the signature an HMAC over the digest and time.
const MOCK_SIGNING_KEY = 'e2e-mock-signing-key';
const hex = (value: string) => createHash('sha256').update(value).digest('hex');

function prepareAnswer(server: SharedProposalServer, body: Record<string, any>): Record<string, any> {
  const proposal = body.proposal || {};
  const city = body.city || proposal.city || null;
  const artifact = {
    protocol: 'prepare/1',
    city,
    cadastreParcelIds: (proposal.cadastreParcelIds || []).map(String),
    binding: {
      parcels: [], touched: [], toleranceM: Number(body.toleranceM) || 0,
      coverage: 'unknown', unsurveyedM2: 0, siteM2: 0, source: 'server:mock-unavailable-cadastre',
    },
  };
  const digest = hex(JSON.stringify(artifact));
  const preparationId = `prep_${digest.slice(0, 32)}`;
  const preparedAt = new Date().toISOString();
  const signature = createHmac('sha256', MOCK_SIGNING_KEY).update(`prepare/1\n${digest}\n${preparedAt}`).digest('hex');
  server.issued.set(preparationId, { signature, artifact });
  return {
    preparationId, digest, preparedAt, signature, artifact,
    proposal: { ...proposal, city, preparation: { id: preparationId, digest, preparedAt, signature }, preparedArtifact: artifact },
  };
}

// POST /proposals checks the presented preparation as the API does: present, signed by this server,
// over exactly the artifact it was given. null = verified.
function preparationRefusal(server: SharedProposalServer, body: Record<string, any>): Record<string, any> | null {
  const preparation = body.preparation;
  if (!preparation || !preparation.id) return { code: 'preparation-required', error: 'Prepare the proposal first.' };
  if (!body.preparedArtifact) return { code: 'preparation-unknown', error: 'The prepared artifact is missing.' };
  const issued = server.issued.get(preparation.id);
  if (!issued || issued.signature !== preparation.signature
      || JSON.stringify(issued.artifact) !== JSON.stringify(body.preparedArtifact)) {
    return { code: 'preparation-invalid', error: 'The preparation was not signed by this server.' };
  }
  return null;
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
    if (suffix === null || !['', 'batch', 'binding', 'prepare', 'count', 'summary'].includes(suffix)
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

    // Every publication is prepared first (frontend/js/proposals/publish-binding.js): the server
    // signs an artifact and stores nothing until the record is published with it.
    if (path.endsWith('/proposals/prepare') && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, any>;
      if (server.prepareRefusal) {
        await route.fulfill({ status: server.prepareRefusal.status, contentType: 'application/json', body: JSON.stringify(server.prepareRefusal.body) });
        return;
      }
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(prepareAnswer(server, body)) });
      return;
    }

    if (!suffix && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, any>;
      const refusal = preparationRefusal(server, body);
      if (refusal) {
        await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify(refusal) });
        return;
      }
      const id = String(server.nextId++);
      // the artifact is stored beside the record, never in it
      const { preparedArtifact, ...stored } = body;
      server.prepared.set(String(body.preparation.id), preparedArtifact);
      const record = { ...stored, id: Number(id) };
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
