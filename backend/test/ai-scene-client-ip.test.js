// The AI scene route charges a real image provider per render, so its cooldown and daily quota are
// only worth as much as the key they count against. These lock the key down: it comes from req.ip
// (nginx real_ip + trust proxy 1), never from a client-supplied header, and one IPv6 visitor must
// not be able to walk their own /56 and get a fresh allowance with every request.

import { describe, expect, it } from 'vitest';
import { clientIp } from '../routes/ai-scene.js';

const request = (ip = undefined, headers = {}) => ({ headers, ip });

describe('clientIp', () => {
    it('buckets a whole IPv6 allocation to one key', () => {
        const first = clientIp(request('2001:db8:abcd:1234::1'));
        const second = clientIp(request('2001:db8:abcd:1234::9999'));
        const third = clientIp(request('2001:db8:abcd:12ff::feed'));
        expect(first).toBe(second);
        expect(first).toBe(third);
        expect(first).toContain('/');
    });

    it('separates genuinely different IPv6 allocations', () => {
        expect(clientIp(request('2001:db8:abcd:1234::1')))
            .not.toBe(clientIp(request('2001:db8:ffff:1234::1')));
    });

    it('leaves IPv4 addresses exactly as they were', () => {
        expect(clientIp(request('203.0.113.7'))).toBe('203.0.113.7');
        expect(clientIp(request('203.0.113.7'))).not.toBe(clientIp(request('203.0.113.8')));
    });

    it('ignores a forged CF-Connecting-IP header: a direct-to-origin caller cannot pick its bucket', () => {
        const forged = (v) => clientIp(request('198.51.100.9', { 'cf-connecting-ip': v }));
        expect(forged('203.0.113.1')).toBe('198.51.100.9');
        expect(forged('203.0.113.2')).toBe(forged('203.0.113.1'));
    });

    it('never returns an empty key when no address is available', () => {
        expect(clientIp(request())).toBe('unknown');
        expect(clientIp(request('   '))).toBe('unknown');
    });
});
