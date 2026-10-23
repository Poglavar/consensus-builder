// Actual committed restatement designs and their archived immutable source parcels; no network.
import { readFileSync } from 'node:fs';
import * as turf from '@turf/turf';
import { officialPlan, urbanBlocksPlan } from '../../../restatements/upu-borovje/borovje-designs.mjs';
import { projectPlan } from '../../scripts/publish-restatement-archives.mjs';
import { designObject } from '../../agents/agreement-objects.js';
import { createMcpReadTools } from '../../agents/mcp-read-tools.js';
const read = createMcpReadTools({ apiBase: 'https://api.example', appOrigin: 'https://app.example' });
export async function restatementFixture(key) {
    const isBorovje = key.startsWith('borovje');
    const plan = isBorovje ? await (key === 'borovje-official' ? officialPlan() : urbanBlocksPlan()) : projectPlan('pionir-paron', key);
    const path = isBorovje ? 'upu-borovje/data/parcels.geojson' : `pionir-paron/${key}/proposal.geojson`;
    const source = JSON.parse(readFileSync(new URL(`../../../restatements/${path}`, import.meta.url))).features;
    const parcels = source.filter(f => f.properties?.parcelId || f.properties?.['consensus:role'] === 'site')
        .map(f => ({ ...f, id: f.properties.parcelId || f.properties.id,
            properties: { ...f.properties, parcelId: f.properties.parcelId || f.properties.id } }));
    const designs = plan.designs.map(d => {
        const { cid, content } = designObject(d.record), site = turf.feature(read.siteOfDesign(content));
        const parcelIds = parcels.filter(p => turf.booleanIntersects(p, site)).map(p => p.id);
        return { cid, content, parcelIds };
    });
    return { designs, parcels };
}
