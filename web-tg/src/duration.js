((root,factory)=>{const api=factory();if(typeof module==='object')module.exports=api;else root.durationRules=api;})(globalThis,()=>{
  function values(model,field){
    if(field.key!=='duration')return null;
    if(field.options)return field.options.map(Number);
    let min=field.min??field.schema?.minimum,max=field.max??field.schema?.maximum,auto;
    const id=model.apiModel;
    if(id==='bytedance/seedance-1.5-pro'){min=4;max=12;}
    if(/^bytedance\/seedance-2/.test(id)){min=4;max=id.endsWith('-5')?30:15;auto=-1;}
    if(/^grok-imagine\/(image|text)-to-video$/.test(id)){min=6;max=30;}
    if(/^kling\/v3-turbo-/.test(id)){min=3;max=15;}
    if(/^wan\/3-0-video/.test(id)){min=2;max=30;auto=-1;}
    if(id==='wan/2-7-videoedit'){min=2;max=10;auto=0;}
    if(!Number.isFinite(min)||!Number.isFinite(max))return null;
    return [...(auto!==undefined?[auto]:[]),...Array.from({length:max-min+1},(_,i)=>min+i)];
  }
  function validate(model,input){const field=model.fields.find(f=>f.key==='duration'),allowed=field&&values(model,field);if(allowed&&input.duration!==undefined&&input.duration!==''&&!allowed.includes(Number(input.duration)))throw new Error('Недопустимая длительность. Разрешено: '+allowed.join(', ')+' сек.');}
  return {values,validate};
});
