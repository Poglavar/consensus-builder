// Ordinary R6A attached-building massing in a surveyed rectangular lot's local
// feet coordinates. The floor-area budget constrains how much of this volume can be filled.
import { getDistrictRules } from './districts.js';

export function calculateR6aEnvelope({ widthFt, depthFt, streetWidthFt }) {
    if (![widthFt, depthFt, streetWidthFt].every(n => typeof n === 'number' && Number.isFinite(n) && n > 0)
        || widthFt < 18 || widthFt >= 40 || depthFt < 95 || depthFt > 110 || widthFt * depthFt < 1700) {
        throw new RangeError('Dimensions are outside the reviewed R6A interior-lot path');
    }
    const rules = getDistrictRules('R6A');
    const lotAreaSqFt = widthFt * depthFt;
    const rearYardStart = depthFt - rules.rearYardFt;
    const setbackFt = streetWidthFt >= rules.wideStreetMinWidthFt ? rules.wideStreetSetbackFt : rules.narrowStreetSetbackFt;
    const rectangle = front => [[0, front], [widthFt, front], [widthFt, rearYardStart], [0, rearYardStart], [0, front]];
    return {
        units: { length: 'ft', area: 'sq ft' },
        lotAreaSqFt,
        floorAreaBudgetSqFt: rules.residentialFar * lotAreaSqFt,
        maxLotCoverageAreaSqFt: rules.maxLotCoverage * lotAreaSqFt,
        rearYardFt: rules.rearYardFt,
        streetWallOffsetFt: 0,
        upperSetbackFt: setbackFt,
        minBaseHeightFt: rules.minBaseHeightFt,
        maxBaseHeightFt: rules.maxBaseHeightFt,
        maxBuildingHeightFt: rules.maxBuildingHeightFt,
        geometry: {
            coordinateSystem: 'lot-local-feet',
            origin: 'Front-left corner on the legal street line; z=0 is the reviewed base plane.',
            axes: { x: 'Along the frontage', y: 'Perpendicular toward the rear', z: 'Above the base plane' },
            tiers: [
                { bottomFt: 0, topFt: rules.maxBaseHeightFt, footprint: rectangle(0), footprintAreaSqFt: widthFt * rearYardStart },
                { bottomFt: rules.maxBaseHeightFt, topFt: rules.maxBuildingHeightFt, footprint: rectangle(setbackFt), footprintAreaSqFt: widthFt * (rearYardStart - setbackFt) },
            ],
        },
        scope: 'Standard bulk massing with a full-width street wall on the street line and a setback at 65 ft. Permitted obstructions, articulation and alternative massings are not included.',
        limitations: [
            'The volume cannot all be filled: total zoning floor area must stay within the separate FAR budget.',
            'This does not determine achievable floor count, apartment count, net floor area, remaining air rights or permission to demolish an existing building.',
            'Building-code design, light and air, access, parking, recreation space and other permit requirements require a building proposal.',
        ],
    };
}
