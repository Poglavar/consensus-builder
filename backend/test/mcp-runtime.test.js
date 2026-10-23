import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
describe('standalone MCP geometry runtime', () => {
    it('drafts all five kinds without caller cwd dependencies or preloaded globals', () => {
        const script = `
            const {intentDesign,appTurf}=await import(process.argv[1]);
            const site={type:'Polygon',coordinates:[[[-0.1,51.5],[-0.099,51.5],[-0.099,51.501],[-0.1,51.501],[-0.1,51.5]]]};
            const intents=[{kind:'road',points:[[-0.1,51.5],[-0.099,51.5]],preset:'1+1'},
                {kind:'space',spaceKind:'park'},{kind:'building',floors:4},
                {kind:'parcel-layout',algorithm:'equal',count:4},{kind:'urban-rule',rule:{floors:6}}];
            console.log(JSON.stringify(intents.map(intent=>intentDesign.build({...intent,city:'london',site}).goal)));
        `;
        const output = execFileSync(process.execPath, ['--input-type=module', '-e', script, new URL('../agents/mcp-geometry.js', import.meta.url).href], { cwd: tmpdir(), encoding: 'utf8' });
        expect(JSON.parse(output)).toEqual(['road-track', 'park', 'buildings', 'parcel-layout', 'urban-rule']);
    });
});
