import { pinningError } from '../pinning-error.js';

export const PINATA_FILE_ENDPOINT = 'https://api.pinata.cloud/pinning/pinFileToIPFS';

export async function pinFileToPinata({ bytes, fileName, contentType, name }, { env = process.env } = {}) {
    const apiKey = env.PINATA_API_KEY, apiSecret = env.PINATA_API_SECRET;
    if (!apiKey || !apiSecret) throw pinningError('pinning-unconfigured',
        'Pinata requires PINATA_API_KEY and PINATA_API_SECRET.', 503);
    const body = new FormData();
    body.append('file', new Blob([bytes], { type: contentType }), fileName);
    if (name) body.append('pinataMetadata', JSON.stringify({ name }));
    body.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));
    const response = await fetch(PINATA_FILE_ENDPOINT, {
        method: 'POST', headers: { pinata_api_key: apiKey, pinata_secret_api_key: apiSecret }, body,
        signal: AbortSignal.timeout(60000)
    });
    if (!response.ok) {
        let refusal;
        try { refusal = (await response.json())?.error; } catch { /* Status remains actionable. */ }
        if (response.status === 403 && refusal?.reason === 'FORBIDDEN' && /plan usage limit/i.test(refusal.details || '')) {
            throw pinningError('pinning-quota-exhausted', 'The Pinata account has reached its usage limit.', 409,
                { upstreamStatus: response.status });
        }
        throw pinningError('pin-failed', `Pinata upload returned HTTP ${response.status}.`, 502,
            { upstreamStatus: response.status });
    }
    const result = await response.json();
    if (!result?.IpfsHash) throw pinningError('pin-failed', 'Pinata returned no CID.', 502);
    return { cid: result.IpfsHash, pinnedAt: result.Timestamp || null };
}
