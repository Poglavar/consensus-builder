// Bounded public downloads with DNS-pinned connections, robots policies and host serialization.
import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import robotsParser from 'robots-parser';
import { gunzipSync,inflateSync,brotliDecompressSync } from 'node:zlib';

const hosts = new Map();
const robotsCache = new Map();
const cleanIp = ip => String(ip).replace(/^\[|\]$/g, '').toLowerCase();
const blockedNetworks = new net.BlockList();
for (const [address,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.168.0.0',16],['198.18.0.0',15],['224.0.0.0',4],['240.0.0.0',4]]) blockedNetworks.addSubnet(address,prefix,'ipv4');
const globalV6 = new net.BlockList(); globalV6.addSubnet('2000::',3,'ipv6');
const privateIp = raw => {
    const ip=cleanIp(raw),family=net.isIP(ip);
    if(family===4) return blockedNetworks.check(ip,'ipv4');
    if(family===6) return !globalV6.check(ip,'ipv6');
    return false;
};
const hostKey = url => cleanIp(url.hostname);
const publicUrl = value => { try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || privateIp(url.hostname)) return null; return url; } catch (_) { return null; } };

export async function validatePublicUrl(raw, lookup = dns.lookup) {
    const url = publicUrl(raw); if (!url) throw new Error('URL is not a public HTTP(S) URL');
    const hostname = cleanIp(url.hostname);
    if (net.isIP(hostname)) { if (privateIp(hostname)) throw new Error('URL resolves to a private address'); return url; }
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(address => privateIp(address.address))) throw new Error('URL resolves to a private address');
    return url;
}

// The connection uses the checked answer, rather than doing a second untrusted DNS lookup.
async function requestPinned(raw, options) {
    const url=await validatePublicUrl(raw),hostname=cleanIp(url.hostname);
    const addresses=net.isIP(hostname)?[{address:hostname,family:net.isIP(hostname)}]:await dns.lookup(hostname,{all:true,verbatim:true});
    if(!addresses.length || addresses.some(row=>privateIp(row.address))) throw new Error('URL resolves to a private address');
    const address=addresses.find(row=>row.family===4) || addresses[0];
    return new Promise((resolve,reject)=>{
        const request=(url.protocol==='https:'?https:http).get(url,{
            headers:options.headers,signal:options.signal,
            lookup:(_host,lookupOptions,callback)=>lookupOptions.all?callback(null,[address]):callback(null,address.address,address.family)
        },response=>resolve({status:response.statusCode,headers:new Headers(Object.entries(response.headers).filter(([,value])=>value!==undefined).map(([key,value])=>[key,Array.isArray(value)?value.join(', '):value])),body:response}));
        request.on('error',reject);
    });
}
async function readBody(response, maxBytes) {
    const chunks = []; let total = 0;
    for await (const chunk of response.body || []) { total += chunk.length; if (total > maxBytes) throw new Error('response exceeds maxBytes'); chunks.push(chunk); }
    return Buffer.concat(chunks);
}

export async function fetchPublic(rawUrl, options = {}) {
    const opts = { maxBytes: 12 * 1024 * 1024, timeoutMs: 20000, userAgent: 'FloorPlanArchive/1.0', respectRobots: true, ...options };
    const request = opts.fetch || requestPinned, lookup = opts.lookup || dns.lookup; let url = await validatePublicUrl(rawUrl, lookup);
    for (let redirect = 0; redirect <= 8; redirect++) {
        const key = hostKey(url), previous = hosts.get(key) || Promise.resolve(); let release; const current = new Promise(resolve => { release = resolve; }); const turn = previous.then(async () => { const wait = (hosts.get(`${key}:last`) || 0) + 750 - Date.now(); if (wait > 0) await delay(wait); hosts.set(`${key}:last`, Date.now()); }); hosts.set(key, turn.then(() => current)); await turn; try {
            if (opts.respectRobots) {
                const robotsUrl = `${url.origin}/robots.txt`, robotKey = `${url.origin}|${opts.userAgent}`;
                let policy = robotsCache.get(robotKey);
                if (!policy || policy.expires < Date.now()) {
                    let robotsCurrentUrl=robotsUrl;
                    let robotsResp = await request(robotsCurrentUrl, { headers: { 'user-agent': opts.userAgent }, redirect: 'manual', signal: AbortSignal.timeout(opts.timeoutMs) });
                    for (let hop = 0; hop < 5 && robotsResp.status >= 300 && robotsResp.status < 400; hop++) {
                        const location = robotsResp.headers.get('location');
                        if (!location) break;
                        robotsResp.body?.destroy?.();
                        const next = await validatePublicUrl(new URL(location, robotsCurrentUrl).href, lookup);
                        robotsCurrentUrl=next.href;
                        robotsResp = await request(next.href, { headers: { 'user-agent': opts.userAgent }, redirect: 'manual', signal: AbortSignal.timeout(opts.timeoutMs) });
                    }
                    policy = { status: robotsResp.status, reason: null, rules: null, expires: Date.now() + 3600000 };
                    // RFC 9309: robots 4xx means unavailable; server/network errors remain closed.
                    if (robotsResp.status >= 500 || robotsResp.status === 429) policy.reason = `robots-${robotsResp.status}`;
                    else if (robotsResp.status >= 300 && robotsResp.status < 400) policy.reason = 'robots-redirect';
                    else if (robotsResp.status < 400) policy.rules = robotsParser(robotsUrl, await readBody(robotsResp, 512 * 1024).then(b => b.toString()));
                    if(!policy.rules) robotsResp.body?.destroy?.();
                    robotsCache.set(robotKey, policy);
                }
                if (policy.reason) return { url: rawUrl, finalUrl: url.href, status: policy.status, headers: {}, body: null, blockedReason: policy.reason, notModified: false };
                if (policy.rules && !policy.rules.isAllowed(url.href, opts.userAgent)) return { url: rawUrl, finalUrl: url.href, status: null, headers: {}, body: null, blockedReason: 'robots-disallow', notModified: false };
            }
            const headers = { 'user-agent': opts.userAgent, ...(opts.etag ? { 'if-none-match': opts.etag } : {}), ...(opts.lastModified ? { 'if-modified-since': opts.lastModified } : {}) };
            const controller = new AbortController(), timer = setTimeout(() => controller.abort(), opts.timeoutMs); let response;
            try { response = await request(url.href, { headers, redirect: 'manual', signal: controller.signal }); }
            catch (error) { clearTimeout(timer); if (error.name === 'AbortError' || error.name === 'TimeoutError') throw new Error('request timeout'); throw error; }
            finally { /* Keep the signal active while the body is consumed. */ }
            if ([301,302,303,307,308].includes(response.status)) { clearTimeout(timer); response.body?.destroy?.(); const next = response.headers.get('location'); if (!next) break; try { url = await validatePublicUrl(new URL(next, url).href, lookup); } catch (error) { return { url: rawUrl, finalUrl: new URL(next, url).href, status: response.status, headers: {}, body: null, blockedReason: error.message, notModified: false }; } continue; }
            const outHeaders = { contentType: response.headers.get('content-type'), etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified') };
            if (response.status === 304) { clearTimeout(timer); response.body?.destroy?.(); return { url: rawUrl, finalUrl: url.href, status: 304, headers: outHeaders, body: null, blockedReason: null, notModified: true }; }
            let body = null; if (response.body && (response.status < 500 || response.status === 404)) { try { body = await readBody(response, opts.maxBytes); } catch (error) { if (error.name === 'AbortError') throw new Error('request timeout'); throw error; } finally { clearTimeout(timer); } }
            clearTimeout(timer);
            if(body) {
                const encoding=response.headers.get('content-encoding') || '';
                if(encoding==='gzip' || (/\.gz$/i.test(url.pathname) && body[0]===31 && body[1]===139)) body=gunzipSync(body,{maxOutputLength:opts.maxBytes});
                else if(encoding==='deflate') body=inflateSync(body,{maxOutputLength:opts.maxBytes});
                else if(encoding==='br') body=brotliDecompressSync(body,{maxOutputLength:opts.maxBytes});
                if(/\.xml\.gz$/i.test(url.pathname)) outHeaders.contentType='application/xml';
            }
            if(!body) response.body?.destroy?.();
            return { url: rawUrl, finalUrl: url.href, status: response.status, headers: outHeaders, body, blockedReason: response.status === 403 ? 'http-403' : response.status >= 500 ? `http-${response.status}` : null, notModified: false };
        } finally { release(); }
    }
    return { url: rawUrl, finalUrl: url.href, status: null, headers: {}, body: null, blockedReason: 'redirect-limit', notModified: false };
}
