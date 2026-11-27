// A process holding 127.0.0.1 on the port supertest's [::] server drew must not answer its requests.
import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import express from 'express';
import request from 'supertest';

describe('supertest requests', () => {
    it('reach the server they started even when 127.0.0.1 holds the same port', async () => {
        const app = express().get('/who', (req, res) => res.json({ who: 'app' }));
        // Keep the IPv4 port available for the decoy on Linux as well as macOS.
        const server = app.listen({ port: 0, host: '::1', ipv6Only: true });
        await once(server, 'listening');
        const { port } = server.address();
        const decoy = createServer((req, res) => { res.statusCode = 401; res.end(); });
        try {
            decoy.listen(port, '127.0.0.1');
            await once(decoy, 'listening');
            const res = await request(server).get('/who');
            expect([res.status, res.body]).toEqual([200, { who: 'app' }]);
        } finally {
            server.close(); decoy.close();
        }
    });
});
