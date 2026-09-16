const {test}=require('node:test');const assert=require('node:assert/strict');
const costs=require('../src/costs');const {models}=require('../src/catalog');
test('additional model tariffs match exact parameters and billing units',()=>{
  const cases=[
    ['hailuo/02-image-to-video-pro',{},'hailuo 02, image-to-video, Pro-6.0s-1080p',57,'per video',57],
    ['hailuo/2-3-image-to-video-standard',{duration:'10',resolution:'768P'},'hailuo 2.3, image-to-video, Standard-10.0s-768p',50,'per video',50],
    ['kling-2.6/text-to-video',{duration:'5',sound:true},'kling 2.6, text-to-video, with audio-5.0s',110,'per video',110],
    ['bytedance/seedance-1.5-pro',{duration:8,resolution:'480p',generate_audio:false},'bytedance/seedance-1.5-pro, without audio-480p',1.75,'per second',14],
    ['google/imagen4-fast',{},'google imagen4, text-to-image, Fast',4,'per request',4],
    ['google/imagen4-ultra',{},'google imagen4, text-to-image, Ultra',12,'per image',12],
    ['seedream/4.5-edit',{quality:'high'},'seedream 4.5, image-to-image',6.5,'per image',6.5],
    ['seedream/5-lite-text-to-image',{quality:'basic'},'seedream 5.0 Lite, text-to-image',5.5,'per image',5.5]
  ];
  for(const [id,input,modelDescription,creditPrice,creditUnit,total] of cases){
    const model=models.find(m=>m.apiModel===id);assert.ok(model,id);
    const row={modelDescription,creditPrice,creditUnit};const tariffs={rows:[row],fetchedAt:'2026-09-09'};
    assert.equal(costs.quote(model,input,tariffs)?.credits,total,id);
    assert.equal(costs.quote(model,input,{rows:[row,row]}),null,'ambiguous tariff');
    assert.equal(costs.quote(model,input,{rows:[{...row,creditUnit:'per million tokens'}]}),null,'wrong unit');
    assert.equal(costs.quote(model,input,{rows:[]}),null,'missing tariff');
  }
  assert.equal(costs.quote(models.find(m=>m.apiModel==='kling-2.6/text-to-video'),{sound:true,duration:7},{rows:[]}),null);
});
test('Grok quote uses verified units, ruble price and rejects unknown settings',()=>{
  const model=models.find(m=>m.apiModel==='grok-imagine-video-1-5-preview');
  const tariffs={fetchedAt:'2026-09-09',rows:[{modelDescription:'grok-imagine-video-1-5-preview, image-to-video, 480p',creditPrice:'2.4',creditUnit:'per second'}]};
  const input={resolution:'480p',duration:8,image_urls:['source']};
  assert.equal(costs.quote(model,input,tariffs).credits,19.2);assert.equal(costs.round(19.2*0.51),9.79);
  assert.equal(costs.quote(model,{...input,resolution:'1080p'},tariffs),null);assert.equal(costs.quote(model,{...input,duration:0},tariffs),null);
});
test('accounting separates unknown, zero, estimates and historical rates without duplicates',()=>{
  const records=[{id:'1',taskId:'a',providerId:'kie',creditsConsumed:19.2,rubPerCredit:0.51},{id:'copy',taskId:'a',providerId:'kie',creditsConsumed:19.2},{id:'2',state:'success',estimate:{credits:50}},{id:'3',state:'success',creditsConsumed:0},{id:'4',state:'cancelled'},{id:'5',state:'fail',creditsConsumed:'10'},{id:'6',state:'success',creditsConsumed:''}];
  const result=costs.summary(records,1);
  assert.equal(result.credits,29.2);assert.equal(result.rubles,19.79);assert.equal(result.known,3);assert.equal(result.unknown,2);assert.equal(result.legacy,2);
  assert.equal(costs.charge(records[0],2).rubles,9.79);
  assert.equal(costs.amount(null),null);assert.equal(costs.amount(-1),null);
});
test('periods filter by local task creation date',()=>{
  const now=new Date(2026,8,9,12);const rows=[{id:'1',createdAt:new Date(2026,8,9).toISOString(),creditsConsumed:2},{id:'2',createdAt:new Date(2026,8,8).toISOString(),creditsConsumed:3},{id:'3',createdAt:new Date(2026,7,9).toISOString(),creditsConsumed:5}];
  assert.equal(costs.summary(rows,0.51,'day',now).credits,2);assert.equal(costs.summary(rows,0.51,'month',now).credits,5);
});
test('balance reconciliation compares account decrease with task charges',()=>{
  const records=[{id:'1',providerId:'kie',state:'success',creditsConsumed:12},{id:'2',providerId:'kie',state:'success'},{id:'3',providerId:'other',state:'success',creditsConsumed:50}];
  assert.deepEqual(costs.providerSnapshot(records,'kie'),{credits:12,known:1,unknown:1});
  assert.deepEqual(costs.reconcile({balance:100,apiCredits:10},{balance:82,apiCredits:24}),{balanceSpent:18,apiSpent:14,difference:4});
});
