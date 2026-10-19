// Ownership adapter for Belgrade parcels (SR-<cadmun_code>-<parcel_num>) in parcel_bg. The RGZ
// parcel layer carries no owners, so a known parcel answers with an empty owner list.
import { HttpError } from '../../utils/helpers.js';

const PARCEL_ID = /^SR-([0-9]+)-(.+)$/;

export const rsBgAdapter = {
    name: 'rs-bg',
    async lookup({ parcelId, pool }) {
        const match = PARCEL_ID.exec(parcelId);
        if (!match) throw new HttpError(400, 'Expected a parcel id SR-<cadmun_code>-<parcel_num>.');
        const { rows } = await pool.query(
            'SELECT 1 FROM parcel_bg WHERE cadmun_code = $1 AND parcel_num = $2 LIMIT 1',
            [Number(match[1]), match[2]]
        );
        if (!rows.length) return null;
        return { parcelId, owners: [], observedAt: null, retrievedAt: null };
    }
};
