// Namespace-aware, bounded INSPIRE/HMLR geometry reader. XML/ownership fields never enter its output.
import { SaxesParser } from 'saxes';
import proj4 from 'proj4';
import { validateGeometry, upstreamError } from './source-contract.js';

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
export const POZNAN_GML_SCHEMA = Object.freeze({
    featureNamespace: 'http://portal.geopoz.poznan.pl/wmsegib',
    featureName: 'dzialki',
    idField: 'ID_DZIALKI',
    geometryField: 'MSGEOMETRY',
    gmlNamespace: GML32,
    sourceCrs: 'EPSG:2177',
    axisOrder: 'northing-easting'
});
proj4.defs('EPSG:27700', '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.1502,0.2470,0.8421,-20.4894 +units=m +no_defs');
proj4.defs('EPSG:2177', '+proj=tmerc +lat_0=0 +lon_0=18 +k=0.999923 +x_0=6500000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');
for (const zone of [30,31,33]) proj4.defs(`EPSG:258${zone}`, `+proj=utm +zone=${zone} +ellps=GRS80 +towgs84=0,0,0 +units=m +no_defs`);
const attr = (tag,name) => Object.values(tag.attributes).find(a => a.local === name && !a.uri)?.value;
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

export async function parseGmlParcels(input, { idField = 'INSPIREID', maxBytes = 160 * 1024 * 1024,
    maxFeatures = 150000, signal, featureNamespace, featureName, schema } = {}) {
    const hasCustomSchema = schema !== undefined;
    const customSchema = hasCustomSchema ? schema : null;
    const validCustomSchema = customSchema && typeof customSchema === 'object' && !Array.isArray(customSchema)
        && [MAPSERVER_GML_SCHEMA, SAXONY_GML_SCHEMA, POZNAN_GML_SCHEMA].some(known => Object.keys(customSchema).length === Object.keys(known).length
            && Object.entries(known).every(([key,value]) => customSchema[key] === value));
    if ((hasCustomSchema && !validCustomSchema) || (customSchema && (idField !== 'INSPIREID'
        || featureNamespace !== undefined || featureName !== undefined))
        || (!customSchema && !['INSPIREID','nationalCadastralReference'].includes(idField))
        || !Number.isSafeInteger(maxBytes) || maxBytes < 1
        || !Number.isSafeInteger(maxFeatures) || maxFeatures < 1) throw new Error('Invalid parcel GML reader options.');
    const activeIdField = customSchema ? customSchema.idField : idField;
    const activeFeatureNamespace = customSchema ? customSchema.featureNamespace : featureNamespace;
    const activeFeatureName = customSchema ? customSchema.featureName : featureName;
    const isGmlTag = tag => customSchema ? tag.uri === customSchema.gmlNamespace : GML.has(tag.uri);
    const isFeatureTag = tag => customSchema
        ? tag.uri === customSchema.featureNamespace && tag.local === customSchema.featureName : featureTag(tag);
    const parser = new SaxesParser({ xmlns: true });
    const stack = [], byId = new Map();
    let current = null, polygon = null, ringKind = null, collection = false, closedCollection = false;
    let geometryDepth = null, sourceCrs = null, numberMatched, numberMatchedUnknown = false, numberReturned, featureCount = 0, duplicateNativeCount = 0;
    const projections = new Map();
    const fail = message => { throw upstreamError(message); };
    parser.on('doctype', () => fail('Parcel GML document types and external entities are forbidden.'));
    parser.on('error', () => fail('Malformed parcel GML.'));
    parser.on('opentag', tag => {
        if (!stack.length) {
            if (!collectionTag(tag) || (customSchema && tag.uri !== 'http://www.opengis.net/wfs/2.0')) fail('Parcel GML must be a FeatureCollection.');
            collection = true;
            const matchedAttribute = attr(tag,'numberMatched');
            numberMatchedUnknown = matchedAttribute === 'unknown';
            numberMatched = count(matchedAttribute); numberReturned = count(attr(tag,'numberReturned'));
        }
        const parent = stack.at(-1)?.tag;
        if (parent && collectionTag(parent) && !(['member','featureMember','featureMembers','boundedBy'].includes(tag.local)
            && ['http://www.opengis.net/wfs/2.0','http://www.opengis.net/wfs',...GML].includes(tag.uri))) fail('Unsupported parcel GML collection content.');
        if (parent && ['member','featureMember','featureMembers'].includes(parent.local) && ['http://www.opengis.net/wfs/2.0','http://www.opengis.net/wfs',...GML].includes(parent.uri) && !isFeatureTag(tag)) fail('Unsupported parcel GML collection member.');
        if (current && geometryDepth !== null && !isGmlTag(tag)) fail('Unsupported parcel GML geometry namespace.');
        const frame = { tag, text: '' }; stack.push(frame);
        const srs = attr(tag,'srsName');
        if (srs !== undefined) {
            const resolved = crsName(srs, customSchema);
            if (customSchema && resolved !== customSchema.sourceCrs) fail('Parcel GML response coordinate system does not match the configured schema.');
            if (sourceCrs && sourceCrs !== resolved) fail('Parcel GML mixes coordinate systems.');
            sourceCrs = resolved;
        }
        const dim = attr(tag,'srsDimension');
        if (dim !== undefined && dim !== '2') fail('Parcel GML must have two-dimensional coordinates.');
        if (isFeatureTag(tag)) {
            if (current || (activeFeatureNamespace && tag.uri !== activeFeatureNamespace) || (activeFeatureName && tag.local !== activeFeatureName)) fail('Unexpected parcel GML feature.');
            current = { depth: stack.length, namespace: tag.uri, id: null, polygons: [], geometrySeen: false };
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
    });
    parser.on('text', text => {
        const frame = stack.at(-1);
        if (current && frame && ((frame.tag.local === activeIdField && frame.tag.uri === current.namespace)
            || (frame.tag.local === 'posList' && isGmlTag(frame.tag)))) {
            frame.text += text;
            if (frame.text.length > 2 * 1024 * 1024) fail('Parcel GML coordinate or identifier text exceeds limit.');
        }
    });
    parser.on('cdata', () => fail('Parcel GML CDATA is unsupported.'));
    parser.on('closetag', tag => {
        const frame = stack.pop();
        if (current && tag.local === activeIdField && tag.uri === current.namespace) {
            const native = frame.text.trim();
            if (!native || native.length > 256 || /[\s\u0000-\u001f]/.test(native) || (activeIdField === 'INSPIREID' && !/^\d+$/.test(native))) fail('Parcel GML has a missing or invalid native identifier.');
            if (current.id !== null) fail('Parcel GML repeats a native identifier field.');
            current.id = native;
        }
        if (current && geometryDepth !== null && isGmlTag(tag)) {
            if (tag.local === 'posList') {
                if(!sourceCrs) fail('Parcel GML coordinates have no coordinate system.');
                if(!projections.has(sourceCrs)) projections.set(sourceCrs,proj4(sourceCrs,'EPSG:4326'));
                const projection=projections.get(sourceCrs), ring=[];
                let x=null,firstX,lastX,firstY,lastY;
                for(const match of frame.text.matchAll(/\S+/g)) {
                    const token=match[0];
                    if(!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(token)||!Number.isFinite(Number(token))) fail('Invalid parcel GML numeric coordinates.');
                    const value=Number(token);
                    if(x===null)x=value;
                    else{
                        if(!ring.length){firstX=x;firstY=value;}lastX=x;lastY=value;
                        ring.push(projection.forward(customSchema?.axisOrder === 'northing-easting' ? [value,x] : [x,value]));x=null;
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
            const geometry = { type: current.polygons.length === 1 ? 'Polygon' : 'MultiPolygon',
                coordinates: current.polygons.length === 1 ? current.polygons[0] : current.polygons };
            if (!validateGeometry(geometry)) fail('Invalid projected parcel GML polygon.');
            const bbox = [Infinity,Infinity,-Infinity,-Infinity];
            for (const poly of current.polygons) for (const ring of poly) for (const [x,y] of ring) {
                bbox[0]=Math.min(bbox[0],x);bbox[1]=Math.min(bbox[1],y);bbox[2]=Math.max(bbox[2],x);bbox[3]=Math.max(bbox[3],y);
            }
            featureCount++; if (featureCount > maxFeatures) fail('Parcel GML exceeds feature limit.');
            const previous = byId.get(current.id);
            if (previous) {
                if (JSON.stringify(previous.geometry) !== JSON.stringify(geometry)) fail('Parcel GML has conflicting geometry for one native identifier.');
                duplicateNativeCount++;
            } else byId.set(current.id,{ type:'Feature',id:current.id,properties:{[activeIdField]:current.id},geometry,bbox });
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
    try {
        for await(const bytes of chunks()) {
            if(!(bytes instanceof Uint8Array))fail('Invalid parcel GML byte chunk.');
            totalBytes+=bytes.byteLength;if(totalBytes>maxBytes)fail('Parcel GML exceeds byte limit.');
            for(let offset=0;offset<bytes.byteLength;offset+=65536){
                if(signal?.aborted)fail('Parcel GML load aborted.');
                parser.write(decoder.decode(bytes.subarray(offset,offset+65536),{stream:true}));
                await new Promise(resolve=>setImmediate(resolve));
            }
        }
        parser.write(decoder.decode()).close();
    } catch (error) { if (error.status) throw error; fail('Malformed parcel GML or coordinate transformation.'); }
    if (!collection || !closedCollection || current || (numberReturned !== undefined && numberReturned !== featureCount)
        || (numberMatched !== undefined && numberMatched < featureCount)) fail('Parcel GML has incomplete or inconsistent feature counts.');
    const features = [...byId.values()];
    const extent = features.length ? features.reduce((out,f)=>[Math.min(out[0],f.bbox[0]),Math.min(out[1],f.bbox[1]),Math.max(out[2],f.bbox[2]),Math.max(out[3],f.bbox[3])],[Infinity,Infinity,-Infinity,-Infinity]) : null;
    return { features,featureCount,uniqueFeatureCount:features.length,numberMatched,numberMatchedUnknown,numberReturned,sourceCrs,extent,duplicateNativeCount };
}
