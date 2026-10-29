// The Compare tab on the 2D map (frontend/js/compare-on-map.js): which half shows permitted massing,
// what each side draws of demolished buildings and of applied designs, and the two pane clips.
// The panes and the divider over the map are checked in the browser; these are the pure rules.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const compare = require('../../frontend/js/three-compare.js');
const onMap = require('../../frontend/js/compare-on-map.js');

const options = compare.sideOptions({
    designs: [{ id: 'd1', title: 'Block' }, { id: 'd2', title: 'Road' }],
    plans: [{ id: 'plan-a', title: 'Plan A', members: ['d1'] }]
});
const side = value => compare.parseSide(value, options);

describe('the map halves', () => {
    it('shows permitted massing only on the half whose side is Permitted', () => {
        expect(onMap.permittedHalf(side('permitted'), side('permitted'))).toBe('both');
        expect(onMap.permittedHalf(side('permitted'), side('proposed'))).toBe('left');
        expect(onMap.permittedHalf(side('built'), side('permitted'))).toBe('right');
        expect(onMap.permittedHalf(side('built'), side('design:d1'))).toBe('none');
    });

    it('keeps a demolished building whole where its design is not applied, and leaves the remainder where it is', () => {
        const affected = [
            { id: 'cut', geometry: 'whole-cut', remainder: 'rest', demolishedBy: 'd1' },
            { id: 'gone', geometry: 'whole-gone', remainder: null, demolishedBy: 'd2' }
        ];
        expect(onMap.demolishedOn(side('built'), affected)).toEqual([
            { id: 'cut', geometry: 'whole-cut', outcome: null }, { id: 'gone', geometry: 'whole-gone', outcome: null }]);
        expect(onMap.demolishedOn(side('proposed'), affected)).toEqual([{ id: 'cut', geometry: 'rest', outcome: 'cut' }]);
        expect(onMap.demolishedOn(side('design:d1'), affected)).toEqual([
            { id: 'cut', geometry: 'rest', outcome: 'cut' }, { id: 'gone', geometry: 'whole-gone', outcome: null }]);
        expect(onMap.demolishedOn(side('plan:plan-a'), affected)).toEqual(onMap.demolishedOn(side('design:d1'), affected));
    });

    it("draws a design's buildings on Proposed, on that design and on a plan holding it", () => {
        const ids = ['d1', 'd2', 7];
        expect(onMap.designsOn(side('built'), ids)).toEqual([]);
        expect(onMap.designsOn(side('permitted'), ids)).toEqual([]);
        expect(onMap.designsOn(side('proposed'), ids)).toEqual(['d1', 'd2', '7']);
        expect(onMap.designsOn(side('design:d2'), ids)).toEqual(['d2']);
        expect(onMap.designsOn(side('plan:plan-a'), ids)).toEqual(['d1']);
    });

    it('clips each pane to its side of the divider over the visible map', () => {
        expect(onMap.halfClips({ left: -100, top: 20, right: 700, bottom: 520 }, 250)).toEqual({
            left: 'polygon(-100px 20px, 250px 20px, 250px 520px, -100px 520px)',
            right: 'polygon(250px 20px, 700px 20px, 700px 520px, 250px 520px)'
        });
    });
});
