(function (global) {
    'use strict';

    const GOVERNMENT_KEYWORDS = [
        'AUTOBUSNI KOLODVOR',
        'BOLNICA',
        'ČISTOĆA',
        'DIOKI',
        'DOM ZDRAVLJA',
        'DRUŠTVENO VLASNIŠTVO',
        'ELEKTROPRIVREDA',
        'GRAD ZAGREB',
        'GRADSKA PLINARA',
        'HEP D.D.',
        'HOLDING',
        'HRVATSKA RADIOTELEVIZIJA',
        'HRVATSKE VODE',
        'HRVATSKI OPERATOR',
        'INA MAZIVA',
        'INA-INDUSTRIJA NAFTE',
        'INA - INDUSTRIJA NAFTE',
        'INA, D.D.',
        'INFRASTRUKTURA',
        'JADRANSKI NAFTOVOD',
        'JAVNA',
        'JAVNO',
        'KLINIKA',
        'MINISTARSTVO',
        'OSNOVNA ŠKOLA',
        'REPUBLIKA HRVATSKA',
        'STUDENTSKI CENTAR',
        'STUDENTSKI DOM',
        'ŠUME',
        'SVEUČILIŠTE',
        'TEHNIČKA ŠKOLA',
        'TVORNICA ŽELJEZNIČKIH VOZILA GREDELJ',
        'TŽV GREDELJ',
        'VELESAJAM',
        'VODOOPSKRBA',
        'VODOPRIVREDA ZAGREB',
        'ZAGREBAČKI ELEKTRIČNI',
        'ŽELJEZNICE',
        'ZRINJEVAC KOMUNALNA',
        'ŽUPANIJA'
    ].map(value => value.toUpperCase());

    const INSTITUTION_KEYWORDS = [
        'KAPTOL',
        'CRKVA',
        'UDRUGA',
        'ASOCIJACIJA',
        'SAVEZ',
        'NADBISKUPIJA',
        'BISKUPIJA',
        'ŽUPA'
    ];

    const COMPANY_MARKERS = [
        'D.D.',
        'D.D',
        'D.O.O.',
        'D.O.O',
        'J.D.O.O.',
        'J.D.O.O'
    ];

    function normalizeOwnerLabel(label) {
        return (label || '').toString().trim().toUpperCase();
    }

    function includesAnyKeyword(normalizedLabel, keywords) {
        if (!normalizedLabel) return false;
        return keywords.some(keyword => normalizedLabel.includes(keyword));
    }

    function getOwnershipType(ownerLabel) {
        const normalizedLabel = normalizeOwnerLabel(ownerLabel);
        if (!normalizedLabel) {
            return 'private individual';
        }
        if (includesAnyKeyword(normalizedLabel, GOVERNMENT_KEYWORDS)) {
            return 'government';
        }
        if (includesAnyKeyword(normalizedLabel, INSTITUTION_KEYWORDS)) {
            return 'institution';
        }
        if (includesAnyKeyword(normalizedLabel, COMPANY_MARKERS)) {
            return 'company';
        }
        return 'private individual';
    }

    global.getOwnershipType = getOwnershipType;
    global.ParcelsOwnership = Object.assign({}, global.ParcelsOwnership, { getOwnershipType });
})(typeof window !== 'undefined' ? window : globalThis);






