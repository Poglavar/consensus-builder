// AST analysis of consensus-builder's proposals.js god-file.
// Extracts top-level declarations, window.* exports, shared mutable state, and an
// in-file call graph so we can plan a behavior-preserving split into modules.
const fs = require('fs');
const acorn = require('acorn');
const walk = require('acorn-walk');

const FILE = process.argv[2];
const src = fs.readFileSync(FILE, 'utf8');
const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', locations: true });

const topFns = new Map();      // name -> {start,end,sl,el}
const topVars = new Map();     // name -> {kind, sl, el, init}
const topClasses = new Map();
const windowAssigns = [];      // {name, sl}
const otherTop = [];           // side-effecting top-level statements
const line = (n) => n.loc.start.line;

for (const node of ast.body) {
  if (node.type === 'FunctionDeclaration') {
    topFns.set(node.id.name, { sl: line(node), el: node.loc.end.line, node });
  } else if (node.type === 'VariableDeclaration') {
    for (const d of node.declarations) {
      if (d.id.type === 'Identifier') {
        topVars.set(d.id.name, { kind: node.kind, sl: line(node), el: node.loc.end.line,
          initType: d.init ? d.init.type : 'none' });
      }
    }
  } else if (node.type === 'ClassDeclaration') {
    topClasses.set(node.id.name, { sl: line(node), el: node.loc.end.line });
  } else if (node.type === 'ExpressionStatement') {
    const e = node.expression;
    if (e.type === 'AssignmentExpression' && e.left.type === 'MemberExpression' &&
        e.left.object.type === 'Identifier' && e.left.object.name === 'window') {
      const prop = e.left.property.name || (e.left.property.value);
      windowAssigns.push({ name: prop, sl: line(node), rhs: e.right.type,
        rhsName: e.right.type === 'Identifier' ? e.right.name : null });
    } else {
      otherTop.push({ type: e.type, sl: line(node),
        callee: e.type === 'CallExpression' && e.callee.type === 'Identifier' ? e.callee.name : null });
    }
  } else {
    otherTop.push({ type: node.type, sl: line(node) });
  }
}

const topNames = new Set([...topFns.keys(), ...topVars.keys(), ...topClasses.keys()]);

// Build a call/reference graph: for each top-level fn, which top-level names it references.
const refs = new Map();        // fnName -> Set(referenced top-level names)
const externalRefs = new Map(); // fnName -> Set(identifiers not defined at top level & not local)
function collectRefs(fnName, fnNode) {
  const used = new Set();
  walk.ancestor(fnNode, {
    Identifier(node, _state, ancestors) {
      const nm = node.name;
      // skip property keys (obj.PROP) where PROP isn't a real binding ref
      const parent = ancestors[ancestors.length - 2];
      if (parent && parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
      if (parent && parent.type === 'Property' && parent.key === node && !parent.computed) return;
      used.add(nm);
    }
  });
  const inFile = new Set();
  for (const u of used) if (topNames.has(u) && u !== fnName) inFile.add(u);
  refs.set(fnName, inFile);
}
for (const [name, info] of topFns) collectRefs(name, info.node);

// Which top-level VARS are referenced by 2+ functions => shared mutable state (the risky part).
const varReaders = new Map(); // varName -> Set(fnNames)
for (const [fn, set] of refs) {
  for (const r of set) {
    if (topVars.has(r)) {
      if (!varReaders.has(r)) varReaders.set(r, new Set());
      varReaders.get(r).add(fn);
    }
  }
}

// Output
const out = {
  totals: {
    lines: src.split('\n').length,
    topFunctions: topFns.size,
    topVars: topVars.size,
    topClasses: topClasses.size,
    windowAssigns: windowAssigns.length,
    windowUnique: new Set(windowAssigns.map(w => w.name)).size,
    otherTopStatements: otherTop.length,
  },
  windowUniqueNames: [...new Set(windowAssigns.map(w => w.name))].sort(),
  topVars: [...topVars.entries()].map(([n, v]) => ({ name: n, kind: v.kind, sl: v.sl, initType: v.initType,
    readers: varReaders.has(n) ? [...varReaders.get(n)].length : 0 })),
  sharedMutable: [...topVars.entries()]
    .filter(([n, v]) => (v.kind === 'let' || v.kind === 'var') && varReaders.has(n) && varReaders.get(n).size >= 2)
    .map(([n, v]) => ({ name: n, kind: v.kind, sl: v.sl, readers: [...varReaders.get(n)].length })),
  otherTop,
};
fs.writeFileSync(process.argv[3] || 'map.json', JSON.stringify({ ...out, refs: Object.fromEntries([...refs].map(([k,v])=>[k,[...v]])), topFns: Object.fromEntries([...topFns].map(([k,v])=>[k,{sl:v.sl,el:v.el}])) }, null, 2));

console.log('TOTALS:', JSON.stringify(out.totals, null, 1));
console.log('\nSIDE-EFFECTING TOP-LEVEL STATEMENTS (load-order sensitive):', otherTop.length);
otherTop.slice(0, 40).forEach(s => console.log(`  L${s.sl}: ${s.type}${s.callee ? ' -> ' + s.callee + '()' : ''}`));
console.log('\nSHARED MUTABLE TOP-LEVEL STATE (let/var read by >=2 fns) — the risky shared state:', out.sharedMutable.length);
out.sharedMutable.sort((a,b)=>b.readers-a.readers).forEach(v => console.log(`  ${v.name} (${v.kind}, L${v.sl}) <- ${v.readers} fns`));
console.log('\nALL top-level let/var (mutable bindings):', [...topVars].filter(([n,v])=>v.kind!=='const').length);
[...topVars].filter(([n,v])=>v.kind!=='const').forEach(([n,v])=>console.log(`  ${n} (${v.kind}, L${v.sl})`));
