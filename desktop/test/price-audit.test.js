const {test}=require('node:test');
const assert=require('node:assert/strict');
const audit=require('../src/price-audit');
const duration=require('../src/duration');
const {models}=require('../src/catalog');

test('price audit covers every Kie model and pricing values without a Cartesian explosion',()=>{
  const plan=audit.plan(models,duration),covered=new Set(plan.map(row=>row.modelId));
  assert.equal(covered.size,models.filter(model=>model.providerId==='kie').length);
  assert.ok(plan.length>models.length);
  assert.ok(plan.length<2000);
  assert.equal(new Set(plan.map(row=>row.key)).size,plan.length);
});

test('price audit distinguishes account confirmation, tariff matches and missing prices',()=>{
  assert.equal(audit.compare({credits:42},{credits:42}),'match');
  assert.equal(audit.compare({credits:42},{credits:41}),'mismatch');
  assert.equal(audit.compare({credits:42},null),'confirmed');
  assert.equal(audit.compare(null,{credits:42}),'tariff-only');
  assert.equal(audit.compare(null,null),'unavailable');
});
