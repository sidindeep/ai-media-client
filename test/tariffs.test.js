const {test}=require('node:test');const assert=require('node:assert/strict');const {Tariffs}=require('../src/tariffs');
test('public tariffs cache, no authentication or user inputs sent, stale fallback',async()=>{
  let saved=[],calls=0,offline=false;
  const preferences={list:async()=>saved,update:async(id,changes)=>{saved=[{id,...changes}];}};
  const tariffs=new Tariffs(preferences,async(url,options)=>{
    calls++;assert.equal(url,'https://api.kie.ai/client/v1/model-pricing/page');assert.deepEqual(Object.keys(options.headers),['Content-Type']);assert.deepEqual(JSON.parse(options.body),{pageNum:1,pageSize:100});
    if(offline)throw new Error('Offline');return {ok:true,json:async()=>({code:200,data:{pages:1,records:[{modelDescription:'Example',creditPrice:'2',creditUnit:'per second'}]}})};
  });
  const first=await tariffs.get();assert.equal(first.rows.length,1);await tariffs.get();assert.equal(calls,1);offline=true;const stale=await tariffs.get(true);assert.equal(stale.stale,true);assert.equal(stale.rows.length,1);
});
