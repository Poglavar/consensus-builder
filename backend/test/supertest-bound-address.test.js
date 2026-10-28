// A process holding 127.0.0.1 on the port supertest's [::] server drew must not answer its requests.
import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import express from 'express';
import request from 'supertest';

describe('supertest requests', () => {
    it('reach the server they started even when 127.0.0.1 holds the same port', async () => {
        const app = express().get('/who', (req, res) => res.json({ who: 'app' }));
        const server = app.listen(0);
        await once(server, 'listening');
        const { port, address } = server.address();
        // Only a dual-stack wildcard bind can collide this way; elsewhere there is nothing to prove.
        if (!String(address).includes(':')) { server.close(); return; }
        const decoy = createServer((req, res) => { res.statusCode = 401; res.end(); });
        decoy.listen(port, '127.0.0.1');
        await once(decoy, 'listening');
        try {
            const res = await request(server).get('/who');
            expect([res.status, res.body]).toEqual([200, { who: 'app' }]);
        } finally {
            server.close(); decoy.close();
        }
    });
});
