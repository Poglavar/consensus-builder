import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { setupSharedPlanSessionsRoute } from '../routes/shared-plan-sessions.js';
import { createSharedPlanSessions } from '../agents/mcp-shared-plan-sessions.js';
import { createMemorySharedPlanRepository } from './helpers/shared-plan-repository.js';
import { canonicalArtifact } from '../agents/shared-plan-artifact.js';
import { designContent } from './helpers/content-fixtures.js';
import { cidOfObject } from '../cid.js';

const services = [];
afterEach(async () => { for (const service of services.splice(0)) await service.close(); });
function fixture() {
    const app = express(); app.use(express.json());
    const sessions = createSharedPlanSessions({ repository: createMemorySharedPlanRepository(), validateArtifact: canonicalArtifact });
    services.push(setupSharedPlanSessionsRoute(app, null, { sessions }));
    const content = designContent(), cid = cidOfObject(content);
    const plan = { schema: 'plan/v1', title: 'Security fixture', designCids: [cid], view: { at: '45.8,15.97,18', mode: '2d' } };
    return { app, sessions, artifact: canonicalArtifact({ cid: cidOfObject(plan), plan, designs: [{ cid, content }] }) };
}
describe('shared plan API security', () => {
    it('authenticates deletion as the owner and leaves no readable or editable session', async () => {
        const { app, sessions, artifact } = fixture(), created = await sessions.create(artifact);
        const path = `/shared-plan-sessions/${created.id}`;
        expect((await request(app).delete(path)).status).toBe(401);
        expect((await request(app).delete(path).set('Authorization', `Bearer ${created.inviteToken}`)).status).toBe(403);
        const response = await request(app).delete(path).set('Authorization', `Bearer ${created.ownerToken}`);
        expect(response.status).toBe(200); expect(response.body).toEqual({ id: created.id, terminated: true });
        expect((await request(app).get(path).set('Authorization', `Bearer ${created.ownerToken}`)).status).toBe(404);
        expect((await request(app).put(path).set('Authorization', `Bearer ${created.inviteToken}`).send({ expectedVersion: 0, artifact })).status).toBe(404);
        expect((await request(app).delete(path).set('Authorization', `Bearer ${created.ownerToken}`)).status).toBe(404);
    });
    it('keeps missing, invalid and invited credentials out of the owner budget', async () => {
        const { app, sessions, artifact } = fixture(), created = await sessions.create(artifact);
        const path = `/shared-plan-sessions/${created.id}`;
        for (const [token, status] of [[null, 401], ['x'.repeat(32), 403], [created.inviteToken, 200]]) {
            for (let i = 0; i < 600; i++) {
                const call = request(app).get(path);
                if (token) call.set('Authorization', `Bearer ${token}`);
                expect((await call).status).toBe(status);
            }
            const exhausted = request(app).get(path);
            if (token) exhausted.set('Authorization', `Bearer ${token}`);
            expect((await exhausted).status).toBe(429);
            expect((await request(app).get(path).set('Authorization', `Bearer ${created.ownerToken}`)).status).toBe(200);
        }
    }, 20_000);
    it('limits creation independently and preserves existing owner access', async () => {
        const { app, artifact } = fixture();
        let first;
        for (let i = 0; i < 10; i++) {
            const response = await request(app).post('/shared-plan-sessions').send({ artifact });
            expect(response.status).toBe(201); first ||= response.body;
        }
        expect((await request(app).post('/shared-plan-sessions').send({ artifact })).status).toBe(429);
        expect((await request(app).get(`/shared-plan-sessions/${first.id}`).set('Authorization', `Bearer ${first.ownerToken}`)).status).toBe(200);
    });
});
