// Serialize editable state, not validated API inputs: incomplete drafts are valid drafts.
let draftsReady=false,draftTimer,draftWrite=Promise.resolve(),draftClosing=false;
const draftFileCache=new WeakMap();
async function snapshotWorkspaces(){
  const active=currentTab;
  const tabs=workTabs.map((tab,index)=>index===active?{fields:$('fields'),structured,sourceFiles,restoredFiles,previewSelection,provider:$('provider').value,model:$('model').value,search:$('modelSearch').value,filter:$('mediaFilter').value}:tab.draft);
  return {version:1,active,tabs:await Promise.all(tabs.map(async draft=>{
    if(!draft||!draft.model)return null;
    const metadata=[...draft.sourceFiles];
    const save=async file=>{
      if(!draftFileCache.has(file)){
        const operation=file.arrayBuffer().then(bytes=>window.desktop.saveSource({name:file.name,type:file.type,bytes:new Uint8Array(bytes)}));
        draftFileCache.set(file,operation);operation.catch(()=>draftFileCache.delete(file));
      }
      const saved=await draftFileCache.get(file);if(!metadata.some(item=>item.ref===saved.ref))metadata.push(saved);return saved.ref;
    };
    const model=catalog.models.find(m=>m.id===draft.model);
    const values=await Promise.all((model?.fields||[]).map(async field=>{
      const editor=draft.structured.get(field.key);
      if(editor)return [field.key,{structured:await editor.snapshot(save)}];
      const input=draft.fields.querySelector(`[data-key="${field.key}"]`);
      if(field.type==='files'){
        const files=[...input.files];const refs=draft.restoredFiles[field.key];
        return [field.key,{refs:files.length?await Promise.all(files.map(save)):refs}];
      }
      return [field.key,{value:input.value,checked:input.checked}];
    }));
    return {provider:draft.provider,model:draft.model,search:draft.search,filter:draft.filter,previewSelection:draft.previewSelection,sourceFiles:metadata,values:Object.fromEntries(values)};
  }))};
}
function saveWorkspaceDrafts(){
  if(!draftsReady)return Promise.resolve();
  const snapshot=snapshotWorkspaces();
  // Attach rejection handlers immediately; persist snapshots in capture order.
  const settled=snapshot.then(value=>({value}),error=>({error}));
  draftWrite=draftWrite.catch(()=>{}).then(async()=>{const result=await settled;if(result.error)throw result.error;await window.desktop.saveDrafts(result.value);$('draftStatus').textContent='Черновики сохранены на компьютере';});
  return draftWrite;
}
function scheduleDraftSave(){
  if(!draftsReady||draftClosing)return;clearTimeout(draftTimer);
  $('draftStatus').textContent='Сохранение черновиков…';
  draftTimer=setTimeout(()=>saveWorkspaceDrafts().catch(error=>{$('draftStatus').textContent='Черновик не сохранён: '+error.message;}),600);
}
async function restoreWorkspaceDrafts(){
  const data=await window.desktop.loadDrafts();
  if(data?.version===1&&Array.isArray(data.tabs)){
    for(let index=0;index<Math.min(data.tabs.length,workTabs.length);index++){
      const draft=data.tabs[index];if(!draft||!draft.model)continue;
      const model=catalog.models.find(m=>m.id===draft.model&&m.providerId===draft.provider);
      if(!model)throw new Error('Модель сохранённого черновика отсутствует: '+draft.model);
      switchWorkTab(index,true);$('modelSearch').value='';$('mediaFilter').value='';$('provider').value=draft.provider;$('provider').dispatchEvent(new Event('change'));$('model').value=draft.model;renderModel();
      sourceFiles=draft.sourceFiles||[];previewSelection=draft.previewSelection||null;
      for(const field of model.fields){
        const saved=draft.values?.[field.key];if(!saved)continue;
        if(structured.has(field.key)){structured.get(field.key).restore(saved.structured);continue;}
        const input=$('fields').querySelector(`[data-key="${field.key}"]`);
        if(field.type==='files'&&saved.refs!==undefined){
          const refs=Array.isArray(saved.refs)?saved.refs:[saved.refs];
          restoredFiles[field.key]=field.scalar?refs[0]:refs;input.required=Boolean(field.required)&&!refs.length;
          input.refreshFiles();
        }else if(field.type!=='files'){
          input.value=saved.value??'';input.checked=Boolean(saved.checked);
          if(field.key==='duration'&&field.required&&input.value==='')input.value=String(window.durationRules.values(model,field)?.[0]??'');
          input.syncDuration?.();
        }
      }
    }
    switchWorkTab(Number.isInteger(data.active)&&data.active>=0&&data.active<visibleWorkTabs?data.active:0);updatePreview();renderWorkTabs();
  }
  draftsReady=true;refreshCostPreview();
}
document.addEventListener('input',event=>{if(event.target.closest('#generationForm,#modelSearch'))scheduleDraftSave();});
document.addEventListener('change',event=>{if(event.target.closest('#generationForm,#provider,#model,#mediaFilter,#queueConcurrency'))scheduleDraftSave();});
document.addEventListener('click',event=>{if(event.target.closest('#generationForm,#workTabs,[data-repeat-id],#editPreview,#followCurrent,#queueTasks,#historyList'))scheduleDraftSave();});
window.addEventListener('beforeunload',event=>{
  if(!draftsReady)return;
  event.preventDefault();event.returnValue=false;
  if(draftClosing)return;draftClosing=true;clearTimeout(draftTimer);
  saveWorkspaceDrafts().then(()=>window.desktop.finishClose()).catch(error=>{draftClosing=false;setStatus('Не удалось сохранить черновики. Окно оставлено открытым: '+error.message,true);});
});
