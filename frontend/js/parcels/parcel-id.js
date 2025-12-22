(function (global) {
    'use strict';

    function buildHumanParcelIdFromProps(props) {
        if (!props || typeof props !== 'object') return null;
        const cad = props.maticni_broj_ko ?? props.MATICNI_BROJ_KO;
        const num = props.broj_cestice ?? props.BROJ_CESTICE;
        if (cad === undefined || cad === null || num === undefined || num === null) {
            return null;
        }
        const cadStr = String(cad).trim();
        const numStr = String(num).trim();
        if (!cadStr || !numStr) return null;
        return `HR-${cadStr}-${numStr}`;
    }

    function coerceId(value) {
        if (value === undefined || value === null) return null;
        return String(value).trim();
    }

    function ensureParcelId(target) {
        if (!target) return null;
        const props = target.properties || target;
        if (!props || typeof props !== 'object') return null;

        // Zagreb canonical ID: prefer HR-<MATICNI_BROJ_KO>-<BROJ_CESTICE> when present.
        // This avoids accidentally using numeric `id` values (e.g. CESTICA_ID) as the parcel id,
        // which breaks proposal parent lookup after reload.
        const humanId = buildHumanParcelIdFromProps(props);
        if (humanId) {
            const existingExplicit = coerceId(props.parcelId ?? props.parcel_id);
            if (!existingExplicit || !existingExplicit.startsWith('HR-')) {
                props.parcelId = humanId;
                if (!props.id) {
                    props.id = humanId;
                }
                return humanId;
            }
        }

        const parcelId = coerceId(
            props.parcelId
            ?? props.parcel_id
            ?? props.id
        );

        if (!parcelId) return null;

        props.parcelId = parcelId;
        if (!props.id) {
            props.id = parcelId;
        }

        return parcelId;
    }

    function getParcelId(input) {
        if (input && typeof input === 'object' && 'properties' in input) {
            return ensureParcelId(input);
        }
        if (input && typeof input === 'object') {
            return ensureParcelId({ properties: input });
        }
        return coerceId(input);
    }

    global.ensureParcelId = ensureParcelId;
    global.getParcelId = getParcelId;
})(typeof window !== 'undefined' ? window : globalThis);
