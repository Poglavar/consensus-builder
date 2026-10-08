// Forced tool-call shape; structure, metric constraints and topology are validated independently.
const number={type:'number'},string={type:'string'},nullableNumber={type:['number','null']};
const array=items=>({type:'array',items});
const point=array(number);
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
export const READING_SCHEMA=object({
    schema:{type:'string',enum:['floor-plan-reading.v3']},notPlan:{type:'boolean'},issues:array(string),
    plans:array(object({
        id:string,label:string,scope:{type:'string',enum:['unit','floor']},floor:{type:['integer','null']},floorEvidence:string,
        scale:object({candidateId:string,lengthM:number,quote:string}),
        slabs:array(object({outer:array(string),holes:array(array(string))})),wallIds:array(string),railingIds:array(string),
        openings:array(object({candidateId:string,kind:{type:'string',enum:['door','window','glazedDoor','slidingDoor']},
            hinge:{anyOf:[{type:'string',enum:['a','b']},{type:'null'}]},
            swing:{anyOf:[{type:'string',enum:['clockwise','counterclockwise']},{type:'null'}]}})),
        rooms:array(object({name:string,areaM2:nullableNumber})),wallHeightM:nullableNumber,heightEvidence:string,
        elevationM:nullableNumber,elevationEvidence:string,northPx:{anyOf:[array(point),{type:'null'}]},northEvidence:string,issues:array(string)
    }))
});
