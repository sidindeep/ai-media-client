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
  for(const message of ['Content review failed. Please adjust the input and try again', '内容安全审查未通过，请调整输入内容后重试']) {
    const policy=errors.classify({code:'1501',message});
    assert.equal(policy.category,'content_policy');
    assert.equal(policy.message,'Провайдер отклонил содержимое запроса.');
    assert.equal(policy.automaticRetry,false);
  }
  assert.equal(errors.classify({code:1501,message:'Unspecified error'}).category,'unknown');
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

test('old moderation failures receive the corrected explanation without rewriting history',()=>{
  const record={state:'fail',errorInfo:{category:'unknown',providerCode:'1501',providerMessage:'Content review failed',message:'Провайдер не сообщил точную причину ошибки.',stage:'generation'}};
  const {publicRecord}=require('../src/services/accounts');
  assert.match(publicRecord(record).error,/Провайдер отклонил содержимое запроса/);
  assert.doesNotMatch(publicRecord(record).error,/не сообщил точную причину/);
  assert.equal(record.errorInfo.category,'unknown');
});
