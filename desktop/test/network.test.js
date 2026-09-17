const {test}=require('node:test');
const assert=require('node:assert/strict');
const {request}=require('../src/network');
test('source upload recovers from a transient connection failure without changing its body',async()=>{
  let calls=0;const body=new FormData();body.append('file',new Blob(['image']),'image.png');
  const response=await request('https://upload.example/',{method:'POST',body},{safeToRetry:true,delay:async()=>{},fetcher:async(_url,options)=>{
    assert.equal(options.body,body);calls++;if(calls<3)throw new TypeError('fetch failed');return new Response('ok');
  }});
  assert.equal(calls,3);assert.equal(await response.text(),'ok');
});
test('paid POST is never retried and does not expose raw secrets or URLs',async()=>{
  let calls=0;
  await assert.rejects(request('https://example.com/?secret=private',{method:'POST'},{delay:async()=>{},fetcher:async()=>{calls++;throw new Error('private');}}),error=>error.code==='NETWORK_ERROR'&&!error.message.includes('private'));
  assert.equal(calls,1);
});
test('exhausted timeouts report the operation and readable advice',async()=>{
  await assert.rejects(request('https://example.com/',{},{operation:'Загрузка исходного файла в Kie',safeToRetry:true,delay:async()=>{},fetcher:async()=>{throw Object.assign(new TypeError('fetch failed'),{cause:{code:'UND_ERR_CONNECT_TIMEOUT'}});}}),/Загрузка исходного файла.*сервер не ответил вовремя/);
});
test('HTTP errors are returned to provider classification without repeating them',async()=>{
  let calls=0;const result=await request('https://example.com/',{},{safeToRetry:true,fetcher:async()=>{calls++;return new Response('',{status:402});}});
  assert.equal(result.status,402);assert.equal(calls,1);
});
