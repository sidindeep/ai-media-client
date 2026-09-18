// Real Codex ramp with the worker's hour-long result cache, no web billing.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const args = process.argv.slice(2);
const options = {};
for (const arg of args) {
  if (arg === '--live' || arg === '--docker') options[arg.slice(2)] = true;
  else { const m = /^--(kind|transport|max-concurrency|start-concurrency|model|pool-size)=(.+)$/.exec(arg); if (!m) throw Error('Unsupported argument'); options[m[1]] = m[2]; }
}
if (!options.live) throw Error('Real generations require --live and an allocated account budget');
const kind = options.kind || 'image', transport = options.transport || 'app-server';
const max = Number(options['max-concurrency'] || 64);
const first = Number(options['start-concurrency'] || 1);
const steps = [1,2,4,8,16,32,64,128,256];
if (!['text','image'].includes(kind) || !['exec','app-server'].includes(transport) || !steps.includes(max) || !steps.includes(first) || first > max) throw Error('Invalid kind, transport or concurrency');
if (options['pool-size'] !== undefined) {
  const size = Number(options['pool-size']);
  if (!Number.isSafeInteger(size) || size < 1 || size > 32) throw Error('Invalid pool size');
}
if (options.docker) {
  const { spawn } = require('node:child_process');
  const root = path.resolve(__dirname, '..');
  const dir = path.join(root, 'artifacts/load-tests', 'capacity-' + kind + '-' + new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const output = fs.createWriteStream(path.join(dir, 'events.jsonl'), { encoding: 'utf8' });
  const child = spawn('docker', ['compose','exec','-T','codex','node','-',...args.filter(x=>x!=='--docker')], { cwd: root, windowsHide: true, stdio:['pipe','pipe','inherit'] });
  child.stdin.end(fs.readFileSync(__filename));
  child.stdout.on('data', chunk => { process.stdout.write(chunk); output.write(chunk); });
  child.on('error', () => { output.end(); process.exitCode=1; });
  child.on('close', code => { output.end(); console.log('Evidence: '+dir); process.exitCode=code || 0; });
} else {
  const root = process.cwd();
  const { createCodexWorker } = require(path.join(root,'src/services/codex-worker'));
  const { validateCodexRequest } = require(path.join(root,'src/services/codex-request'));
  const { validatePng } = require(path.join(root,'src/services/codex-images'));
  const catalog = require(path.join(root,'config/codex-models.json'));
  const model = options.model || catalog.uiDefaults.model;
  if (!catalog.models.some(item => item.id === model && item.efforts.includes(catalog.uiDefaults.effort))) throw Error('Invalid model or effort');
  if (options['pool-size']) process.env.MEDIA_CODEX_POOL_SIZE = options['pool-size'];
  const emit = value => console.log(JSON.stringify({ at:new Date().toISOString(),...value }));
  const sleep = ms => new Promise(r=>setTimeout(r,ms));
  const pct = (list,p) => list.length ? list.slice().sort((a,b)=>a-b)[Math.ceil(list.length*p)-1] : null;
  let stopReason = '', sent=0, success=0, cachedBytes=0, previous, peakMemory=0;
  const maximumRequests = 2*max-first;
  function resources() {
    const read = p=>fs.readFileSync('/sys/fs/cgroup/'+p,'utf8').trim();
    const configured=read('memory.max');
    const memoryLimit=configured==='max'?os.totalmem():Number(configured);
    return { memoryBytes:Number(read('memory.current')),memoryLimit,
      cpuUsec:Number(read('cpu.stat').match(/usage_usec (\d+)/)[1]),pids:Number(read('pids.current')) };
  }
  const server=createCodexWorker(undefined,{transport});
  const account=randomUUID(),headers={'Content-Type':'application/json','X-Account-Id':account};
  let interval;
  (async()=>{
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const base='http://127.0.0.1:'+server.address().port;
    const started=performance.now();
    emit({event:'manifest',kind,transport,pool:(await fetch(base+'/health').then(r=>r.json())).pool,startConcurrency:first,maxConcurrency:max,maximumRequests,model,
      effort:catalog.uiDefaults.effort,speed:catalog.uiDefaults.speed,cli:catalog.version,resources:resources(),
      scope:'local worker ramp with result cache; no web/DB/credits; one wave per stage',
      stopRules:{memoryFraction:0.8,wallSeconds:900,errors:1,throughputGain:0.1}});
    interval=setInterval(()=>{
      try {
        const r=resources();peakMemory=Math.max(peakMemory,r.memoryBytes);
        emit({event:'resources',...r,sent,success,cachedBase64Bytes:cachedBytes});
        if(r.memoryBytes>r.memoryLimit*0.8)stopReason='memory >=80%';
        if(performance.now()-started>900000)stopReason='900 second launch budget';
      } catch {stopReason='resource monitoring lost';}
    },2000);
    const probe=validateCodexRequest({requestId:randomUUID(),kind,model,effort:catalog.uiDefaults.effort,
      speed:catalog.uiDefaults.speed,prompt:kind==='image'?'One simple watercolor illustration of a small red apple on a plain white background. No text.':'Write exactly three short English sentences describing a quiet garden. No headings.'});
    for(let concurrency=first;concurrency<=max&&!stopReason;concurrency*=2){
      const begin=performance.now(),before=resources();
      emit({event:'stageStarted',concurrency,sent});
      const poolSample = setTimeout(() => {
        void fetch(base+'/health').then(r=>r.json()).then(health=>emit({event:'pool',concurrency,...health})).catch(()=>{});
      }, 5000);
      const results=await Promise.all(Array.from({length:concurrency},async()=>{
        if(stopReason||sent>=maximumRequests)return {skipped:true};
        sent++;const request={...probe,requestId:randomUUID()},began=performance.now();
        let state='unknown';
        try{
          const accepted=await fetch(base+'/jobs',{method:'POST',headers,body:JSON.stringify(request),signal:AbortSignal.timeout(15000)});
          if(!accepted.ok)throw Error('Worker refused request: '+accepted.status);
          const deadline=began+(kind==='image'?340000:220000);
          while(performance.now()<deadline){
            const response=await fetch(base+'/jobs/'+request.requestId,{headers,signal:AbortSignal.timeout(15000)});
            if(!response.ok)throw Error('Status unavailable: '+response.status);
            const job=await response.json();state=job.state;
            if(state==='success'){
              const imageBytes=kind==='image'?validatePng(Buffer.from(job.imageBase64||'','base64')).length:0;
              if(kind==='text'&&!job.output?.trim())throw Error('Empty output');
              success++;cachedBytes+=job.imageBase64?.length||0;
              const result={ok:true,requestId:request.requestId,seconds:(performance.now()-began)/1000,imageBytes,usage:job.usage};
              emit({event:'result',concurrency,...result});return result;
            }
            if(state==='failed'||state==='unknown')throw Error(job.error||state);
            await sleep(1500);
          }
          throw Error('Completion deadline');
        }catch(error){
          stopReason=stopReason||'generation error';
          const result={ok:false,requestId:request.requestId,state,error:error.message,seconds:(performance.now()-began)/1000};
          emit({event:'result',concurrency,...result});return result;
        }
      }));
      clearTimeout(poolSample);
      const elapsed=(performance.now()-begin)/1000,after=resources();
      const done=results.filter(x=>x.ok),times=done.map(x=>x.seconds);
      const summary={event:'stage',concurrency,submitted:results.filter(x=>!x.skipped).length,success:done.length,
        errors:results.filter(x=>x.ok===false).length,seconds:elapsed,successfulRps:done.length/elapsed,
        meanSeconds:times.length?times.reduce((a,b)=>a+b,0)/times.length:null,medianSeconds:pct(times,.5),p95Seconds:pct(times,.95),
        cpuSeconds:(after.cpuUsec-before.cpuUsec)/1e6,before,after,peakMemory,cachedBase64Bytes:cachedBytes};
      emit(summary);
      if(previous&&summary.successfulRps<previous.successfulRps*1.1&&summary.meanSeconds>previous.meanSeconds)stopReason=stopReason||'throughput plateau with growing latency';
      if(previous&&summary.meanSeconds>previous.meanSeconds*2)stopReason=stopReason||'latency doubled';
      previous=summary;
      if(!stopReason)await sleep(2000);
    }
    clearInterval(interval);
    emit({event:'end',sent,success,stopReason:stopReason||'configured ceiling reached; saturation not established',resources:resources(),cachedBase64Bytes:cachedBytes});
  })().catch(error=>{emit({event:'fatal',error:error.message});process.exitCode=1;}).finally(()=>{
    clearInterval(interval);server.stopActive();server.closeAllConnections();server.close();
  });
}
