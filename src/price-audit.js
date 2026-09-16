((root,factory)=>{const api=factory();if(typeof module==='object')module.exports=api;else root.priceAudit=api;})(globalThis,()=>{
  const PRICE_KEY=/(duration|resolution|quality|mode|audio|sound|num_images|number_of|image_count|output_format|image_size|rendering_speed|tier|aspect_ratio|ratio|reference|image.*url|video.*url)/i;
  const IGNORED_KEY=/(nsfw|safety|seed|watermark|prompt|translate|camera|web_search|output_format)/i;
  function schemaValue(schema={}){
    if(schema.default!==undefined)return structuredClone(schema.default);
    const selected=schema.oneOf?.[0]||schema.anyOf?.[0];if(selected)return schemaValue(selected);
    if(schema.enum?.length)return schema.enum[0];
    if(schema.type==='object'){const value={};for(const key of schema.required||[])value[key]=schemaValue(schema.properties?.[key]||{});return value;}
    if(schema.type==='array')return Array.from({length:Math.max(1,schema.minItems||0)},()=>schemaValue(schema.items||{}));
    if(schema.type==='boolean')return false;if(schema.type==='integer'||schema.type==='number')return schema.minimum??1;
    if(schema.format==='uri')return 'https://local.invalid/present';return 'price-check';
  }
  function initialValue(field){
    if(field.default!==undefined)return structuredClone(field.default);
    if(field.schema?.default!==undefined)return structuredClone(field.schema.default);
    if(field.type==='boolean')return false;
    if(field.type==='select')return field.options?.[0];
    if(field.type==='number')return field.min??field.schema?.minimum??1;
    if(field.type==='files')return field.scalar?true:[true];
    if(field.type==='json')return schemaValue(field.schema);
    return 'price-check';
  }
  function baseInput(model){
    const input={};
    for(const field of model.fields||[]){
      if(field.required||field.default!==undefined||field.schema?.default!==undefined||field.type==='boolean')input[field.key]=initialValue(field);
    }
    return input;
  }
  function values(model,field,durationApi){
    if(IGNORED_KEY.test(field.key))return [];
    if(field.key==='duration'){
      const allowed=durationApi?.values?.(model,field);
      return allowed?.length?allowed:field.options||[field.min,field.default,field.max].filter(v=>v!==undefined);
    }
    if(!PRICE_KEY.test(field.key))return [];
    if(field.type==='select')return field.options||[];
    if(field.type==='boolean')return [false,true];
    if(field.type==='files'&&!field.required)return [undefined,field.scalar?true:[true]];
    if(field.type==='number')return [field.min??field.schema?.minimum,field.default??field.schema?.default,field.max??field.schema?.maximum].filter(v=>v!==undefined);
    return [];
  }
  function stable(value){if(Array.isArray(value))return value.map(stable);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));return value;}
  function caseKey(model,input){return `${model.id}:${JSON.stringify(stable(input))}`;}
  function plan(models,durationApi){
    const cases=[];
    for(const model of models.filter(item=>item.providerId==='kie')){
      const baseline=baseInput(model),inputs=[baseline];
      for(const field of model.fields||[])for(const value of values(model,field,durationApi)){
        const input=structuredClone(baseline);if(value===undefined)delete input[field.key];else input[field.key]=value;inputs.push(input);
      }
      const seen=new Set();for(const input of inputs){const key=caseKey(model,input);if(seen.has(key))continue;seen.add(key);cases.push({key,modelId:model.id,apiModel:model.apiModel,modelName:model.name,input});}
    }
    return cases;
  }
  function compare(account,local){
    if(account&&local)return Math.abs(account.credits-local.credits)<0.01?'match':'mismatch';
    if(account)return 'confirmed';if(local)return 'tariff-only';return 'unavailable';
  }
  return {plan,baseInput,compare,caseKey};
});
