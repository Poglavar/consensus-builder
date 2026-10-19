import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../parcels/portable-hash.js';

describe('portable SHA-256', () => {
    it('matches standard UTF-8 and byte-array SHA-256 vectors', () => {
        expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
        expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
        expect(sha256Hex(Uint8Array.of(0, 1, 2, 253, 254, 255)))
            .toBe('3f2d1552cdc7483f40dd720c80b900225dfecfd5cae7cd168d79ab6ee5959885');
    });
});
