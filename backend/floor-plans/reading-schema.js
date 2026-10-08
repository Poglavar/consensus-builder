// Forced tool-call shape; structure, metric constraints and topology are validated independently.
const number={type:'number'},string={type:'string'},nullableNumber={type:['number','null']};
const array=items=>({type:'array',items});
const point=array(number),nullablePoint={anyOf:[point,{type:'null'}]};
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
export const READING_SCHEMA=object({
    schema:{type:'string',enum:['floor-plan-reading.v1']},notPlan:{type:'boolean'},issues:array(string),
    plans:array(object({
        id:string,label:string,scope:{type:'string',enum:['unit','floor']},floor:{type:['integer','null']},floorEvidence:string,
        framePx:array(number),scale:object({a:point,b:point,lengthM:number,quote:string}),
        slabsPx:array(array(array(point))),wallsPx:array(object({a:point,b:point,widthPx:number})),
        openingsPx:array(object({kind:{type:'string',enum:['door','window','glazedDoor','slidingDoor']},
            a:point,b:point,depthPx:number,hinge:nullablePoint,openTip:nullablePoint})),
        rooms:array(object({name:string,areaM2:nullableNumber})),wallHeightM:nullableNumber,heightEvidence:string,
        elevationM:nullableNumber,elevationEvidence:string,northPx:{anyOf:[array(point),{type:'null'}]},northEvidence:string,issues:array(string)
    }))
});
