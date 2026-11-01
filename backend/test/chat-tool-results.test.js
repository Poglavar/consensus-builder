import { describe, expect, it } from 'vitest';
import { compactForModel, planFromResult, summarizeStep } from '../chat/tool-results.js';

describe('chat tool results', () => {
    it('keeps useful compact placement data without geometry or preview links', () => {
        const result = { structuredContent: { cid: 'cid-1', draftRef: 'https://secret.example/design-draft', takes: Array.from({ length: 40 }, (_, i) => `parcel-${i}`), previewUrl: 'https://secret.example', untrusted: { title: 'Park', goal: 'park', design: { schema: 'design/v1', title: 'Park', goal: 'park', geometry: { buildings: [{ geometry: { coordinates: 'x'.repeat(50000) } }] } } }, plan: { cid: 'plan-1', draftRef: 'https://secret.example/plan-draft', untrusted: { plan: { schema: 'plan/v1', designCids: ['cid-1'] } } }, placement: { status: 'placed' }, consequences: { removed: [{ cid: 'old', untrusted: { title: 'Old' } }] } } };
        const text = compactForModel('ugt_draft_space', result);
        expect(text.length).toBeLessThanOrEqual(4096);
        expect(text).toContain('parcel-0'); expect(text).toContain('cid-1'); expect(text).toContain('Park'); expect(text).not.toContain('50000'); expect(text).not.toContain('previewUrl'); expect(text).not.toContain('draftRef');
        expect(planFromResult('ugt_draft_space', result)).toEqual({ draftRef: 'https://secret.example/plan-draft', cid: 'plan-1', placement: { status: 'placed', code: undefined, conflictCount: 0, conflicts: [] }, consequences: { removed: [{ cid: 'old', title: 'Old' }], junctions: [], cuts: undefined } });
    });
    it('compacts errors and reports an intelligible step', () => {
        expect(JSON.parse(compactForModel('ugt_edit_plan', { isError: true, structuredContent: { code: 'conflict', message: 'Tool request failed.', untrusted: { message: 'occupied' } } }))).toMatchObject({ ok: false, code: 'conflict', message: 'occupied' });
        expect(summarizeStep('ugt_edit_plan', {}, { structuredContent: { title: 'Plan' } })).toContain('Plan');
    });
    it('retains exact ambiguity choices and array navigation without invented partial geometry', () => {
        const matches = [{ parcelId: 'P#cadastre-1', point: [1, 2], partIndex: 1 }, { parcelId: 'P#cadastre-2', point: [3, 4], partIndex: 2 }];
        expect(JSON.parse(compactForModel('ugt_select_parcels', { isError: true, structuredContent: { code: 'parcel-ambiguous', constraints: { matches } } })).matches).toEqual(matches);
        const value = Array.from({ length: 40 }, () => ({ type: 'node', lat: 51, lon: 0 }));
        expect(JSON.parse(compactForModel('ugt_inspect_design', { values: [{ path: '/roadProposal/definition/osm/elements', untrustedValue: value }] })).values[0].value)
            .toMatchObject({ truncated: true, type: 'array', length: 40, itemKeys: ['type', 'lat', 'lon'] });
    });
    it('extracts plan revisions and ignores refused or unrelated calls', () => {
        expect(planFromResult('ugt_edit_plan', { structuredContent: { plan: { draftRef: 'http://localhost/d', cid: 'p2' }, changes: ['move'] } })).toMatchObject({ cid: 'p2', changes: ['move'] });
        expect(planFromResult('ugt_edit_design', { structuredContent: { cid: 'design-2', draftRef: 'http://localhost/design', plan: { cid: 'p2', draftRef: 'http://localhost/plan' }, placement: { status: 'placed' } } })).toMatchObject({ cid: 'p2', draftRef: 'http://localhost/plan' });
        const refused = { structuredContent: { cid: 'design-3', draftRef: 'http://localhost/design', plan: { cid: 'p2', status: 'unchanged' }, placement: { status: 'refused', conflicts: [{ cid: 'holding', untrusted: { title: 'Existing design' } }] } } };
        expect(JSON.parse(compactForModel('ugt_draft_building', refused))).toMatchObject({ ok: false, placement: { status: 'refused', conflicts: [{ cid: 'holding', title: 'Existing design' }] } });
        expect(planFromResult('ugt_draft_building', refused)).toBeNull();
        expect(planFromResult('ugt_edit_plan', { isError: true, structuredContent: { plan: { draftRef: '/d', cid: 'x' } } })).toBeNull();
        expect(planFromResult('ugt_find_place', { structuredContent: { plan: { draftRef: '/d', cid: 'x' } } })).toBeNull();
    });
    it('keeps exact bounded JSON-pointer values and essential CIDs when change arrays are large', () => {
        const inspect = JSON.parse(compactForModel('ugt_inspect_design', { structuredContent: { cid: 'design-cid', values: [{ path: '/geometry/buildings/0/properties/floors', untrustedValue: 6 }, { path: '/geometry/buildings/0/geometry/coordinates', untrustedValue: [[1, 2], [3, 4]] }] } }));
        expect(inspect.values).toEqual([{ path: '/geometry/buildings/0/properties/floors', value: 6 }, { path: '/geometry/buildings/0/geometry/coordinates', value: [[1, 2], [3, 4]] }]);
        const large = JSON.parse(compactForModel('ugt_edit_plan', { structuredContent: { cid: 'plan-cid', changes: Array.from({ length: 40 }, (_, i) => ({ type: 'modify', ref: `design:${i}`, afterCid: `cid-${i}`, extra: 'x'.repeat(300) })) } }));
        expect(large.cid).toBeUndefined(); expect(large.truncated).toBe(true); expect(large.changes.length).toBeGreaterThan(0); expect(JSON.stringify(large).length).toBeLessThanOrEqual(4096);
    });
    it('keeps all compacted responses within 4096 UTF-8 bytes for multibyte payloads', () => {
        const huge = '🌇東京街区建设 '.repeat(3000);
        const cases = [
            ['ugt_draft_building', { ok: false, cid: 'design-cid', title: huge, placement: { status: 'refused', conflicts: Array.from({ length: 30 }, (_, i) => ({ cid: `c-${i}`, untrusted: { title: huge }, overlapM2: 12 })) } }],
            ['ugt_edit_plan', { ok: false, code: 'conflict', cid: 'private-plan-cid', changes: Array.from({ length: 40 }, (_, i) => ({ type: 'modify', ref: `design:${i}`, beforeCid: `before-${i}`, afterCid: `after-${i}`, label: huge })) }],
            ['ugt_find_place', { candidates: Array.from({ length: 50 }, (_, i) => ({ kind: 'parcel', title: huge, untrusted: { title: huge }, city: huge, parcelIds: [`parcel-${i}`] })) }],
            ['ugt_parcel_context', { parcelSourceId: huge, designs: Array.from({ length: 40 }, () => ({ cid: 'design-cid', untrusted: { title: huge }, goal: huge })) }],
            ['ugt_help', { text: huge }]
        ];
        for (const [name, payload] of cases) {
            const text = compactForModel(name, { structuredContent: payload });
            expect(Buffer.byteLength(text, 'utf8'), name).toBeLessThanOrEqual(4096);
            if (name === 'ugt_edit_plan') expect(JSON.parse(text)).toMatchObject({ ok: false, code: 'conflict', truncated: true, changeCount: 40 });
            if (name === 'ugt_draft_building') expect(JSON.parse(text).placement).toMatchObject({ status: 'refused', conflictCount: 30 });
        }
    });
    it('reports an oversized inspect value by pointer without dropping its contents silently', () => {
        const oversized = { geometry: { content: 'secret?', coordinates: '界'.repeat(1200) }, nested: { untrusted: true } };
        const text = compactForModel('ugt_inspect_design', { structuredContent: { values: [{ path: '/geometry/content', untrustedValue: oversized }] } });
        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(4096);
        expect(JSON.parse(text).values[0]).toMatchObject({ path: '/geometry/content', value: { truncated: true, type: 'object', fields: { geometry: { keys: ['content', 'coordinates'] }, nested: { keys: ['untrusted'] } } } });
        const exact = { geometry: { content: 'included' }, nested: { untrusted: true } };
        expect(JSON.parse(compactForModel('ugt_inspect_design', { structuredContent: { values: [{ path: '/x', untrustedValue: exact }] } })).values[0].value).toEqual(exact);
    });
    it('does not expose plan CIDs while retaining member design CIDs', () => {
        for (const name of ['ugt_inspect_plan','ugt_edit_plan','ugt_get_plan','ugt_draft_plan']) {
            const payload = { cid: 'private-plan-cid', plan: { cid: 'private-plan-cid', designCids: ['member-design-cid'] }, designs: [{ cid: 'member-design-cid' }], items: [{ cid: 'member-design-cid' }], changes: [{ type: 'modify', afterCid: 'member-design-cid' }] };
            const compact = JSON.parse(compactForModel(name, { structuredContent: payload }));
            expect(JSON.stringify(compact)).not.toContain('private-plan-cid');
            expect(JSON.stringify(compact)).toContain('member-design-cid');
        }
    });
    it('reads place and parcel titles from untrusted fields', () => {
        expect(JSON.parse(compactForModel('ugt_find_place', { structuredContent: { candidates: [{ untrusted: { title: 'Quiet park' } }] } })).candidates[0].title).toBe('Quiet park');
        expect(JSON.parse(compactForModel('ugt_parcel_context', { structuredContent: { designs: [{ cid: 'd1', untrusted: { title: 'Housing' } }] } })).designs[0].title).toBe('Housing');
    });
});
