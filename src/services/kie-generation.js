const trace = require('../generation-log');
const { providers } = require('../catalog');
const { buildRequest, normalizeTask } = require('../adapters');
const { request } = require('../network');
const provider = providers.find(item => item.id === 'kie');

// Application adapter: native Kie transport stays separate from application records.
async function createKieGeneration({ apiKey, fetchImpl = fetch }) {
  const { createKieClient } = await import('../providers/kie/client.mjs');
  trace.secret(apiKey);
  async function clientCall(method, argument) {
    let failure;
    const client=createKieClient({apiKey,fetchImpl:async(url,options)=>{
      const response=await trace.tracedFetch(url,options,fetchImpl);
      try {const body=await response.clone().json();if(!response.ok||body.success===false||(body.code!==undefined&&body.code!==200))failure=require('../api-errors').responseError(response.status,body);}catch{}
      return response;
    }});
    try{return await client[method](argument);}catch(error){if(failure){failure.outcome=error.outcome;throw failure;}throw error;}
  }
  function configured() {
    if (!apiKey) throw new Error('Генерация ещё не подключена на сервере');
  }
  async function native(path, options = {}) {
    configured();
    const response = await request(`${provider.baseUrl}${path}`, {
      ...options, redirect: 'error', headers: { Authorization: `Bearer ${apiKey}`, ...options.headers }
    }, { fetcher: fetchImpl, safeToRetry: false, operation: 'Запрос к Kie' });
    let body;
    try { body = await response.json(); } catch { throw new Error('Kie вернул некорректный ответ'); }
    if (!response.ok || (body.code && body.code !== 200)) {
      const error = require('../api-errors').responseError(response.status,body);
      if (response.status === 402 || body.code === 402) { error.code = 'INSUFFICIENT_CREDITS'; error.message = 'Недостаточно кредитов Kie'; }
      throw error;
    }
    return body.data;
  }
  return {
    id: 'kie', isConfigured: () => Boolean(apiKey),
    async upload(file) {
      configured();
      const { randomUUID } = require('node:crypto');
      const extension = require('node:path').extname(file.name || '');
      const data = await clientCall('uploadFile',{
        file: new Blob([file.bytes], { type: file.type }), uploadPath: 'ai-media-client',
        fileName: randomUUID() + (/^\.[a-z0-9]{1,10}$/i.test(extension) ? extension : '')
      });
      return data.downloadUrl || data.fileUrl;
    },
    async create(model, input) {
      configured();
      const body = buildRequest(model, input);
      if (!model.adapter) return clientCall('createTask',body);
      // Existing desktop special-protocol mapping is reused without changing its contract.
      return native(model.createPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    },
    async poll(model, taskId) {
      configured();
      const data = model.adapter
        ? await native(`${model.taskPath}?taskId=${encodeURIComponent(taskId)}`)
        : await clientCall('getTask',{ taskId });
      const result = normalizeTask(model, data);
      return result;
    },
    balance: () => native(provider.balancePath)
  };
}
module.exports = { createKieGeneration };
