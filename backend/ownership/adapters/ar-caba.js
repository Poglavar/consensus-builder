// Ownership adapter for Buenos Aires parcels (AR-<smp>): the horizontal-property units and their
// percentages stored in parcel_ba from the city's cadastre API. The source names units, not people.
import { HttpError } from '../../utils/helpers.js';
import { isoOrNull } from '../contract.js';

const PARCEL_ID = /^AR-([0-9]{3}-[0-9]{3}[A-Za-z]?-[0-9]{3}[A-Za-z]?)$/;

function unitOwner(unit, index) {
    const depto = (unit?.dpto ?? '').toString().trim();
    const piso = (unit?.piso ?? '').toString().trim();
    const percent = typeof unit?.porcentual === 'number' ? unit.porcentual
        : (typeof unit?.porcentual === 'string' && unit.porcentual.trim() ? Number(unit.porcentual) : NaN);
    const known = Number.isFinite(percent) && percent >= 0 && percent <= 100;
    return {
        name: [depto ? `dpto ${depto}` : `unidad ${index + 1}`, piso ? `piso ${piso}` : ''].filter(Boolean).join(', '),
        shareText: known ? `${percent}%` : null,
        sharePercent: known ? percent : null
    };
}

export const arCabaAdapter = {
    name: 'ar-caba',
    async lookup({ parcelId, pool }) {
        const match = PARCEL_ID.exec(parcelId);
        if (!match) throw new HttpError(400, 'Expected a parcel id AR-<smp>, e.g. AR-001-005-027A.');
        const { rows } = await pool.query(
            'SELECT property_horizontal, date_updated FROM parcel_ba WHERE smp = $1 LIMIT 1',
            [match[1]]
        );
        if (!rows.length) return null;
        const units = Array.isArray(rows[0].property_horizontal?.phs) ? rows[0].property_horizontal.phs : [];
        return {
            parcelId,
            // No horizontal-property units: the cadastre publishes no owner split for the parcel.
            owners: units.map(unitOwner),
            observedAt: null,
            retrievedAt: isoOrNull(rows[0].date_updated)
        };
    }
};
