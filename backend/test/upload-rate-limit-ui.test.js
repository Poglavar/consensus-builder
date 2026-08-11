// Being told to wait is not the same as being told it failed.
//
// A plan uploads one proposal per request, deliberately — the author should see each one go rather
// than fire off a bundle they have not looked at. That makes the write limiter a ceiling on plan
// size, and hitting it is an ordinary event, not an error: 100 roads is an afternoon's drawing.
//
// What the author used to get was the generic "Failed to upload proposal. Please try again." once
// per remaining proposal — sixty-odd identical red lines, none of which said that waiting was the
// answer or for how long. The server sends the answer in a header; this reads it.

import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { rateLimitRetrySeconds, uploadRateLimitMessage } = require('../../frontend/js/proposals/server-sync.js');
const source = readFileSync(fileURLToPath(new URL('../../frontend/js/proposals/server-sync.js', import.meta.url)), 'utf8');

// A fetch Response is only consulted for headers here.
const responseWith = headers => ({
    headers: { get: name => (Object.prototype.hasOwnProperty.call(headers, name) ? headers[name] : null) }
});

afterEach(() => { delete globalThis.window; });

describe('reading how long to wait', () => {
    it('prefers RateLimit-Reset, which is what standardHeaders sends', () => {
        expect(rateLimitRetrySeconds(responseWith({ 'RateLimit-Reset': '480' }))).toBe(480);
    });

    it('falls back to Retry-After, the older spelling of the same thing', () => {
        expect(rateLimitRetrySeconds(responseWith({ 'Retry-After': '120' }))).toBe(120);
    });

    it('prefers Reset when both are present', () => {
        expect(rateLimitRetrySeconds(responseWith({ 'RateLimit-Reset': '60', 'Retry-After': '900' }))).toBe(60);
    });

    it('says it does not know rather than guessing zero', () => {
        // A proxy that strips the headers must not produce "try again in 0 minutes".
        expect(rateLimitRetrySeconds(responseWith({}))).toBe(null);
        expect(rateLimitRetrySeconds(responseWith({ 'RateLimit-Reset': 'soon' }))).toBe(null);
        expect(rateLimitRetrySeconds(responseWith({ 'RateLimit-Reset': '-5' }))).toBe(null);
        expect(rateLimitRetrySeconds(null)).toBe(null);
    });

    it('accepts zero, which means the window is about to turn over', () => {
        expect(rateLimitRetrySeconds(responseWith({ 'RateLimit-Reset': '0' }))).toBe(0);
    });
});

describe('what the author is told', () => {
    it('names the wait in whole minutes', () => {
        expect(uploadRateLimitMessage(480)).toMatch(/8 minutes/);
    });

    it('rounds up, so the advice is never early', () => {
        // 61 s is "about 2 minutes": telling someone to retry in 1 would just fail again.
        expect(uploadRateLimitMessage(61)).toMatch(/2 minutes/);
    });

    it('never says zero minutes', () => {
        expect(uploadRateLimitMessage(0)).toMatch(/1 minute\b/);
        expect(uploadRateLimitMessage(5)).toMatch(/1 minute\b/);
    });

    it('says minute, singular, when it is one', () => {
        expect(uploadRateLimitMessage(60)).toMatch(/1 minute\./);
    });

    it('still gives useful advice when the header was stripped', () => {
        const message = uploadRateLimitMessage(null);
        expect(message).toMatch(/wait a few minutes/i);
        expect(message).not.toMatch(/\bNaN\b|undefined|null/);
    });

    it('says it is about uploading, not that the proposal is broken', () => {
        // The old message was "Failed to upload proposal. Please try again." — which reads as "this
        // proposal is bad", and is what sent the author looking for a fault that was not there.
        expect(uploadRateLimitMessage(300).toLowerCase()).toContain('too many uploads');
        expect(uploadRateLimitMessage(300).toLowerCase()).not.toContain('failed');
    });

    it('uses the translation when one exists', () => {
        // …At, not …In: when the retry-after is known the message now names a CLOCK TIME as well
        // as a duration, and that is a different string with a different plural set.
        globalThis.window = { i18n: { t: (key, params) => `HR ${key} ${params.minutes}` } };
        expect(uploadRateLimitMessage(120)).toBe('HR proposalDrafts.uploadRateLimitedAt 2');
    });

    it('tells you WHEN, not only how long — a duration goes stale the moment you look away', () => {
        delete globalThis.window;
        const message = uploadRateLimitMessage(300);
        // A time of day, in whatever form the locale writes one.
        expect(message).toMatch(/\d{1,2}[:.]\d{2}/);
        expect(message).toMatch(/5 minutes/);
    });

    it('still says something useful when the server did not say when', () => {
        // The header is not always readable — it is not CORS-safe-listed, which is exactly how this
        // came to say "a few minutes" for weeks.
        delete globalThis.window;
        const message = uploadRateLimitMessage(null);
        expect(message.toLowerCase()).toContain('too many uploads');
        expect(message).not.toMatch(/\bNaN\b|undefined|null/);
    });

    it('ignores a lookup that just echoed the key back', () => {
        // i18n.t returns the key itself when there is no translation; that is not a message.
        globalThis.window = { i18n: { t: key => key } };
        expect(uploadRateLimitMessage(120)).toMatch(/2 minutes/);
    });

    it('survives an i18n that throws', () => {
        globalThis.window = { i18n: { t: () => { throw new Error('not loaded'); } } };
        expect(uploadRateLimitMessage(120)).toMatch(/2 minutes/);
    });
});

describe('the upload path uses it', () => {
    it('treats 429 separately from a genuine failure', () => {
        const upload = source.slice(source.indexOf('async function uploadProposalToServer'));
        expect(upload).toMatch(/response\.status === 429/);
        expect(upload.indexOf('response.status === 429'))
            .toBeLessThan(upload.indexOf("'Failed to upload proposal. Please try again.'"));
    });

    it('carries the wait out to the caller, not only inside the sentence', () => {
        const upload = source.slice(source.indexOf('async function uploadProposalToServer'));
        expect(upload).toMatch(/retryAfterSeconds: rateLimitRetrySeconds\(response\)/);
    });
});

describe('every locale can say it', () => {
    it.each(['en', 'hr', 'sr', 'es'])('%s has both strings, with plural forms', locale => {
        const dict = JSON.parse(readFileSync(fileURLToPath(new URL(`../../frontend/i18n/${locale}.json`, import.meta.url)), 'utf8'));
        const drafts = dict.proposalDrafts;
        expect(drafts.uploadRateLimited, `${locale} missing uploadRateLimited`).toBeTruthy();
        expect(drafts.uploadRateLimitedIn, `${locale} missing uploadRateLimitedIn`).toBeTruthy();
        expect(drafts.uploadRateLimitedIn.one).toContain('{minutes}');
        expect(drafts.uploadRateLimitedIn.other).toContain('{minutes}');
    });
});
