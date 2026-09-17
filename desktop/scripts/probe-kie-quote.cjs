// Explicit read-only probe. Never creates tasks, uploads files, or prints secrets/responses.
const {app,safeStorage}=require('electron');
const fs=require('node:fs/promises');const path=require('node:path');
// Use this app's encryption context, rather than Electron's development profile.
app.setPath('userData',path.join(app.getPath('appData'),'ai-media-client'));
app.whenReady().then(async()=>{
  let stage='read stored key';
  try{
    const filename=path.join(app.getPath('appData'),'ai-media-client','credentials.json');
    const saved=JSON.parse(await fs.readFile(filename,'utf8'));
    if(!saved.kie||!safeStorage.isEncryptionAvailable())throw new Error('Saved Kie key unavailable');
    stage='decrypt stored key';
    const key=safeStorage.decryptString(Buffer.from(saved.kie,'base64'));
    const headers={Authorization:`Bearer ${key}`,'Content-Type':'application/json'};
    stage='read balance';
    const balance=await fetch('https://api.kie.ai/api/v1/chat/credit',{headers,signal:AbortSignal.timeout(20000)});
    const credit=await balance.json();
    console.log(JSON.stringify({check:'API key accepted by balance endpoint',httpStatus:balance.status,code:credit.code,accepted:balance.ok&&credit.code===200}));
    if(!balance.ok||credit.code!==200){app.exit(1);return;}
    stage='read public model metadata';
    const page=await(await fetch('https://kie.ai/grok-imagine-video-1.5',{signal:AbortSignal.timeout(20000)})).text();
    const data=JSON.parse(page.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s)[1]);
    const group=data.props.pageProps.pageData.groupData[0];const model=group.userPath+(group.path?'/'+group.path:'');
    stage='read quote';
    const response=await fetch('https://api.kie.ai/api/v1/playground/getConsumeCredits',{method:'POST',headers,body:JSON.stringify({model,input:{resolution:'480p',duration:8,aspect_ratio:'auto',nsfw_checker:true}}),signal:AbortSignal.timeout(20000)});
    const result=await response.json();
    console.log(JSON.stringify({check:'Read-only quote',model,httpStatus:response.status,code:result.code,credits:typeof result.data==='number'?result.data:null}));
    app.exit(0);
  }catch{console.error('Probe failed at stage: '+stage+'; no secret or response body logged.');app.exit(1);}
});
