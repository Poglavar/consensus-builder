// Sheet context: lenient parsing of a paid reading, and the storey formula a sheet implies.
import { describe, expect, it } from 'vitest';
import { parseSheetContext,enqueueSheetTasks,selectSheetPlans } from '../floor-plans/sheet-context.js';
import { storeysFromSheet } from '../floor-plans/site-model.js';

const reading = (overrides = {}) => ({
    schema: 'sheet-context.v1', kind: 'unit-plan',
    orientation: { northDeg: null, basis: 'street-labels', streets: [{ name: 'Ulica Grada Vukovara', side: 'bottom' }, { name: 'Strojarska cesta', side: 'right' }], evidence: 'labels' },
    keyPlan: { present: true, unitCenter: [0.04, 0.8], blocks: 3, unitBlock: 1, evidence: 'tlocrt petog kata' },
    storeys: { aboveGround: 9, belowGround: 1, recessedTop: true, evidence: 'južno pročelje' },
    elevations: [{ level: 5, label: '+18,40', elevationM: 18.4 }], floorLabel: 'PETI', issues: [], ...overrides,
});

const posting = { url: 'https://source.test/stan-s10/', facts: { unitId: 'S10',
    propertyDetails: { propertyType: 'apartment' } } };
const plan = (id, byteCount, unitId = 'S10', extra = {}) => ({ id, kind: 'original', byte_count: byteCount,
    sha256: id.padEnd(64, 'a'), listing_url: posting.url,
    model: { scope: 'unit', unitId, architecture: null, source: { url: `https://source.test/${id}.png` } }, ...extra });

describe('sheet primary-plan selection', () => {
    it('reads one selected primary original per apartment rather than each thumbnail or alternate render', () => {
        const thumb = plan('thumb', 100), full = plan('full', 10000), render = plan('render', 500);
        const other = plan('other', 2000, 'S11');
        for (const plans of [[thumb, full, render, other], [other, render, full, thumb]]) {
            expect(selectSheetPlans([posting], plans).map(row => row.id).sort()).toEqual(['full', 'other']);
        }
    });
    it('preserves whole-floor sheets and geometry placement contexts alongside the selected primary', () => {
        const primary = plan('primary', 10000), thumb = plan('thumb', 100);
        const geometry = plan('geometry', 0, 'S10', { kind: 'machine', model: { scope: 'unit', unitId: 'S10',
            architecture: { schema: 'consensus-builder.floor-architecture.v1' } } });
        const floor = plan('floor', 100, null, { kind: 'reviewed', model: { scope: 'floor' } });
        expect(selectSheetPlans([posting], [primary, thumb, geometry, floor]).map(row => row.id)).toEqual(['geometry', 'floor']);
        const held = { ...geometry, model: { ...geometry.model, quality: { boundaryValid: false } } };
        expect(selectSheetPlans([posting], [primary, thumb, held, floor]).map(row => row.id)).toEqual(['primary', 'geometry', 'floor']);
    });
    it('merges listing aliases before choosing their shared apartment source', () => {
        const facts = { ...posting.facts, sourceId: '123456' };
        const hr = { url: 'https://eurovilla.hr/nekretnina/stan/123456/', facts };
        const en = { url: 'https://eurovilla.hr/en/property/apartment/123456/', facts };
        const full = { ...plan('full', 10000), listing_url: hr.url };
        const thumb = { ...plan('thumb', 100), listing_url: en.url };
        expect(selectSheetPlans([hr, en], [thumb, full]).map(row => row.id)).toEqual(['full']);
    });
    it('queues the selected drawing and reuses it on subsequent passes without queuing derivatives', async () => {
        const calls = [], tasks = new Set();
        const original = (name, bytes) => {
            const url = `https://source.test/${name}.png`, sha = (name === 'full' ? 'a' : 'b').repeat(64);
            return { listing_url: posting.url, source_url: url, sha256: sha, current_sha256: sha,
                image_classified_sha256: sha, bytes_available: true, byte_count: bytes, media_type: 'image/png',
                location_status: 'located', asset: { url, listingOwned: true }, facts: posting.facts,
                image_kind: 'floor_plan', image_status: 'complete', reading: { kind: 'floor_plan', containsPlan: true, confidence: 'high' } };
        };
        const db = { async query(sql, params) {
            calls.push([sql, params]);
            if (sql.includes('CROSS JOIN LATERAL jsonb_array_elements')) return { rows: [original('thumb', 100), original('full', 10000)] };
            if (sql.startsWith('SELECT url, facts FROM floor_plan.listing')) return { rows: [posting] };
            if (sql.includes('SELECT id FROM floor_plan.plan_task')) return { rows: tasks.has(params[0]) ? [{ id: 'existing' }] : [] };
            if (sql.startsWith('INSERT INTO floor_plan.plan_task')) { tasks.add(params[1]); return { rows: [], rowCount: 1 }; }
            return { rows: [] };
        } };
        expect(await enqueueSheetTasks(db, { listingUrls: [posting.url] })).toEqual({ sources: 1, enqueued: 1, reused: 0, deferred: 0 });
        expect(await enqueueSheetTasks(db, { listingUrls: [posting.url] })).toEqual({ sources: 1, enqueued: 0, reused: 1, deferred: 0 });
        const inserts = calls.filter(([sql]) => sql.startsWith('INSERT INTO floor_plan.plan_task'));
        expect(inserts).toHaveLength(1);
        expect(inserts[0][1][1]).toBe('a'.repeat(64));
        expect(inserts[0][1][2]).toBe('https://source.test/full.png');
    });
});

describe('sheet context', () => {
    it('reuses a sheet already read through another listing alias without queuing paid work',async()=>{
        const statements=[];
        const db={query:async(sql)=>{
            statements.push(sql);
            if(sql.includes('SELECT DISTINCT ON (t.current_sha256)'))return {rows:[{sha256:'a'.repeat(64),source_url:'https://source.test/sheet.png',listing_url:'https://source.test/new-alias'}]};
            if(sql.includes('SELECT id FROM floor_plan.plan_task'))return {rows:[{id:'existing-task'}]};
            return {rows:[],rowCount:0};
        }};
        expect(await enqueueSheetTasks(db,{listingUrls:['https://source.test/new-alias']})).toMatchObject({sources:1,enqueued:0,reused:1});
        expect(statements.some(sql=>sql.startsWith('INSERT'))).toBe(false);
    });
    it('keeps orientation from street labels, the key-plan position and the visible storeys', () => {
        const sheet = parseSheetContext(reading());
        expect(sheet.orientation).toMatchObject({ basis: 'street-labels', northDeg: null });
        expect(sheet.keyPlan).toMatchObject({ present: true, unitCenter: [0.04, 0.8], blocks: 3, unitBlock: 1 });
        expect(storeysFromSheet(sheet)).toBe('Po+P+7+Uk');
    });

    it('a printed north arrow outranks street labels; out-of-range values are dropped, not trusted', () => {
        const sheet = parseSheetContext(reading({ orientation: { northDeg: -90, basis: 'north-arrow', streets: [], evidence: 'arrow' },
            keyPlan: { present: true, unitCenter: [1.4, 0.2], blocks: 0, unitBlock: null, evidence: '' } }));
        expect(sheet.orientation).toMatchObject({ basis: 'north-arrow', northDeg: 270 });
        expect(sheet.keyPlan.unitCenter).toBeNull();
        expect(sheet.keyPlan.blocks).toBeNull();
        expect(sheet.issues.join(' ')).toMatch(/dropped/);
    });

    it('a sheet that does not show the whole height says nothing about storeys', () => {
        expect(storeysFromSheet(parseSheetContext(reading({ storeys: { aboveGround: null, belowGround: null, recessedTop: null, evidence: '' } })))).toBeNull();
        expect(() => parseSheetContext({ schema: 'other' })).toThrow();
    });
});
