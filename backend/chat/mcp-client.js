// This adapter provides one cancellable MCP session for a chat turn and memoizes tool discovery.
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const listCache = new Map();
export function createMcpToolCaller({ url = process.env.MCP_INTERNAL_URL ?? 'http://127.0.0.1:3098/mcp', timeoutMs = 115_000, clientFactory } = {}) {
    const endpoint = new URL(url);
    const client = clientFactory ? clientFactory() : new Client({ name: 'consensus-builder-chat', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(endpoint);
    let connected = false, closed = false;
    const connect = async () => { if (closed) throw new Error('MCP client is closed.'); if (!connected) { await client.connect(transport); connected = true; } };
    return {
        async listTools() {
            const cached = listCache.get(endpoint.href);
            if (cached && cached.expiresAt > Date.now()) return cached.value;
            await connect();
            const value = await client.listTools();
            listCache.set(endpoint.href, { value, expiresAt: Date.now() + 600_000 });
            return value;
        },
        async callTool(name, args = {}, { signal } = {}) {
            await connect();
            if (signal?.aborted) throw Object.assign(new Error('Tool call aborted.'), { code: 'aborted' });
            const controller = new AbortController();
            const abort = () => controller.abort(signal?.reason);
            signal?.addEventListener('abort', abort, { once: true });
            const timer = setTimeout(() => controller.abort(Object.assign(new Error('Tool call timed out.'), { code: 'tool-timeout' })), timeoutMs);
            try { return await client.callTool({ name, arguments: args }, undefined, { signal: controller.signal }); }
            catch (error) {
                if (controller.signal.aborted) throw Object.assign(new Error(signal?.aborted ? 'Tool call aborted.' : 'Tool call timed out.'), { code: signal?.aborted ? 'aborted' : 'tool-timeout', cause: error });
                throw error;
            } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
        },
        async close() { if (closed) return; closed = true; if (connected) { try { await client.close(); } finally { connected = false; } } }
    };
}
