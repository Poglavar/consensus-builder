// This pure scorer compares a completed turn against the compact expectations used by chat eval cases.
const getPath = (value, path) => path.split('.').reduce((at, key) => at == null ? undefined : at[key], value);
const argsOf = call => call.args || call.input || {};
export function scoreTurn(expect = {}, turnResult = {}, calls = []) {
    const tools = calls.map(call => call.tool || call.name);
    const includes = (expect.tools || []).every(tool => tools.includes(tool));
    const excludes = (expect.forbidTools || []).every(tool => !tools.includes(tool));
    if (!includes) return { passed: false, reason: 'missing-tool', missing: (expect.tools || []).filter(tool => !tools.includes(tool)) };
    if (!excludes) return { passed: false, reason: 'forbidden-tool-used', used: (expect.forbidTools || []).filter(tool => tools.includes(tool)) };
    const outcome = turnResult.outcome?.type;
    if (expect.outcome && outcome !== expect.outcome) return { passed: false, reason: 'outcome-mismatch', expected: expect.outcome, actual: outcome };
    if (expect.planChanged != null && Boolean(turnResult.planChanged) !== Boolean(expect.planChanged)) return { passed: false, reason: 'plan-changed-mismatch' };
    for (const [tool, paths] of Object.entries(expect.args || {})) {
        const call = calls.find(row => (row.tool || row.name) === tool);
        for (const [path, expected] of Object.entries(paths)) if (!call || getPath(argsOf(call), path) !== expected) return { passed: false, reason: 'argument-mismatch', tool, path, expected, actual: call ? getPath(argsOf(call), path) : undefined };
    }
    return { passed: true, tools, outcome, planChanged: Boolean(turnResult.planChanged) };
}
