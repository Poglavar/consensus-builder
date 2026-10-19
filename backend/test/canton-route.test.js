// Canton provider failures must be observable server-side without exposing the
// provider's OAuth or ledger response to public callers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendCantonUnavailable } from '../routes/canton.js';

describe('Canton route failures', () => {
  it('logs the operation and returns a sanitized service-unavailable response', () => {
    const providerError = new Error('invalid client secret from upstream');
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    sendCantonUnavailable({ status }, 'parcel-counts', providerError);

    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({
      error: 'Canton ledger is temporarily unavailable',
      code: 'canton_unavailable',
    });
    expect(JSON.stringify(json.mock.calls)).not.toContain('client secret');
    expect(consoleSpy).toHaveBeenCalledWith('[canton] parcel-counts failed:', providerError);
    consoleSpy.mockRestore();
  });
});

// The server's Canton credentials can act as ANY party. Before these checks, /canton/* let any
// caller accept a proposal as any owner, allocate unlimited parties, and read any party's
// contracts. Writes now need the admin token; reads without it are limited to the public party.
describe('Canton route authorization', () => {
  const PUBLIC = 'CantonPublic::1220abc';
  const mocks = vi.hoisted(() => ({
    acceptProposal: vi.fn(async () => ({ ok: true, sales: [] })),
    allocateDemoParty: vi.fn(async () => ({ party: 'Stranger::1' })),
    createProposal: vi.fn(async () => ({ ok: true })),
    listProposalsForParty: vi.fn(async () => []),
    listSalesForParty: vi.fn(async () => []),
    listParcelCounts: vi.fn(async () => ({})),
    knownPublicParty: vi.fn(async () => 'CantonPublic::1220abc'),
    ccviewParty: vi.fn(async () => ({})),
  }));
  vi.mock('../canton/proposals.js', () => ({
    acceptProposal: mocks.acceptProposal,
    allocateDemoParty: mocks.allocateDemoParty,
    createProposal: mocks.createProposal,
    listProposalsForParty: mocks.listProposalsForParty,
    listSalesForParty: mocks.listSalesForParty,
    listParcelCounts: mocks.listParcelCounts,
    knownPublicParty: mocks.knownPublicParty,
  }));
  vi.mock('../canton/ccview.js', () => ({ ccviewParty: mocks.ccviewParty }));
  vi.mock('../canton/ledger.js', () => ({ ledgerEnd: vi.fn(async () => 1) }));

  let app;
  let request;
  const savedToken = process.env.CANTON_ADMIN_TOKEN;
  beforeEach(async () => {
    Object.values(mocks).forEach((m) => m.mockClear());
    process.env.CANTON_ADMIN_TOKEN = 'correct-horse-battery-staple';
    const express = (await import('express')).default;
    request = (await import('supertest')).default;
    const { setupCantonRoute } = await import('../routes/canton.js');
    app = express();
    app.use(express.json());
    setupCantonRoute(app);
  });
  afterEach(() => {
    if (savedToken === undefined) delete process.env.CANTON_ADMIN_TOKEN; else process.env.CANTON_ADMIN_TOKEN = savedToken;
  });

  it('refuses to accept on behalf of an owner without the admin token', async () => {
    const res = await request(app).post('/canton/proposals/cid1/accept').send({ owner: 'Victim::1' });
    expect(res.status).toBe(401);
    const wrong = await request(app).post('/canton/proposals/cid1/accept').set('x-canton-admin-token', 'guess').send({ owner: 'Victim::1' });
    expect(wrong.status).toBe(401);
    expect(mocks.acceptProposal).not.toHaveBeenCalled();
  });

  it('refuses party allocation and proposal creation without the admin token', async () => {
    expect((await request(app).post('/canton/parties').send({ hint: 'x' })).status).toBe(401);
    expect((await request(app).post('/canton/proposals').send({ parcelId: 'p', price: 1 })).status).toBe(401);
    expect(mocks.allocateDemoParty).not.toHaveBeenCalled();
    expect(mocks.createProposal).not.toHaveBeenCalled();
  });

  it('allows writes with the admin token', async () => {
    const res = await request(app).post('/canton/proposals/cid1/accept')
      .set('x-canton-admin-token', 'correct-horse-battery-staple').send({ owner: 'Owner::1' });
    expect(res.status).toBe(200);
    expect(mocks.acceptProposal).toHaveBeenCalledWith('cid1', 'Owner::1');
  });

  it('refuses writes entirely when no admin token is configured', async () => {
    delete process.env.CANTON_ADMIN_TOKEN;
    const res = await request(app).post('/canton/parties').set('x-canton-admin-token', '').send({});
    expect(res.status).toBe(503);
    expect(mocks.allocateDemoParty).not.toHaveBeenCalled();
  });

  it('limits party reads to the public party unless admin', async () => {
    const other = await request(app).get('/canton/proposals?party=Someone::9');
    expect(other.status).toBe(403);
    expect((await request(app).get('/canton/sales?party=Someone::9')).status).toBe(403);
    expect((await request(app).get('/canton/ccview/Someone::9')).status).toBe(403);
    expect(mocks.listProposalsForParty).not.toHaveBeenCalled();
    expect(mocks.listSalesForParty).not.toHaveBeenCalled();

    expect((await request(app).get(`/canton/proposals?party=${encodeURIComponent(PUBLIC)}`)).status).toBe(200);
    const admin = await request(app).get('/canton/proposals?party=Someone::9').set('x-canton-admin-token', 'correct-horse-battery-staple');
    expect(admin.status).toBe(200);
  });

  it('rate limits per IP', async () => {
    const { CANTON_RATE_MAX } = await import('../routes/canton.js');
    let last;
    for (let i = 0; i <= CANTON_RATE_MAX; i++) last = await request(app).get('/canton/parcel-counts');
    expect(last.status).toBe(429);
  });
});
