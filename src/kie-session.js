// A separate Chromium profile: no application preload, API keys or filesystem bridge.
const {BrowserWindow,session}=require('electron');
const PARTITION='persist:kie-price-session';
// Never retain URL paths, query strings, fragments, headers or page/console text.
function diagnosticOrigin(value){try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)?u.origin:u.protocol;}catch{return 'unknown';}}
function allowedNavigation(value){
  try{const u=new URL(value);return u.protocol==='https:'&&['kie.ai','www.kie.ai','accounts.google.com','login.microsoftonline.com','login.live.com'].includes(u.hostname);}catch{return false;}
}
class KieSession{
  constructor(){
    this.auth={state:'unknown',checkedAt:null};this.authEpoch=0;
    this.quoteCache=new Map();this.loading=null;
    this.events=[];
    this.windows=new Set();this.profile=session.fromPartition(PARTITION);
    this.profile.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
    this.profile.setPermissionCheckHandler(()=>false);
    this.profile.on('will-download',event=>event.preventDefault());
  }
  record(event,url,code){
    const row={time:new Date().toISOString(),event,origin:diagnosticOrigin(url)};
    if(Number.isInteger(code))row.code=code;
    this.events.push(row);if(this.events.length>100)this.events.shift();
  }
  diagnostics(){return this.events.map(row=>({...row}));}
  async status(){
    const win=this.window,epoch=this.authEpoch;
    if(!win||win.isDestroyed())return {...this.auth,live:false};
    if(diagnosticOrigin(win.webContents.getURL())!=='https://kie.ai')return {...this.auth,live:false};
    try{
      // Read only visible login controls. Never inspect cookies, storage, identity or tokens.
      const state=await win.webContents.executeJavaScript(`(()=>{
        const visible=e=>!!e&&e.getClientRects().length>0;
        const avatar=[...document.querySelectorAll('button img[alt="avatar"]')].some(visible);
        const login=[...document.querySelectorAll('button')].some(e=>visible(e)&&e.textContent.trim()==='Get Started');
        return avatar&&!login?'signed-in':login&&!avatar?'signed-out':'unknown';
      })()`);
      if(epoch!==this.authEpoch)return {...this.auth,live:false};
      this.auth={state:['signed-in','signed-out'].includes(state)?state:'unknown',checkedAt:new Date().toISOString()};
      return {...this.auth,live:true};
    }catch{return {state:'unknown',checkedAt:null,live:false};}
  }
  secure(win){
    this.windows.add(win);
    for(const name of ['will-navigate','will-redirect'])win.webContents.on(name,(event,url)=>{
      const allowed=allowedNavigation(url);this.record(allowed?'navigation_allowed':'navigation_blocked',url);
      if(!allowed)event.preventDefault();
    });
    win.webContents.on('did-navigate',(_event,url,status)=>this.record('page_loaded',url,status));
    win.webContents.on('did-fail-load',(_event,code,_description,url,isMainFrame)=>{if(isMainFrame)this.record('load_failed',url,code);});
    win.webContents.on('render-process-gone',()=>this.record('renderer_stopped',''));
    win.webContents.setWindowOpenHandler(({url})=>{
      const allowed=allowedNavigation(url);this.record(allowed?'popup_allowed':'popup_blocked',url);
      return allowed?{action:'allow',overrideBrowserWindowOptions:{webPreferences:{partition:PARTITION,nodeIntegration:false,contextIsolation:true,sandbox:true}}}:{action:'deny'};
    });
    win.webContents.on('did-create-window',child=>this.secure(child));
    win.on('closed',()=>{this.windows.delete(win);void this.profile.cookies.flushStore().catch(()=>{});});
  }
  async open(){
    if(this.window&&!this.window.isDestroyed()){this.window.show();this.window.focus();return;}
    this.window=new BrowserWindow({width:1100,height:800,title:'Kie — вход и проверка цен',webPreferences:{partition:PARTITION,nodeIntegration:false,contextIsolation:true,sandbox:true}});
    this.secure(this.window);
    this.record('window_opened','https://kie.ai');
    await this.window.loadURL('https://kie.ai/grok-imagine-video-1.5');
  }
  async ensurePage(){
    if(this.window&&!this.window.isDestroyed()&&diagnosticOrigin(this.window.webContents.getURL())==='https://kie.ai')return this.window;
    if(this.loading)return this.loading;
    this.loading=(async()=>{
      this.window=new BrowserWindow({show:false,width:1100,height:800,title:'Kie — проверка цен',webPreferences:{partition:PARTITION,nodeIntegration:false,contextIsolation:true,sandbox:true}});
      this.secure(this.window);this.record('window_opened','https://kie.ai');
      await this.window.loadURL('https://kie.ai/grok-imagine-video-1.5');return this.window;
    })();
    try{return await this.loading;}finally{this.loading=null;}
  }
  priceInput(value,key=''){
    if(/url|image|video|audio/i.test(key)&&['string','boolean'].includes(typeof value))return value?'https://local.invalid/present':'';
    if(value===null||['string','number','boolean'].includes(typeof value)){
      if(typeof value==='string'&&(/prompt|description/i.test(key)))return '';
      return value;
    }
    if(Array.isArray(value))return value.map(item=>this.priceInput(item,key));
    if(typeof value==='object')return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,this.priceInput(item,name)]));
    return undefined;
  }
  async quote(model,input){
    if(typeof model!=='string'||!model||model.length>200||!input||typeof input!=='object')return null;
    const safeInput=this.priceInput(input),cacheKey=JSON.stringify([model,safeInput]);
    const cached=this.quoteCache.get(cacheKey);if(cached&&Date.now()-cached.time<300000)return cached.value;
    const win=await this.ensurePage();
    const payload=JSON.stringify({model,input:safeInput}).replace(/[\u2028\u2029]/g,c=>c==='\u2028'?'\\u2028':'\\u2029');
    const result=await win.webContents.executeJavaScript(`(async payload=>{
      const authorization=document.cookie.split('; ').find(row=>row.startsWith('authorization='))?.slice(14);
      if(!authorization)return {state:'signed-out'};
      try{
        const response=await fetch('https://api.kie.ai/api/v1/playground/getConsumeCredits',{method:'POST',headers:{authorization:decodeURIComponent(authorization),'content-type':'application/json'},body:JSON.stringify(payload)});
        const body=await response.json();return {state:response.ok&&body.code===200?'ok':'unavailable',value:body.code===200?body.data:null};
      }catch{return {state:'unavailable'};}
    })(${payload})`);
    if(result?.state==='signed-out')this.auth={state:'signed-out',checkedAt:new Date().toISOString()};
    else this.auth={state:'signed-in',checkedAt:new Date().toISOString()};
    const raw=typeof result?.value==='object'?(result.value?.consumeCredits??result.value?.credits):result?.value;
    const credits=(typeof raw==='number'||(typeof raw==='string'&&/^\d+(\.\d+)?$/.test(raw.trim())))?Number(raw):null;
    const value=result?.state==='ok'&&Number.isFinite(credits)&&credits>=0?{credits,type:'kie-account',source:'Kie account'}:null;
    this.quoteCache.set(cacheKey,{time:Date.now(),value});return value;
  }
  async clear(){
    this.authEpoch++;this.auth={state:'signed-out',checkedAt:new Date().toISOString()};
    for(const win of this.windows)win.destroy();
    await this.profile.clearStorageData();await this.profile.clearCache();await this.profile.cookies.flushStore();
    this.events=[];
    this.quoteCache.clear();
  }
}
module.exports={KieSession,allowedNavigation,PARTITION,diagnosticOrigin};
