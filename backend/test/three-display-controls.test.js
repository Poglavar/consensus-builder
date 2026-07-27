// Guards the compact Built/Planned selector contract so the fourth Built state cannot reintroduce
// uneven segmented widths or label truncation in abstract 3D.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const threeModeSource = readFileSync(new URL('../../frontend/js/three-mode.js', import.meta.url), 'utf8');
const mapCssSource = readFileSync(new URL('../../frontend/css/map.css', import.meta.url), 'utf8');

describe('abstract 3D display controls', () => {
    it('uses an associated select for each state row and forwards changes to the existing policy', () => {
        expect(threeModeSource).toContain("const select = document.createElement('select');");
        expect(threeModeSource).toContain("select.className = 'three-mode-display-select';");
        expect(threeModeSource).toContain("label.htmlFor = `three-mode-${kind}-display`;");
        expect(threeModeSource).toContain("select.addEventListener('change', () => setBuildingDisplay(kind, select.value));");
        expect(threeModeSource).not.toContain("btn.className = 'three-mode-segment';");
    });

    it('keeps both selectors at one readable desktop width and lets them fill narrow screens', () => {
        expect(mapCssSource).toMatch(/\.three-mode-display-select\s*\{[\s\S]*?width: 168px;/);
        expect(mapCssSource).toMatch(/@media \(max-width: 480px\)[\s\S]*?\.three-mode-display-select\s*\{[\s\S]*?width: auto;/);
    });
});
