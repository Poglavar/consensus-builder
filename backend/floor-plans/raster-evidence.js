// Check interpreted wall positions against the immutable source raster before admission.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const exec=promisify(execFile);

export function attachRasterEvidence(reading,results) {
    if(!Array.isArray(results)||results.length!==reading.plans.length) throw new Error('Incomplete source-raster verification.');
    for(const model of reading.plans) {
        const matches=results.filter(row=>row.unitId===model.unitId);
        if(matches.length!==1||!Array.isArray(matches[0].issues)||!matches[0].rasterEvidence) throw new Error('Source-raster verification identity mismatch.');
        const row=matches[0];
        model.quality.issues=[...new Set([...model.quality.issues,...row.issues])];
        model.quality.rasterEvidence={...row.rasterEvidence,checked:true,passed:row.issues.length===0};
    }
    return reading;
}

export async function verifyRasterEvidence(reading,image,{python=process.env.FLOOR_PLAN_PYTHON||'python3',deadline=Infinity}={}) {
    const directory=await mkdtemp(join(tmpdir(),'floor-plan-raster-'));
    try {
        const source=join(directory,'source.png'),models=join(directory,'models.json');
        await writeFile(source,image.data);await writeFile(models,JSON.stringify(reading));
        const {stdout}=await exec(python,[fileURLToPath(new URL('../scripts/check-floor-plan-raster.py',import.meta.url)),source,models],
            {timeout:Math.max(1,Math.min(120000,deadline-Date.now())),maxBuffer:2*1024*1024});
        return attachRasterEvidence(reading,JSON.parse(stdout));
    } finally {await rm(directory,{recursive:true,force:true});}
}
