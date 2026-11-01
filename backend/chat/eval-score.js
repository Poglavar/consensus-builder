// This pure scorer compares a completed turn against the compact expectations used by chat eval cases.
const getPath = (value, path) => path.split('.').reduce((at, key) => at == null ? undefined : at[key], value);
const argsOf = call => call.args || call.input || {};
const sameValue = (actual, expected) => Object.is(actual, expected) ||
    (actual && expected && typeof actual === 'object' && typeof expected === 'object' && JSON.stringify(actual) === JSON.stringify(expected));
const positionsOf = value => {
    const isPoint = item => Array.isArray(item) && item.length >= 2
        && item.every(Number.isFinite) && Math.abs(item[0]) <= 180 && Math.abs(item[1]) <= 90;
    if (Array.isArray(value) && value.some(item => item && typeof item === 'object' && Object.hasOwn(item, 'coordinate')))
        return value.every(item => isPoint(item?.coordinate)) ? value.map(item => item.coordinate) : [];
    if (value && typeof value === 'object' && Object.hasOwn(value, 'coordinate')) return isPoint(value.coordinate) ? [value.coordinate] : [];
    const geometry = value?.type === 'Feature' ? value.geometry : value;
    const walk = item => {
        if (!Array.isArray(item)) return { valid: false, points: [] };
        if (item.length >= 2 && (typeof item[0] === 'number' || typeof item[1] === 'number'))
            return isPoint(item) ? { valid: true, points: [item] } : { valid: false, points: [] };
        const points = [];
        for (const child of item) {
            const result = walk(child);
            if (!result.valid) return result;
            points.push(...result.points);
        }
        return { valid: points.length > 0, points };
    };
    const result = walk(geometry?.coordinates);
    return result.valid ? result.points : [];
};
const center = value => {
    const positions = positionsOf(value);
    if (!positions.length) return null;
    const point = positions.reduce((sum, p) => [sum[0] + p[0] / positions.length, sum[1] + p[1] / positions.length], [0, 0]);
    return point.every(Number.isFinite) ? point : null;
};
// Unitless relative area is enough for lifecycle checks. A local lon/lat shoelace ratio avoids
// importing browser geometry; latitude weighting keeps separated MultiPolygon parts comparable.
const polygonalArea = value => {
    const geometry = value?.type === 'Feature' ? value.geometry : value;
    if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) return null;
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    if (!Array.isArray(polygons) || !polygons.length) return null;
    let total = 0;
    for (const rings of polygons) {
        if (!Array.isArray(rings) || !rings.length) return null;
        let component = 0, latSum = 0, pointCount = 0;
        for (const [ringIndex, ring] of rings.entries()) {
            if (!Array.isArray(ring) || ring.length < 4 || ring.some(point => !Array.isArray(point) || point.length < 2
                || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90)) return null;
            const first = ring[0], last = ring.at(-1);
            if (first[0] !== last[0] || first[1] !== last[1]) return null;
            let twice = 0;
            for (let i = 0; i < ring.length - 1; i++) twice += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
            const area = Math.abs(twice) / 2;
            component += ringIndex === 0 ? area : -area;
            for (const point of ring.slice(0, -1)) { latSum += point[1]; pointCount++; }
        }
        if (!(component > 0) || !pointCount) return null;
        total += component * Math.cos((latSum / pointCount) * Math.PI / 180);
    }
    return Number.isFinite(total) && total > 0 ? total : null;
};
const orientation = value => {
    const points = positionsOf(value), lat = center(value)?.[1];
    if (points.length < 3 || !Number.isFinite(lat)) return null;
    const scale = Math.cos(lat * Math.PI / 180), xy = points.map(([x, y]) => [x * scale, y]);
    const mean = xy.reduce((sum, p) => [sum[0] + p[0] / xy.length, sum[1] + p[1] / xy.length], [0, 0]);
    const xx = xy.reduce((sum, p) => sum + (p[0] - mean[0]) ** 2, 0);
    const yy = xy.reduce((sum, p) => sum + (p[1] - mean[1]) ** 2, 0);
    const xyCov = xy.reduce((sum, p) => sum + (p[0] - mean[0]) * (p[1] - mean[1]), 0);
    const angle = 0.5 * Math.atan2(2 * xyCov, xx - yy) * 180 / Math.PI;
    return Number.isFinite(angle) ? angle : null;
};
const angleDifference = degrees => ((degrees + 90) % 180 + 180) % 180 - 90;
const designsOf = plan => plan?.designs || [];
function scoreArtifact(expect, readback) {
    if (!readback?.after) return { passed: false, reason: 'artifact-readback-missing', error: readback?.error };
    const index = expect.designIndex ?? 0;
    const goal = expect.designGoal;
    let afterIndex = index, beforeRow, afterRow;
    if (goal != null) {
        if (typeof goal !== 'string' || !goal.trim()) return { passed: false, reason: 'artifact-design-goal-invalid' };
        const findUnique = plan => {
            const matches = designsOf(plan).flatMap((row, rowIndex) => row.design?.goal === goal ? [{ row, index: rowIndex }] : []);
            return matches.length === 1 ? matches[0] : { count: matches.length };
        };
        const afterMatch = findUnique(readback.after);
        if (!afterMatch.row) return { passed: false, reason: afterMatch.count ? 'artifact-design-goal-ambiguous' : 'artifact-design-goal-missing', goal, count: afterMatch.count };
        afterRow = afterMatch.row; afterIndex = afterMatch.index;
        if (readback.before) {
            const beforeMatch = findUnique(readback.before);
            const needsBeforeTarget = expect.changedPaths != null || expect.unchangedPaths != null || expect.areaRatio != null
                || expect.moved != null || expect.rotated != null;
            if (!beforeMatch.row && needsBeforeTarget) return { passed: false,
                reason: beforeMatch.count ? 'artifact-before-design-goal-ambiguous' : 'artifact-before-design-goal-missing', goal, count: beforeMatch.count };
            if (beforeMatch.row) beforeRow = beforeMatch.row;
        }
    } else {
        if (!Number.isInteger(index) || index < 0) return { passed: false, reason: 'artifact-design-index-invalid', designIndex: index };
        beforeRow = designsOf(readback.before)[index]; afterRow = designsOf(readback.after)[index];
    }
    const before = beforeRow?.design, after = afterRow?.design;
    if (!after) return { passed: false, reason: 'artifact-design-missing', designIndex: afterIndex };
    for (const [path, expected] of Object.entries(expect.paths || {})) {
        const actual = getPath(after, path);
        if (!sameValue(actual, expected)) return { passed: false, reason: 'artifact-path-mismatch', path, expected, actual };
    }
    if (expect.changedPaths != null) {
        if (!Array.isArray(expect.changedPaths) || !expect.changedPaths.length || expect.changedPaths.some(path => typeof path !== 'string' || !path))
            return { passed: false, reason: 'artifact-changed-paths-invalid' };
        if (!before) return { passed: false, reason: 'artifact-before-design-missing', designIndex: afterIndex };
        for (const path of expect.changedPaths) {
            const oldValue = getPath(before, path), newValue = getPath(after, path);
            if (oldValue === undefined || newValue === undefined) return { passed: false, reason: 'artifact-changed-path-missing', path };
            if (sameValue(oldValue, newValue)) return { passed: false, reason: 'artifact-path-unchanged', path };
        }
    }
    if (expect.unchangedPaths != null) {
        if (!Array.isArray(expect.unchangedPaths) || !expect.unchangedPaths.length || expect.unchangedPaths.some(path => typeof path !== 'string' || !path))
            return { passed: false, reason: 'artifact-unchanged-paths-invalid' };
        if (!before) return { passed: false, reason: 'artifact-before-design-missing', designIndex: afterIndex };
        for (const path of expect.unchangedPaths) {
            const oldValue = getPath(before, path), newValue = getPath(after, path);
            if (oldValue === undefined || newValue === undefined) return { passed: false, reason: 'artifact-unchanged-path-missing', path };
            if (!sameValue(oldValue, newValue)) return { passed: false, reason: 'artifact-preserved-path-changed', path };
        }
    }
    if (expect.areaRatio != null) {
        const { path, ratio, tolerance = 0 } = expect.areaRatio;
        if (typeof path !== 'string' || !path || !Number.isFinite(ratio) || ratio <= 0
            || !Number.isFinite(tolerance) || tolerance < 0) return { passed: false, reason: 'artifact-area-ratio-expectation-invalid' };
        if (!before) return { passed: false, reason: 'artifact-before-design-missing', designIndex: afterIndex };
        const beforeArea = polygonalArea(getPath(before, path)), afterArea = polygonalArea(getPath(after, path));
        if (beforeArea == null || afterArea == null) return { passed: false, reason: 'artifact-area-ratio-geometry-missing', path };
        const actual = afterArea / beforeArea, error = Math.abs(actual - ratio);
        if (error > tolerance) return { passed: false, reason: 'artifact-area-ratio-mismatch', path,
            expected: { ratio, tolerance }, actual: { ratio: actual, error } };
    }
    if (expect.proposalKind != null && after.structureProposal?.kind !== expect.proposalKind)
        return { passed: false, reason: 'artifact-proposal-kind-mismatch', expected: expect.proposalKind, actual: after.structureProposal?.kind };
    if (expect.building) {
        const index = Number(expect.building.index ?? 0), properties = after.geometry?.buildings?.[index]?.properties;
        if (!properties) return { passed: false, reason: 'artifact-building-missing', buildingIndex: index };
        for (const field of ['floors', 'rotation', 'type']) if (expect.building[field] != null && properties[field] !== expect.building[field])
            return { passed: false, reason: 'artifact-building-mismatch', buildingIndex: index, field, expected: expect.building[field], actual: properties[field] };
    }
    for (const [name, count] of Object.entries(expect.decorationCounts || {})) {
        const actual = after.structureProposal?.decorationDesign?.[name]?.length;
        if (actual !== count) return { passed: false, reason: 'artifact-decoration-count-mismatch', name, expected: count, actual };
    }
    if (expect.moved) {
        const paths = expect.moved.paths || (Number.isInteger(expect.moved.buildingIndex) && expect.moved.buildingIndex >= 0 ? [`geometry.buildings.${expect.moved.buildingIndex}`] : []);
        const tolerance = Object.hasOwn(expect.moved, 'toleranceM') ? expect.moved.toleranceM : 1;
        if (!Array.isArray(paths) || !paths.length || paths.some(path => typeof path !== 'string' || !path) ||
            !Number.isFinite(expect.moved.eastM) || !Number.isFinite(expect.moved.northM) ||
            !Number.isFinite(tolerance) || tolerance < 0) return { passed: false, reason: 'artifact-movement-expectation-invalid' };
        if (!before) return { passed: false, reason: 'artifact-before-design-missing', designIndex: afterIndex };
        for (const path of paths) {
            const oldCenter = center(getPath(before, path)), newCenter = center(getPath(after, path));
            if (!oldCenter || !newCenter) return { passed: false, reason: 'artifact-movement-geometry-missing', path };
            const lat = (oldCenter[1] + newCenter[1]) / 2;
            const eastM = (newCenter[0] - oldCenter[0]) * 111320 * Math.cos(lat * Math.PI / 180);
            const northM = (newCenter[1] - oldCenter[1]) * 111320;
            const errorM = Math.hypot(eastM - expect.moved.eastM, northM - expect.moved.northM);
            if (![eastM, northM, errorM].every(Number.isFinite)) return { passed: false, reason: 'artifact-movement-geometry-invalid', path };
            if (errorM > tolerance) return { passed: false, reason: 'artifact-movement-mismatch', path, expected: { eastM: expect.moved.eastM, northM: expect.moved.northM, toleranceM: tolerance }, actual: { eastM, northM, errorM } };
        }
    }
    if (expect.rotated) {
        const toleranceDegrees = Object.hasOwn(expect.rotated, 'toleranceDegrees') ? expect.rotated.toleranceDegrees : 3;
        if (typeof expect.rotated.path !== 'string' || !Number.isFinite(expect.rotated.degrees) ||
            !Number.isFinite(toleranceDegrees) || toleranceDegrees < 0) return { passed: false, reason: 'artifact-rotation-expectation-invalid' };
        if (!before) return { passed: false, reason: 'artifact-before-design-missing', designIndex: afterIndex };
        const beforeAngle = orientation(getPath(before, expect.rotated.path));
        const afterAngle = orientation(getPath(after, expect.rotated.path));
        if (beforeAngle == null || afterAngle == null) return { passed: false, reason: 'artifact-rotation-geometry-missing', path: expect.rotated.path };
        const delta = angleDifference(afterAngle - beforeAngle), expected = angleDifference(expect.rotated.degrees);
        const errorDegrees = Math.min(Math.abs(delta - expected), Math.abs(delta - expected + 180), Math.abs(delta - expected - 180));
        if (![delta, expected, errorDegrees].every(Number.isFinite)) return { passed: false, reason: 'artifact-rotation-geometry-invalid', path: expect.rotated.path };
        if (errorDegrees > toleranceDegrees) return { passed: false, reason: 'artifact-rotation-mismatch', path: expect.rotated.path,
            expected: { degrees: expect.rotated.degrees, toleranceDegrees }, actual: { degrees: delta, errorDegrees } };
    }
    if (expect.previousUnchanged) {
        if (!readback.before) return { passed: false, reason: 'artifact-before-design-missing', designIndex: afterIndex };
        const prior = readback.previous, priorDesigns = designsOf(prior), initialDesigns = designsOf(readback.before);
        if (!prior || prior.cid !== readback.before.cid || priorDesigns.length !== initialDesigns.length ||
            priorDesigns.some((row, i) => row.cid !== initialDesigns[i].cid || row.designHash !== initialDesigns[i].designHash))
            return { passed: false, reason: 'artifact-previous-snapshot-changed' };
    }
    return { passed: true, planCid: readback.after.cid, designCid: afterRow.cid, designIndex: afterIndex };
}

export function scoreTurn(expect = {}, turnResult = {}, calls = [], readback = null) {
    const tools = calls.map(call => call.tool || call.name);
    const includes = (expect.tools || []).every(tool => tools.includes(tool));
    const excludes = (expect.forbidTools || []).every(tool => !tools.includes(tool));
    const alternatives = expect.anyTools || [];
    if (!includes || (alternatives.length && !alternatives.some(tool => tools.includes(tool)))) return { passed: false, reason: 'missing-tool', missing: (expect.tools || []).filter(tool => !tools.includes(tool)), anyOf: alternatives };
    if (!excludes) return { passed: false, reason: 'forbidden-tool-used', used: (expect.forbidTools || []).filter(tool => tools.includes(tool)) };
    const outcome = turnResult.outcome?.type;
    if (expect.outcome && outcome !== expect.outcome) return { passed: false, reason: 'outcome-mismatch', expected: expect.outcome, actual: outcome };
    if (expect.planChanged != null && Boolean(turnResult.planChanged) !== Boolean(expect.planChanged)) return { passed: false, reason: 'plan-changed-mismatch' };
    for (const [tool, paths] of Object.entries(expect.args || {})) {
        const call = calls.find(row => (row.tool || row.name) === tool);
        for (const [path, expected] of Object.entries(paths)) if (!call || getPath(argsOf(call), path) !== expected) return { passed: false, reason: 'argument-mismatch', tool, path, expected, actual: call ? getPath(argsOf(call), path) : undefined };
    }
    const artifact = expect.artifact ? scoreArtifact(expect.artifact, readback) : null;
    if (artifact && !artifact.passed) return { ...artifact, tools, outcome, planChanged: Boolean(turnResult.planChanged) };
    return { passed: true, tools, outcome, planChanged: Boolean(turnResult.planChanged), ...(artifact ? { artifact } : {}) };
}
