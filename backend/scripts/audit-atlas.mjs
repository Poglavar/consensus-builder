// Audit a locally supplied Atlas sample. Emits counts and evidence states, never source geometry
// or row-level numeric constraints; does not fetch data, call an API or write proposals.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { auditAtlasCollection } from '../planning/atlas-audit.js';

const [input, product = 'slices', ...extra] = process.argv.slice(2);
if (!input || extra.length) {
    console.error('Usage: node backend/scripts/audit-atlas.mjs <local.geojson> [slices|districts]');
    process.exitCode = 1;
} else {
    const bytes = readFileSync(input);
    const result = auditAtlasCollection(JSON.parse(bytes.toString('utf8')), { product });
    console.log(JSON.stringify({ inputSha256: createHash('sha256').update(bytes).digest('hex'), ...result }, null, 2));
}
