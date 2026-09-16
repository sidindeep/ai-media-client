const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {download}=require('../src/downloads');
async function temp(work){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ai-download-test-'));try{await work(dir);}finally{for(const name of await fs.readdir(dir))await fs.unlink(path.join(dir,name));await fs.rmdir(dir);}}
test('download saves bytes without authentication and never overwrites a prior result',()=>temp(async dir=>{
  const mock=async(url,options)=>{assert.equal(options.headers,undefined);return new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/png'}});};
  const first=await download('https://example.com/result',dir,mock);
  const second=await download('https://example.com/result',dir,mock);
  assert.notEqual(first.path,second.path);assert.equal(first.size,3);
  assert.deepEqual([...await fs.readFile(first.path)],[1,2,3]);
  assert.equal((await fs.readdir(dir)).length,2);
}));
test('expired link and HTML error page do not create media files',()=>temp(async dir=>{
  await assert.rejects(download('https://example.com/result',dir,async()=>new Response('Expired',{status:403})),/403/);
  await assert.rejects(download('https://example.com/result',dir,async()=>new Response('<html>Error</html>',{headers:{'content-type':'text/html'}})),/поддерживаемое/);
  assert.deepEqual(await fs.readdir(dir),[]);
}));
test('broken stream removes partial data',()=>temp(async dir=>{
  const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1]));controller.error(new Error('Disconnected'));}});
  await assert.rejects(download('https://example.com/result',dir,async()=>new Response(stream,{headers:{'content-type':'video/mp4'}})),/Disconnected/);
  assert.deepEqual(await fs.readdir(dir),[]);
}));
