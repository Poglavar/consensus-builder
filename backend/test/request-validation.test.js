import { describe, expect, it, vi } from 'vitest';
import {
    createJsonBodyValidator,
    isPlainObject,
    validators
} from '../utils/request-validation.js';

function createMockRes() {
    return {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis()
    };
}

describe('isPlainObject', () => {
    it('accepts plain objects and null-prototype objects', () => {
        expect(isPlainObject({ foo: 'bar' })).toBe(true);
        expect(isPlainObject(Object.create(null))).toBe(true);
    });

    it('rejects arrays, dates, and nullish values', () => {
        expect(isPlainObject([])).toBe(false);
        expect(isPlainObject(new Date())).toBe(false);
        expect(isPlainObject(null)).toBe(false);
        expect(isPlainObject(undefined)).toBe(false);
    });
});

describe('createJsonBodyValidator', () => {
    it('rejects non-object request bodies', () => {
        const middleware = createJsonBodyValidator({
            schema: { name: { required: true, validate: validators.string() } }
        });
        const req = { body: [] };
        const res = createMockRes();
        const next = vi.fn();

        middleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: 'Invalid request body. Expected a JSON object.' });
        expect(next).not.toHaveBeenCalled();
    });

    it('rejects unsupported fields by default', () => {
        const middleware = createJsonBodyValidator({
            schema: { name: { validate: validators.string() } }
        });
        const req = { body: { name: 'Alice', extra: true } };
        const res = createMockRes();
        const next = vi.fn();

        middleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: 'Request body contains unsupported fields.' });
        expect(next).not.toHaveBeenCalled();
    });

    it('allows unknown fields when configured and stores only validated values', () => {
        const middleware = createJsonBodyValidator({
            schema: {
                name: { validate: validators.string() },
                count: { validate: validators.finiteNumber({ integer: true }) },
                note: { validate: validators.optional(validators.string(), { nullValue: null }) }
            },
            allowUnknownFields: true
        });
        const req = { body: { name: '  Alice  ', count: '2', note: '   ', keepFlexible: { any: 'shape' } } };
        const res = createMockRes();
        const next = vi.fn();

        middleware(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.validatedBody).toEqual({
            name: 'Alice',
            count: 2,
            note: null
        });
        expect(res.status).not.toHaveBeenCalled();
    });

    it('uses required-field validation messages', () => {
        const middleware = createJsonBodyValidator({
            schema: {
                title: {
                    required: true,
                    missingMessage: 'title is mandatory.',
                    validate: validators.string()
                }
            }
        });
        const req = { body: {} };
        const res = createMockRes();
        const next = vi.fn();

        middleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: 'title is mandatory.' });
        expect(next).not.toHaveBeenCalled();
    });
});

describe('validators', () => {
    it('supports optional values and preserves empty strings when requested', () => {
        const optionalString = validators.optional(validators.string({ minLength: 1 }), {
            nullValue: null,
            treatEmptyStringAsMissing: false
        });

        expect(optionalString(undefined, 'name')).toEqual({ ok: true, value: null });
        expect(optionalString('', 'name')).toEqual({ ok: false, error: 'name must be at least 1 characters.' });
    });

    it('normalizes strings and rejects invalid control characters', () => {
        const validator = validators.string({ minLength: 2, disallowControlChars: true });

        expect(validator('  ok  ', 'label')).toEqual({ ok: true, value: 'ok' });
        expect(validator('a', 'label')).toEqual({ ok: false, error: 'label must be at least 2 characters.' });
        expect(validator('bad\u0000value', 'label')).toEqual({ ok: false, error: 'label contains invalid control characters.' });
    });

    it('parses finite numbers from strings and enforces integer and bounds', () => {
        const validator = validators.finiteNumber({ integer: true, min: 2, max: 4 });

        expect(validator(' 3 ', 'count')).toEqual({ ok: true, value: 3 });
        expect(validator('', 'count')).toEqual({ ok: false, error: 'count must be a valid number.' });
        expect(validator(1.5, 'count')).toEqual({ ok: false, error: 'count must be an integer.' });
        expect(validator(5, 'count')).toEqual({ ok: false, error: 'count must be at most 4.' });
    });

    it('validates plain objects and dates', () => {
        const objectValidator = validators.plainObject();
        const dateValidator = validators.date();
        const date = new Date('2025-01-02T03:04:05.000Z');

        expect(objectValidator({ nested: true }, 'metadata')).toEqual({ ok: true, value: { nested: true } });
        expect(objectValidator([], 'metadata')).toEqual({ ok: false, error: 'metadata must be an object.' });
        expect(dateValidator(date, 'startsAt')).toEqual({ ok: true, value: new Date('2025-01-02T03:04:05.000Z') });
        expect(dateValidator('not-a-date', 'startsAt')).toEqual({ ok: false, error: 'startsAt must be a valid date.' });
    });

    it('validates arrays and rejects duplicates after normalization', () => {
        const validator = validators.arrayOf(validators.string(), { minItems: 1, unique: true });

        expect(validator([' Alpha ', 'Beta'], 'tags')).toEqual({ ok: true, value: ['Alpha', 'Beta'] });
        expect(validator([], 'tags')).toEqual({ ok: false, error: 'tags must contain at least 1 items.' });
        expect(validator([' Alpha ', 'Alpha'], 'tags')).toEqual({ ok: false, error: 'tags must not contain duplicates.' });
    });

    it('validates absolute http urls', () => {
        const validator = validators.httpUrl({ maxLength: 30 });

        expect(validator(' https://example.com ', 'link')).toEqual({ ok: true, value: 'https://example.com' });
        expect(validator('/relative/path', 'link')).toEqual({ ok: false, error: 'link must be a valid absolute URL.' });
        expect(validator('ftp://example.com', 'link')).toEqual({ ok: false, error: 'link must use http or https.' });
    });
});