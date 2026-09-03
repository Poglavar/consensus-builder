// Files the API stores must be embeddable from other origins: the frontend and the API live on
// different hosts in production, and helmet's same-origin resource policy made every thumbnail
// <img> fail there and on every dev port pair.
import { describe, expect, it } from 'vitest';
import express from 'express';
import helmet from 'helmet';
import request from 'supertest';
import { embeddableStatic } from '../utils/embeddable-static.js';

describe('embeddable static files', () => {
    it('overrides helmet with a cross-origin resource policy on the served-file mount only', async () => {
        const app = express();
        app.use(helmet());
        app.use('/uploads', embeddableStatic, (req, res) => res.type('png').send('bytes'));
        app.get('/api', (req, res) => res.json({ ok: true }));

        const file = await request(app).get('/uploads/images/a.png');
        expect(file.status).toBe(200);
        expect(file.headers['cross-origin-resource-policy']).toBe('cross-origin');

        const json = await request(app).get('/api');
        expect(json.headers['cross-origin-resource-policy']).toBe('same-origin');
    });
});
