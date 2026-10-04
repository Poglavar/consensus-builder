import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { createPublicSourceFetch, validatePublicSourceUrl, isPublicSourceAddress } from '../parcels/public-source-fetch.js';

function transport(replies) {
    const calls = [];
    const requestImpl = vi.fn((options, callback) => {
        const req = new EventEmitter(); req.destroy = vi.fn();
        req.end = body => {
            calls.push({ options, body, req });
            queueMicrotask(() => {
                const reply = replies.shift();
                const res = new EventEmitter(); res.destroy = vi.fn();
                res.statusCode = reply.status ?? 200; res.headers = reply.headers ?? {};
                callback(res);
                if (reply.wait) return;
                for (const chunk of reply.chunks ?? ['{"ok":true}']) res.emit('data', Buffer.from(chunk));
                res.emit(reply.aborted ? 'aborted' : 'end');
            });
        }; return req;
    });
    return { requestImpl, calls };
}
const publicLookup = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]);
function client(replies, options = {}) { const wire = transport(replies);return { ...wire, fetch: createPublicSourceFetch({ lookupImpl: publicLookup, requestImpl: wire.requestImpl, ...options }) }; }

describe('public source URL and address policy', () => {
    it('normalizes public HTTPS URLs and assigns a safe 400 validation error', () => {
        expect(validatePublicSourceUrl('https://EXAMPLE.com:443/data?a=1').href).toBe('https://example.com/data?a=1');
        for (const url of ['http://example.com', 'https://example.com:8443', 'https://user:secret@example.com/',
            'https://example.com/#fragment', 'https://127.1', 'https://[::1]', 'https://example.com/?api_key=secret',
            'https://example.com/?access_token=secret', 'not a URL']) {
            expect(() => validatePublicSourceUrl(url)).toThrow(expect.objectContaining({ status: 400, code: 'invalid-source-url', message: 'Invalid public source URL.' }));
        }
    });
    it('rejects oversized request URLs before opening a connection', async () => {
        const wire = client([]);
        await expect(wire.fetch('https://example.com/' + 'x'.repeat(16384))).rejects.toMatchObject({ status: 400, code: 'invalid-source-url' });
        expect(wire.requestImpl).not.toHaveBeenCalled();
    });
    it.each(['0.0.0.0','10.1.2.3','100.64.0.1','127.0.0.1','169.254.169.254','172.31.1.2','192.168.1.1',
        '192.0.0.1','192.0.2.1','192.88.99.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255',
        '::','::1','fc00::1','fe80::1','ff02::1','::ffff:127.0.0.1','::ffff:7f00:1','::ffff:8.8.8.8',
        '2606:4700::1%eth0','64:ff9b::7f00:1','2001:db8::1','2001::1','2002:7f00:1::','3fff::1','invalid'])('rejects private/reserved %s', address => {
        expect(isPublicSourceAddress(address)).toBe(false);
    });
    it.each(['8.8.8.8','1.1.1.1','93.184.216.34','2606:4700:4700::1111','2001:4860:4860::8888'])('admits public %s', address => {
        expect(isPublicSourceAddress(address)).toBe(true);
    });
});

describe('pinned public source transport', () => {
    it('checks every DNS answer rather than accepting a public first result', async () => {
        const {fetch,requestImpl} = client([], { lookupImpl: async () => [{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}] });
        await expect(fetch('https://example.com/data')).rejects.toThrow(/non-public/);
        expect(requestImpl).not.toHaveBeenCalled();
    });
    it('pins the validated address and original TLS name without a second DNS lookup or forwarded credentials', async () => {
        const lookupImpl = vi.fn().mockResolvedValueOnce([{address:'8.8.8.8',family:4}]).mockResolvedValue([{address:'127.0.0.1',family:4}]);
        const {fetch,calls} = client([{}], {lookupImpl});
        const response = await fetch('https://example.com/data', { headers:{Authorization:'secret',Cookie:'session',Host:'internal'} });
        const options = calls[0].options;
        expect(options).toMatchObject({hostname:'example.com',servername:'example.com',port:443,agent:false,rejectUnauthorized:true});
        const pinned = vi.fn();options.lookup('example.com',{},pinned);
        expect(pinned).toHaveBeenCalledWith(null,'8.8.8.8',4);
        const all = vi.fn();options.lookup('example.com',{all:true},all);
        expect(all).toHaveBeenCalledWith(null,[{address:'8.8.8.8',family:4}]);
        expect(lookupImpl).toHaveBeenCalledTimes(1);
        expect(options.headers).toEqual({Accept:'application/geo+json, application/json','Accept-Encoding':'identity','User-Agent':'consensus-builder/1.0 (+https://urbangametheory.xyz)'});
        expect(response.status).toBe(200);expect(response.ok).toBe(true);expect(response.url).toBe('https://example.com/data');
        expect(await response.json()).toEqual({ok:true});
    });
    it('exposes headers, bytes and a readable body for snapshot callers', async () => {
        const {fetch} = client([{headers:{etag:'"release"','content-length':'3'},chunks:['a','bc']},{chunks:['xyz']},{chunks:['bytes']},{status:404,chunks:['missing']}]);
        const response=await fetch('https://example.com');expect(response.headers.get('ETag')).toBe('"release"');
        const reader=response.body.getReader();expect(new TextDecoder().decode((await reader.read()).value)).toBe('abc');expect((await reader.read()).done).toBe(true);
        expect(await (await fetch('https://example.com')).text()).toBe('xyz');
        expect(new TextDecoder().decode(await (await fetch('https://example.com')).arrayBuffer())).toBe('bytes');
        expect((await fetch('https://example.com')).ok).toBe(false);
    });
    it('validates each redirect host and prevents same-host DNS rebinding', async () => {
        const lookupImpl = vi.fn().mockResolvedValueOnce([{address:'8.8.8.8',family:4}]).mockResolvedValueOnce([{address:'127.0.0.1',family:4}]);
        const {fetch,requestImpl} = client([{status:302,headers:{location:'/next'}}],{lookupImpl});
        await expect(fetch('https://example.com/data')).rejects.toThrow(/non-public/);expect(requestImpl).toHaveBeenCalledTimes(1);
    });
    it.each(['http://example.com', 'https://169.254.169.254/latest', 'https://user:secret@example.com', 'https://example.com/?token=secret'])('rejects unsafe redirect %s without exposing its contents', async location => {
        const {fetch,requestImpl} = client([{status:302,headers:{location}}]);
        await expect(fetch('https://example.com')).rejects.toThrow('Public source redirect rejected.');expect(requestImpl).toHaveBeenCalledTimes(1);
    });
    it('follows at most three public redirects and honors redirect:error', async () => {
        const replies=Array.from({length:4},()=>({status:302,headers:{location:'/next'}}));
        const {fetch,requestImpl}=client(replies);await expect(fetch('https://example.com')).rejects.toThrow(/redirect rejected/);expect(requestImpl).toHaveBeenCalledTimes(4);
        const stopped=client([{status:302,headers:{location:'/next'}}]);await expect(stopped.fetch('https://example.com',{redirect:'error'})).rejects.toThrow(/redirect rejected/);expect(stopped.requestImpl).toHaveBeenCalledTimes(1);
    });
    it('follows a validated public redirect and reports the final URL', async () => {
        const {fetch,calls}=client([{status:302,headers:{location:'https://other.example/final'}},{}]);
        expect((await fetch('https://example.com')).url).toBe('https://other.example/final');expect(calls[1].options.servername).toBe('other.example');
    });
    it('bounds declared and actual bytes, detects truncation and rejects compression', async () => {
        for(const reply of [{headers:{'content-length':'9'}},{chunks:['123','456']},{headers:{'content-length':'4'},chunks:['12']},
            {headers:{'content-length':'not-number'}},{headers:{'content-encoding':'gzip'}}]) {
            const {fetch,calls}=client([reply],{maxBytes:5});await expect(fetch('https://example.com')).rejects.toThrow(/byte limit|invalid length|incomplete|compressed/);
            expect(calls[0].req.destroy).toHaveBeenCalled();
        }
    });
    it('times out during DNS and aborts an active response', async () => {
        const dns=client([],{lookupImpl:()=>new Promise(()=>{}),timeoutMs:5});await expect(dns.fetch('https://example.com')).rejects.toThrow(/timed out/);expect(dns.requestImpl).not.toHaveBeenCalled();
        const active=client([{wait:true}],{timeoutMs:5});await expect(active.fetch('https://example.com')).rejects.toThrow(/timed out/);expect(active.calls[0].req.destroy).toHaveBeenCalled();
        const controller=new AbortController();controller.abort();const cancelled=client([]);await expect(cancelled.fetch('https://example.com',{signal:controller.signal})).rejects.toThrow(/aborted/);expect(cancelled.requestImpl).not.toHaveBeenCalled();
    });
    it('sanitizes raw DNS transport errors containing secrets', async () => {
        const {fetch}=client([],{lookupImpl:async()=>{throw Error('Public source https://user:secret@example.com/?token=secret');}});
        await expect(fetch('https://example.com')).rejects.toThrow('Public source DNS lookup failed.');
    });
    it('supports bounded form POST and never follows its redirects or forwards caller authentication', async () => {
        const {fetch,calls}=client([{}, {status:303,headers:{location:'https://other.example'}}]);
        const options={method:'POST',body:'where=id%3D1&f=json',headers:{'Content-Type':'application/x-www-form-urlencoded',Authorization:'secret'}};
        expect(await (await fetch('https://example.com/query',options)).json()).toEqual({ok:true});
        expect(calls[0].body).toBe(options.body);expect(calls[0].options.headers).toMatchObject({'Content-Type':'application/x-www-form-urlencoded','Content-Length':String(Buffer.byteLength(options.body))});
        expect(calls[0].options.headers).not.toHaveProperty('Authorization');
        await expect(fetch('https://example.com/query',options)).rejects.toThrow(/redirect rejected/);expect(calls).toHaveLength(2);
        for(const invalid of [{method:'DELETE'},{method:'GET',body:'x'},{method:'POST',body:'x',headers:{'Content-Type':'application/json'}},
            {method:'POST',body:'x'.repeat(16385),headers:{'Content-Type':'application/x-www-form-urlencoded'}}]) await expect(fetch('https://example.com',invalid)).rejects.toThrow(/bounded form POST/);
    });
});
