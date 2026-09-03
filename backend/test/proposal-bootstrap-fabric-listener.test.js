import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../frontend/js/proposals/bootstrap.js', import.meta.url), 'utf8');

describe('proposal bootstrap fabric listener', () => {
    it('uses the browser root and the captured selected parcel id', () => {
        expect(source).not.toMatch(/\bglobal\.LiveParcelFabric\b/);
        expect(source).toContain('const selectedId = window.selectedParcelId;');
        expect(source).toContain('window.LiveParcelFabric.get(selectedId)');
        expect(source).toContain('window.ParcelPresenter?.getLayer?.(selectedId)');
    });
});
