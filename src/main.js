const { app, BrowserWindow, ipcMain, safeStorage, dialog, shell, Notification, Tray, Menu, session } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const appUserModelId='local.aimedia.client';
const toastActivatorClsid='{3F045F2E-4895-4B8E-A9BD-C6AB9F9A91A7}';
if(process.platform==='win32'){
  app.setAppUserModelId(appUserModelId);
  app.setToastActivatorCLSID(toastActivatorClsid);
}
const {pathToFileURL}=require('node:url');
const { providers, models } = require("./catalog");
const { History } = require('./history');
const {buildRequest,normalizeTask} = require('./adapters');
const {Assets}=require('./assets');
const {TaskQueue}=require('./task-queue');
const {request}=require('./network');
let assets, taskQueue, tray, mainWindow, persistentNotificationsReady=false, lastOutputDirectory='';
const activeNotifications=new Set();
let history;
let preferences;
const costs=require('./costs');
let tariffs;
async function costSettings(){return (await preferences.list()).find(row=>row.id==='cost-settings')||{rubPerCredit:0.51};}
async function balanceWithAudit(provider,reset=false){
  const balance=costs.amount((await api(provider,provider.balancePath)).data);
  if(balance===null)throw new Error('API вернул некорректный баланс');
  const spend=costs.providerSnapshot(await history.list(),provider.id);
  const id=`balance-audit:${provider.id}`;
  const saved=(await preferences.list()).find(row=>row.id===id);
  const current={balance,apiCredits:spend.credits,known:spend.known,unknown:spend.unknown,at:new Date().toISOString()};
  const baseline=!reset&&saved?.baseline&&costs.reconcile(saved.baseline,current)?saved.baseline:current;
  await preferences.update(id,{baseline,current});
  return {balance,audit:{baseline,current,reconciliation:costs.reconcile(baseline,current)}};
}
let drafts;
const {download} = require('./downloads');
const saving = new Map();
async function storageSettings() { return (await preferences.list()).find(item=>item.id==='storage') || {directory:'',autoSave:false}; }
async function rememberOutputDirectory(directory) {
  const settings=await storageSettings();
  lastOutputDirectory=path.resolve(directory);
  await preferences.update('storage',{directory:lastOutputDirectory,autoSave:Boolean(settings.autoSave)});
  return storageSettings();
}
function rememberBrowserDownloadDirectory(browserSession) {
  browserSession.on('will-download',(_event,item)=>{
    const directory=lastOutputDirectory||app.getPath('downloads');
    item.setSaveDialogOptions({...item.getSaveDialogOptions(),defaultPath:path.join(directory,item.getFilename())});
    item.once('done',(_doneEvent,state)=>{
      if(state!=='completed')return;
      const savedPath=item.getSavePath();
      if(savedPath)void rememberOutputDirectory(path.dirname(savedPath)).catch(()=>{});
    });
  });
}
async function chooseOutputFolder() {
  const settings=await storageSettings();
  const options={title:'Папка для результатов генерации',defaultPath:settings.directory||app.getPath('downloads'),properties:['openDirectory','createDirectory']};
  const parent=BrowserWindow.getFocusedWindow()||BrowserWindow.getAllWindows()[0];
  const result=parent?await dialog.showOpenDialog(parent,options):await dialog.showOpenDialog(options);
  if(!result.canceled&&result.filePaths[0])await rememberOutputDirectory(result.filePaths[0]);
  return storageSettings();
}
async function saveResults(id) {
  if(saving.has(id)) return saving.get(id);
  const operation=(async()=>{
    const record=(await history.list()).find(item=>item.id===id);
    if(!record || record.state!=='success') throw new Error('Результат ещё не готов');
    let {directory}=await storageSettings();
    if(!directory)({directory}=await chooseOutputFolder());
    if(!directory) throw new Error('Скачивание отменено: папка не выбрана');
    await rememberOutputDirectory(directory);
    const result=typeof record.resultJson==='string'?JSON.parse(record.resultJson):record.resultJson;
    const urls=result?.resultUrls;
    if(!Array.isArray(urls)||!urls.length) throw new Error('API не вернул ссылки на файлы');
    const localFiles=[...(record.localFiles||[])];
    try {
      for(const url of urls) {
        const existing=localFiles.find(file=>file.url===url);
        if(existing && await fs.stat(existing.path).then(s=>s.isFile()).catch(()=>false)) continue;
        const file=await download(url,directory);
        if(existing) localFiles.splice(localFiles.indexOf(existing),1);
        localFiles.push(file);
        await history.update(id,{localFiles,downloadError:null});
      }
      return localFiles;
    } catch(error) { await history.update(id,{localFiles,downloadError:error.message}); throw error; }
  })();
  saving.set(id,operation);
  try { return await operation; } finally {saving.delete(id);}
}
const Ajv = require('ajv');
const ajv = new Ajv({ strict:false, validateFormats:false });

const keyFile = () => path.join(app.getPath("userData"), "credentials.json");

async function readKeys() {
  try { return JSON.parse(await fs.readFile(keyFile(), "utf8")); } catch { return {}; }
}

async function getKey(providerId) {
  const keys = await readKeys();
  if (!keys[providerId]) throw new Error("Сначала сохраните API-ключ провайдера");
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Шифрование Windows недоступно");
  return safeStorage.decryptString(Buffer.from(keys[providerId], "base64"));
}

async function api(provider, apiPath, options = {}) {
  const key = await getKey(provider.id);
  const response = await request(`${provider.baseUrl}${apiPath}`, {
    ...options,
    headers: { Authorization: `Bearer ${key}`, ...(options.headers || {}) }
  },{operation:options.method==='POST'?'Отправка задачи (результат неизвестен; проверьте журнал Kie)':'Получение данных Kie',safeToRetry:!options.method||options.method==='GET'});
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { msg: text || response.statusText }; }
  if (!response.ok || (body.code && body.code !== 200)) {
    throw require('./api-errors').responseError(response.status,body);
  }
  return body;
}

function providerById(id) {
  const provider = providers.find((item) => item.id === id);
  if (!provider) throw new Error("Неизвестный провайдер");
  return provider;
}

function createWindow() {
  const win = new BrowserWindow({
    icon: path.join(__dirname,'assets','icon.ico'),
    width: 1240,
    height: 820,
    minWidth: 960,
    minHeight: 650,
    backgroundColor: "#0b0c10",
    title: "AI Media Client",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow=win;
  win.loadFile(path.join(__dirname, "index.html"));
  // A hidden pricing browser must not keep the application alive after drafts close.
  win.on('closed',()=>{if(mainWindow===win)mainWindow=null;for(const other of BrowserWindow.getAllWindows())other.destroy();});
  return win;
}

async function uploadSource(providerId,file) {
  const provider=providerById(providerId);const key=await getKey(provider.id);
  const form=new FormData();
  form.append('file',new Blob([Buffer.from(file.bytes)],{type:file.type}),file.name);
  form.append('uploadPath','ai-media-client');
  const response=await request(provider.uploadUrl,{method:'POST',headers:{Authorization:`Bearer ${key}`},body:form},{operation:'Загрузка исходного файла в Kie',safeToRetry:true,timeout:180000});
  const body=await response.json();
  if(!response.ok||body.success===false||(body.code&&body.code!==200))throw new Error(body.msg||'Не удалось загрузить файл');
  const url=body.data?.downloadUrl||body.data?.fileUrl;
  if(typeof url!=='string'||!url.startsWith('https://'))throw new Error('API не вернул ссылку на исходный файл');
  return url;
}
function getModel(record) {
  const model=models.find(m=>m.providerId===record.providerId&&m.apiModel===record.model);
  if(!model)throw new Error('Модель не найдена');return model;
}
function validateInput(model,input) {
  require('./duration').validate(model,input);
  if(model.inputSchema&&!ajv.validate(model.inputSchema,input))throw new Error('Проверьте параметры: '+ajv.errorsText());
  return buildRequest(model,input);
}
async function checkTask(record) {
  const provider=providerById(record.providerId);const model=getModel(record);
  const raw=(await api(provider,`${model.taskPath||provider.taskPath}?taskId=${encodeURIComponent(record.taskId)}`)).data;
  return normalizeTask(model,raw);
}
function queueChanged(){for(const win of BrowserWindow.getAllWindows())win.webContents.send('queue:changed');}
function focusMainWindow() {
  if(!mainWindow||mainWindow.isDestroyed())return;
  if(mainWindow.isMinimized())mainWindow.restore();
  mainWindow.show();mainWindow.focus();
}
function createTray() {
  tray=new Tray(path.join(__dirname,'assets','icon.ico'));
  tray.setToolTip('AI Media Client');
  tray.on('click',focusMainWindow);
  tray.on('balloon-click',focusMainWindow);
  tray.setContextMenu(Menu.buildFromTemplate([
    {label:'Открыть AI Media Client',click:focusMainWindow},
    {type:'separator'},
    {label:'Выход',click:()=>app.quit()}
  ]));
}
async function registerWindowsNotifications() {
  if(process.platform!=='win32')return true;
  const shortcut=path.join(app.getPath('appData'),'Microsoft','Windows','Start Menu','Programs','AI Media Client.lnk');
  await fs.mkdir(path.dirname(shortcut),{recursive:true});
  return shell.writeShortcutLink(shortcut,'create',{
    target:process.execPath,
    cwd:path.dirname(process.execPath),
    description:'AI Media Client',
    icon:process.execPath,
    iconIndex:0,
    appUserModelId,
    toastActivatorClsid
  });
}
function showTrayBalloon(body) {
  if(process.platform==='win32'&&tray)tray.displayBalloon({title:'Генерация готова',content:body,iconType:'info',largeIcon:true,noSound:false});
}
function showGenerationReady(record) {
  const kind=record.kind==='video'?'Видео':'Изображение';
  const body=`${kind} · ${record.modelName||record.model||'Результат можно посмотреть в приложении'}`;
  if(!persistentNotificationsReady||!Notification.isSupported()){showTrayBalloon(body);return;}
  const notification=new Notification({
    title:'Генерация готова',
    body,
    icon:path.join(__dirname,'assets','icon.png'),
    silent:false,
    timeoutType:'never'
  });
  activeNotifications.add(notification);
  notification.on('close',()=>activeNotifications.delete(notification));
  notification.on('failed',()=>{activeNotifications.delete(notification);showTrayBalloon(body);});
  notification.show();
}

// One writer for history/queue across application windows and launches.
if(!app.requestSingleInstanceLock())app.quit();
else app.whenReady().then(async () => {
  createTray();
  persistentNotificationsReady=await registerWindowsNotifications().catch(()=>false);
  history = new History(path.join(app.getPath('userData'), 'history.json'));
  preferences = new History(path.join(app.getPath('userData'), 'preferences.json'));
  lastOutputDirectory=(await storageSettings()).directory||'';
  rememberBrowserDownloadDirectory(session.defaultSession);
  tariffs=new (require('./tariffs').Tariffs)(preferences);
  const kieSession=new (require('./kie-session').KieSession)();
  const localCaller=event=>{if(event.senderFrame?.url!==pathToFileURL(path.join(__dirname,'index.html')).href)throw new Error('Недопустимый источник запроса');};
  ipcMain.handle('notification:test',event=>{localCaller(event);showGenerationReady({kind:'image',modelName:'Проверка уведомлений'});return true;});
  ipcMain.handle('kie-session:open',async event=>{localCaller(event);await kieSession.open();return true;});
  ipcMain.handle('kie-session:clear',async event=>{localCaller(event);await kieSession.clear();return true;});
  ipcMain.handle('kie-session:diagnostics',event=>{localCaller(event);return kieSession.diagnostics();});
  ipcMain.handle('kie-session:status',event=>{localCaller(event);return kieSession.status();});
  ipcMain.handle('kie-session:quote',async(event,value)=>{localCaller(event);return kieSession.quote(value?.model,value?.input);});
  ipcMain.handle('costs:get',costSettings);
  ipcMain.handle('tariffs:descriptions',()=>{const {checkedAt,totalModels,coveredModels,entries}=require('./kie-price-descriptions.json');return {checkedAt,totalModels,coveredModels,entries};});
  ipcMain.handle('costs:set',async(_event,value)=>{if(typeof value!=='number'||!Number.isFinite(value)||value<=0||value>100000)throw new Error('Введите положительную цену кредита');await preferences.update('cost-settings',{rubPerCredit:value});return costSettings();});
  ipcMain.handle('tariffs:get',(_event,force)=>tariffs.get(force===true));
  ipcMain.handle('price-audit:get',async()=> (await preferences.list()).find(row=>row.id==='price-audit')?.data||null);
  ipcMain.handle('price-audit:auto',()=>process.argv.includes('--audit-prices'));
  ipcMain.handle('favorites:get',async()=> (await preferences.list()).find(row=>row.id==='model-favorites')?.ids||[]);
  ipcMain.handle('favorites:set',async(_event,ids)=>{
    if(!Array.isArray(ids)||ids.length>500||ids.some(id=>typeof id!=='string'||id.length>500))throw new Error('Некорректный список избранного');
    const clean=[...new Set(ids)];await preferences.update('model-favorites',{ids:clean});return clean;
  });
  ipcMain.handle('price-audit:save',async(_event,data)=>{
    if(!data||data.version!==1||!Array.isArray(data.results)||data.results.length>10000)throw new Error('Некорректный отчёт проверки цен');
    const clean={version:1,checkedAt:String(data.checkedAt||new Date().toISOString()),results:data.results.map(row=>({key:String(row.key).slice(0,2000),modelId:String(row.modelId).slice(0,300),modelName:String(row.modelName).slice(0,300),status:['match','mismatch','confirmed','tariff-only','unavailable'].includes(row.status)?row.status:'unavailable',accountCredits:costs.amount(row.accountCredits),localCredits:costs.amount(row.localCredits),checkedAt:String(row.checkedAt||new Date().toISOString())}))};
    await preferences.update('price-audit',{data:clean});return clean;
  });
  drafts = new History(path.join(app.getPath('userData'), 'drafts.json'));
  const templates=new (require('./prompt-templates').PromptTemplates)(path.join(app.getPath('userData'),'prompt-templates.json'));
  ipcMain.handle('templates:list',()=>templates.list());
  ipcMain.handle('templates:save',(_event,value)=>templates.save(value));
  ipcMain.handle('templates:remove',(_event,id)=>templates.remove(id));
  ipcMain.handle('drafts:load',async()=> (await drafts.list()).find(row=>row.id==='workspace')?.data||null);
  ipcMain.handle('drafts:save',async(_event,data)=>{if(data?.version!==1||!Array.isArray(data.tabs)||data.tabs.length<1||data.tabs.length>5)throw new Error('Некорректный черновик');await drafts.update('workspace',{data});return true;});
  ipcMain.on('drafts:close',event=>BrowserWindow.fromWebContents(event.sender)?.destroy());
  assets=new Assets(path.join(app.getPath('userData'),'sources'));
  const queuePreferences=(await preferences.list()).find(item=>item.id==='queue');
  taskQueue=new TaskQueue({store:history,notify:queueChanged,concurrency:queuePreferences?.concurrency||3,
    prepare:async record=>{await getKey(record.providerId);const input=await assets.resolve(record.input,record.sourceFiles||[],file=>uploadSource(record.providerId,file));validateInput(getModel(record),input);return input;},
    create:async(record,input)=>{const provider=providerById(record.providerId);const model=getModel(record);return (await api(provider,model.createPath||provider.createPath,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(validateInput(model,input))})).data;},
    poll:checkTask,
    complete:async record=>{
      showGenerationReady(record);
      if((await storageSettings()).autoSave){try{await saveResults(record.id);}catch{/* Recorded separately by saveResults; generation remains successful. */}}
    }
  });
  await taskQueue.recover();
  ipcMain.handle('source:save',(_event,file)=>assets.save(file));
  ipcMain.handle('source:preview',async(_event,ref)=>{
    const id=assets.id(ref);
    if(!id)throw new Error('Некорректный исходник');
    const filename=path.join(assets.directory,id);
    if(!await fs.stat(filename).then(s=>s.isFile()).catch(()=>false))throw new Error('Исходник не найден');
    return pathToFileURL(filename).href;
  });
  ipcMain.handle('queue:status',()=>({paused:taskQueue.paused,error:taskQueue.error,concurrency:taskQueue.concurrency}));
  ipcMain.handle('queue:concurrency',async(_event,value)=>{if(!Number.isInteger(value)||value<1||value>5)throw new Error('Лимит должен быть от 1 до 5');await preferences.update('queue',{concurrency:value});taskQueue.setConcurrency(value);queueChanged();return value;});
  ipcMain.handle('queue:start',()=>{taskQueue.start();return true;});
  ipcMain.handle('queue:pause',()=>{taskQueue.pause();return true;});
  ipcMain.handle('queue:cancel',(_event,id)=>taskQueue.cancel(id));
  ipcMain.handle('queue:remove',(_event,id)=>taskQueue.remove(id));
  ipcMain.handle('queue:clear',()=>taskQueue.clear());
  ipcMain.handle('queue:acknowledge',(_event,id)=>taskQueue.acknowledge(id));
  ipcMain.handle('history:list', async () => {
    const records=await history.list();
    return Promise.all(records.map(async record=>({...record,localFiles:await Promise.all((record.localFiles||[]).map(async file=>({...file,previewUrl:pathToFileURL(file.path).href,exists:await fs.stat(file.path).then(s=>s.isFile()).catch(()=>false)})))})));
  });
  ipcMain.handle('storage:get', storageSettings);
  ipcMain.handle('storage:folder', chooseOutputFolder);
  ipcMain.handle('storage:auto', async (_event,enabled) => {
    if(typeof enabled!=='boolean') throw new Error('Некорректная настройка');
    if(enabled && !(await storageSettings()).directory) throw new Error('Сначала выберите папку');
    await preferences.update('storage',{autoSave:enabled}); return storageSettings();
  });
  ipcMain.handle('results:save', (_event,id)=>saveResults(id));
  ipcMain.handle('results:reveal', async (_event,id,index) => {
    const record=(await history.list()).find(item=>item.id===id);
    const file=record?.localFiles?.[index];
    if(!file || !await fs.stat(file.path).then(s=>s.isFile()).catch(()=>false)) throw new Error('Файл перемещён или удалён');
    shell.showItemInFolder(file.path);
  });
  ipcMain.handle("catalog:get", () => ({ providers, models }));
  ipcMain.handle("key:status", async (_event, providerId) => Boolean((await readKeys())[providerId]));
  ipcMain.handle("key:save", async (_event, providerId, key) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Шифрование Windows недоступно");
    const keys = await readKeys();
    keys[providerId] = safeStorage.encryptString(String(key).trim()).toString("base64");
    await fs.mkdir(path.dirname(keyFile()), { recursive: true });
    await fs.writeFile(keyFile(), JSON.stringify(keys), { mode: 0o600 });
    return true;
  });
  ipcMain.handle("balance:get", async (_event, providerId, reset) => {
    const provider = providerById(providerId);
    return balanceWithAudit(provider,reset===true);
  });
  ipcMain.handle("file:upload", async (_event, providerId, file) => {
    return uploadSource(providerId,file);
  });
  ipcMain.handle("task:create", async (_event, request) => {
    const provider = providerById(request.providerId);
    const model = models.find(item => item.providerId === provider.id && item.apiModel === request.model);
    if (!model) throw new Error('Неизвестная модель');
    validateInput(model,request.input);
    const {rubPerCredit}=await costSettings();
    const cachedTariffs=(await preferences.list()).find(row=>row.id==='kie-tariffs')?.data;
    const estimate=await kieSession.quote(model.apiModel,request.input).catch(()=>null)||costs.quote(model,request.input,cachedTariffs);
    if(estimate)estimate.stale=Date.now()-Date.parse(estimate.tariffDate)>=86400000;
    return taskQueue.enqueue({ providerId: provider.id, providerName: provider.name,
      rubPerCredit,estimate,
      model: model.apiModel, modelName: model.name, kind: model.kind, input: request.input,workspace:[1,2,3,4,5].includes(request.workspace)?request.workspace:1,
      sourceFiles:(request.sourceFiles||[]).filter(file=>JSON.stringify(request.input).includes(file.ref)) });
  });
  ipcMain.handle("task:get", async (_event, providerId, taskId) => {
    const provider = providerById(providerId);
    const record = (await history.list()).find(item => item.providerId === providerId && item.taskId === taskId);
    const model = models.find(item=>item.providerId===providerId && item.apiModel===record?.model);
    if(!model) throw new Error('Модель задачи не найдена в каталоге');
    const raw = (await api(provider, `${model.taskPath || provider.taskPath}?taskId=${encodeURIComponent(taskId)}`)).data;
    const data = normalizeTask(model, raw);
    if (record) await history.update(record.id, { state: data.state, resultJson: data.resultJson,
      creditsConsumed: data.creditsConsumed, progress: data.progress, error: data.failMsg || null });
    if(record && data.state==='success' && (await storageSettings()).autoSave) {
      try { await saveResults(record.id); } catch(error) { data.downloadError=error.message; }
    }
    return data;
  });
  createWindow();
  app.on("activate", () => { if(!mainWindow||mainWindow.isDestroyed())createWindow();else focusMainWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on('before-quit',()=>taskQueue?.close());
app.on('second-instance',focusMainWindow);
