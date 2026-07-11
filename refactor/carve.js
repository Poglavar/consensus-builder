// Carve tool: behavior-preserving extraction engine for the proposals.js split.
// Moves the given top-level symbols (by name) out of a source file into a new classic-script
// module, preserving exact source bytes + leading own-line comments, and rewrites the source with
// those ranges removed. Validates name conservation so nothing is silently lost or duplicated.
//
//   node refactor/carve.js <src.js> <out-module.js> <names.txt> "<header comment>"
//   --dry  : print what would move, write nothing
const fs = require('fs');
const acorn = require('/private/tmp/claude-501/-Users-simun-Code/74e9e415-57ac-420a-ba07-7b8542dc8ba0/scratchpad/node_modules/acorn');

const [src, outPath, namesPath, header] = process.argv.slice(2);
const dry = process.argv.includes('--dry');
const code = fs.readFileSync(src, 'utf8');
const want = new Set(fs.readFileSync(namesPath, 'utf8').split('\n').map(s => s.trim()).filter(Boolean));

const comments = [];
const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', locations: true, ranges: true, onComment: comments });

// name(s) declared by a top-level node
function namesOf(node) {
  if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') return [node.id.name];
  if (node.type === 'VariableDeclaration') return node.declarations.map(d => d.id.type === 'Identifier' ? d.id.name : null).filter(Boolean);
  return [];
}
const allTop = [];
for (const node of ast.body) for (const n of namesOf(node)) allTop.push(n);

// find leading own-line comment block immediately above a node (only whitespace between)
function leadingCommentStart(node) {
  let start = node.start;
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    if (c.end <= start && /^\s*$/.test(code.slice(c.end, start))) {
      // comment must be on its own line(s): only whitespace between line-start and comment
      const ls = code.lastIndexOf('\n', c.start - 1) + 1;
      if (/^\s*$/.test(code.slice(ls, c.start))) { start = ls; continue; }
    }
    break;
  }
  return start;
}
function lineStart(pos) { return code.lastIndexOf('\n', pos - 1) + 1; }
function lineEndAfter(pos) { const nl = code.indexOf('\n', pos); return nl === -1 ? code.length : nl + 1; }

const cuts = [];        // {a,b,node,names}
const extractedPieces = [];
const movedNames = [];
const multiViolations = [];

for (const node of ast.body) {
  const ns = namesOf(node);
  const hit = ns.filter(n => want.has(n));
  if (hit.length === 0) continue;
  if (ns.length > 1 && hit.length !== ns.length) { multiViolations.push({ names: ns, wanted: hit }); continue; }
  const a = lineStart(leadingCommentStart(node));
  const b = lineEndAfter(node.end);
  cuts.push({ a, b }); extractedPieces.push(code.slice(a, b)); movedNames.push(...ns);
}

if (multiViolations.length) {
  console.error('ABORT: targeted names share a multi-declarator statement with non-targeted names:');
  multiViolations.forEach(v => console.error('  ', v.names.join(', '), ' wanted:', v.wanted.join(',')));
  process.exit(2);
}
const missing = [...want].filter(n => !movedNames.includes(n));
if (missing.length) { console.error('ABORT: requested names not found at top level:', missing.join(', ')); process.exit(2); }

// build remaining source (remove cuts)
cuts.sort((x, y) => x.a - y.a);
let remaining = '', last = 0;
for (const c of cuts) { remaining += code.slice(last, c.a); last = c.b; }
remaining += code.slice(last);

// name conservation check
const remTop = [];
{
  const rast = acorn.parse(remaining, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
  for (const node of rast.body) for (const n of namesOf(node)) remTop.push(n);
}
const union = new Set([...remTop, ...movedNames]);
const lost = allTop.filter(n => !union.has(n));
const dupInExtract = movedNames.filter(n => remTop.includes(n));
console.log(`carve: ${src} -> ${outPath}`);
console.log(`  moving ${movedNames.length} symbols; remaining top-level: ${remTop.length}; original: ${allTop.length}`);
if (lost.length) { console.error('  ABORT: names lost:', lost.join(', ')); process.exit(2); }
if (dupInExtract.length) { console.error('  ABORT: names in BOTH files:', dupInExtract.join(', ')); process.exit(2); }
if (allTop.length !== remTop.length + movedNames.length) console.warn('  WARN: count mismatch (duplicate top-level names in original?)');
console.log('  name conservation: OK');

const moduleText = `${header || '// extracted from proposals.js'}\n\n${extractedPieces.join('\n')}`;
if (dry) { console.log('  --dry: nothing written'); process.exit(0); }
fs.writeFileSync(outPath, moduleText);
fs.writeFileSync(src, remaining);
console.log(`  wrote ${outPath} (${moduleText.split('\n').length} lines) and rewrote ${src} (${remaining.split('\n').length} lines)`);
