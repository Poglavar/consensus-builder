import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { createRequire } from 'node:module';
import { parse } from '@babel/parser';
const source = readFileSync(new URL('../../frontend/js/building-blocks.js', import.meta.url), 'utf8');
const ast = parse(source, { sourceType: 'script' });
const fn = name => { const n = ast.program.body.find(item => item.type === 'FunctionDeclaration' && item.id.name === name); return source.slice(n.start, n.end); };
const history = createRequire(import.meta.url)('../../frontend/js/geometry-edit/history.js');
function harness() {
    const display = vi.fn(), sync = vi.fn(), handles = vi.fn();
    const context = createContext({ display, sync, handles });
    runInContext(`
        let blockifyMode='parametric', generatedBuildingFeature={geometry:{type:'Polygon',coordinates:[]},properties:{height:10}}, generatedBuildingFeatures=null;
        let manualOuterRing=[], lastOuterRing=[[0,0],[1,0],[0,0]], currentSetback=2, currentBuildingWidth=8, currentBuildingHeight=10;
        let currentChamferM=0, currentSimplifyM=0, gapPositions=[], wingPositions=[], currentGapWidth=5, currentWingLength=10;
        let blockRuleKind='maximum', blockMinHeightM=0, blockMinDepthM=0, blockMinPlotAreaM2=50, blockRuleExtras={}, blockVariationSeed=123;
        const DEFAULT_BLOCK_RULE_KIND='maximum', DEFAULT_BLOCK_MIN_PLOT_AREA_M2=50;
        const blockifyOuterRing=()=>[], syncBlockifyControlsFromState=sync, setFootprintSlidersEnabled=()=>{}, updateManualToggleLabel=()=>{};
        const displayBuildingInModal=display, renderGapWingHandles=handles, renderManualPolygonEditor=()=>{}, displayBuildingsInModal=()=>{};
        ${fn('blockifyClone')} ${fn('blockifyGeometrySnapshot')} ${fn('restoreBlockifyGeometrySnapshot')}
        this.capture=blockifyGeometrySnapshot; this.restore=restoreBlockifyGeometrySnapshot;
        this.edit=(key,value)=>{ if(key==='height') { currentBuildingHeight=value; generatedBuildingFeature.properties.height=value; }
          if(key==='setback') currentSetback=value; if(key==='gaps') gapPositions=value; if(key==='wings') wingPositions=value;
          if(key==='gapWidth') currentGapWidth=value; if(key==='wingLength') currentWingLength=value; if(key==='extras') blockRuleExtras=value; };
    `, context);
    return { context, display, sync, handles };
}
describe('Block parameter history', () => {
    it.each([['height', 20], ['setback', 4], ['gaps', [0.3]], ['wings', [0.5]], ['gapWidth', 9], ['wingLength', 35], ['extras', { balconyDepthM: 2, roof: 'pitched' }]])('restores %s and redraws the saved design', (key, value) => {
        const h = harness(), stack = history.create({ capture: h.context.capture, restore: h.context.restore });
        const before = JSON.stringify(h.context.capture());
        stack.record(); h.context.edit(key, value);
        expect(JSON.stringify(h.context.capture())).not.toBe(before);
        expect(stack.undo()).toBe(true);
        expect(JSON.stringify(h.context.capture())).toBe(before);
        expect(h.sync).toHaveBeenCalledOnce(); expect(h.display).toHaveBeenCalledOnce(); expect(h.handles).toHaveBeenCalledOnce();
    });
});
