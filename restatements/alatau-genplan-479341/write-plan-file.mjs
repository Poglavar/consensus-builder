#!/usr/bin/env node
// Writes the district's portable plan file (ugt-plan-file/v1, docs/portable-plan-files.md) from the
// designs district-designs.mjs builds: import it through Lists → Plans → Import plan file. Local only:
// nothing is pinned, indexed or published.
//
//   node write-plan-file.mjs

import { rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { PLAN_FILE, districtPlanFile } from './district-designs.mjs';

const PlanFile = createRequire(import.meta.url)('../../frontend/js/plan-file.js');
if (process.argv.includes('--help')) {
    console.log('Usage: node write-plan-file.mjs\nWrites the district plan file next to this script.');
    process.exit(0);
}
const file = await districtPlanFile();
const temporary = `${PLAN_FILE}.${process.pid}.tmp`;
await writeFile(temporary, PlanFile.stringify(file));
await rename(temporary, PLAN_FILE);
console.log(`[${new Date().toISOString()}] wrote ${file.designs.length} designs, plan "${file.plan.title}", to ${PLAN_FILE.split('/').slice(-2).join('/')}`);
