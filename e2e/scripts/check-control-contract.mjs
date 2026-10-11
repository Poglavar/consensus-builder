// Check source inventory and exclusions without launching a browser.
import fs from 'node:fs';
import path from 'node:path';
import { sourceInventory, sourceFiles, frontendRoot } from '../helpers/control-source.mjs';
import { checkExemptionGuards } from '../helpers/control-report.mjs';

const contract = JSON.parse(fs.readFileSync(new URL('../control-contract.json', import.meta.url), 'utf8'));
const sites = sourceInventory();
const current = new Set(sites.map(site => site.id));
const expected = new Set();
const errors = [];
for (const rule of contract.controls) {
  if (expected.has(rule.id)) errors.push(`Duplicate control: ${rule.id}`);
  expected.add(rule.id);
  if (!current.has(rule.id)) errors.push(`Removed or changed button: ${rule.source} ${rule.id}`);
  if (rule.exhaustiveVariants && !rule.variants?.length) errors.push(`Missing action variants: ${rule.id}`);
  for (const variant of rule.variants || []) {
    if (!variant.name || !(variant.label || variant.labelPattern || variant.classes?.length || Object.keys(variant.attrs || {}).length)) {
      errors.push(`Action needs a name and a semantic matcher: ${rule.id}`);
    }
    if (variant.labelPattern) new RegExp(variant.labelPattern);
  }
}
for (const site of sites) if (!expected.has(site.id)) errors.push(`New button needs a contract: ${site.source}:${site.line} ${site.id}`);
const sources = new Map(sourceFiles().map(file => [path.relative(frontendRoot, file), fs.readFileSync(file, 'utf8')]));
errors.push(...checkExemptionGuards(contract, sources));
if (errors.length) {
  errors.forEach(error => console.error(error));
  process.exitCode = 1;
} else console.log(`Button contract matches ${sites.length} source sites; all exclusion guards hold.`);
