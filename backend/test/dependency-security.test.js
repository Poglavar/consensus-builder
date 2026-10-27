import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import proxyaddr from 'proxy-addr';
import { z } from 'zod';

const require = createRequire(import.meta.url);
const fromToken = createRequire(require.resolve('@solana/spl-token'));
const fromLayout = createRequire(fromToken.resolve('@solana/buffer-layout-utils'));
const bigint = fromLayout('bigint-buffer');

describe('dependency security regressions', () => {
    it('does not trust arbitrary IPv4 clients through a short IPv4-mapped IPv6 subnet', () => {
        const req = {
            socket: { remoteAddress: '203.0.113.10' },
            headers: { 'x-forwarded-for': '198.51.100.20' }
        };
        expect(proxyaddr(req, proxyaddr.compile(['::ffff:10.0.0.0/8'])))
            .toBe(req.socket.remoteAddress);
    });

    it('rejects an oversized constrained array before collecting per-element errors', () => {
        const result = z.array(z.number()).max(2).safeParse(Array(4096).fill('invalid'));
        expect(result.success).toBe(false);
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0].code).toBe('too_big');
    });

    it('uses the native-free BigInt implementation through the actual Solana dependency', () => {
        const pkg = fromLayout('bigint-buffer/package.json');
        expect(pkg.name).toBe('@exodus/bigint-buffer');
        expect(pkg.scripts.install).toBeUndefined();
        expect(pkg.dependencies).toBeUndefined();
    });

    it.each([0, 1, 3, 7, 8, 9, 16, 32, 257])('round-trips %i bytes in both byte orders without mutating input', width => {
        const input = Buffer.from(Array.from({ length: width }, (_, i) => (i * 31 + 7) % 256));
        const original = Buffer.from(input);
        const expectedLE = [...input].reverse().map(v => v.toString(16).padStart(2, '0')).join('');
        const expectedBE = input.toString('hex');
        expect(bigint.toBigIntLE(input)).toBe(BigInt(`0x${expectedLE || '0'}`));
        expect(bigint.toBigIntBE(input)).toBe(BigInt(`0x${expectedBE || '0'}`));
        expect(bigint.toBufferLE(bigint.toBigIntLE(input), width)).toEqual(input);
        expect(bigint.toBufferBE(bigint.toBigIntBE(input), width)).toEqual(input);
        expect(input).toEqual(original);
    });

    it('preserves the full unsigned token amount range through Solana layouts', () => {
        const { u64 } = fromToken('@solana/buffer-layout-utils');
        const layout = u64(), bytes = Buffer.alloc(8), maximum = (1n << 64n) - 1n;
        expect(layout.encode(maximum, bytes, 0)).toBe(8);
        expect(bytes).toEqual(Buffer.alloc(8, 255));
        expect(layout.decode(bytes, 0)).toBe(maximum);
    });
});
