// The AI scene route charges a real image provider per render, so its cooldown and daily quota are
// only worth as much as the key they count against. These lock the key down: one IPv6 visitor must
// not be able to walk their own /56 and get a fresh allowance with every request.

import { describe, expect, it } from 'vitest';
import { clientIp } from '../routes/ai-scene.js';

const request = (headers = {}, ip = undefined) => ({ headers, ip });

describe('clientIp', () => {
    it('buckets a whole IPv6 allocation to one key', () => {
        const first = clientIp(request({ 'cf-connecting-ip': '2001:db8:abcd:1234::1' }));
        const second = clientIp(request({ 'cf-connecting-ip': '2001:db8:abcd:1234::9999' }));
        const third = clientIp(request({ 'cf-connecting-ip': '2001:db8:abcd:12ff::feed' }));
        expect(first).toBe(second);
        expect(first).toBe(third);
        expect(first).toContain('/');
    });

    it('separates genuinely different IPv6 allocations', () => {
        expect(clientIp(request({ 'cf-connecting-ip': '2001:db8:abcd:1234::1' })))
            .not.toBe(clientIp(request({ 'cf-connecting-ip': '2001:db8:ffff:1234::1' })));
    });

    it('leaves IPv4 addresses exactly as they were', () => {
        expect(clientIp(request({ 'cf-connecting-ip': '203.0.113.7' }))).toBe('203.0.113.7');
        expect(clientIp(request({ 'cf-connecting-ip': '203.0.113.7' })))
            .not.toBe(clientIp(request({ 'cf-connecting-ip': '203.0.113.8' })));
    });

    it('prefers the Cloudflare header over the proxy socket, and falls back to it', () => {
        expect(clientIp(request({ 'cf-connecting-ip': '203.0.113.7' }, '10.0.0.1'))).toBe('203.0.113.7');
        expect(clientIp(request({}, '203.0.113.9'))).toBe('203.0.113.9');
    });

    it('takes the client end of an appended proxy chain', () => {
        expect(clientIp(request({ 'cf-connecting-ip': '203.0.113.7, 70.41.3.18' }))).toBe('203.0.113.7');
    });

    it('never returns an empty key when no address is available', () => {
        expect(clientIp(request({}))).toBe('unknown');
        expect(clientIp(request({ 'cf-connecting-ip': '   ' }))).toBe('unknown');
    });
});
