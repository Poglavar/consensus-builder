import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createCanvas, loadImage } from 'canvas';
import { decodeImagerySource, encodeImagerySource } from '../imagery/custom-source.js';
import { discoverImagerySource, wmsMapUrl } from '../imagery/discovery.js';
import { setupImagerySourcesRoute } from '../routes/imagery-sources.js';

const bbox = [15.95, 45.79, 15.97, 45.81];
// A discover check is a GET: its fields as a query string, lists comma-joined as the client sends them.
const asQuery = body => Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : value]));
const sampleCanvas = createCanvas(256, 256);
sampleCanvas.getContext('2d').fillRect(0, 0, 256, 256);
const png = sampleCanvas.toBuffer('image/png');
const image = () => new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } });
const capabilities = (layers = '<Layer><Name>OI.OrthoimageCoverage</Name><Title>Digital orthophoto</Title></Layer>') => `
<WMS_Capabilities version="1.3.0"><Service><Title>Public orthophoto</Title></Service>
<Capability><Request><GetMap><Format>image/png</Format><Format>image/jpeg</Format></GetMap></Request>
<Layer><Title>Root</Title><CRS>CRS:84</CRS><CRS>EPSG:3765</CRS>
<EX_GeographicBoundingBox><westBoundLongitude>13.419167</westBoundLongitude><southBoundLatitude>43.572269</southBoundLatitude><eastBoundLongitude>16.5</eastBoundLongitude><northBoundLatitude>46.417688</northBoundLatitude></EX_GeographicBoundingBox>
${layers}</Layer></Capability></WMS_Capabilities>`;
const app = publicFetch => {
    const server = express();
    server.use(express.json());
    setupImagerySourcesRoute(server, { publicFetch });
    return server;
};

describe('public imagery source discovery and gateway', () => {
    it('discovers and samples a DGU-style WMS in its advertised CRS:84, then serves an actual PNG', async () => {
        const fetchImpl = vi.fn(async url => String(url).includes('GetCapabilities')
            ? new Response(capabilities(), { status: 200, headers: { 'Content-Type': 'text/xml' } }) : image());
        const server = app(fetchImpl);
        const result = await request(server).get('/imagery-sources/discover').query(asQuery({
            url: 'https://geoportal.dgu.hr/services/inspire/orthophoto_2024/wms', city: 'zagreb', bbox
        }));
        expect(result.status).toBe(200);
        expect(result.body.source).toMatchObject({ kind: 'imagery', adapter: 'wms', cityIds: ['zagreb'],
            layers: ['OI.OrthoimageCoverage'], version: '1.3.0', crs: 'CRS:84', format: 'image/png',
            bounds: [13.419167, 43.572269, 16.5, 46.417688], idPrefix: expect.stringMatching(/^CUSTOM-I-[0-9a-f]{20}-$/) });
        expect(decodeImagerySource(result.body.source.id)).toEqual(result.body.source);
        const sample = new URL(fetchImpl.mock.calls[1][0]);
        expect(sample.searchParams.get('BBOX')).toBe(bbox.join(',')); // longitude before latitude
        expect(sample.searchParams.get('CRS')).toBe('CRS:84');
        const map = await request(server).get(`/imagery-sources/${result.body.source.id}/map`)
            .query({ bbox: bbox.join(','), width: 256, height: 256 });
        expect(map.status).toBe(200);
        expect(map.headers['content-type']).toMatch(/^image\/png/);
        expect(map.body).toEqual(png);
    });

    it('offers named layer selection and then verifies the selected GetMap', async () => {
        const xml = capabilities('<Layer><Name>orthos:2022</Name><Title>2022</Title></Layer><Layer><Name>orthos:2024</Name><Title>2024</Title></Layer>');
        const fetchImpl = vi.fn(async url => String(url).includes('GetCapabilities')
            ? new Response(xml, { status: 200 }) : image());
        const first = await request(app(fetchImpl)).get('/imagery-sources/discover').query(asQuery({
            url: 'https://maps.example.org/wms', city: 'zagreb', bbox
        }));
        expect(first.body).toMatchObject({ selectionRequired: true, layers: [
            { name: 'orthos:2022', title: '2022' }, { name: 'orthos:2024', title: '2024' }
        ] });
        expect(fetchImpl).toHaveBeenCalledOnce();
        const chosen = await request(app(fetchImpl)).get('/imagery-sources/discover').query(asQuery({
            url: 'https://maps.example.org/wms', city: 'zagreb', bbox, layers: ['orthos:2024']
        }));
        expect(chosen.status).toBe(200);
        expect(chosen.body.source.layers).toEqual(['orthos:2024']);
        expect(new URL(fetchImpl.mock.calls.at(-1)[0]).searchParams.get('LAYERS')).toBe('orthos:2024');
    });

    it('verifies an XYZ sample and keeps only a portable city-bound source identity', async () => {
        const fetchImpl = vi.fn(async () => image());
        const server = app(fetchImpl);
        const result = await request(server).get('/imagery-sources/discover').query(asQuery({
            url: 'https://tiles.example.org/{z}/{x}/{y}.png', city: 'zagreb', bbox
        }));
        expect(result.status).toBe(200);
        expect(result.body.source).toMatchObject({ adapter: 'xyz', cityIds: ['zagreb'],
            endpoint: 'https://tiles.example.org/{z}/{x}/{y}.png' });
        expect(result.body.source.id).toMatch(/^imagery\./);
        expect(fetchImpl.mock.calls[0][0]).toMatch(/^https:\/\/tiles\.example\.org\/\d+\/\d+\/\d+\.png$/);
        const tile = await request(server).get(`/imagery-sources/${result.body.source.id}/tiles/5/16/10`);
        expect(tile.status).toBe(200);
        expect(tile.body).toEqual(png);
        expect(fetchImpl.mock.calls.at(-1)[0]).toBe('https://tiles.example.org/5/16/10.png');
    });

    it('rejects XML service exceptions, private URLs, secret query keys and tampered identities', async () => {
        const fetchImpl = vi.fn(async () => new Response('<ServiceException>Unauthorized</ServiceException>', { status: 200 }));
        const server = app(fetchImpl);
        const xml = await request(server).get('/imagery-sources/discover').query(asQuery({
            url: 'https://tiles.example.org/{z}/{x}/{y}.png', city: 'zagreb', bbox
        }));
        expect(xml.status).toBe(422);
        expect(xml.body.code).toBe('imagery-not-image');
        const before = fetchImpl.mock.calls.length;
        for (const url of ['http://maps.example.org/wms', 'https://127.0.0.1/wms',
            'https://maps.example.org/wms?authKey=abc']) {
            const denied = await request(server).get('/imagery-sources/discover').query(asQuery({ url, city: 'zagreb', bbox }));
            expect(denied.status).toBe(400);
        }
        expect(fetchImpl).toHaveBeenCalledTimes(before);
        const id = encodeImagerySource({ kind: 'imagery', adapter: 'xyz', endpoint: 'https://tiles.example.org/{z}/{x}/{y}.png',
            cityIds: ['zagreb'], name: 'tiles.example.org' });
        const tampered = await request(server).get(`/imagery-sources/${id.slice(0, -1)}A/tiles/5/16/10`);
        expect(tampered.status).toBe(400);
        expect(fetchImpl).toHaveBeenCalledTimes(before);
    });

    it('rejects malformed or oversized WMS capabilities and maps geographic bbox correctly', async () => {
        const source = { kind: 'imagery', adapter: 'wms', endpoint: 'https://maps.example.org/wms',
            cityIds: ['zagreb'], name: 'map', layers: ['layer'], version: '1.3.0', crs: 'EPSG:4326', format: 'image/png' };
        const url = new URL(wmsMapUrl(source, bbox));
        expect(url.searchParams.get('BBOX')).toBe('45.79,15.95,45.81,15.97'); // WMS 1.3 EPSG:4326 axis order
        const fetchImpl = async () => new Response('<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]>', { status: 200 });
        const response = await request(app(fetchImpl)).get('/imagery-sources/discover').query(asQuery({
            url: source.endpoint, city: 'zagreb', bbox
        }));
        expect(response.status).toBe(422);
        expect(response.body.code).toBe('imagery-capabilities-invalid');
    });

    it('warps geographic WMS rows onto a Mercator tile at low zoom', async () => {
        const source = { kind: 'imagery', adapter: 'wms', endpoint: 'https://maps.example.org/wms',
            cityIds: ['zagreb'], name: 'map', layers: ['layer'], version: '1.3.0', crs: 'CRS:84', format: 'image/png' };
        const canvas = createCanvas(256, 256), context = canvas.getContext('2d');
        const pixels = context.createImageData(256, 256);
        for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
            const at = (y * 256 + x) * 4;
            pixels.data[at] = y;
            pixels.data[at + 3] = 255;
        }
        context.putImageData(pixels, 0, 0);
        const fetchImpl = vi.fn(async () => new Response(canvas.toBuffer('image/png'), { status: 200 }));
        const tile = await request(app(fetchImpl)).get(`/imagery-sources/${encodeImagerySource(source)}/tiles/0/0/0`);
        expect(tile.status).toBe(200);
        const requested = new URL(fetchImpl.mock.calls[0][0]);
        expect(requested.searchParams.get('CRS')).toBe('CRS:84');
        const image = await loadImage(tile.body), rendered = createCanvas(256, 256);
        const renderedContext = rendered.getContext('2d');
        renderedContext.drawImage(image, 0, 0);
        const red = renderedContext.getImageData(128, 64, 1, 1).data[0];
        // Mercator row 64 is about 66°N, only ~28/256 down the geographic source image.
        expect(red).toBeGreaterThan(22);
        expect(red).toBeLessThan(34);
        expect(red).not.toBe(64);
    });

    it('rejects a PNG whose decoded size differs from the requested WMS map', async () => {
        const source = { kind: 'imagery', adapter: 'wms', endpoint: 'https://maps.example.org/wms',
            cityIds: ['zagreb'], name: 'map', layers: ['layer'], version: '1.3.0', crs: 'CRS:84', format: 'image/png' };
        const fetchImpl = vi.fn(async () => new Response(createCanvas(2, 2).toBuffer('image/png'), { status: 200 }));
        const tile = await request(app(fetchImpl)).get(`/imagery-sources/${encodeImagerySource(source)}/tiles/1/1/1`);
        expect(tile.status).toBe(422);
        expect(tile.body.code).toBe('imagery-image-size');
    });

    it('does not claim coverage from a fully transparent XYZ sample', async () => {
        const empty = createCanvas(256, 256).toBuffer('image/png');
        const result = await request(app(async () => new Response(empty, { status: 200 })))
            .get('/imagery-sources/discover').query(asQuery({
                url: 'https://tiles.example.org/{z}/{x}/{y}.png', city: 'zagreb', bbox
            }));
        expect(result.status).toBe(422);
        expect(result.body.code).toBe('imagery-empty-sample');
    });
});
