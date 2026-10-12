// Namespace-aware, bounded INSPIRE/HMLR geometry reader. XML/ownership fields never enter its output.
import { SaxesParser } from 'saxes';
import proj4 from 'proj4';
import { validateGeometry, upstreamError } from './source-contract.js';
import { CATASTRO_ATOM_GML_SCHEMA } from './catastro-atom-profile.js';

const GML = new Set(['http://www.opengis.net/gml', 'http://www.opengis.net/gml/3.2']);
const GML32 = 'http://www.opengis.net/gml/3.2';
const CP = /^https?:\/\/inspire\.ec\.europa\.eu\/schemas\/cp\/(?:3\.0|4\.0)$/;
const LR = 'www.landregistry.gov.uk';
export const MAPSERVER_GML_SCHEMA = Object.freeze({
    featureNamespace: 'http://mapserver.gis.umn.edu/mapserver',
    featureName: 'dzialki',
    idField: 'ID_DZIALKI',
    geometryField: 'msGeometry',
    gmlNamespace: GML32,
    sourceCrs: 'EPSG:3857'
});
export const SAXONY_GML_SCHEMA = Object.freeze({
    featureNamespace: 'http://repository.gdi-de.org/schemas/adv/produkt/alkis-vereinfacht/2.0',
    featureName: 'Flurstueck',
    idField: 'flstkennz',
    geometryField: 'geometrie',
    gmlNamespace: 'http://www.opengis.net/gml/3.2',
    sourceCrs: 'EPSG:25833'
});
export const HESSEN_GML_SCHEMA = Object.freeze({
    featureNamespace: 'http://repository.gdi-de.org/schemas/adv/produkt/alkis-vereinfacht/2.0',
    featureName: 'Flurstueck',
    idField: 'oid',
    geometryField: 'geometrie',
    gmlNamespace: GML32,
    sourceCrs: 'EPSG:25832',
    axisOrder: 'easting-northing',
    localIdPattern: '^DEHE[A-Za-z0-9]{12}FL$'
});
// Every Hessen geometry component must be inline and fully parsed. An empty
// member or an XLink cannot stand in for geometry that would otherwise be lost.
const HESSEN_GEOMETRY_CHILDREN = Object.freeze({
    geometrie: ['MultiSurface', 'MultiPolygon', 'Surface', 'Polygon'],
    MultiSurface: ['surfaceMember', 'surfaceMembers'],
    MultiPolygon: ['polygonMember'],
    surfaceMember: ['Surface', 'Polygon'], surfaceMembers: ['Surface', 'Polygon'],
    polygonMember: ['Polygon'], Surface: ['patches'], patches: ['PolygonPatch'],
    Polygon: ['exterior', 'interior'], PolygonPatch: ['exterior', 'interior'],
    exterior: ['LinearRing'], interior: ['LinearRing'], LinearRing: ['posList'], posList: []
});
const HESSEN_SINGLE_GEOMETRY_CHILD = new Set([
    'geometrie', 'surfaceMember', 'polygonMember', 'Surface', 'exterior', 'interior', 'LinearRing'
]);
export const POZNAN_GML_SCHEMA = Object.freeze({
    featureNamespace: 'http://portal.geopoz.poznan.pl/wmsegib',
    featureName: 'dzialki',
    idField: 'ID_DZIALKI',
    geometryField: 'MSGEOMETRY',
    gmlNamespace: GML32,
    sourceCrs: 'EPSG:2177',
    axisOrder: 'northing-easting'
});
// Gdańsk DescribeFeatureType exposes geometry and a text cadastral ID. The
// publisher's dzialki.<row> gml:id is not the cadastral identifier.
export const GDANSK_GML_SCHEMA = Object.freeze({
    featureNamespace: 'http://mapserver.gis.umn.edu/mapserver',
    featureName: 'dzialki',
    idField: 'ID_DZIALKI',
    geometryField: 'geometry',
    gmlNamespace: GML32,
    sourceCrs: 'EPSG:2177',
    axisOrder: 'northing-easting',
    localIdPattern: '^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$'
});
// GUGiK's national collective EGiB WFS (launched 2026-07-16) cascades the county services into one
// MapServer layer: geometry in ms:geom, PUWG 1992 (EPSG:2180) in the URN's northing-easting order,
// verified on raw GetFeature samples from eleven cities on 2026-10-12.
export const POLAND_EGIB_GML_SCHEMA = Object.freeze({
    featureNamespace: 'http://mapserver.gis.umn.edu/mapserver',
    featureName: 'dzialki',
    idField: 'ID_DZIALKI',
    geometryField: 'geom',
    gmlNamespace: GML32,
    sourceCrs: 'EPSG:2180',
    axisOrder: 'northing-easting',
    localIdPattern: '^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$'
});
// Sosnowiec's own DescribeFeatureType and safe GetFeature samples verify these
// fields and N,E axes. Its row gml:id is unrelated to the municipal cadastral ID.
export const SOSNOWIEC_GML_SCHEMA = Object.freeze({
    featureNamespace: 'http://mapserver.gis.umn.edu/mapserver',
    featureName: 'dzialki',
    idField: 'ID_DZIALKI',
    geometryField: 'geometry',
    gmlNamespace: GML32,
    sourceCrs: 'EPSG:2177',
    axisOrder: 'northing-easting',
    localIdPattern: '^(?=.{1,128}$)247501_1\\.[0-9]{4}\\.[0-9]+(?:/[0-9]+)?$'
});
const GDANSK_GEOMETRY_CHILDREN = Object.freeze({
    ...HESSEN_GEOMETRY_CHILDREN,
    geometry: HESSEN_GEOMETRY_CHILDREN.geometrie
});
// Kartverket's public Teig WFS uses a numeric app:teigId and a matching
// gml:id (teig.<teigId>). Its data responses incorrectly report
// numberReturned="0" even when wfs:member elements are present; keep this
// schema identity explicit so only this fixed publisher profile can normalize
// that one declared count quirk after parsing the actual members.
export const NORWAY_TEIG_GML_SCHEMA = Object.freeze({
    featureNamespace: 'http://skjema.geonorge.no/SOSI/produktspesifikasjon/Matrikkelen-Eiendomskart-Teig/20211101',
    featureName: 'Teig',
    idField: 'teigId',
    geometryField: 'område',
    gmlNamespace: GML32,
    sourceCrs: 'EPSG:25833',
    gmlIdPrefix: 'teig.'
});
export const FINLAND_CP_GML_SCHEMA = Object.freeze({
    featureNamespace: 'http://inspire.ec.europa.eu/schemas/cp/4.0',
    featureName: 'CadastralParcel',
    idField: 'localId',
    idNamespace: 'http://inspire.ec.europa.eu/schemas/base/3.3',
    identityPath: 'cp:inspireId/base:Identifier',
    namespaceField: 'namespace',
    expectedInspireNamespace: 'http://paikkatiedot.fi/so/1001077/cp/CadastralParcel/',
    canonicalIdPrefix: 'http://paikkatiedot.fi/so/1001077/cp/CadastralParcel/',
    gmlIdentifierField: 'identifier',
    gmlIdentifierCodeSpace: 'http://paikkatiedot.fi',
    gmlNamespace: GML32,
    gmlIdPrefix: 'FI_CP_CADASTRALPARCEL_',
    localIdPattern: '^(?:0|[1-9]\\d*)$',
    geometryField: 'geometry',
    sourceCrs: 'EPSG:3067',
    axisOrder: 'easting-northing'
});
const CUSTOM_SCHEMAS = [MAPSERVER_GML_SCHEMA, SAXONY_GML_SCHEMA, HESSEN_GML_SCHEMA, POZNAN_GML_SCHEMA, GDANSK_GML_SCHEMA, SOSNOWIEC_GML_SCHEMA, POLAND_EGIB_GML_SCHEMA, NORWAY_TEIG_GML_SCHEMA, FINLAND_CP_GML_SCHEMA, CATASTRO_ATOM_GML_SCHEMA];
proj4.defs('EPSG:27700', '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.1502,0.2470,0.8421,-20.4894 +units=m +no_defs');
proj4.defs('EPSG:2177', '+proj=tmerc +lat_0=0 +lon_0=18 +k=0.999923 +x_0=6500000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');
proj4.defs('EPSG:2180', '+proj=tmerc +lat_0=0 +lon_0=19 +k=0.9993 +x_0=500000 +y_0=-5300000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');
for (const zone of [30,31,32,33]) proj4.defs(`EPSG:258${zone}`, `+proj=utm +zone=${zone} +ellps=GRS80 +towgs84=0,0,0 +units=m +no_defs`);
// EPSG:3067 is EUREF-FIN / TM35FIN(E,N); the Finnish INSPIRE service emits E,N order.
proj4.defs('EPSG:3067', '+proj=utm +zone=35 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');
const attr = (tag,name) => Object.values(tag.attributes).find(a => a.local === name && !a.uri)?.value;
const namespacedAttr = (tag, namespace, name) => Object.values(tag.attributes).find(a => a.local === name && a.uri === namespace)?.value;
function crsName(value, customSchema) {
    const supported = customSchema ? [customSchema.sourceCrs.slice(5)] : ['27700','25830','25831'];
    const match = /^(?:EPSG:|urn:ogc:def:crs:EPSG::|http:\/\/www\.opengis\.net\/def\/crs\/EPSG\/0\/)([0-9]+)$/.exec(value);
    if (!match || !supported.includes(match[1])) throw upstreamError('Unsupported parcel GML coordinate system.');
    return `EPSG:${match[1]}`;
}
const featureTag = tag => (tag.uri === LR && tag.local === 'PREDEFINED') || (CP.test(tag.uri) && tag.local === 'CadastralParcel');
const geometryTag = tag => (tag.uri === LR && tag.local === 'GEOMETRY') || (CP.test(tag.uri) && tag.local === 'geometry');
const collectionTag = tag => tag.local === 'FeatureCollection' && ['http://www.opengis.net/wfs/2.0','http://www.opengis.net/wfs',...GML].includes(tag.uri);
const count = value => {
    if (value === undefined || value === 'unknown') return undefined;
    if (!/^(?:0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw upstreamError('Invalid parcel GML feature count.');
    return Number(value);
};

function isoTimestamp(value) {
    if (value === undefined) return undefined;
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
    if (!match || !Number.isFinite(Date.parse(value))) throw upstreamError('Invalid parcel GML collection timestamp.');
    const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
    const year = Number(yearText), month = Number(monthText), day = Number(dayText);
    const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > days[month - 1]
        || hour > 23 || minute > 59 || second > 59
        || (offsetHourText !== undefined && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59))) {
        throw upstreamError('Invalid parcel GML collection timestamp.');
    }
    return value;
}

function validNativeGeometry(geometry) {
    if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type) || !Array.isArray(geometry.coordinates)) return false;
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    return polygons.length > 0 && polygons.every(polygon => Array.isArray(polygon) && polygon.length > 0
        && polygon.every(ring => Array.isArray(ring) && ring.length >= 4
            && ring.every(point => Array.isArray(point) && point.length === 2
                && point.every(value => typeof value === 'number' && Number.isFinite(value)))
            && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]));
}

export async function parseGmlParcels(input, { idField = 'INSPIREID', maxBytes = 160 * 1024 * 1024,
    maxFeatures = 150000, signal, featureNamespace, featureName, schema,
    coordinateMode = 'wgs84', onFeature } = {}) {
    const hasCustomSchema = schema !== undefined;
    const customSchema = hasCustomSchema ? schema : null;
    const canonicalCustomSchema = customSchema && typeof customSchema === 'object' && !Array.isArray(customSchema)
        ? CUSTOM_SCHEMAS.find(known => Object.keys(customSchema).length === Object.keys(known).length
            && Object.entries(known).every(([key,value]) => customSchema[key] === value)) : null;
    const validCustomSchema = Boolean(canonicalCustomSchema);
    if ((hasCustomSchema && !validCustomSchema) || (customSchema && (idField !== 'INSPIREID'
        || featureNamespace !== undefined || featureName !== undefined))
        || (!customSchema && !['INSPIREID','nationalCadastralReference'].includes(idField))
        || !['wgs84', 'native'].includes(coordinateMode)
        || (coordinateMode === 'native' && (customSchema || idField !== 'INSPIREID'
            || featureNamespace !== undefined || featureName !== undefined))
        || (onFeature !== undefined && typeof onFeature !== 'function')
        || !Number.isSafeInteger(maxBytes) || maxBytes < 1
        || !Number.isSafeInteger(maxFeatures) || maxFeatures < 1) throw new Error('Invalid parcel GML reader options.');
    // Native coordinates are importer-only. A streaming callback may run before final
    // document count checks, so callers must stage writes and roll them back on rejection.
    const streaming = onFeature !== undefined;
    const nativeCoordinates = coordinateMode === 'native';
    const activeIdField = customSchema ? customSchema.idField : idField;
    const activeFeatureNamespace = customSchema ? customSchema.featureNamespace : featureNamespace;
    const activeFeatureName = customSchema ? customSchema.featureName : featureName;
    const isFinland = canonicalCustomSchema === FINLAND_CP_GML_SCHEMA;
    const isHessen = canonicalCustomSchema === HESSEN_GML_SCHEMA;
    const isGdansk = canonicalCustomSchema === GDANSK_GML_SCHEMA;
    const isSosnowiec = canonicalCustomSchema === SOSNOWIEC_GML_SCHEMA;
    const isCatastroAtom = canonicalCustomSchema === CATASTRO_ATOM_GML_SCHEMA;
    const isMunicipalGeometry = isGdansk || isSosnowiec;
    const strictFlatFields = isHessen || isMunicipalGeometry || isCatastroAtom;
    const geometryChildren = isMunicipalGeometry || isCatastroAtom ? GDANSK_GEOMETRY_CHILDREN : HESSEN_GEOMETRY_CHILDREN;
    const isGmlTag = tag => customSchema ? tag.uri === customSchema.gmlNamespace : GML.has(tag.uri);
    const isFeatureTag = tag => nativeCoordinates
        ? tag.uri === LR && tag.local === 'PREDEFINED'
        : customSchema ? tag.uri === customSchema.featureNamespace && tag.local === customSchema.featureName : featureTag(tag);
    const parser = new SaxesParser({ xmlns: true });
    const stack = [], byId = streaming ? null : new Map();
    let current = null, polygon = null, ringKind = null, collection = false, closedCollection = false;
    let geometryDepth = null, sourceCrs = null, sourceTimestamp, numberMatched, numberMatchedUnknown = false, numberReturned, featureCount = 0, duplicateNativeCount = 0;
    let streamedExtent = null;
    const projections = new Map();
    const fail = message => { throw upstreamError(message); };
    parser.on('doctype', () => fail('Parcel GML document types and external entities are forbidden.'));
    parser.on('error', () => fail('Malformed parcel GML.'));
    parser.on('opentag', tag => {
        if (!stack.length) {
            if (!collectionTag(tag) || (customSchema && tag.uri !== 'http://www.opengis.net/wfs/2.0')) fail('Parcel GML must be a FeatureCollection.');
            collection = true;
            const matchedAttribute = attr(tag,'numberMatched');
            // Only the native HMLR import contract records and validates collection
            // timeStamp. Other WFS publishers use this optional attribute differently.
            if (nativeCoordinates) sourceTimestamp = isoTimestamp(attr(tag, 'timeStamp'));
            numberMatchedUnknown = matchedAttribute === 'unknown';
            numberMatched = count(matchedAttribute); numberReturned = count(attr(tag,'numberReturned'));
            if (isCatastroAtom && (numberMatched === undefined || numberReturned !== numberMatched)) {
                fail('Spanish ATOM parcel archive must declare complete matching feature counts.');
            }
            if (isCatastroAtom && numberMatched > maxFeatures) fail('Parcel GML exceeds feature limit.');
        }
        const parent = stack.at(-1)?.tag;
        if (parent && collectionTag(parent) && !(['member','featureMember','featureMembers','boundedBy'].includes(tag.local)
            && ['http://www.opengis.net/wfs/2.0','http://www.opengis.net/wfs',...GML].includes(tag.uri))) fail('Unsupported parcel GML collection content.');
        if (parent && ['member','featureMember','featureMembers'].includes(parent.local) && ['http://www.opengis.net/wfs/2.0','http://www.opengis.net/wfs',...GML].includes(parent.uri) && !isFeatureTag(tag)) fail('Unsupported parcel GML collection member.');
        if (current && geometryDepth !== null && !isGmlTag(tag)) fail('Unsupported parcel GML geometry namespace.');
        const frame = { tag, text: '' }; stack.push(frame);
        if (isCatastroAtom && stack.length === 2) {
            if (tag.uri === 'http://www.opengis.net/wfs/2.0' && tag.local === 'member') {
                frame.parcelMemberFeatures = 0;
                if (namespacedAttr(tag, 'http://www.w3.org/1999/xlink', 'href') !== undefined
                    || ![undefined, 'false', '0'].includes(namespacedAttr(tag, 'http://www.w3.org/2001/XMLSchema-instance', 'nil'))) {
                    fail('Spanish ATOM parcel members must contain an inline feature.');
                }
            } else if (!(isGmlTag(tag) && tag.local === 'boundedBy')) {
                fail('Unexpected Spanish ATOM parcel collection content.');
            }
        }
        if (current && (isMunicipalGeometry || isCatastroAtom) && [activeIdField, customSchema.geometryField].includes(tag.local)
            && tag.uri !== current.namespace) fail('Unexpected municipal parcel field namespace.');
        if (current && strictFlatFields && tag.uri === current.namespace
            && [activeIdField, customSchema.geometryField].includes(tag.local)
            && stack.length !== current.depth + 1) fail('Parcel GML has a path-confused identity or geometry field.');
        if (current && strictFlatFields && parent?.uri === current.namespace && parent.local === activeIdField) {
            fail('Parcel GML native identifier must be simple text.');
        }
        if (current && isCatastroAtom && tag.local === activeIdField
            && (namespacedAttr(tag, 'http://www.w3.org/1999/xlink', 'href') !== undefined
                || ![undefined, 'false', '0'].includes(namespacedAttr(tag, 'http://www.w3.org/2001/XMLSchema-instance', 'nil')))) {
            fail('Spanish ATOM native identifiers must be inline non-nil text.');
        }
        const srs = attr(tag,'srsName');
        if (srs !== undefined) {
            const resolved = crsName(srs, customSchema);
            if (customSchema && resolved !== customSchema.sourceCrs) fail('Parcel GML response coordinate system does not match the configured schema.');
            if (nativeCoordinates && resolved !== 'EPSG:27700') fail('Native HMLR coordinates require EPSG:27700.');
            if (sourceCrs && sourceCrs !== resolved) fail('Parcel GML mixes coordinate systems.');
            sourceCrs = resolved;
        }
        // A preceding parcel or referencePoint is not a CRS ancestor of this
        // geometry. Keep the fixed Spanish profile's coordinate inheritance local.
        if (isCatastroAtom) frame.crs = srs === undefined ? stack.at(-2)?.crs : sourceCrs;
        const dim = attr(tag,'srsDimension');
        if (dim !== undefined && dim !== '2') fail('Parcel GML must have two-dimensional coordinates.');
        if (isFeatureTag(tag)) {
            if (isCatastroAtom && (stack.length !== 3 || parent?.uri !== 'http://www.opengis.net/wfs/2.0'
                || parent.local !== 'member')) fail('Unexpected Spanish ATOM parcel member path.');
            if (isCatastroAtom && ++stack.at(-2).parcelMemberFeatures !== 1) {
                fail('Spanish ATOM parcel members must contain exactly one feature.');
            }
            if (current || (activeFeatureNamespace && tag.uri !== activeFeatureNamespace) || (activeFeatureName && tag.local !== activeFeatureName)) fail('Unexpected parcel GML feature.');
            current = { depth: stack.length, namespace: tag.uri, id: null,
                gmlId: (customSchema?.gmlIdPrefix || isHessen) ? namespacedAttr(tag, customSchema.gmlNamespace, 'id') : null,
                polygons: [], geometrySeen: false,
                ...(isFinland ? { inspireIdSeen: false, identifierObjectSeen: false, localIdSeen: false,
                    namespaceSeen: false, gmlIdentifierSeen: false, inspireNamespace: null, gmlIdentifier: null,
                    gmlIdentifierCodeSpace: null } : {}) };
        } else if (current && (customSchema
            ? tag.uri === current.namespace && tag.local === customSchema.geometryField
            : geometryTag(tag))) {
            if (current.geometrySeen || tag.uri !== current.namespace) fail('Unexpected parcel GML geometry.');
            current.geometrySeen = true; geometryDepth = stack.length;
        } else if (current && geometryDepth !== null && isGmlTag(tag)) {
            if (!['MultiSurface','surfaceMember','surfaceMembers','MultiPolygon','polygonMember','Surface','patches','PolygonPatch','Polygon','exterior','interior','LinearRing','posList'].includes(tag.local)) fail('Unsupported parcel GML geometry.');
            if (['Polygon','PolygonPatch'].includes(tag.local)) {
                if (polygon) fail('Nested parcel GML polygons.');
                polygon = { exterior: null, interiors: [] };
            }
            if (['exterior','interior'].includes(tag.local)) {
                if (!polygon || ringKind) fail('Invalid parcel GML ring structure.');
                ringKind = tag.local;
            }
            if (tag.local === 'posList' && (!polygon || !ringKind)) fail('Invalid parcel GML coordinate list.');
        }
        if (current && strictFlatFields && geometryDepth !== null) {
            // Sosnowiec and Spanish ATOM geometry is inline. A nil component, even one carrying
            // coordinates, cannot be reinterpreted as a usable source polygon.
            if ((isSosnowiec || isCatastroAtom) && namespacedAttr(tag, 'http://www.w3.org/2001/XMLSchema-instance', 'nil') !== undefined) {
                const nil = namespacedAttr(tag, 'http://www.w3.org/2001/XMLSchema-instance', 'nil');
                if (!['false', '0'].includes(nil)) fail('Parcel GML has a nil or invalid geometry component.');
            }
            if (namespacedAttr(tag, 'http://www.w3.org/1999/xlink', 'href') !== undefined) {
                fail('Parcel GML referenced geometry is unsupported.');
            }
            frame.hessenGeometryChildren = 0;
            if (stack.length > geometryDepth) {
                const parentFrame = stack.at(-2);
                if (!geometryChildren[parent.local]?.includes(tag.local)) {
                    fail('Invalid parcel GML geometry structure.');
                }
                parentFrame.hessenGeometryChildren++;
                if ((HESSEN_SINGLE_GEOMETRY_CHILD.has(parent.local) || ((isMunicipalGeometry || isCatastroAtom) && parent.local === 'geometry')) && parentFrame.hessenGeometryChildren > 1) {
                    fail('Parcel GML repeats a geometry component.');
                }
            }
        }
        if (current && isFinland) {
            const frames = stack.map(item => item.tag);
            const atPathDepth = depth => frames.length === current.depth + depth;
            const directFeatureChild = frames.length === current.depth + 1;
            const directInspireIdentifier = atPathDepth(2)
                && frames.at(-2)?.uri === current.namespace && frames.at(-2)?.local === 'inspireId'
                && frames.at(-1)?.uri === customSchema.idNamespace && frames.at(-1)?.local === 'Identifier';
            const directIdentifierMember = atPathDepth(3)
                && frames.at(-3)?.uri === current.namespace && frames.at(-3)?.local === 'inspireId'
                && frames.at(-2)?.uri === customSchema.idNamespace && frames.at(-2)?.local === 'Identifier';
            if (tag.local === 'inspireId' && tag.uri === current.namespace) {
                if (!directFeatureChild || current.inspireIdSeen) fail('Parcel GML has a path-confused or duplicate INSPIRE identifier.');
                current.inspireIdSeen = true;
            }
            if (tag.local === 'Identifier' && tag.uri === customSchema.idNamespace) {
                if (!directInspireIdentifier || current.identifierObjectSeen) fail('Parcel GML has a path-confused or duplicate INSPIRE identifier.');
                current.identifierObjectSeen = true;
            }
            if (tag.local === customSchema.idField) {
                if (tag.uri !== customSchema.idNamespace || !directIdentifierMember || current.localIdSeen) {
                    fail('Parcel GML has a path-confused or duplicate INSPIRE local identifier.');
                }
                current.localIdSeen = true;
                frame.finlandIdentityField = 'localId';
            } else if (tag.local === customSchema.namespaceField) {
                if (tag.uri !== customSchema.idNamespace || !directIdentifierMember || current.namespaceSeen) {
                    fail('Parcel GML has a path-confused or duplicate INSPIRE namespace.');
                }
                current.namespaceSeen = true;
                frame.finlandIdentityField = 'namespace';
            } else if (tag.local === customSchema.gmlIdentifierField && tag.uri === customSchema.gmlNamespace) {
                if (!directFeatureChild || current.gmlIdentifierSeen) fail('Parcel GML has a path-confused or duplicate gml:identifier.');
                current.gmlIdentifierSeen = true;
                current.gmlIdentifierCodeSpace = attr(tag, 'codeSpace') ?? null;
                frame.finlandIdentityField = 'gmlIdentifier';
            }
        }
    });
    parser.on('text', text => {
        const frame = stack.at(-1);
        if (current && (isSosnowiec || isCatastroAtom) && geometryDepth !== null && frame
            && !(frame.tag.local === 'posList' && isGmlTag(frame.tag)) && text.trim()) {
            fail('Parcel GML has unexpected geometry text.');
        }
        if (current && frame && (frame.finlandIdentityField || (frame.tag.local === activeIdField && frame.tag.uri === current.namespace)
            || (frame.tag.local === 'posList' && isGmlTag(frame.tag)))) {
            frame.text += text;
            if (frame.text.length > 2 * 1024 * 1024) fail('Parcel GML coordinate or identifier text exceeds limit.');
        }
    });
    parser.on('cdata', () => fail('Parcel GML CDATA is unsupported.'));
    parser.on('closetag', tag => {
        const frame = stack.pop();
        if (isCatastroAtom && frame.parcelMemberFeatures !== undefined && frame.parcelMemberFeatures !== 1) {
            fail('Spanish ATOM parcel members must contain exactly one feature.');
        }
        if (strictFlatFields && frame.hessenGeometryChildren === 0 && tag.local !== 'posList') {
            fail('Parcel GML has an empty geometry component.');
        }
        if (current && isFinland && frame.finlandIdentityField) {
            const value = frame.text.trim();
            if (!value || value.length > 512 || /[\s\u0000-\u001f]/.test(value)) fail('Parcel GML has a missing or invalid Finland identity value.');
            if (frame.finlandIdentityField === 'localId') {
                if (!new RegExp(customSchema.localIdPattern).test(value)) fail('Parcel GML has a missing or invalid native identifier.');
                if (current.id !== null) fail('Parcel GML repeats a native parcel identifier.');
                current.id = value;
            } else if (frame.finlandIdentityField === 'namespace') current.inspireNamespace = value;
            else current.gmlIdentifier = value;
        } else if (current && tag.local === activeIdField && tag.uri === current.namespace) {
            const native = frame.text.trim();
            if (!native || native.length > 256 || /[\s\u0000-\u001f]/.test(native)
                || (activeIdField === 'INSPIREID' && !/^\d+$/.test(native))
                || (canonicalCustomSchema === NORWAY_TEIG_GML_SCHEMA && !/^(?:0|[1-9]\d*)$/.test(native))
                || (strictFlatFields && !new RegExp(customSchema.localIdPattern).test(native))) fail('Parcel GML has a missing or invalid native identifier.');
            if (current.id !== null) fail('Parcel GML repeats a native identifier field.');
            current.id = native;
        }
        if (current && geometryDepth !== null && isGmlTag(tag)) {
            if (tag.local === 'posList') {
                if (isCatastroAtom && !frame.crs) fail('Parcel GML coordinates have no inherited coordinate system.');
                if(!sourceCrs) fail('Parcel GML coordinates have no coordinate system.');
                if (!nativeCoordinates && !projections.has(sourceCrs)) projections.set(sourceCrs, proj4(sourceCrs, 'EPSG:4326'));
                const projection = nativeCoordinates ? null : projections.get(sourceCrs), ring=[];
                let x=null,firstX,lastX,firstY,lastY;
                for(const match of frame.text.matchAll(/\S+/g)) {
                    const token=match[0];
                    if(!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(token)||!Number.isFinite(Number(token))) fail('Invalid parcel GML numeric coordinates.');
                    const value=Number(token);
                    if(x===null)x=value;
                    else{
                        if(!ring.length){firstX=x;firstY=value;}lastX=x;lastY=value;
                        const point = customSchema?.axisOrder === 'northing-easting' ? [value, x] : [x, value];
                        ring.push(nativeCoordinates ? point : projection.forward(point));x=null;
                    }
                }
                if(x!==null||ring.length<4||firstX!==lastX||firstY!==lastY) fail('Parcel GML polygon ring is invalid or not closed.');
                if (ringKind === 'exterior') { if (polygon.exterior) fail('Parcel GML repeats an exterior ring.'); polygon.exterior = ring; }
                else polygon.interiors.push(ring);
            }
            if (['exterior','interior'].includes(tag.local)) ringKind = null;
            if (['Polygon','PolygonPatch'].includes(tag.local)) {
                if (!polygon?.exterior) fail('Parcel GML polygon has no exterior ring.');
                current.polygons.push([polygon.exterior,...polygon.interiors]); polygon = null;
            }
        }
        if (current && geometryDepth === stack.length+1) geometryDepth = null;
        if (current && current.depth === stack.length+1) {
            if (!current.id || !current.geometrySeen || !current.polygons.length || polygon || ringKind) fail('Parcel GML feature is missing identity or polygon geometry.');
            if (customSchema?.gmlIdPrefix && (!current.gmlId || !current.gmlId.startsWith(customSchema.gmlIdPrefix)
                || current.gmlId !== `${customSchema.gmlIdPrefix}${current.id}`)) fail('Parcel GML feature ID does not match its native identifier.');
            if (isHessen && current.gmlId !== current.id) fail('Parcel GML feature ID does not match its native identifier.');
            if (isFinland && (!current.inspireIdSeen || !current.identifierObjectSeen || !current.localIdSeen || !current.namespaceSeen
                || !current.gmlIdentifierSeen || current.inspireNamespace !== customSchema.expectedInspireNamespace
                || customSchema.canonicalIdPrefix !== customSchema.expectedInspireNamespace
                || current.gmlIdentifier !== `${current.inspireNamespace}${current.id}`
                || current.gmlIdentifierCodeSpace !== customSchema.gmlIdentifierCodeSpace)) {
                fail('Parcel GML Finland identities do not agree.');
            }
            const geometry = { type: current.polygons.length === 1 ? 'Polygon' : 'MultiPolygon',
                coordinates: current.polygons.length === 1 ? current.polygons[0] : current.polygons };
            if (nativeCoordinates ? !validNativeGeometry(geometry) : !validateGeometry(geometry)) {
                fail(nativeCoordinates ? 'Invalid native parcel GML polygon.' : 'Invalid projected parcel GML polygon.');
            }
            const bbox = [Infinity,Infinity,-Infinity,-Infinity];
            for (const poly of current.polygons) for (const ring of poly) for (const [x,y] of ring) {
                bbox[0]=Math.min(bbox[0],x);bbox[1]=Math.min(bbox[1],y);bbox[2]=Math.max(bbox[2],x);bbox[3]=Math.max(bbox[3],y);
            }
            if (streaming) streamedExtent = streamedExtent
                ? [Math.min(streamedExtent[0],bbox[0]),Math.min(streamedExtent[1],bbox[1]),Math.max(streamedExtent[2],bbox[2]),Math.max(streamedExtent[3],bbox[3])]
                : bbox.slice();
            featureCount++; if (featureCount > maxFeatures) fail('Parcel GML exceeds feature limit.');
            const feature = { type:'Feature',id:current.id,properties:{[activeIdField]:current.id},geometry,bbox };
            if (streaming) {
                const callbackResult = onFeature(feature);
                if (callbackResult && (typeof callbackResult === 'object' || typeof callbackResult === 'function')
                    && typeof callbackResult.then === 'function') fail('GML onFeature callback must be synchronous.');
            } else {
                const previous = byId.get(current.id);
                if (previous) {
                    if (JSON.stringify(previous.geometry) !== JSON.stringify(geometry)) fail('Parcel GML has conflicting geometry for one native identifier.');
                    duplicateNativeCount++;
                } else byId.set(current.id, feature);
            }
            current = null;
        }
        if (!stack.length && collectionTag(tag)) closedCollection = true;
    });
    const decoder = new TextDecoder('utf-8',{ fatal:true });
    async function* chunks() {
        if(typeof input==='string')yield new TextEncoder().encode(input);
        else if(input instanceof Uint8Array)yield input;
        else if(input?.[Symbol.asyncIterator])yield* input;
        else fail('Invalid parcel GML byte input.');
    }
    let totalBytes=0;
    let bytesUntilYield=0;
    try {
        for await(const bytes of chunks()) {
            if(!(bytes instanceof Uint8Array))fail('Invalid parcel GML byte chunk.');
            totalBytes+=bytes.byteLength;if(totalBytes>maxBytes)fail('Parcel GML exceeds byte limit.');
            for(let offset=0;offset<bytes.byteLength;offset+=65536){
                if(signal?.aborted)fail('Parcel GML load aborted.');
                const length=Math.min(65536,bytes.byteLength-offset);
                parser.write(decoder.decode(bytes.subarray(offset,offset+length),{stream:true}));
                bytesUntilYield+=length;
                if(bytesUntilYield>=65536){
                    bytesUntilYield=0;
                    if(typeof globalThis.scheduler?.yield==='function')await globalThis.scheduler.yield();
                    else if(typeof globalThis.setImmediate==='function')await new Promise(resolve=>globalThis.setImmediate(resolve));
                    else await new Promise(resolve=>globalThis.setTimeout(resolve,0));
                }
            }
            if(signal?.aborted)fail('Parcel GML load aborted.');
        }
        if(signal?.aborted)fail('Parcel GML load aborted.');
        parser.write(decoder.decode()).close();
    } catch (error) { if (error.status) throw error; fail('Malformed parcel GML or coordinate transformation.'); }
    const declaredNumberReturned = numberReturned;
    if (nativeCoordinates && sourceCrs !== 'EPSG:27700') fail('Native HMLR coordinates require EPSG:27700.');
    let numberReturnedNormalized = false;
    let numberReturnedProtocolException = null;
    if (numberReturned !== undefined && numberReturned !== featureCount) {
        if (canonicalCustomSchema === NORWAY_TEIG_GML_SCHEMA && numberReturned === 0 && featureCount > 0) {
            numberReturned = featureCount;
            numberReturnedNormalized = true;
            numberReturnedProtocolException = 'kartverket-no-teig-zero-numberReturned-on-data-response';
        } else fail('Parcel GML has incomplete or inconsistent feature counts.');
    }
    if (!collection || !closedCollection || current
        || (numberMatched !== undefined && numberMatched < featureCount)) fail('Parcel GML has incomplete or inconsistent feature counts.');
    if (isCatastroAtom && (numberMatched !== featureCount || numberReturned !== featureCount || duplicateNativeCount)) {
        fail('Spanish ATOM parcel archive is not a complete unique declared parcel set.');
    }
    const features = streaming ? [] : [...byId.values()];
    const extent = streaming ? streamedExtent : features.length
        ? features.reduce((out,f)=>[Math.min(out[0],f.bbox[0]),Math.min(out[1],f.bbox[1]),Math.max(out[2],f.bbox[2]),Math.max(out[3],f.bbox[3])],[Infinity,Infinity,-Infinity,-Infinity]) : null;
    return { features,featureCount,uniqueFeatureCount:streaming ? null : features.length,numberMatched,numberMatchedUnknown,numberReturned,
        declaredNumberReturned,numberReturnedNormalized,numberReturnedProtocolException,sourceCrs,extent,
        duplicateNativeCount:streaming ? null : duplicateNativeCount,
        ...(sourceTimestamp !== undefined ? { sourceTimestamp } : {}) };
}
