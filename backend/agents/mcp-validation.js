// Review authored named-plan geometry without inventing source coverage, construction cost,
// operating safety, ownership or planning compliance. Cadastral verification is a separate read.
import { appTurf as turf, constructorRuntime } from './mcp-geometry.js';
import { validateDesignContent } from '../routes/designs.js';
import { editedDesign } from './mcp-edit.js';
import { validateTrackDesign } from './mcp-constructors.js';
import { authoredAreas } from './mcp-compare.js';

export function createMcpValidationTools({ plans }) {
    return { async validatePlan({ plan }) {
        const resolved = await plans.getPlan({ plan });
        const issues = [], buildings = [], records = [];
        const issue = (code, ref, message, details = {}) => issues.push({ code, ref, message, ...details });
        for (const row of resolved.designs) {
            const design = row.content, ref = `design:${row.cid}`;
            records.push(design);
            try {
                const checked = validateDesignContent(design);
                if (!checked.ok) issue(checked.code || 'invalid-design', ref, checked.error, { field: checked.field || null });
                // Reuse the editor's geometry, payload, coupling and layout checks. A test-only
                // patch mutates only a private clone; the authored revision stays unchanged.
                editedDesign(design, row.cid, [{ op: 'test', path: '/goal', value: design.goal }]);
                validateTrackDesign(design);
            } catch (error) { issue(error.code || 'invalid-design', ref, error.message, { ...(error.field ? { field: error.field } : {}) }); }
            if (design.structureProposal?.kind === 'station' && !design.structureProposal.attachment?.sourceId) {
                issue('station-attachment-missing', ref, 'The station has no committed corridor attachment.');
            }
            for (const [index, building] of (design.geometry?.buildings || []).entries()) {
                const buildingRef = `building:${row.cid}:${index}`;
                try {
                    if (!building?.geometry || !['Polygon', 'MultiPolygon'].includes(building.geometry.type)) {
                        issue('invalid-building', buildingRef, 'A building needs polygon geometry.'); continue;
                    }
                    if (design.site && !constructorRuntime.singleBuilding.footprintWithinBoundary(building, turf.feature(design.site), turf)) {
                        issue('building-outside-site', buildingRef, 'The authored building extends outside its authored site.');
                    }
                    const massing = design.geometry.blockMassing;
                    if (massing && !constructorRuntime.singleBuilding.footprintWithinBoundary(building, massing, turf)) {
                        issue('building-outside-massing', buildingRef, 'The building geometry extends outside its coupled authored massing.');
                    }
                    const rule = building.properties?.urbanRule, height = building.properties?.height;
                    const target = rule?.typology === 'parcelBased' ? rule.maxFloors * rule.floorHeightM : rule?.maxHeightM;
                    if (typeof target === 'number' && Number.isFinite(target) && typeof height === 'number' && Number.isFinite(height) && Math.abs(height - target) > 1e-6) {
                        issue('building-rule-height-mismatch', buildingRef, 'The authored envelope height differs from its rule maximum.');
                    }
                    buildings.push({ ref: buildingRef, designCid: row.cid, feature: building });
                } catch (error) { issue('invalid-building-geometry', buildingRef, error.message); }
            }
        }
        for (let first = 0; first < buildings.length; first++) for (let second = first + 1; second < buildings.length; second++) {
            const a = buildings[first], b = buildings[second];
            if (a.designCid === b.designCid) continue;
            try {
                const intersection = turf.intersect(a.feature, b.feature), overlapM2 = intersection ? turf.area(intersection) : 0;
                if (overlapM2 > 0.01) issue('authored-building-overlap', a.ref, 'Buildings in different designs overlap in authored plan geometry.', { otherRef: b.ref, overlapM2 });
            } catch (error) { issue('overlap-check-unavailable', a.ref, error.message, { otherRef: b.ref }); }
        }
        let metrics;
        try { metrics = authoredAreas(records); }
        catch (error) { metrics = { floorAreaM2: null, greenAreaM2: null, roadAreaM2: null }; issue('authored-metrics-unavailable', `plan:${resolved.cid}`, error.message); }
        return { cid: resolved.cid, valid: issues.length === 0, issues, metrics, assessmentBasis: 'authored-geometry',
            sourceAssessment: { status: 'unknown', reason: 'not-queried', parcelCoverage: 'unknown', buildingStock: 'unknown', planningCompliance: 'unknown' },
            warnings: ['Validation checks authored geometry and contracts. It does not establish current cadastral coverage, permissions, ownership, effective ground after application, construction cost or rail operating safety.'] };
    } };
}
