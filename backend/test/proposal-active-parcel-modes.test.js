// Creation-surface contract for the active parcel model: the create dialog keeps cadastral
// boundaries as they are; new borders are drawn with Lay out parcels (a parcel-layout design).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = relative => readFileSync(new URL(`../../frontend/js/${relative}`, import.meta.url), 'utf8');
const dialogSource = read('proposals/dialog-create.js');
const coreSource = read('proposals/core.js');

describe('active proposal parcel modes', () => {
    it('offers only unchanged boundaries in the create dialog', () => {
        expect(dialogSource).toContain('name="proposalParcelsMode" value="as-is"');
        expect(dialogSource).not.toContain('name="proposalParcelsMode" value="readjust"');
        expect(dialogSource).not.toContain('data-proposal-main-type="Reparcellization"');
        expect(dialogSource).not.toContain('parcelsOptions.readjust');
        expect(dialogSource).not.toContain('name="proposalParcelsMode" value="merge"');
        expect(dialogSource).not.toContain('parcelsOptions.merge');
        expect(coreSource).not.toContain("return 'reparcellization'");
    });
});
