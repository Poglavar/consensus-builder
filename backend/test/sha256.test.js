// The synchronous SHA-256 the market question builder uses must agree with node's crypto on every
// padding class (empty, under one block, exactly one block, two blocks, long) and on UTF-8 input.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const Sha256 = require('../../frontend/js/bets/sha256.js');

const reference = input => createHash('sha256').update(input).digest('hex');

describe('Sha256.hex', () => {
    it('matches node crypto on the known vectors and every padding boundary', () => {
        expect(Sha256.hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
        expect(Sha256.hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
        for (const length of [1, 54, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 4096]) {
            const text = 'a'.repeat(length);
            expect(Sha256.hex(text), `length ${length}`).toBe(reference(text));
        }
    });

    it('hashes UTF-8 text and raw bytes alike', () => {
        const text = 'US-CA-SF|4884039A,4884040 · Šibenik – čćž';
        expect(Sha256.hex(text)).toBe(reference(text));
        const bytes = new Uint8Array([0, 1, 2, 255, 128, 64]);
        expect(Sha256.hex(bytes)).toBe(reference(Buffer.from(bytes)));
        expect(Sha256.digest('abc')).toBeInstanceOf(Uint8Array);
        expect(Sha256.digest('abc').length).toBe(32);
        expect(() => Sha256.hex(42)).toThrow(/string or a Uint8Array/);
    });
});
