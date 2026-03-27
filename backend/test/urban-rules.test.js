import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { setupUrbanRulesRoute } from '../routes/urban-rules.js';
import { createRouteApp } from './helpers/create-route-app.js';
import { createMockPool } from './helpers/mock-pool.js';

let pool;
let app;

beforeEach(() => {
    pool = createMockPool();
    app = createRouteApp(setupUrbanRulesRoute, pool);
});

describe('GET /urban-rules', () => {
    it('rejects missing coordinates', async () => {
        const res = await request(app).get('/urban-rules');
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Missing required parameter: coordinates' });
    });

    it('rejects malformed coordinate formats', async () => {
        const res = await request(app).get('/urban-rules?coordinates=15.9');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Invalid coordinates. Expected x,y format.' });
    });

    it('rejects invalid coordinate ranges', async () => {
        const res = await request(app).get('/urban-rules?coordinates=9999,9999');
        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            error: 'Invalid coordinate range. Expected WGS84 (lon,lat) or HTRS96/TM (x,y) coordinates.'
        });
    });

    it('returns grouped urban rules for valid coordinates', async () => {
        pool.setResult({
            rows: [{
                geom_hash: 'hash1',
                geom: null,
                title: 'Residential Rule',
                short_name: 'R1',
                exception_from: null,
                exception_para: null,
                created_at: '2026-01-01',
                updated_at: '2026-01-02',
                updated_by: 'planner',
                paragraph: '1',
                text: '**General:**\n1. Building height applies.',
                text_updated_at: '2026-01-03',
                text_updated_by: 'planner',
                rule_id: 1,
                var_rule_short_name: 'R1',
                land_uses_text: 'Housing',
                land_uses_marks: 'H',
                exception_paragraph: null,
                variables: { max_height: 4 }
            }],
            rowCount: 1
        });

        const res = await request(app).get('/urban-rules?coordinates=15.9,45.79');
        expect(res.status).toBe(200);
        expect(res.body.coordinate_system).toBe('WGS84');
        expect(res.body.rule_count).toBe(1);
        expect(res.body.urban_rules[0].title).toBe('Residential Rule');
        expect(res.body.urban_rules[0].text_entry.analyzed_formatted.sections[0].name).toBe('General');
    });

    it('groups duplicate rule rows, keeps iznimka text, and filters iznimka text from regular rules', async () => {
        pool.setResult({
            rows: [
                {
                    geom_hash: 'hash1',
                    geom: null,
                    title: 'Residential Rule',
                    short_name: 'R1',
                    exception_from: null,
                    exception_para: null,
                    created_at: '2026-01-01',
                    updated_at: '2026-01-02',
                    updated_by: 'planner',
                    paragraph: '1',
                    text: '**General:**\n1. IZNIMKA for a different rule.',
                    text_updated_at: '2026-01-03',
                    text_updated_by: 'planner',
                    rule_id: 1,
                    var_rule_short_name: 'R1',
                    land_uses_text: 'Housing',
                    land_uses_marks: 'H',
                    exception_paragraph: null,
                    variables: { max_height: 4 }
                },
                {
                    geom_hash: 'hash1',
                    geom: null,
                    title: 'Residential Rule',
                    short_name: 'R1',
                    exception_from: null,
                    exception_para: null,
                    created_at: '2026-01-01',
                    updated_at: '2026-01-02',
                    updated_by: 'planner',
                    paragraph: '2',
                    text: '**Ignored:**\n1. Should not replace first text entry.',
                    text_updated_at: '2026-01-04',
                    text_updated_by: 'planner-2',
                    rule_id: null,
                    var_rule_short_name: null,
                    land_uses_text: null,
                    land_uses_marks: null,
                    exception_paragraph: null,
                    variables: null
                },
                {
                    geom_hash: 'hash2',
                    geom: null,
                    title: 'IZNIMKA',
                    short_name: 'IZ-1',
                    exception_from: 'R1',
                    exception_para: '1',
                    created_at: '2026-01-05',
                    updated_at: '2026-01-06',
                    updated_by: 'planner',
                    paragraph: '1',
                    text: '**Special:**\n1. Iznimno odstupanje vrijedi.',
                    text_updated_at: '2026-01-07',
                    text_updated_by: 'planner',
                    rule_id: null,
                    var_rule_short_name: null,
                    land_uses_text: null,
                    land_uses_marks: null,
                    exception_paragraph: null,
                    variables: null
                }
            ],
            rowCount: 3
        });

        const res = await request(app).get('/urban-rules?coordinates=15.9,45.79');

        expect(res.status).toBe(200);
        expect(res.body.rule_count).toBe(2);
        expect(res.body.urban_rules).toHaveLength(2);
        expect(res.body.urban_rules[0].text_entry).toBeNull();
        expect(res.body.urban_rules[0].rule_variable).toMatchObject({ rule_id: 1, rule_short_name: 'R1' });
        expect(res.body.urban_rules[1].title).toBe('IZNIMKA');
        expect(res.body.urban_rules[1].text_entry.text).toContain('Iznimno');
        expect(res.body.urban_rules[1].text_entry.analyzed_formatted.sections[0].name).toBe('Special');
    });

    it('parses numbered section markers and root paragraphs in analyzed text output', async () => {
        pool.setResult({
            rows: [{
                geom_hash: 'hash3',
                geom: null,
                title: 'Mixed Format Rule',
                short_name: 'M1',
                exception_from: null,
                exception_para: null,
                created_at: '2026-01-01',
                updated_at: '2026-01-02',
                updated_by: 'planner',
                paragraph: '1',
                text: '1. Standalone paragraph\n2. **Nested Section:**\n3. Iznimno allowed here',
                text_updated_at: '2026-01-03',
                text_updated_by: 'planner',
                rule_id: null,
                var_rule_short_name: null,
                land_uses_text: null,
                land_uses_marks: null,
                exception_paragraph: null,
                variables: null
            }],
            rowCount: 1
        });

        const res = await request(app).get('/urban-rules?coordinates=15.9,45.79');

        expect(res.status).toBe(200);
        const sections = res.body.urban_rules[0].text_entry.analyzed_formatted.sections;
        expect(sections[0].name).toBe('General');
        expect(sections[0].paragraphs[0]).toMatchObject({ name: '1', text: 'Standalone paragraph', isException: false });
        expect(sections[1].name).toBe('Nested Section');
        expect(sections[1].paragraphs[0]).toMatchObject({ name: '3', isException: true });
    });

    it('returns 404 when no rules are found', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app).get('/urban-rules?coordinates=15.9,45.79');

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'No urban rules found for the given coordinates.' });
    });

    it('returns 400 when more than two rules match a point', async () => {
        pool.setResult({
            rows: [
                { title: 'Rule 1' },
                { title: 'Rule 2' },
                { title: 'Rule 3' }
            ],
            rowCount: 3
        });

        const res = await request(app).get('/urban-rules?coordinates=15.9,45.79');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            error: 'Too many urban rules found for the given coordinates.',
            count: 3,
            message: 'Expected 1-2 urban rules, but found 3.'
        });
    });

    it('reports HTRS96 coordinate systems for projected inputs', async () => {
        pool.setResult({
            rows: [{
                geom_hash: 'hash1',
                geom: null,
                title: 'Residential Rule',
                short_name: 'R1',
                exception_from: null,
                exception_para: null,
                created_at: '2026-01-01',
                updated_at: '2026-01-02',
                updated_by: 'planner',
                paragraph: null,
                text: null,
                text_updated_at: null,
                text_updated_by: null,
                rule_id: null,
                var_rule_short_name: null,
                land_uses_text: null,
                land_uses_marks: null,
                exception_paragraph: null,
                variables: null
            }],
            rowCount: 1
        });

        const res = await request(app).get('/urban-rules?coordinates=500000,5050000');

        expect(res.status).toBe(200);
        expect(res.body.coordinate_system).toBe('HTRS96/TM');
    });

    it('returns 500 when the urban rules lookup fails', async () => {
        pool.query = async () => {
            throw new Error('urban rules offline');
        };

        const res = await request(app).get('/urban-rules?coordinates=15.9,45.79');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Internal server error' });
    });
});