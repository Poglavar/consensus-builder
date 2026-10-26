import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createFileCar } from '../ipfs-car.js';
import { pinningError } from '../pinning-error.js';

export async function pinFileToFilebase({ bytes }, { env = process.env, client } = {}) {
    const bucket = env.FILEBASE_BUCKET;
    if (!env.FILEBASE_ACCESS_KEY_ID || !env.FILEBASE_SECRET_ACCESS_KEY || !bucket) {
        throw pinningError('pinning-unconfigured',
            'Filebase requires FILEBASE_ACCESS_KEY_ID, FILEBASE_SECRET_ACCESS_KEY and FILEBASE_BUCKET.', 503);
    }
    const ownedClient = !client;
    client ||= new S3Client({
        endpoint: 'https://s3.filebase.com', region: 'us-east-1', forcePathStyle: true,
        requestChecksumCalculation: 'WHEN_REQUIRED',
        credentials: { accessKeyId: env.FILEBASE_ACCESS_KEY_ID, secretAccessKey: env.FILEBASE_SECRET_ACCESS_KEY }
    });
    try {
        const abortSignal = AbortSignal.timeout(60000);
        const archive = await createFileCar(bytes);
        const key = `${archive.cid}.car`;
        await client.send(new PutObjectCommand({
            Bucket: bucket, Key: key, Body: archive.bytes,
            ContentType: 'application/vnd.ipld.car', Metadata: { import: 'car' }
        }), { abortSignal });
        for (let attempt = 0; attempt < 10; attempt++) {
            const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal });
            if (result.Metadata?.['pinning-status'] === 'failed') {
                throw pinningError('pin-failed', 'Filebase could not pin the imported content.', 502);
            }
            if (result.Metadata?.cid && result.Metadata['pinning-status'] === 'pinned') return {
                cid: result.Metadata.cid, pinnedAt: result.LastModified?.toISOString() || null
            };
            if (attempt < 9) await new Promise(resolve => setTimeout(resolve, 500));
        }
        throw pinningError('pin-failed', 'Filebase did not confirm the imported CID.', 502);
    } catch (error) {
        if (error.code === 'pin-failed') throw error;
        const status = error.$metadata?.httpStatusCode;
        const quota = /quota|limit|storagefull|insufficientstorage|toomany/i.test(error.name || '');
        throw pinningError(quota ? 'pinning-quota-exhausted' : 'pin-failed',
            `Filebase upload failed (${error.name || 'unknown error'}).`, quota ? 409 : 502,
            status ? { upstreamStatus: status } : {});
    } finally {
        if (ownedClient) client.destroy();
    }
}
