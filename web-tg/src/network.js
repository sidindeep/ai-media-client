const trace = require('./generation-log');
// Retry only operations that cannot create a paid generation job.
function networkMessage(error,operation){
  const code=String(error.cause?.code||error.code||'');
  const timeout=error.name==='TimeoutError'||/TIMEOUT|TIMEDOUT/.test(code);
  return `${operation}: ${timeout?'сервер не ответил вовремя':'не удалось соединиться с сервером'}. Проверьте подключение к интернету и доступ к Kie, затем повторите действие.`;
}
async function request(url,options={}, {operation='Запрос к Kie',safeToRetry=false,timeout=60000,fetcher=fetch,delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  const attempts=safeToRetry?3:1;
  for(let attempt=0;attempt<attempts;attempt++){
    try{
      return await trace.tracedFetch(url,{...options,signal:options.signal||AbortSignal.timeout(timeout)},fetcher);
    }catch(error){
      if(options.signal?.aborted)throw error;
      if(attempt+1<attempts){trace.write('http.retry',{operation,attempt:attempt+1,delayMs:1000*(attempt+1)});await delay(1000*(attempt+1));continue;}
      const failure=new Error(networkMessage(error,operation));
      failure.code='NETWORK_ERROR';
      throw failure;
    }
  }
}
module.exports={request};
