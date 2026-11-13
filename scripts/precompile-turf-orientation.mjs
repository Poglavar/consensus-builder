// Removes the run-time code generation from the vendored turf 6.5.0 bundle, so the page needs no
// 'unsafe-eval' in its Content-Security-Policy. turf's copy of robust-orientation (used by
// concaveman, which turf.convex calls) builds its exact orientation predicates with new Function()
// and Function.apply() while the bundle loads. This script runs that generator once here, in node,
// and writes the generated functions into the bundle as ordinary source. rbush also compiles its
// coordinate accessors with new Function() whenever it is given a format (concaveman passes
// ["[0]","[1]","[0]","[1]"] on every turf.convex call); those become plain property-reading closures.
// Usage: node scripts/precompile-turf-orientation.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const BUNDLE = fileURLToPath(new URL('../frontend/vendor/turf-6.5.0/turf.min.js', import.meta.url));
const MARKER = '__turfRobustOrientation';

// The three places in the minified robust-orientation module, each of which must occur exactly once.
const EXACT_SITE = 'return new Function("sum","prod","scale","sub",p)(Ut,zt,Xt,Yt)';
const DISPATCH_SITE = 'var s=Function.apply(void 0,n);';
const MODULE_START = 'var Ht=Bt((function(t){function e(t,e){for(var n=new Array(t.length-1)';
const RBUSH_FORMAT = '_initFormat:function(t){var e=["return a"," - b",";"];this.compareMinX=new Function("a","b",e.join(t[0])),'
    + 'this.compareMinY=new Function("a","b",e.join(t[1])),this.toBBox=new Function("a","return {minX: a"+t[0]+", minY: a"+t[1]+'
    + '", maxX: a"+t[2]+", maxY: a"+t[3]+"};")}';
// Same results as rbush's generated accessors for the formats it documents: "[index]" or ".property".
const RBUSH_FORMAT_CLOSURES = '_initFormat:function(t){var g=function(s){var m=/^\\[(\\d+)\\]$|^\\.([A-Za-z_$][\\w$]*)$/.exec(s);'
    + 'if(!m)throw new Error("rbush format "+s+" is not [index] or .property");var k=m[1]!==void 0?+m[1]:m[2];'
    + 'return function(a){return a[k]}},x=g(t[0]),y=g(t[1]),X=g(t[2]),Y=g(t[3]);'
    + 'this.compareMinX=function(a,b){return x(a)-x(b)},this.compareMinY=function(a,b){return y(a)-y(b)},'
    + 'this.toBBox=function(a){return{minX:x(a),minY:y(a),maxX:X(a),maxY:Y(a)}}}';

function once(source, needle) {
    const first = source.indexOf(needle);
    if (first < 0 || source.indexOf(needle, first + 1) >= 0) {
        throw new Error(`expected exactly one occurrence of ${JSON.stringify(needle.slice(0, 60))} in ${BUNDLE}`);
    }
}

// Loads the bundle with a Function stand-in that records each generated body and builds it with
// the real constructor, so the generated code is exactly what the browser would have built.
function recordGeneratedCode(source) {
    const generated = [];
    const RealFunction = Function;
    function RecordingFunction(...args) {
        generated.push(args);
        return RealFunction(...args);
    }
    const context = vm.createContext({ Function: RecordingFunction, console });
    context.self = context;
    vm.runInContext(source, context, { filename: 'turf.min.js' });
    return generated;
}

const source = readFileSync(BUNDLE, 'utf8');
if (source.includes(MARKER)) {
    console.log(`[${new Date().toISOString()}] ${BUNDLE} is already precompiled; nothing to do`);
    process.exit(0);
}
if (process.argv.includes('--check')) {
    console.error(`[${new Date().toISOString()}] ${BUNDLE} still generates code at load; run this script`);
    process.exit(1);
}
for (const needle of [EXACT_SITE, DISPATCH_SITE, MODULE_START, RBUSH_FORMAT]) once(source, needle);

const exact = {};
let dispatch = null;
for (const args of recordGeneratedCode(source)) {
    const body = args[args.length - 1];
    const params = args.slice(0, -1).join(',');
    const name = /^function (orientation\d+Exact)\(/.exec(body)?.[1];
    if (params === 'sum,prod,scale,sub' && name) exact[name] = `function(${params}){${body}}`;
    else if (params.startsWith('slow,') && body.startsWith('function getOrientation(')) dispatch = `function(${params}){${body}}`;
    else throw new Error(`unexpected generated code at load: (${params}) ${body.slice(0, 80)}`);
}
if (Object.keys(exact).length !== 3 || !dispatch) {
    throw new Error(`expected 3 exact predicates and 1 dispatcher, got ${Object.keys(exact).join(', ')} and ${dispatch ? 1 : 0}`);
}

const table = `var ${MARKER}={${Object.entries(exact).map(([k, v]) => `${k}:${v}`).join(',')}},`
    + `${MARKER}Dispatch=${dispatch};`;
const patched = source
    .replace(MODULE_START, table + MODULE_START)
    // Orders above 5 are only built on demand for longer argument lists, which turf never passes.
    .replace(EXACT_SITE, `return (${MARKER}[h]||new Function("sum","prod","scale","sub",p))(Ut,zt,Xt,Yt)`)
    .replace(DISPATCH_SITE, `var s=${MARKER}Dispatch;`)
    .replace(RBUSH_FORMAT, RBUSH_FORMAT_CLOSURES);

if (recordGeneratedCode(patched).length !== 0) throw new Error('the patched bundle still generates code at load');
writeFileSync(BUNDLE, patched);
console.log(`[${new Date().toISOString()}] precompiled ${Object.keys(exact).join(', ')} and getOrientation into ${BUNDLE}`);
