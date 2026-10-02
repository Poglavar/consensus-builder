// Verifies source-scoped certificate trust, request failures and bounded JSON streaming.
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { rootCertificates } from 'node:tls';
import { describe, expect, it, vi } from 'vitest';
import { createHttpsJsonFetch } from '../parcels/https-json-fetch.js';

const extraCa = readFileSync(new URL('../parcels/certificates/geotrust-ev-rsa-ca-g2.pem', import.meta.url), 'utf8');

function readableResponse(chunks, statusCode = 200) {
    const response = Readable.from(chunks.map(chunk => Buffer.from(chunk)));
    response.statusCode = statusCode;
    return response;
}

function respondingGet(response, onCall = () => {}) {
    return vi.fn((url, options, callback) => {
        onCall(url, options);
        const request = new EventEmitter();
        queueMicrotask(() => callback(response));
        return request;
    });
}

describe('createHttpsJsonFetch', () => {
    it('adds the source certificate to normal roots, forwards request options, and parses streamed JSON', async () => {
        const response = readableResponse(['{"type":"Feature', 'Collection","features":[]}']);
        let requestOptions;
        let requestUrl;
        const getImpl = respondingGet(response, (url, options) => {
            requestUrl = url;
            requestOptions = options;
        });
        const fetchJson = createHttpsJsonFetch(extraCa, { getImpl });
        const controller = new AbortController();

        const result = await fetchJson('https://sig.car.gov.co/arcgis/query?f=geojson', {
            headers: { Accept: 'application/geo+json' }, signal: controller.signal
        });

        expect(requestUrl).toBe('https://sig.car.gov.co/arcgis/query?f=geojson');
        expect(requestOptions.headers).toEqual({ Accept: 'application/geo+json' });
        expect(requestOptions.signal).toBe(controller.signal);
        expect(requestOptions.agent.options).toMatchObject({ rejectUnauthorized: true, keepAlive: true, maxSockets: 6 });
        expect(requestOptions.agent.options.ca).toEqual([...rootCertificates, extraCa]);
        expect(result).toMatchObject({ ok: true, status: 200 });
        await expect(result.json()).resolves.toEqual({ type: 'FeatureCollection', features: [] });
        requestOptions.agent.destroy();
    });

    it('propagates request errors', async () => {
        const failure = new Error('socket failed');
        let request;
        const getImpl = vi.fn(() => {
            request = new EventEmitter();
            queueMicrotask(() => request.emit('error', failure));
            return request;
        });
        const fetchJson = createHttpsJsonFetch(extraCa, { getImpl });

        await expect(fetchJson('https://sig.car.gov.co/arcgis/query')).rejects.toBe(failure);
        getImpl.mock.calls[0][1].agent.destroy();
    });

    it('rejects a streamed response that exceeds the byte limit', async () => {
        const response = readableResponse(['123', '456']);
        const fetchJson = createHttpsJsonFetch(extraCa, {
            getImpl: respondingGet(response), maxBytes: 5
        });
        const result = await fetchJson('https://sig.car.gov.co/arcgis/query');

        await expect(result.json()).rejects.toThrow('Parcel provider response exceeds the byte limit.');
    });

    it('drains non-success responses and reports their status', async () => {
        const response = readableResponse(['error body'], 503);
        const resume = vi.spyOn(response, 'resume');
        const fetchJson = createHttpsJsonFetch(extraCa, { getImpl: respondingGet(response) });

        const result = await fetchJson('https://sig.car.gov.co/arcgis/query');

        expect(result).toMatchObject({ ok: false, status: 503 });
        expect(resume).toHaveBeenCalledOnce();
    });
});
