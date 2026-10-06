// Reads provider JSON over verified HTTPS with a source-scoped certificate-chain supplement.
import { Agent, get, request as httpsRequest } from 'node:https';
import { rootCertificates } from 'node:tls';

export function createHttpsJsonFetch(extraCa, { getImpl = get, requestImpl = httpsRequest, maxBytes = 20 * 1024 * 1024 } = {}) {
    const agent = new Agent({ ca: [...rootCertificates, extraCa], rejectUnauthorized: true, keepAlive: true, maxSockets: 6 });
    return async (url, { headers, signal, method = 'GET', body } = {}) => {
        const response = await new Promise((resolve, reject) => {
            const isGet = method === 'GET' && body === undefined;
            const request = (isGet ? getImpl : requestImpl)(url, { headers, signal, agent, method }, resolve);
            request.once('error', reject);
            if (!isGet) request.end(body);
        });
        const status = response.statusCode;
        const ok = status >= 200 && status < 300;
        if (!ok) response.resume();
        return {
            status, ok, headers: new Headers(response.headers),
            async json() {
                const chunks = [];
                let size = 0;
                for await (const chunk of response) {
                    size += chunk.length;
                    if (size > maxBytes) {
                        response.destroy();
                        throw new Error('Parcel provider response exceeds the byte limit.');
                    }
                    chunks.push(chunk);
                }
                return JSON.parse(Buffer.concat(chunks).toString('utf8'));
            }
        };
    };
}
