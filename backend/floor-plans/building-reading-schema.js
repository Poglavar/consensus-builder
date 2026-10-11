// Constrain model output to quoted listing evidence and opaque candidate references.
const string={type:'string'};
const nullableString={type:['string','null']};
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
export const BUILDING_SCHEMA=object({
    schema:{type:'string',enum:['ad-building-reading.v1']},
    isListing:{type:'boolean'},
    address:object({value:nullableString,quote:nullableString}),
    project:object({name:nullableString,quote:nullableString,linkId:nullableString}),
    candidateId:nullableString,
    confidence:{type:'string',enum:['high','medium','low']},
    rationale:string,
    issues:{type:'array',items:string}
});
