const test = require('node:test');
const assert = require('node:assert/strict');
const costs = require('../src/costs');
test('Nano Banana quote uses verified snapshot, overrides with live tariff and rejects unsupported settings', () => {
  const model={providerId:'kie',apiModel:'nano-banana-pro'};
  assert.equal(costs.quote(model,{resolution:'1K'}).credits,18);
  assert.equal(costs.quote(model,{resolution:'2K'}).credits,18);
  assert.equal(costs.quote(model,{resolution:'4K'}).credits,24);
  assert.equal(costs.quote(model,{resolution:'8K'}),null);
  const tariffs={fetchedAt:new Date().toISOString(),rows:[{modelDescription:'Google nano banana pro, 1/2K',creditPrice:'20',creditUnit:'per image'}]};
  assert.equal(costs.quote(model,{resolution:'1K'},tariffs).credits,20);
  assert.equal(costs.quote(model,{resolution:'1K'},tariffs).snapshot,false);
  assert.equal(costs.quote({...model,apiModel:'nano-banana-2'},{resolution:'2K'}).credits,12);
  assert.equal(costs.quote({...model,apiModel:'nano-banana-2-lite'},{}).credits,4);
});
test('estimate never becomes actual charge; historical rate and actual zero survive failure', () => {
  const record={state:'fail',rubPerCredit:0.51,estimate:{credits:18,source:'tariff'}};
  const missing=costs.breakdown(record,2);
  assert.equal(missing.estimate.rubles,9.18);
  assert.deepEqual(missing.actual,{credits:null,rubles:null,known:false});
  assert.deepEqual(costs.breakdown({...record,creditsConsumed:0},2).actual,{credits:0,rubles:0,known:true});
  assert.deepEqual(costs.breakdown({...record,creditsConsumed:'12'},2).actual,{credits:12,rubles:6.12,known:true});
});
