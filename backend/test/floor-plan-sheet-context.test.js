// Sheet context: lenient parsing of a paid reading, and the storey formula a sheet implies.
import { describe, expect, it } from 'vitest';
import { parseSheetContext,enqueueSheetTasks } from '../floor-plans/sheet-context.js';
import { storeysFromSheet } from '../floor-plans/site-model.js';

const reading = (overrides = {}) => ({
    schema: 'sheet-context.v1', kind: 'unit-plan',
    orientation: { northDeg: null, basis: 'street-labels', streets: [{ name: 'Ulica Grada Vukovara', side: 'bottom' }, { name: 'Strojarska cesta', side: 'right' }], evidence: 'labels' },
    keyPlan: { present: true, unitCenter: [0.04, 0.8], blocks: 3, unitBlock: 1, evidence: 'tlocrt petog kata' },
    storeys: { aboveGround: 9, belowGround: 1, recessedTop: true, evidence: 'južno pročelje' },
    elevations: [{ level: 5, label: '+18,40', elevationM: 18.4 }], floorLabel: 'PETI', issues: [], ...overrides,
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
