(function (global) {
    'use strict';

    function normalizeOwnerLabel(label) {
        return (label || '')
            .toString()
            .trim()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toUpperCase()
            .replace(/\s+/g, ' ')
            .trim();
    }

    function normalizeOwnerLabelLoose(label) {
        return normalizeOwnerLabel(label)
            .replace(/[^A-Z0-9]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function createNormalizedKeywordList(values = []) {
        return Object.freeze(values.map(normalizeOwnerLabelLoose).filter(Boolean));
    }

    const GOVERNMENT_KEYWORDS = createNormalizedKeywordList([
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
    ]);

    const INSTITUTION_KEYWORDS = createNormalizedKeywordList([
        'KAPTOL',
        'CRKVA',
        'UDRUGA',
        'ASOCIJACIJA',
        'SAVEZ',
        'NADBISKUPIJA',
        'BISKUPIJA',
        'ŽUPA'
    ]);

    const COMPANY_MARKERS = createNormalizedKeywordList([
        'D.D.',
        'D.D',
        'D.O.O.',
        'D.O.O',
        'J.D.O.O.',
        'J.D.O.O'
    ]);

    const CITY_OWNER_MAPPERS = Object.freeze({
        zagreb: Object.freeze({
            exact: createNormalizedKeywordList([
                'GRAD ZAGREB'
            ]),
            contains: createNormalizedKeywordList([
                'GRAD ZAGREB',
                'GRADA ZAGREBA',
                'U VLASNISTVU GRADA ZAGREBA',
                'U NEOTUDIVOM VLASNISTVU GRADA ZAGREBA',
                'VLASNISTVU GRADA ZAGREBA',
                'NEOTUDIVOM VLASNISTVU GRADA ZAGREBA',
                'TRG STJEPANA RADICA 1 ZAGREB',
                'OIB 61817894937'
            ]),
            regexes: Object.freeze([
                /\bGRAD(?:A)? ZAGREB(?:A)?\b/
            ])
        })
    });

    function includesAnyKeyword(normalizedLabel, keywords) {
        if (!normalizedLabel) return false;
        return keywords.some(keyword => normalizedLabel.includes(keyword));
    }

    function getCityOwnershipMapper(city = 'zagreb') {
        const cityKey = normalizeOwnerLabelLoose(city).toLowerCase();
        return CITY_OWNER_MAPPERS[cityKey] || CITY_OWNER_MAPPERS.zagreb;
    }

    function isCityOwnedLabel(ownerLabel, options = {}) {
        const normalizedLabel = normalizeOwnerLabelLoose(ownerLabel);
        if (!normalizedLabel) {
            return false;
        }

        const mapper = getCityOwnershipMapper(options.city || 'zagreb');
        if (mapper.exact.includes(normalizedLabel)) {
            return true;
        }
        if (mapper.contains.some(keyword => normalizedLabel.includes(keyword))) {
            return true;
        }
        return mapper.regexes.some(regex => regex.test(normalizedLabel));
    }

    function classifyOwnershipLabel(ownerLabel, options = {}) {
        const normalizedLabel = normalizeOwnerLabelLoose(ownerLabel);
        if (!normalizedLabel) {
            return 'private individual';
        }
        if (isCityOwnedLabel(normalizedLabel, options)) {
            return 'government';
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

    function getOwnershipType(ownerLabel) {
        return classifyOwnershipLabel(ownerLabel);
    }

    global.normalizeOwnerLabel = normalizeOwnerLabel;
    global.normalizeOwnerLabelLoose = normalizeOwnerLabelLoose;
    global.isCityOwnedLabel = isCityOwnedLabel;
    global.classifyOwnershipLabel = classifyOwnershipLabel;
    global.getOwnershipType = getOwnershipType;
    global.ParcelsOwnership = Object.assign({}, global.ParcelsOwnership, {
        normalizeOwnerLabel,
        normalizeOwnerLabelLoose,
        isCityOwnedLabel,
        classifyOwnershipLabel,
        getOwnershipType
    });

    // Also export for node, so ownership classification can be unit-tested without a browser
    // (backend/test/parcel-ownership-type.test.js). The browser path above is unchanged.
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            GOVERNMENT_KEYWORDS,
            INSTITUTION_KEYWORDS,
            COMPANY_MARKERS,
            normalizeOwnerLabel,
            normalizeOwnerLabelLoose,
            isCityOwnedLabel,
            classifyOwnershipLabel,
            getOwnershipType
        };
    }
})(typeof window !== 'undefined' ? window : globalThis);











