import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const inventory = JSON.parse(fs.readFileSync(path.join(root, 'feature-inventory.json')));
const commands = require('../../frontend/js/ui/commands.js').listCommands().map(c => c.id);
const mapped = inventory.commands.map(c => c.id);
const missing = commands.filter(id => !mapped.includes(id));
const retired = mapped.filter(id => !commands.includes(id));
const duplicates = mapped.filter((id, i) => mapped.indexOf(id) !== i);
const files = [...new Set([...inventory.commands, ...inventory.workflows].flatMap(c => c.specs))];
const absent = files.filter(file => !fs.existsSync(path.join(root, file)));
if (missing.length || retired.length || duplicates.length || absent.length) {
  console.error({ missing, retired, duplicates, absent });
  process.exitCode = 1;
} else {
  console.log(`${commands.length} UI commands indexed across ${files.length} spec files. Run headed tests to verify behavior.`);
}
