// Shared pure calculations. Unknown charges stay unknown, never zero.
((root,factory)=>{const api=factory(typeof module==='object'?require('./tariff-snapshot'):root.tariffSnapshot);if(typeof module==='object')module.exports=api;else root.costs=api;})(globalThis,(snapshot)=>{
  const amount=value=>{if(typeof value!=='number'&&!(typeof value==='string'&&/^\d+(\.\d+)?$/.test(value.trim())))return null;const number=Number(value);return Number.isFinite(number)&&number>=0?number:null;};
  const round=value=>Math.round((value+Number.EPSILON)*100)/100;
  function quote(model,input,tariffs){
    if(model?.providerId!=='kie')return null;
    let description,multiplier=1,expectedUnit='per second';
    if(['nano-banana-pro','nano-banana-2','nano-banana-2-lite'].includes(model.apiModel)){
      expectedUnit='per image';
      if(model.apiModel==='nano-banana-2-lite')description='nano-banana-2-lite, 1k';
      else {const resolution=input.resolution||'1K';if(!['1K','2K','4K'].includes(resolution))return null;description=model.apiModel==='nano-banana-pro'?'Google nano banana pro, '+(resolution==='4K'?'4K':'1/2K'):'Google nano banana 2, '+resolution;}
    }else if(model.apiModel==='grok-imagine-video-1-5-preview'){
      if(!input.image_urls?.length||!['480p','720p'].includes(input.resolution)||!Number.isInteger(Number(input.duration))||Number(input.duration)<1||Number(input.duration)>15)return null;
      description=`grok-imagine-video-1-5-preview, image-to-video, ${input.resolution}`;multiplier=Number(input.duration);
    }else if(model.apiModel==='kling-3.0/video'){
      if(input.multi_shots||input.kling_elements?.length)return null;
      const resolution={std:'720P',pro:'1080P','4K':'4K'}[input.mode];
      if(!resolution||typeof input.sound!=='boolean'||!Number.isInteger(Number(input.duration))||Number(input.duration)<3||Number(input.duration)>15)return null;
      description=`Kling 3.0, video, ${input.sound?'with':'without'} audio-${resolution}`;multiplier=Number(input.duration);
    }else if(model.adapter==='veo'){
      expectedUnit='per video';
      // The public rate is per video; do not extrapolate it to unverified durations.
      if(Number(input.duration)!==8)return null;
      const tier={veo3:'Quality',veo3_fast:'Fast',veo3_lite:'Lite'}[model.wireModel];
      const mode={TEXT_2_VIDEO:'text-to-video',FIRST_AND_LAST_FRAMES_2_VIDEO:'image-to-video',REFERENCE_2_VIDEO:'reference-to-video'}[model.mode];
      if(!tier||!mode)return null;
      description=`Google veo 3.1, ${mode}, ${tier}-${input.resolution}`;
    }else if(/^hailuo\/(02|2-3)-(image|text)-to-video-(pro|standard)$/.test(model.apiModel)){
      const [,version,mode,tier]=model.apiModel.match(/^hailuo\/(02|2-3)-(image|text)-to-video-(pro|standard)$/);
      const fixed=version==='02'&&tier==='pro';
      const duration=fixed?6:Number(input.duration);
      const resolution=fixed?'1080p':mode==='text'?'768p':String(input.resolution).toLowerCase();
      if(![6,10].includes(duration)||!['512p','768p','1080p'].includes(resolution))return null;
      description=`hailuo ${version==='02'?'02':'2.3'}, ${mode}-to-video, ${tier==='pro'?'Pro':'Standard'}-${duration}.0s-${resolution}`;
      expectedUnit='per video';
    }else if(/^kling-2\.6\/(image|text)-to-video$/.test(model.apiModel)){
      if(typeof input.sound!=='boolean'||![5,10].includes(Number(input.duration)))return null;
      description=`kling 2.6, ${model.apiModel.split('/')[1]}, ${input.sound?'with':'without'} audio-${Number(input.duration)}.0s`;
      expectedUnit='per video';
    }else if(model.apiModel==='bytedance/seedance-1.5-pro'){
      if(typeof input.generate_audio!=='boolean'||!['480p','720p','1080p'].includes(input.resolution)||!Number.isInteger(Number(input.duration))||Number(input.duration)<4||Number(input.duration)>12)return null;
      description=`bytedance/seedance-1.5-pro, ${input.generate_audio?'with':'without'} audio-${input.resolution}`;
      multiplier=Number(input.duration);
    }else if(/^google\/imagen4(-fast|-ultra)?$/.test(model.apiModel)){
      const tier={'google/imagen4':'default','google/imagen4-fast':'Fast','google/imagen4-ultra':'Ultra'}[model.apiModel];
      description=`google imagen4, text-to-image, ${tier}`;
      expectedUnit=tier==='Ultra'?'per image':'per request';
    }else if(/^seedream\/(4\.5-(edit|text-to-image)|5-lite-(image-to-image|text-to-image))$/.test(model.apiModel)){
      const lite=model.apiModel.includes('5-lite');
      if(!(lite?['basic','high','ultra']:['basic','high']).includes(input.quality))return null;
      description=`seedream ${lite?'5.0 Lite':'4.5'}, ${model.apiModel.endsWith('text-to-image')?'text-to-image':'image-to-image'}`;
      expectedUnit='per image';
    }else return null;
    let source=tariffs;
    let rows=(source?.rows||[]).filter(row=>row.modelDescription?.toLowerCase()===description.toLowerCase());
    if(!rows.length){source=snapshot;rows=(source?.rows||[]).filter(row=>row.modelDescription?.toLowerCase()===description.toLowerCase());}
    if(rows.length!==1)return null;
    const row=rows[0],unit=amount(row.creditPrice);
    if(unit===null||row.creditUnit!==expectedUnit)return null;
    return {credits:round(unit*multiplier),description,tariffDate:source.fetchedAt,source:source.source||'https://kie.ai/pricing',type:'tariff',snapshot:Boolean(source.snapshot),stale:Boolean(source.stale)||Date.now()-Date.parse(source.fetchedAt)>86400000};
  }
  function charge(record,currentRate){
    const credits=amount(record.creditsConsumed);
    const stored=amount(record.rubPerCredit);
    const rate=stored??amount(currentRate);
    return {credits,rubles:credits===null||rate===null?null:round(credits*rate),rate,historical:stored!==null};
  }
  function breakdown(record,currentRate){
    const actual=charge(record,currentRate),credits=amount(record.estimate?.credits);
    return {rate:actual.rate,actual:{credits:actual.credits,rubles:actual.rubles,known:actual.credits!==null},estimate:{credits,rubles:credits===null||actual.rate===null?null:round(credits*actual.rate),source:record.estimate?.source||null,tariffDate:record.estimate?.tariffDate||null,stale:Boolean(record.estimate?.stale),snapshot:Boolean(record.estimate?.snapshot)}};
  }
  function summary(records,currentRate,period='all',now=new Date()){
    let credits=0,rubles=0,known=0,unknown=0,legacy=0;const models=new Map();const seen=new Set();
    for(const record of records){
      const date=new Date(record.createdAt);if(period!=='all'&&(!Number.isFinite(date.getTime())||date.getFullYear()!==now.getFullYear()||date.getMonth()!==now.getMonth()||(period==='day'&&date.getDate()!==now.getDate())))continue;
      const identity=`${record.providerId}:${record.taskId||record.id}`;if(seen.has(identity))continue;seen.add(identity);
      const value=charge(record,currentRate);
      if(value.credits===null){if(['success','fail','unknown','unconfirmed'].includes(record.state))unknown++;continue;}
      known++;credits+=value.credits;rubles+=value.rubles;if(!value.historical)legacy++;
      const key=`${record.providerName} · ${record.modelName}`;const group=models.get(key)||{name:key,credits:0,rubles:0};group.credits+=value.credits;group.rubles+=value.rubles;models.set(key,group);
    }
    return {credits:round(credits),rubles:round(rubles),known,unknown,legacy,models:[...models.values()].map(row=>({...row,credits:round(row.credits),rubles:round(row.rubles)}))};
  }
  function providerSnapshot(records,providerId){
    let credits=0,known=0,unknown=0;const seen=new Set();
    for(const record of records){
      if(record.providerId!==providerId)continue;
      const identity=`${record.providerId}:${record.taskId||record.id}`;if(seen.has(identity))continue;seen.add(identity);
      const value=amount(record.creditsConsumed);
      if(value===null){if(['success','fail','unknown','unconfirmed'].includes(record.state))unknown++;continue;}
      credits+=value;known++;
    }
    return {credits:round(credits),known,unknown};
  }
  function reconcile(baseline,current){
    const startBalance=amount(baseline?.balance),endBalance=amount(current?.balance);
    const startCredits=amount(baseline?.apiCredits),endCredits=amount(current?.apiCredits);
    if([startBalance,endBalance,startCredits,endCredits].some(value=>value===null))return null;
    const balanceSpent=round(startBalance-endBalance),apiSpent=round(endCredits-startCredits);
    return {balanceSpent,apiSpent,difference:round(balanceSpent-apiSpent)};
  }
  return {amount,round,quote,charge,breakdown,summary,providerSnapshot,reconcile};
});
