import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CarReader } from '@ipld/car';
import { decode as decodeDagPb } from '@ipld/dag-pb';
import { UnixFS } from 'ipfs-unixfs';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { pinBytes, pinFile, ipfsGatewayUrl } from '../storage/pinning.js';
import { createFileCar } from '../storage/ipfs-car.js';
import { cidOf } from '../cid.js';
import { setupIpfsRoute } from '../routes/ipfs.js';
import { createRouteApp } from './helpers/create-route-app.js';

const bytes = Buffer.from('{"schema":"test/v1"}');
const cid = cidOf(bytes);
let send;
let uploadedCid;

beforeEach(() => {
    vi.stubEnv('IPFS_PINNING_PROVIDER', 'filebase');
    vi.stubEnv('FILEBASE_ACCESS_KEY_ID', 'test-access');
    vi.stubEnv('FILEBASE_SECRET_ACCESS_KEY', 'test-secret');
    vi.stubEnv('FILEBASE_BUCKET', 'test-publications');
    vi.stubEnv('IPFS_READ_GATEWAY', 'https://example.com/ipfs/');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    send = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async command => {
        if (command instanceof PutObjectCommand) {
            const reader = await CarReader.fromBytes(command.input.Body);
            uploadedCid = (await reader.getRoots())[0].toString();
            return {};
        }
        if (command instanceof HeadObjectCommand) return {
            Metadata: { cid: uploadedCid, 'pinning-status': 'pinned' }, LastModified: new Date('2026-10-26T12:00:00Z')
        };
        throw new Error('Unexpected S3 command');
    });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('provider-independent pins', () => {
    it('imports a CAR through Filebase and confirms the actual CID from object metadata', async () => {
        await expect(pinBytes({ bytes, cid, name: 'test' })).resolves.toEqual({ cid, pinnedAt: '2026-10-26T12:00:00.000Z' });
        expect(send).toHaveBeenCalledTimes(2);
        expect(send.mock.calls[0][0].input).toMatchObject({
            Bucket: 'test-publications', Key: `${cid}.car`, ContentType: 'application/vnd.ipld.car', Metadata: { import: 'car' }
        });
    });

    it('rejects a provider CID mismatch and wrong input bytes', async () => {
        send.mockImplementation(async command => command instanceof HeadObjectCommand
            ? { Metadata: { cid: cidOf(Buffer.from('wrong')), 'pinning-status': 'pinned' } } : {});
        await expect(pinBytes({ bytes, cid, name: 'test' })).rejects.toMatchObject({ code: 'cid-mismatch', status: 409 });
        send.mockClear();
        await expect(pinBytes({ bytes: Buffer.from('wrong'), cid, name: 'test' })).rejects.toMatchObject({ code: 'cid-mismatch', status: 400 });
        expect(send).not.toHaveBeenCalled();
    });

    it('switches explicitly to Pinata while retaining the same file CID', async () => {
        vi.stubEnv('IPFS_PINNING_PROVIDER', 'pinata');
        vi.stubEnv('PINATA_API_KEY', 'test-key');
        vi.stubEnv('PINATA_API_SECRET', 'test-secret');
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ IpfsHash: cid })));
        vi.stubGlobal('fetch', fetchMock);
        expect((await pinFile({ bytes, fileName: 'test.json' })).cid).toBe(cid);
        expect(fetchMock.mock.calls[0][0]).toBe('https://api.pinata.cloud/pinning/pinFileToIPFS');
        expect(send).not.toHaveBeenCalled();
    });

    it('reports Filebase quota failures without silently uploading to Pinata', async () => {
        const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
        send.mockRejectedValue(Object.assign(new Error('full'), { name: 'QuotaExceeded', $metadata: { httpStatusCode: 403 } }));
        await expect(pinBytes({ bytes, cid, name: 'test' })).rejects.toMatchObject({ code: 'pinning-quota-exhausted', status: 409 });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not report publication while Filebase is still pinning', async () => {
        vi.useFakeTimers();
        let heads = 0;
        send.mockImplementation(async command => command instanceof HeadObjectCommand
            ? { Metadata: { cid, 'pinning-status': ++heads === 1 ? 'pinning' : 'pinned' } } : {});
        try {
            const pending = pinBytes({ bytes, cid, name: 'test' });
            await vi.advanceTimersByTimeAsync(0);
            expect(heads).toBe(1);
            await vi.advanceTimersByTimeAsync(500);
            expect((await pending).cid).toBe(cid);
            expect(heads).toBe(2);
        } finally { vi.useRealTimers(); }
    });

    it('refuses missing Filebase configuration and unknown providers', async () => {
        vi.stubEnv('FILEBASE_SECRET_ACCESS_KEY', '');
        await expect(pinFile({ bytes, fileName: 'test' })).rejects.toMatchObject({ code: 'pinning-unconfigured', status: 503 });
        vi.stubEnv('IPFS_PINNING_PROVIDER', 'toString');
        await expect(pinFile({ bytes, fileName: 'test' })).rejects.toMatchObject({ code: 'pinning-unconfigured', status: 503 });
        expect(send).not.toHaveBeenCalled();
    });

    it('selects the read gateway independently of the pinning provider', () => {
        expect(ipfsGatewayUrl(cid)).toBe(`https://example.com/ipfs/${cid}`);
        vi.stubEnv('IPFS_PINNING_PROVIDER', 'pinata');
        expect(ipfsGatewayUrl(cid)).toBe(`https://example.com/ipfs/${cid}`);
        expect(() => ipfsGatewayUrl(cid, { IPFS_READ_GATEWAY: 'https://name:secret@example.com/ipfs' })).toThrow();
    });

    it.each([1, 262144, 262145, 1048576])('preserves verifiable DAG blocks and the canonical root for %i bytes', async size => {
        const source = Buffer.alloc(size, 23), archive = await createFileCar(source);
        const reader = await CarReader.fromBytes(archive.bytes);
        const root = (await reader.getRoots())[0];
        expect(root.toString()).toBe(cidOf(source));
        const blocks = new Map();
        for await (const block of reader.blocks()) {
            expect(Buffer.from(block.cid.multihash.digest)).toEqual(createHash('sha256').update(block.bytes).digest());
            blocks.set(block.cid.toString(), block.bytes);
        }
        const payload = cid => {
            const block = blocks.get(cid.toString());
            expect(block).toBeDefined();
            if (cid.code === 0x55) return Buffer.from(block);
            const node = decodeDagPb(block);
            return Buffer.concat([Buffer.from(UnixFS.unmarshal(node.Data).data || []), ...node.Links.map(link => payload(link.Hash))]);
        };
        expect(payload(root)).toEqual(source);
    // The 1 MiB case chunks and hashes in JS (~1.5 s alone); under the parallel suite it outran 5 s.
    }, 20000);

    it('uses the selected provider and independent gateway for both NFT image and metadata', async () => {
        const image = Buffer.from('iVBORw0KGgoAAAAAAAAAAAAAAAAAAAAA', 'base64');
        const result = await request(createRouteApp(setupIpfsRoute)).post('/ipfs/upload').send({
            imageData: `data:image/png;base64,${image.toString('base64')}`, metadata: { name: 'Test NFT' }
        });
        expect(result.status).toBe(200);
        expect(result.body.imageUri).toBe(`ipfs://${cidOf(image)}`);
        expect(result.body.imageGatewayUrl).toBe(`https://example.com/ipfs/${cidOf(image)}`);
        expect(result.body.metadataGatewayUrl).toMatch(/^https:\/\/example.com\/ipfs\/baf/);
        expect(send).toHaveBeenCalledTimes(4);
    });
});
