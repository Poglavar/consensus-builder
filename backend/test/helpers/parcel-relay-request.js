// Decodes a browser call to the parcel provider relay into the request envelope the relay route validates
// (backend/routes/parcel-provider-relay.js): the GET query form for a plain read, the POST JSON body otherwise.
import assert from 'node:assert/strict';

const GET_HEADERS = { referer: 'Referer', accept: 'Accept', 'accept-language': 'Accept-Language' };
const GET_PARAMETERS = ['url', 'redirect', ...Object.keys(GET_HEADERS)];

// The relay endpoint a call went to, without the GET form's query string.
export const relayPath = url => String(url).split('?')[0];

export function relayEnvelope(url, options = {}) {
    assert.equal(options.credentials, 'omit');
    if (options.method === 'POST') return JSON.parse(options.body);
    assert.equal(options.method, 'GET');
    assert.equal(options.body, undefined);
    const query = new URL(String(url), 'https://relay.invalid').searchParams;
    const keys = [...query.keys()];
    assert.equal(new Set(keys).size, keys.length, 'a relay GET parameter is repeated');
    for (const key of keys) assert.ok(GET_PARAMETERS.includes(key), `unexpected relay GET parameter ${key}`);
    assert.notEqual(query.get('redirect'), 'manual');
    const headers = Object.fromEntries(Object.entries(GET_HEADERS).filter(([key]) => query.has(key))
        .map(([key, name]) => [name, query.get(key)]));
    return { url: query.get('url'), method: 'GET', headers, ...(query.has('redirect') ? { redirect: query.get('redirect') } : {}) };
}
