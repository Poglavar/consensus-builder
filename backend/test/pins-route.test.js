// POST /pins, the courier that pins a design or an agreement the browser addressed itself
// (routes/pins.js, plan-design-agreement.md M2): the server recomputes the CID from the exact bytes,
// takes only a canonical design/v1 or agreement/v1 object of at most 256 KiB, and answers only when
// Pinata pinned it under that CID. The pinning call is replaced through registerContentRoutes.
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createMockPool } from './helpers/mock-pool.js';
import { createContentApp } from './helpers/create-app.js';
import { canonicalBytes, cidOf } from '../cid.js';
import { MAX_PINNED_OBJECT_BYTES } from '../storage/pinning.js';
import { createUploadRateLimiter } from '../utils/nft-asset-upload.js';
import { agreementContent, designContent } from './helpers/content-fixtures.js';

const PINNED_AT = '2026-10-21T10:00:00.000Z';
const pinError = (code, status, extra = {}) => Object.assign(new Error(code), { code, status, ...extra });

function appWith(pinBytes = vi.fn(async ({ cid }) => ({ cid, pinnedAt: PINNED_AT })), overrides = {}) {
    return { app: createContentApp(createMockPool(), { pinBytes, thumbnailQueue: { enqueue: vi.fn() }, ...overrides }), pinBytes };
}
// The body the browser sends for an object: its canonical bytes, base64, under their CID.
function pinBody(kind, object) {
    const bytes = canonicalBytes(object);
    return { kind, cid: cidOf(bytes), bytes: bytes.toString('base64') };
}
const raw = (kind, text) => {
    const bytes = Buffer.from(text, 'utf8');
    return { kind, cid: cidOf(bytes), bytes: bytes.toString('base64') };
};

describe('POST /pins', () => {
    it('pins a canonical design and an agreement under their CIDs, exactly as sent', async () => {
        const { app, pinBytes } = appWith();
        const design = designContent();
        const body = pinBody('design', design);
        const res = await request(app).post('/pins').send(body);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ cid: body.cid, pinnedAt: PINNED_AT });
        expect(pinBytes).toHaveBeenCalledTimes(1);
        const [{ bytes, name, cid }] = pinBytes.mock.calls[0];
        expect(cid).toBe(body.cid);
        expect(name).toBe(`design-${body.cid}`);
        expect(Buffer.from(bytes).equals(canonicalBytes(design))).toBe(true);

        const agreement = pinBody('agreement', agreementContent([design]));
        expect((await request(app).post('/pins').send(agreement)).body).toEqual({ cid: agreement.cid, pinnedAt: PINNED_AT });
        expect(pinBytes.mock.calls[1][0].name).toBe(`agreement-${agreement.cid}`);
    });

    it('refuses a malformed request before anything is decoded', async () => {
        const { app, pinBytes } = appWith();
        const good = pinBody('design', designContent());
        const cases = [
            [[], 400, 'bad-request'],
            [{ ...good, extra: 1 }, 400, 'bad-request'],
            [{ ...good, kind: 'proposal' }, 400, 'invalid-kind'],
            [{ ...good, kind: 'toString' }, 400, 'invalid-kind'],
            [{ ...good, cid: good.cid.toUpperCase() }, 400, 'invalid-cid'],
            [{ ...good, cid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG' }, 400, 'invalid-cid'],
            [{ ...good, bytes: '' }, 400, 'invalid-bytes'],
            [{ ...good, bytes: 'not base64!' }, 400, 'invalid-bytes'],
            [{ ...good, bytes: { data: [1, 2] } }, 400, 'invalid-bytes'],
            [{ ...good, bytes: Buffer.from('{}').toString('base64url').replace(/=+$/, '') }, 400, 'invalid-bytes']
        ];
        for (const [body, status, code] of cases) {
            const res = await request(app).post('/pins').send(body);
            expect([res.status, res.body.code], JSON.stringify(body).slice(0, 80)).toEqual([status, code]);
        }
        expect(pinBytes).not.toHaveBeenCalled();
    });

    it('refuses bytes that are not the CID they are sent under, naming the CID they are', async () => {
        const { app, pinBytes } = appWith();
        const body = pinBody('design', designContent());
        const other = canonicalBytes(designContent({ title: 'Changed after addressing' }));
        const res = await request(app).post('/pins').send({ ...body, bytes: other.toString('base64') });
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: 'cid-mismatch', cid: body.cid, computedCid: cidOf(other) });
        expect(pinBytes).not.toHaveBeenCalled();
    });

    it('pins nothing but canonical objects of the named kind that the index would take', async () => {
        const { app, pinBytes } = appWith();
        const design = designContent();
        const cases = [
            [raw('design', '{"not json"'), 400, 'invalid-object'],
            [{ kind: 'design', cid: cidOf(Buffer.from([0xff, 0xfe])), bytes: Buffer.from([0xff, 0xfe]).toString('base64') }, 400, 'invalid-object'],
            // The same object with whitespace, or keys out of order, is not its canonical form.
            [raw('design', JSON.stringify(design, null, 1)), 400, 'not-canonical'],
            [raw('design', JSON.stringify(design)), 400, 'not-canonical'],
            // Any JSON object is not a design: the courier is no open relay for our quota.
            [pinBody('design', { schema: 'note/v1', text: 'pin me for free' }), 400, 'invalid-kind'],
            [pinBody('agreement', design), 400, 'invalid-kind'],
            [pinBody('design', [1, 2, 3]), 400, 'invalid-kind'],
            [pinBody('design', designContent({ goal: '' })), 400, 'invalid-design'],
            [pinBody('agreement', agreementContent([design], { designs: [] })), 400, 'invalid-agreement'],
            [pinBody('agreement', agreementContent([design], { deadline: '2001-01-01T00:00:00.000Z' })), 422, 'deadline-past']
        ];
        for (const [body, status, code] of cases) {
            const res = await request(app).post('/pins').send(body);
            expect([res.status, res.body.code], code).toEqual([status, code]);
        }
        const invalid = await request(app).post('/pins').send(pinBody('design', designContent({ goal: '', origin: { cid: 'x' } })));
        expect(invalid.body.errors.map(error => error.code)).toEqual(expect.arrayContaining(['design-goal', 'design-origin']));
        const section = await request(app).post('/pins').send(pinBody('agreement', agreementContent([design], { money: { currency: 'USD', lines: [] } })));
        expect(section.body).toMatchObject({ code: 'invalid-agreement', section: 'money' });
        expect(pinBytes).not.toHaveBeenCalled();
    });

    it('takes at most 256 KiB, refused before or after decoding', async () => {
        const { app, pinBytes } = appWith();
        // Decodes to one byte over the cap, in base64 that still fits the encoded bound.
        const justOver = Buffer.alloc(MAX_PINNED_OBJECT_BYTES + 1, 0x20);
        const decoded = await request(app).post('/pins').send({ kind: 'design', cid: cidOf(justOver), bytes: justOver.toString('base64') });
        expect([decoded.status, decoded.body.code]).toEqual([413, 'too-large']);
        const farOver = Buffer.alloc(MAX_PINNED_OBJECT_BYTES + 3, 0x20);
        const encoded = await request(app).post('/pins').send({ kind: 'design', cid: cidOf(farOver), bytes: farOver.toString('base64') });
        expect([encoded.status, encoded.body.code]).toEqual([413, 'too-large']);
        expect(pinBytes).not.toHaveBeenCalled();
    });

    it('answers 409 when Pinata pinned another CID, 503 unconfigured and 502 for any other failure', async () => {
        const body = pinBody('design', designContent());
        const pinnedCid = cidOf(Buffer.from('other'));
        const mismatch = await request(appWith(vi.fn(async () => { throw pinError('cid-mismatch', 409, { cid: body.cid, pinnedCid }); })).app)
            .post('/pins').send(body);
        expect(mismatch.status).toBe(409);
        expect(mismatch.body).toMatchObject({ code: 'cid-mismatch', cid: body.cid, pinnedCid });

        const unconfigured = await request(appWith(vi.fn(async () => { throw pinError('pinning-unconfigured', 503); })).app)
            .post('/pins').send(body);
        expect([unconfigured.status, unconfigured.body.code]).toEqual([503, 'pinning-unconfigured']);

        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const failed = await request(appWith(vi.fn(async () => { throw pinError('pin-failed', 502); })).app).post('/pins').send(body);
        error.mockRestore();
        expect([failed.status, failed.body.code]).toEqual([502, 'pin-failed']);
    });

    it('is behind the per-client upload limiter, whose refusal says when to try again', async () => {
        const { app, pinBytes } = appWith(undefined, { uploadRateLimiter: createUploadRateLimiter({ windowMs: 60_000, limit: 1 }) });
        const body = pinBody('design', designContent());
        expect((await request(app).post('/pins').send(body)).status).toBe(200);
        const limited = await request(app).post('/pins').send(body);
        expect(limited.status).toBe(429);
        // The browser words the wait from this (proposals/design-sync.js refusalMessage).
        expect(limited.body).toMatchObject({ code: 'upload-rate-limited', retryAfterSeconds: expect.any(Number) });
        expect(limited.body.retryAfterSeconds).toBeGreaterThan(0);
        expect(limited.body.retryAfterSeconds).toBeLessThanOrEqual(60);
        expect(pinBytes).toHaveBeenCalledTimes(1);
    });
});
