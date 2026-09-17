const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const trace = require('../src/generation-log');
const { History } = require('../src/history');
const { TaskQueue } = require('../src/task-queue');

test('generation journal correlates lifecycle, raw provider timeout and retries without leaking credentials', async t => {
  const base = path.resolve(__dirname, '../artifacts'); await fs.mkdir(base, {recursive:true});
  const directory = await fs.mkdtemp(path.join(base, 'trace-test-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  trace.configure(path.join(directory,'logs'));
  const store = new History(path.join(directory,'history.json'));
  const queue = new TaskQueue({store,interval:100000,prepare:async row=>row.input,
    create:async()=>({taskId:'remote-timeout'}),
    poll:async()=>{
      const response = await trace.tracedFetch('https://api.example.test/status?token=signed-secret',
        {headers:{Authorization:'Bearer key-secret-test'}},async()=>new Response(JSON.stringify({data:{state:'fail',failCode:'524',failMsg:'generate task timeout.',token:'body-secret'}}),{headers:{'content-type':'application/json'}}));
      return (await response.json()).data;
    }});
  t.after(()=>queue.close());
  const job = await trace.request(()=>queue.enqueue({model:'nano-banana-pro',input:{prompt:'Проверка',image_input:[]}}));
  queue.start(); await queue.tick(); await queue.tick(); queue.close();
  let attempts=0;
  await require('../src/network').request('https://api.example.test/read',{}, {safeToRetry:true,delay:async()=>{},fetcher:async()=>{if(++attempts===1)throw new Error('temporary');return new Response('{}',{headers:{'content-type':'application/json'}});}});
  assert.equal(attempts,2);
  const raw = await fs.readFile(path.join(directory,'logs/generation.jsonl'),'utf8');
  for(const value of ['key-secret-test','signed-secret','body-secret'])assert.ok(!raw.includes(value));
  const rows = raw.trim().split('\n').map(JSON.parse);
  for(const event of ['session.start','task.enqueued','task.prepare.start','task.prepare.success','task.create.success','task.poll.start','http.request','http.response','http.body','http.retry','task.status'])assert.ok(rows.some(row=>row.event===event),event);
  const taskRows = rows.filter(row=>row.jobId===job.id);
  assert.ok(taskRows.length>6);assert.ok(taskRows.every(row=>row.requestId===job.traceRequestId));
  const body=rows.find(row=>row.event==='http.body');assert.equal(body.taskId,'remote-timeout');
  assert.equal(body.details.body.data.failCode,'524');
  assert.equal(body.details.body.data.failMsg,'generate task timeout.');
  assert.equal((await store.list())[0].state,'fail');
  assert.equal(rows.filter(row=>row.event==='task.create.start').length,1);
  // A saturated journal rotates, and an unavailable log directory cannot fail a task.
  await fs.writeFile(path.join(directory,'logs/generation.jsonl'),'x'.repeat(5*1024*1024));
  trace.write('rotation.check');assert.ok(await fs.stat(path.join(directory,'logs/generation.jsonl.1')));
  trace.configure(path.join(directory,'history.json','not-a-directory'));
  assert.equal(await trace.step('unwritable',{},async()=>42),42);
});
