// Reads provider JSON over verified HTTPS with a source-scoped certificate-chain supplement.
import { Agent, get, request as httpsRequest } from 'node:https';
import { rootCertificates } from 'node:tls';
import { Readable } from 'node:stream';

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
        const hasBody = ok && ![204, 205].includes(status);
        if (!hasBody) response.resume();
        async function* boundedBody() {
            let size = 0;
            try {
                for await (const chunk of response) {
                    size += chunk.length;
                    if (size > maxBytes) throw new Error('Parcel provider response exceeds the byte limit.');
                    yield chunk;
                }
            } finally {
                if (!response.destroyed) response.destroy();
            }
        }
        // A standard body lets adapters impose tighter streaming limits while json() keeps the
        // same certificate-verified transport and shared byte cap used by existing providers.
        return new Response(hasBody ? Readable.toWeb(Readable.from(boundedBody())) : null, {
            status, headers: new Headers(response.headers)
        });
    };
}
