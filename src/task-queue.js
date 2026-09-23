const errors=require('./provider-errors');
const trace = require('./generation-log');
const costs = require('./costs');
const {randomUUID}=require('node:crypto');
const {insufficientCredits,creditErrorMessage}=require('./api-errors');
const remoteStates=['waiting','queuing','generating'];
const queueStates=new Set(['queued','preparing','submitting',...remoteStates,'unknown','blocked']);
const providerMayHaveCharged=record=>Boolean(record?.taskId||record?.providerAcceptedAt||['submitting',...remoteStates,'unknown'].includes(record?.state));
class TaskQueue {
  constructor({store,prepare,create,beforeCreate=async()=>{},onRateLimit=()=>{},poll,complete=async()=>{},notify=()=>{},interval=2000,concurrency=5}) {
    Object.assign(this,{store,prepare,create,beforeCreate,onRateLimit,poll,complete,notify,interval});
    for(const phase of ['prepare','create','poll','complete']){const action=this[phase];this[phase]=(...args)=>trace.run(args[0],()=>trace.step('task.'+phase,{state:args[0].state,input:phase==='prepare'?args[0].input:phase==='create'?args[1]:undefined},()=>action(...args)));}
    this.paused=true;this.running=false;this.polling=false;this.timer=null;this.pollTimer=null;this.error=null;this.closed=false;
    this.setConcurrency(concurrency);
  }
  setConcurrency(value) {if(!Number.isInteger(value)||value<1||value>5)throw new Error('Лимит должен быть от 1 до 5');this.concurrency=value;}
  async recover() {
    trace.write('queue.recover');
    for(const record of await this.store.list()) {
      if(record.state==='unknown'&&!record.taskId&&insufficientCredits(record.error))await this.store.update(record.id,{state:'fail',error:creditErrorMessage,failureCode:'INSUFFICIENT_CREDITS'});
      if(record.state==='preparing'||(record.state==='queued'&&record.queueHidden))await this.store.update(record.id,{state:record.queueHidden?'cancelled':'queued'});
      if(record.state==='submitting' && !record.taskId)await this.store.update(record.id,{state:'unknown',error:'Приложение закрылось во время отправки. Проверьте журнал провайдера.'});
      if(record.taskId&&remoteStates.includes(record.state)&&!record.generationStartedAt)await this.store.update(record.id,{generationStartedAt:record.createdAt||new Date().toISOString()});
    }
    const current=await this.store.list();
    // An ambiguous item is isolated: it must never stop unrelated, safely queued
    // requests. Its own state remains unknown until it is reconciled explicitly.
    this.paused=false;this.error=null;
    if(current.some(record=>record.state==='queued'&&!record.queueHidden))this.schedule(0);
    // Provider jobs are always polled after restart, independently of submission state.
    if(current.some(record=>record.taskId&&remoteStates.includes(record.state)))this.schedulePoll(0);
  }
  async enqueue(request) {
    const queuedAt=new Date().toISOString();
    const record=await this.store.update(randomUUID(),{...request,traceRequestId:trace.current()?.requestId,taskId:null,state:'queued',createdAt:queuedAt,queuedAt,error:null});
    trace.run(record,()=>trace.write('task.enqueued',{input:record.input,sourceFiles:record.sourceFiles,cost:costs.breakdown(record,record.rubPerCredit)}));this.notify();this.schedule(0);return record;
  }
  start() { trace.write('queue.start',{concurrency:this.concurrency});this.paused=false;this.error=null;this.schedule(0);this.schedulePoll();this.notify(); }
  pause() { trace.write('queue.pause');this.paused=true;this.notify(); }
  async cancel(id) {await this.store.update(id,{state:'cancelled'},['queued']);this.notify();}
  async remove(id, notify=true) {
    const record=(await this.store.list()).find(item=>item.id===id);
    if(!record||!queueStates.has(record.state))return {removed:false,providerMayHaveCharged:false};
    const charged=providerMayHaveCharged(record);
    const removed=await this.store.remove(id,charged?'success':'cancelled',[record.state]);
    if(notify)this.notify(removed?{full:true}:undefined);
    return {removed:Boolean(removed),providerMayHaveCharged:Boolean(removed)&&charged};
  }
  async clear() {
    this.pause();
    const results=[];
    for(let attempt=0;attempt<5;attempt++){
      const records=(await this.store.list()).filter(record=>queueStates.has(record.state));
      if(!records.length)break;
      for(const record of records)results.push(await this.remove(record.id,false));
    }
    this.notify({full:true});
    return {removed:results.filter(result=>result?.removed).length,providerMayHaveCharged:results.some(result=>result?.providerMayHaveCharged)};
  }
  async acknowledge(id) {await this.store.update(id,{state:'unconfirmed'},['unknown']);this.error=null;this.notify();}
  schedule(delay=this.interval) {if(this.closed||this.timer)return;this.timer=setTimeout(()=>{this.timer=null;this.tick().catch(error=>{this.error=error.message;this.notify();if(!this.closed&&!this.paused)this.schedule();});},delay);}
  schedulePoll(delay=this.interval) {if(this.closed||this.pollTimer)return;this.pollTimer=setTimeout(()=>{this.pollTimer=null;this.pollTick().catch(error=>{this.error=error.message;this.notify();if(!this.closed)this.schedulePoll();});},delay);}
  close() {trace.write('queue.close');this.closed=true;clearTimeout(this.timer);clearTimeout(this.pollTimer);this.timer=null;this.pollTimer=null;}
  async pollRecord(job) {
    let data;
    try {
      data=await this.poll(job);
    } catch(error) {
      // A provider/status failure belongs to this item. Other submissions and
      // provider polls continue; this item is retried by the polling loop.
      try {await this.store.update(job.id,{lastCheckedAt:new Date().toISOString(),statusError:error.message,errorInfo:errors.classify({code:error.errorInfo?.providerCode??error.status??error.code,message:trace.clean(error.errorInfo?.providerMessage||error.message),taskId:job.taskId,stage:'poll'})},remoteStates);} catch {/* Item already changed state or was removed. */}
      this.notify();return;
    }
    if(![...remoteStates,'success','fail'].includes(data.state)){try{await this.store.update(job.id,{statusError:'Неизвестный статус задачи'},remoteStates);}catch{}return;}
    const checkedAt=new Date().toISOString();
    const terminal=['success','fail'].includes(data.state);
    const timing=terminal?{...this.finishTiming(job,checkedAt),resultReceivedAt:checkedAt}:{};
    trace.run(job,()=>trace.write('task.status',{previous:job.state,response:data,...timing}));
    let updated;
    try {updated=await this.store.update(job.id,{...data,...timing,lastCheckedAt:checkedAt,providerFirstCheckedAt:job.providerFirstCheckedAt||checkedAt,
      ...(data.state!==job.state?{providerStateChangedAt:checkedAt}:{}),error:data.errorInfo?.message||data.failMsg||null,errorInfo:data.errorInfo||null,statusError:null},remoteStates);}
    catch{return;}
    if(terminal)trace.run(updated,()=>trace.write('task.cost',{state:data.state,cost:costs.breakdown(updated,updated.rubPerCredit)}));
    this.notify();
    if(terminal)this.schedule(0);
    if(data.state==='success')Promise.resolve().then(()=>this.complete(updated)).catch(()=>{}).finally(()=>this.notify());
  }
  async pollTick() {
    if(this.polling||this.closed)return;
    this.polling=true;
    try {
      const records=await this.store.list();
      await Promise.all(records.filter(item=>item.taskId&&remoteStates.includes(item.state)).map(job=>this.pollRecord(job)));
    } finally {
      this.polling=false;this.notify();
      if(!this.closed && (await this.store.list()).some(item=>item.taskId&&remoteStates.includes(item.state)))this.schedulePoll();
    }
  }
  async submitRecord(queued) {
    let record;
    try {record=await this.store.update(queued.id,{state:'preparing',preparingAt:new Date().toISOString()},['queued']);}
    catch {return;}
    this.notify();
    let input;
    try {input=await this.prepare(record);}
    catch(error){try{await this.store.update(record.id,{state:'blocked',error:error.message,errorInfo:error.errorInfo||errors.classify({code:error.code,message:trace.clean(error.message),stage:'prepare'})},['preparing']);}catch{}this.notify();return;}
    if(!(await this.store.list()).some(item=>item.id===record.id)){return;}
    try { await this.beforeCreate(record); }
    catch(error){try{await this.store.update(record.id,{state:'blocked',error:error.message},['preparing']);}catch{}this.notify();return;}
    if(!(await this.store.list()).some(item=>item.id===record.id)){return;}
    // Pause stops selecting new items. An item that already owns a slot keeps
    // moving forward, so its visible state never rewinds to queued.
    if(this.closed){try{await this.store.update(record.id,{state:'queued'},['preparing']);}catch{}return;}
    const generationStartedAt=new Date().toISOString();
    try{await this.store.update(record.id,{state:'submitting',generationStartedAt,submittingAt:generationStartedAt,retryAfterAt:null},['preparing']);}catch{return;}this.notify();
    let taskId;
    try {taskId=(await this.create(record,input)).taskId;if(!taskId)throw new Error('API не вернул ID задачи');}
    catch(error){
      if(error.outcome==='rejected' && Number(error.providerCode??error.status)===429){
        const retryAfterAt = new Date(Number(this.onRateLimit(record)) || Date.now()+10_000).toISOString();
        try{await this.store.update(record.id,{state:'queued',error:null,submittingAt:null,generationStartedAt:null,retryAfterAt},['submitting']);}catch{}
        this.notify();return;
      }
      const rejected=error.code==='INSUFFICIENT_CREDITS'||error.outcome==='rejected';
      const generationCompletedAt=new Date().toISOString();
      try{await this.store.update(record.id,{state:rejected?'fail':'unknown',error:error.message,errorInfo:errors.classify({code:error.errorInfo?.providerCode??error.status??error.code,message:trace.clean(error.errorInfo?.providerMessage||error.message),stage:'submit',outcome:rejected?'rejected':(error.outcome==='rejected'?'rejected':'unknown')}),...(rejected?{failureCode:error.code,...this.finishTiming({generationStartedAt},generationCompletedAt)}:{})},['submitting']);}catch{}
      this.notify();return;
    }
    try{await this.store.update(record.id,{state:'waiting',taskId,providerAcceptedAt:new Date().toISOString()},['submitting']);}catch{return;}
    this.schedulePoll();
    this.notify();
  }
  async tick() {
    if(this.running||this.closed)return;
    this.running=true;
    try {
      const records=await this.store.list();
      const active=records.filter(item=>remoteStates.includes(item.state)||['preparing','submitting'].includes(item.state)).length;
      const available=this.paused||this.closed?0:Math.max(0,this.concurrency-active);
      const now=Date.now();
      const queued=records.filter(item=>item.state==='queued'&&!item.queueHidden&&(!item.retryAfterAt||Date.parse(item.retryAfterAt)<=now)).reverse().slice(0,available);
      const results=await Promise.allSettled(queued.map(record=>this.submitRecord(record)));
      const failure=results.find(result=>result.status==='rejected');
      this.error=failure?failure.reason.message:null;
    } catch(error) {
      this.error=error.message;
    } finally {
      this.running=false;this.notify();
      if(!this.closed&&!this.paused)this.schedule();
    }
  }
  finishTiming(record,completedAt) {
    const started=Date.parse(record.generationStartedAt),completed=Date.parse(completedAt);
    return {generationCompletedAt:completedAt,...(Number.isFinite(started)&&Number.isFinite(completed)?{generationDurationMs:Math.max(0,completed-started)}:{})};
  }
}
module.exports={TaskQueue};
