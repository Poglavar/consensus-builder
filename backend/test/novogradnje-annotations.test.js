import { describe, expect, it } from 'vitest';
import A from '../../frontend/novogradnje/review/annotations.js';

const metadata = { unitId: 'S2', sourceSha256: 'a'.repeat(64), page: 1, draftId: 'draft-v14-S2' };

describe('draft plan annotations', () => {
    it('maps client coordinates through the zoomed and scrolled source viewport into stable normalized coordinates', () => {
        const rectAt100 = { left: 20, top: 40, width: 800, height: 600 };
        const point = A.pointFromClient(420, 340, rectAt100);
        expect(point).toEqual([0.5, 0.5]);
        const rectAt200 = { left: -180, top: -110, width: 1600, height: 1200 };
        const zoomedPoint = A.pointFromClient(620, 490, rectAt200);
        expect(zoomedPoint).toEqual(point);
        expect(A.sourcePointToClient(zoomedPoint, rectAt200)).toEqual({ x: 620, y: 490 });
        expect(A.pointFromClient(10, 40, rectAt100)).toBeNull();
    });

    it('keeps the pin comment popover inside a small visible viewport after zoom and scroll', () => {
        const viewport = { width: 360, height: 500 }, popover = { width: 270, height: 180 };
        const stage = { width: 2880, height: 2240 }, scroll = { left: 2400, top: 1800 };
        const pin = [0.95, 0.95];
        const placed = A.popoverPosition(pin, stage, viewport, scroll, popover);
        expect(placed).toEqual({ left: 2454, top: 1936, visibleLeft: 54, visibleTop: 136 });
        expect(placed.visibleLeft).toBeGreaterThanOrEqual(0);
        expect(placed.visibleTop).toBeGreaterThanOrEqual(0);
        expect(placed.visibleLeft + popover.width).toBeLessThanOrEqual(viewport.width);
        expect(placed.visibleTop + popover.height).toBeLessThanOrEqual(viewport.height);
        const mobileEdge = A.popoverPosition([0.99, 0.99], { width: 720, height: 900 }, { width: 320, height: 250 }, { left: 400, top: 640 }, { width: 250, height: 160 });
        expect(mobileEdge.visibleLeft + 250).toBeLessThanOrEqual(320);
        expect(mobileEdge.visibleTop + 160).toBeLessThanOrEqual(250);
        const centered = A.popoverPosition([0.9, 0.9], { width: 300, height: 220 }, { width: 420, height: 300 },
            { left: 0, top: 0 }, { width: 280, height: 180 }, 12, { left: 60, top: 40 });
        expect(centered.visibleLeft).toBeGreaterThanOrEqual(0);
        expect(centered.visibleLeft + 280).toBeLessThanOrEqual(420);
        expect(centered.left + 60).toBe(centered.visibleLeft);
        expect(centered.top + 40).toBe(centered.visibleTop);
    });

    it('validates shape types, point counts, normalized bounds, and identity caps', () => {
        const document = A.newDocument(metadata);
        document.shapes = [
            { id: 'wall-1', type: 'wall', points: [[0.1, 0.2], [0.7, 0.2]], note: '' },
            { id: 'pin_2', type: 'note', points: [[0.5, 0.5]], note: 'Check the doorway' }
        ];
        expect(A.validateDocument(document, metadata)).toBe(true);
        expect(() => A.validateDocument({ ...document, shapes: [{ ...document.shapes[0], points: [[-0.1, 0], [1, 1]] }] })).toThrow(/normalized/);
        expect(() => A.validateDocument({ ...document, shapes: [{ ...document.shapes[0], id: 'bad id' }] })).toThrow(/shape id/);
        expect(() => A.validateDocument({ ...document, shapes: [{ ...document.shapes[0], type: 'opening', points: [[0.1, 0.2]] }] })).toThrow(/normalized/);
        expect(() => A.validateDocument(document, { ...metadata, draftId: 'another-draft' })).toThrow(/draftId/);
        expect(() => A.validateDocument({ ...document, page: 0 })).toThrow(/source page/);
    });

    it('exports the complete source and draft identity with annotations and notes intact', () => {
        const document = A.newDocument(metadata);
        document.revision = 7;
        document.note = 'Use the left edge as the reference.';
        document.shapes = [{ id: 'door-line', type: 'opening', points: [[0.25, 0.4], [0.5, 0.4]], note: 'Likely a window' }];
        const exported = JSON.parse(A.exportDocument(document));
        expect(exported).toMatchObject({ schema: A.SCHEMA, ...metadata, revision: 7,
            note: document.note, shapes: document.shapes });
    });

    it('flushes edits made during a save before allowing navigation', async () => {
        let busy = true, dirty = true, saves = 0, waits = 0;
        const ok = await A.flushChanges({ isBusy: () => busy, isDirty: () => dirty,
            wait: async () => { waits++; busy = false; },
            persist: async () => { saves++; dirty = saves === 1; return true; } });
        expect(ok).toBe(true);
        expect(waits).toBe(1);
        expect(saves).toBe(2);
        expect(dirty).toBe(false);
    });

    it('keeps the page open when a save cannot be confirmed', async () => {
        let saves = 0;
        expect(await A.flushChanges({ isBusy: () => false, isDirty: () => true,
            wait: async () => {}, persist: async () => { saves++; return false; } })).toBe(false);
        expect(saves).toBe(1);
    });

    it('undoes content while retaining the current server revision and update timestamp', () => {
        const current = { ...A.newDocument(metadata), revision: 8, updatedAt: '2026-10-14T10:00:00Z',
            note: 'edited', shapes: [{ id: 'line-1', type: 'wall', points: [[0, 0], [1, 1]], note: '' }] };
        const previous = { ...current, revision: 4, updatedAt: '2026-10-13T10:00:00Z', note: '', shapes: [] };
        const restored = A.restoreContent(current, previous);
        expect(restored).toMatchObject({ ...metadata, revision: 8, updatedAt: current.updatedAt, note: '', shapes: [] });
        expect(A.restoreContent(current, previous)).not.toBe(previous);
    });
});
