const {test}=require('node:test');
const assert=require('node:assert/strict');
const {TaskQueue}=require('../src/task-queue');
const {responseError}=require('../src/api-errors');
test('clearing cancels queued work, keeps remote results and persists hidden history',async()=>{
  const {q,store,created}=setup();const a=await q.enqueue({});const b=await q.enqueue({});q.start();await q.tick();
  await store.update('uncertain',{state:'unknown'});await q.clear();
  assert.equal((await store.list()).find(r=>r.id===b.id).state,'cancelled');
  assert.equal((await store.list()).find(r=>r.id==='uncertain').state,'unconfirmed');
  assert.ok((await store.list()).every(r=>r.queueHidden));
  await q.tick();assert.equal((await store.list()).find(r=>r.id===a.id).state,'success');assert.equal(created.length,1);q.close();
});
test('removing during preparation prevents the provider request',async()=>{
  let release,begin;const gate=new Promise(r=>release=r);const started=new Promise(r=>begin=r);
  const {q,store,created}=setup({prepare:async()=>{begin();await gate;return {};}});
  const task=await q.enqueue({});q.start();const tick=q.tick();await started;await q.remove(task.id);release();await tick;
  assert.equal(created.length,0);assert.equal((await store.list())[0].state,'cancelled');q.close();
});
test('insufficient credits fail the task, retain following jobs and allow manual continuation',async()=>{
  let insufficient=true;
  const {q,store}=setup({create:async()=>{if(insufficient)throw responseError(200,{code:402,msg:'Credits insufficient'});return {taskId:'accepted'};}});
  const a=await q.enqueue({});const b=await q.enqueue({});q.start();await q.tick();
  assert.equal((await store.list()).find(r=>r.id===a.id).state,'fail');
  assert.equal((await store.list()).find(r=>r.id===b.id).state,'queued');assert.equal(q.paused,true);
  insufficient=false;q.start();await q.tick();assert.equal((await store.list()).find(r=>r.id===b.id).state,'waiting');q.close();
});
test('recover repairs old credit rejections but preserves ambiguous and accepted tasks',async()=>{
  const {q,store}=setup();
  await store.update('credit',{state:'unknown',error:'Credits insufficient : Your current balance isn’t enough to run this request.'});
  await store.update('network',{state:'unknown',error:'Connection lost'});
  await store.update('accepted',{state:'unknown',taskId:'remote',error:'Credits insufficient'});
  await q.recover();const rows=await store.list();
  assert.equal(rows.find(r=>r.id==='credit').state,'fail');
  assert.equal(rows.find(r=>r.id==='network').state,'unknown');assert.equal(rows.find(r=>r.id==='accepted').state,'unknown');q.close();
  assert.equal(responseError(500,{msg:'Internal error'}).code,undefined);
  assert.equal(responseError(400,{msg:'Credits insufficient : top up'}).code,'INSUFFICIENT_CREDITS');
});
test('restart automatically resumes polling submitted tasks without starting queued work',async()=>{
  const {q,store}=setup();let scheduled=null;q.schedule=delay=>{scheduled=delay;};
  await store.update('remote',{state:'generating',taskId:'provider-task',createdAt:'2026-09-09T19:43:14.000Z'});
  await store.update('local',{state:'queued',createdAt:'2026-09-09T19:44:00.000Z'});
  await q.recover();const rows=await store.list();
  assert.equal(scheduled,0);assert.equal(q.paused,true);
  assert.equal(rows.find(r=>r.id==='remote').generationStartedAt,'2026-09-09T19:43:14.000Z');
  assert.equal(rows.find(r=>r.id==='local').state,'queued');q.close();
});
test('two models run together, freeing one slot starts the next FIFO job',async()=>{
  const done=new Set();const polled=[];
  const {q,store,created}=setup({concurrency:2,poll:async r=>{polled.push(r.id);return {state:done.has(r.id)?'success':'generating',progress:30};}});
  const a=await q.enqueue({model:'grok'}),b=await q.enqueue({model:'veo'}),c=await q.enqueue({model:'third'});
  q.start();await q.tick();assert.deepEqual(created,[a.id,b.id]);
  await q.tick();assert.deepEqual(polled,[b.id,a.id]);assert.equal(created.length,2);
  done.add(b.id);await q.tick();assert.deepEqual(created,[a.id,b.id,c.id]);
  assert.equal((await store.list()).find(r=>r.id===a.id).state,'generating');q.close();
});
test('lowering the limit never cancels live jobs; pause and unknown jobs still allow polling all jobs',async()=>{
  const polled=[];const {q,store,created}=setup({concurrency:3,poll:async r=>{polled.push(r.id);if(r.model==='bad')throw new Error('Offline');return{state:'generating'};}});
  await q.enqueue({model:'bad'});await q.enqueue({model:'good'});await q.enqueue({model:'good'});await q.enqueue({model:'waiting'});
  q.start();await q.tick();assert.equal(created.length,3);q.setConcurrency(1);q.pause();
  await store.update('unknown',{state:'unknown'});await q.tick();assert.equal(polled.length,3);assert.equal(created.length,3);
  await q.tick();assert.equal(polled.length,6);assert.equal(created.length,3);
  assert.throws(()=>q.setConcurrency(0));assert.throws(()=>q.setConcurrency(6));q.close();
});
test('concurrent ticks do not duplicate submission and downloads do not hold a generation slot',async()=>{
  let release;const gate=new Promise(r=>release=r);
  const {q,created}=setup({concurrency:2,complete:()=>gate});
  await q.enqueue({});await q.enqueue({});await q.enqueue({});q.start();await Promise.all([q.tick(),q.tick()]);assert.equal(created.length,2);
  await q.tick();assert.equal(created.length,3);release();q.close();
});
class Store {
  constructor(){this.rows=[];}
  async list(){return structuredClone(this.rows);}
  async update(id,changes,expected){const i=this.rows.findIndex(r=>r.id===id);if(expected&&!expected.includes(this.rows[i]?.state))throw new Error('Changed');const row={...(this.rows[i]||{id}),...structuredClone(changes)};if(i<0)this.rows.unshift(row);else this.rows[i]=row;return structuredClone(row);}
}
function setup(overrides={}){
  const store=new Store();const created=[];
  const q=new TaskQueue({store,concurrency:1,prepare:async r=>r.input,create:async r=>{created.push(r.id);return{taskId:'remote-'+r.id};},poll:async()=>({state:'success'}),...overrides});
  q.schedule=()=>{};return {q,store,created};
}
test('queue is FIFO and checks current remote job before starting next',async()=>{
  const {q,created,store}=setup();const a=await q.enqueue({input:{prompt:'A'}});const b=await q.enqueue({input:{prompt:'B'}});
  await q.tick();assert.deepEqual(created,[]);q.start();await q.tick();assert.deepEqual(created,[a.id]);
  await q.tick();assert.equal((await store.list()).find(r=>r.id===a.id).state,'success');assert.equal(created.length,2);
  await q.tick();assert.deepEqual(created,[a.id,b.id]);q.close();
});
test('records API generation time from submission through terminal provider status',async()=>{
  const {q,store}=setup();const task=await q.enqueue({});q.start();await q.tick();
  const running=(await store.list()).find(r=>r.id===task.id);
  assert.match(running.generationStartedAt,/T/);assert.equal(running.generationCompletedAt,undefined);
  await new Promise(resolve=>setTimeout(resolve,5));await q.tick();
  const completed=(await store.list()).find(r=>r.id===task.id);
  assert.equal(completed.state,'success');assert.match(completed.generationCompletedAt,/T/);
  assert.ok(Number.isFinite(completed.generationDurationMs));assert.ok(completed.generationDurationMs>=0);q.close();
});
test('pause allows polling current task but prevents following submissions; queued cancellation',async()=>{
  const {q,created,store}=setup();const a=await q.enqueue({});const b=await q.enqueue({});q.start();await q.tick();q.pause();await q.tick();await q.tick();assert.deepEqual(created,[a.id]);await q.cancel(b.id);assert.equal((await store.list()).find(r=>r.id===b.id).state,'cancelled');q.close();
});
test('ambiguous submission never automatically resubmits and pauses the queue',async()=>{
  let calls=0;const {q,store}=setup({create:async()=>{calls++;throw new Error('Connection lost');}});
  const a=await q.enqueue({});await q.enqueue({});q.start();await q.tick();q.start();await q.tick();assert.equal(calls,1);assert.equal((await store.list()).find(r=>r.id===a.id).state,'unknown');assert.equal(q.paused,true);q.close();
});
test('restart recovers preparation but never repeats an uncertain POST',async()=>{
  const {q,store}=setup();await store.update('one',{state:'preparing'});await store.update('two',{state:'submitting'});await q.recover();assert.equal((await store.list()).find(r=>r.id==='one').state,'queued');assert.equal((await store.list()).find(r=>r.id==='two').state,'unknown');q.close();
});
test('restart with a remote task only polls; network failures retain the task ID',async()=>{
  const {q,store,created}=setup({poll:async()=>{throw new Error('Offline');}});await store.update('a',{state:'waiting',taskId:'remote'});q.start();await q.tick();assert.equal(created.length,0);assert.equal(q.paused,true);assert.equal((await store.list())[0].taskId,'remote');assert.equal((await store.list())[0].state,'waiting');q.close();
});
test('pause during source preparation prevents submission',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve);let began;const started=new Promise(resolve=>began=resolve);
  const {q,created,store}=setup({prepare:async()=>{began();await gate;return{};}});await q.enqueue({});q.start();const tick=q.tick();await started;q.pause();release();await tick;assert.equal(created.length,0);assert.equal((await store.list())[0].state,'queued');q.close();
});
