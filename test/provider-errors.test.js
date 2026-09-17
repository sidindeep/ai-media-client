const test=require('node:test');
const assert=require('node:assert/strict');
const errors=require('../src/provider-errors');
const {normalizeTask}=require('../src/adapters');
test('provider errors distinguish timeout, explicit policy, validation and ambiguous submission',()=>{
  const timeout=errors.classify({code:'524',message:'generate task timeout.',taskId:'remote-1'});
  assert.equal(timeout.category,'timeout');assert.equal(timeout.retryable,true);assert.equal(timeout.automaticRetry,false);
  assert.equal(timeout.providerMessage,'generate task timeout.');assert.equal(timeout.taskId,'remote-1');
  assert.equal(errors.classify({code:400,message:'Bad request'}).category,'request_rejected');
  assert.equal(errors.classify({code:400,message:'Content violates policy'}).category,'content_policy');
  assert.equal(errors.classify({code:422,message:'Invalid parameter: resolution'}).category,'validation');
  assert.equal(errors.classify({code:429}).category,'rate_limit');
  assert.equal(errors.classify({code:500}).category,'provider_failure');
  assert.equal(errors.classify({code:524,outcome:'unknown'}).category,'submission_unknown');
  assert.equal(errors.classify({code:524,outcome:'unknown'}).retryable,false);
  assert.equal(errors.classify({code:987,message:'Unexpected'}).category,'unknown');
});
test('Market and special adapters preserve original diagnostics and redact sensitive details',()=>{
  const data={taskId:'remote',state:'fail',failCode:'524',failMsg:'generate task timeout.'};
  for(const model of [{kind:'image'},{kind:'video',adapter:'runway'}]){
    const result=normalizeTask(model,data);assert.equal(result.errorInfo.providerCode,'524');assert.equal(result.errorInfo.providerMessage,data.failMsg);
  }
  const message=errors.classify({message:'token=secretvalue https://example.test/private?key=hidden Bearer abcdef'}).providerMessage;
  for(const value of ['secretvalue','example.test','hidden','abcdef'])assert.ok(!message.includes(value));
  assert.match(errors.text({state:'fail',...data,error:data.failMsg}),/524/);
});
