let catalog;
let historyRecords = [];
let historyPage=0;
const historyPageSize=10;
function switchAppPage(page) {
  const tabs=[...document.querySelectorAll('#appTabs [data-page]')];
  if(!tabs.some(tab=>tab.dataset.page===page))return;
  for(const tab of tabs){
    const selected=tab.dataset.page===page;
    tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;
    document.getElementById(tab.dataset.page).hidden=!selected;
  }
  document.querySelector('#appMain > aside').hidden=page!=='pageGeneration';
  document.getElementById('appMain').classList.toggle('full-page',page!=='pageGeneration');
  window.scrollTo(0,0);
}
document.getElementById('appTabs').addEventListener('click',event=>{
  const tab=event.target.closest('[data-page]');if(tab)switchAppPage(tab.dataset.page);
});
document.getElementById('appTabs').addEventListener('keydown',event=>{
  const tabs=[...document.querySelectorAll('#appTabs [data-page]')];
  let index=tabs.indexOf(event.target);if(index<0)return;
  if(event.key==='ArrowRight')index=(index+1)%tabs.length;
  else if(event.key==='ArrowLeft')index=(index+tabs.length-1)%tabs.length;
  else if(event.key==='Home')index=0;else if(event.key==='End')index=tabs.length-1;else return;
  event.preventDefault();switchAppPage(tabs[index].dataset.page);tabs[index].focus();
});
let activeTask = null;
const downloading = new Set();
let structured = new Map();
const workTabs=Array.from({length:5},()=>({draft:null}));
let visibleWorkTabs=3;
let currentTab=0;
let previewRecord=null;
let favoriteModelIds=[];
function renderWorkTabs(){
  $('workTabs').replaceChildren(...workTabs.slice(0,visibleWorkTabs).map((tab,index)=>{
    const button=document.createElement('button');button.type='button';button.role='tab';button.setAttribute('aria-selected',String(index===currentTab));button.disabled=Boolean(activeTask);
    const model=index===currentTab?selectedModel():catalog.models.find(m=>m.id===tab.draft?.model);
    const jobs=historyRecords.filter(r=>r.workspace===index+1&&['queued','preparing','submitting','waiting','queuing','generating'].includes(r.state));
    button.textContent=`${index+1} · ${model?.name||'Новая генерация'}${jobs.length?' · задач: '+jobs.length:''}`;
    button.title=button.textContent;
    button.onclick=()=>switchWorkTab(index);return button;
  }));
}
function switchWorkTab(index,restoring=false){
  if(!Number.isInteger(index)||index<0||index>=workTabs.length||(!restoring&&index>=visibleWorkTabs)||activeTask||index===currentTab)return;
  const fields=$('fields');fields.id=`parkedFields${currentTab}`;fields.hidden=true;
  const disabled=[...fields.querySelectorAll('input,select,textarea,button')].map(element=>[element,element.disabled]);disabled.forEach(([element])=>element.disabled=true);
  workTabs[currentTab].draft={fields,disabled,structured,sourceFiles,restoredFiles,previewSelection,provider:$('provider').value,model:$('model').value,search:$('modelSearch').value,filter:$('mediaFilter').value};
  const blank=document.createElement('div');blank.id='fields';$('generationForm').insertBefore(blank,$('generate'));
  currentTab=index;const draft=workTabs[index].draft;
  $('modelSearch').value=draft?.search||'';$('mediaFilter').value=draft?.filter||'';
  if(!draft)$('model').value='';
  $('provider').value=draft?.provider||catalog.providers[0].id;$('provider').dispatchEvent(new Event('change'));
  if(draft){
    $('model').value=draft.model;renderModel();$('fields').replaceWith(draft.fields);draft.fields.id='fields';draft.fields.hidden=false;
    structured=draft.structured;sourceFiles=draft.sourceFiles;restoredFiles=draft.restoredFiles;previewSelection=draft.previewSelection;
    draft.disabled.forEach(([element,value])=>element.disabled=value);
  }else previewSelection=null;
  setStatus('');previewSignature='';updatePreview();renderQueueTasks();renderWorkTabs();
  refreshCostPreview();
}
let sourceFiles=[];
let restoredFiles={};
let previewSelection=null;
let previewSignature='';
let balanceRequest=0;
let balanceAudit=null;
let historyInitialized=false;
const completedTasks=new Set();
async function uploadNested(file) {
  setStatus(`Сохранение исходника ${file.name}…`);
  const saved=await window.desktop.saveSource({name:file.name,type:file.type,bytes:new Uint8Array(await file.arrayBuffer())});
  if(!sourceFiles.some(item=>item.ref===saved.ref))sourceFiles.push(saved);
  return saved.ref;
}
const $ = (id) => document.getElementById(id);

function selectedProvider() { return catalog.providers.find((p) => p.id === $("provider").value); }
function selectedModel() { return catalog.models.find((m) => m.id === $("model").value); }

function setStatus(text, error = false) {
  const box = $("status");
  box.textContent = text;
  box.className = `status${error ? " error" : ""}${String(text ?? '').trim() ? '' : ' hidden'}`;
}

function makeField(field) {
  if(field.type==='json') {
    const editor=window.structuredField(field.schema,field.key,field.required,undefined,uploadNested);
    structured.set(field.key,editor);return editor.element;
  }
  const wrap = document.createElement("div"); wrap.className = "field";
  const label = document.createElement("label"); label.textContent = /[А-Яа-я]/.test(field.label)?field.label:ru.label(field.key,field.label);label.textContent+=(field.required?' *':'');wrap.append(label);
  let input;
  if (field.type === "textarea" || field.type === 'json') input = document.createElement("textarea");
  else if (field.type === "select") {
    input = document.createElement("select");
    if (!field.required && field.default === undefined) input.append(new Option('Не задавать', ''));
    field.options.forEach((value) => { const option = document.createElement("option"); option.value=value;option.textContent=ru.option(value); input.append(option); });
  } else if (field.type === "boolean") {
    label.remove(); wrap.className += " check"; input = document.createElement("input"); input.type = "checkbox"; wrap.append(input, label);
  } else { input = document.createElement("input"); input.type = field.type === "files" ? "file" : field.type; }
  input.dataset.key = field.key;
  if (field.required && field.type !== 'boolean') input.required = true;
  if (field.default !== undefined) field.type === "boolean" ? input.checked = field.default : input.value = field.default;
  if (field.min !== undefined) input.min = field.min;
  if (field.max !== undefined) input.max = field.max;
  if (field.maxLength) input.maxLength = field.maxLength;
  if (field.step) input.step = field.step;
  if (field.type === "files") { input.multiple = !field.scalar && field.maxFiles !== 1; input.accept = field.accept; const hint = document.createElement("div"); hint.className="hint"; hint.textContent=[field.maxFiles === 1 ? 'Один файл' : field.maxFiles ? `До ${field.maxFiles} файлов` : '', field.maxSizeMb ? `максимум ${field.maxSizeMb} МБ${field.maxFiles === 1 ? '' : ' каждый'}` : ''].filter(Boolean).join(', '); wrap.append(input, hint); }
  else wrap.append(input);
  if(field.key==='duration'){
    const allowed=durationRules.values(selectedModel(),field);
    if(allowed?.length){
      if(field.required&&input.value==='')input.value=String(allowed[0]);
      if(input.tagName==='INPUT'){input.type='number';input.min=Math.min(...allowed);input.max=Math.max(...allowed);input.step=1;}
      const slider=document.createElement('input');slider.type='range';slider.min=0;slider.max=allowed.length-1;slider.step=1;slider.className='duration-slider';slider.setAttribute('aria-label','Длительность — ползунок');
      const note=document.createElement('small');note.className='hint';
      const sync=()=>{const index=input.value===''?-1:allowed.indexOf(Number(input.value));slider.value=String(Math.max(0,index));slider.disabled=allowed.length===1;note.textContent=index>=0?(Number(input.value)<=0?'Автоматическая длительность':input.value+' сек.'):'Выберите длительность';input.setCustomValidity(input.value!==''&&index<0?'Выберите допустимую длительность ползунком':'');};
      slider.oninput=()=>{input.value=String(allowed[Number(slider.value)]);input.dispatchEvent(new Event('input',{bubbles:true}));};
      input.addEventListener('input',sync);input.addEventListener('change',sync);input.addEventListener('focus',sync);
      wrap.insertBefore(slider,input);wrap.append(note);input.syncDuration=sync;sync();
    }else{const note=document.createElement('small');note.className='hint';note.textContent='Максимум длительности не указан в документации модели.';wrap.append(note);}
  }else if(input.type==='number'&&Number.isFinite(Number(input.min))&&Number.isFinite(Number(input.max))&&input.min!==''&&input.max!==''){
    const min=Number(input.min),max=Number(input.max);let step=field.step;
    if(step==='any'||!Number.isFinite(Number(step)))step=field.schema?.multipleOf||Number(field.schema?.description?.match(/step:?\s*([\d.]+)/i)?.[1])||((max-min)<=1?0.1:1);
    const slider=document.createElement('input');slider.type='range';slider.min=String(min);slider.max=String(max);slider.step=String(step);slider.className='parameter-slider';slider.setAttribute('aria-label',label.textContent+' — ползунок');
    const value=document.createElement('small');value.className='slider-value';
    const sync=()=>{if(input.value!=='')slider.value=input.value;value.textContent=input.value;};
    slider.oninput=()=>{input.value=slider.value;input.dispatchEvent(new Event('input',{bubbles:true}));};input.addEventListener('input',sync);sync();wrap.insertBefore(slider,input);wrap.append(value);
  }
  if(field.type==='select'&&field.key!=='duration')window.attachChoiceButtons(input);
  if(field.type==='textarea'&&/prompt/i.test(field.key))window.attachPromptTemplates(wrap,input);
  if(field.type==='files') {
    const savedLabel=document.createElement('p');savedLabel.className='hint';savedLabel.dataset.savedKey=field.key;wrap.append(savedLabel);
    const clear=document.createElement('button');clear.type='button';clear.textContent='Очистить файлы';wrap.append(clear);
    const thumbnails=document.createElement('div');thumbnails.className='source-thumbnails';thumbnails.dataset.thumbnailsKey=field.key;wrap.append(thumbnails);
    input.refreshFiles=()=>{
      const selected=[...input.files];const saved=restoredFiles[field.key];const refs=saved===undefined?[]:Array.isArray(saved)?[...saved]:[saved];
      const files=selected.length?selected:refs.map(ref=>sourceFiles.find(file=>file.ref===ref)||{ref,name:'Исходник по ссылке'});
      savedLabel.textContent=files.map(file=>file.name||'Сохранённый исходник').join(', ');
      window.showSourceThumbnails(thumbnails,files,index=>{
        if(selected.length){const transfer=new DataTransfer();selected.forEach((file,fileIndex)=>{if(fileIndex!==index)transfer.items.add(file);});input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return;}
        refs.splice(index,1);if(refs.length)restoredFiles[field.key]=field.scalar?refs[0]:refs;else delete restoredFiles[field.key];input.required=Boolean(field.required)&&!refs.length;input.refreshFiles();setStatus('');scheduleDraftSave();
      });
    };
    clear.onclick=()=>{delete restoredFiles[field.key];input.value='';input.required=Boolean(field.required);input.refreshFiles();setStatus('');};
    input.onchange=()=>{delete restoredFiles[field.key];input.required=Boolean(field.required)&&!input.files.length;input.refreshFiles();setStatus('');};
    window.attachFileDrop(input,{maxFiles:field.scalar?1:field.maxFiles,maxSizeMb:field.maxSizeMb});
  }
  const important=ru.importantHint(field.key,field.schema);
  if (field.hint&&important) { const hint = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Особенности и ограничения'; const text = document.createElement('p'); text.textContent = important;const original=document.createElement('details');const title=document.createElement('summary');title.textContent='Документация Kie';const body=document.createElement('p');body.textContent=field.hint;original.append(title,body);hint.append(summary, text,original); wrap.append(hint); }
  if (field.type === 'json') input.placeholder = field.schema?.type === 'array' ? '[ … ]' : '{ … }';
  return wrap;
}

function renderModel() {
  setStatus('');
  structured=new Map();
  sourceFiles=[];restoredFiles={};
  const model = selectedModel();
  if (!model) { $('title').textContent = 'Модели не найдены'; $('fields').replaceChildren(); $('generate').disabled = true; renderFavorites(); return; }
  $('generate').disabled = Boolean(activeTask);
  $("title").textContent = model.name; $("kind").textContent = model.kind === "video" ? "Видео" : "Изображение";
  const displayFields=[...model.fields];
  const first=displayFields.findIndex(field=>/^(firstFrame|first_frame_url|first_frame_image_url)$/.test(field.key));
  const last=displayFields.findIndex(field=>/^(lastFrame|last_frame_url|last_frame_image_url)$/.test(field.key));
  if(first>=0&&last>=0&&last<first)[displayFields[first],displayFields[last]]=[displayFields[last],displayFields[first]];
  $("fields").replaceChildren(...displayFields.map(makeField));
  renderFavorites();
  renderWorkTabs();
  refreshCostPreview();
}

function renderFavorites(){
  const current=selectedModel(),favorite=Boolean(current&&favoriteModelIds.includes(current.id));
  $('toggleFavorite').disabled=!current;$('toggleFavorite').textContent=favorite?'★ Убрать':'☆ Добавить';
  const rows=favoriteModelIds.map(id=>catalog.models.find(model=>model.id===id)).filter(Boolean);
  $('favoriteModels').replaceChildren();
  if(!rows.length){const empty=document.createElement('p');empty.className='favorite-empty';empty.textContent='Добавьте часто используемые модели';$('favoriteModels').append(empty);return;}
  for(const model of rows){
    const row=document.createElement('div');row.className='favorite-row';
    const select=document.createElement('button');select.type='button';select.className='favorite-select';select.textContent=model.name;select.title=model.name;
    select.onclick=()=>{$('modelSearch').value='';$('mediaFilter').value='';$('provider').value=model.providerId;$('provider').dispatchEvent(new Event('change',{bubbles:true}));$('model').value=model.id;$('model').dispatchEvent(new Event('change',{bubbles:true}));};
    const remove=document.createElement('button');remove.type='button';remove.className='favorite-remove';remove.textContent='×';remove.title=`Убрать ${model.name} из избранного`;remove.setAttribute('aria-label',remove.title);
    remove.onclick=async()=>{try{favoriteModelIds=await window.desktop.setFavoriteModels(favoriteModelIds.filter(id=>id!==model.id));renderFavorites();}catch(error){setStatus(error.message,true);}};
    row.append(select,remove);$('favoriteModels').append(row);
  }
}

async function refreshBalance({automatic=false,resetAudit=false}={}) {
  const providerId=selectedProvider()?.id;if(!providerId)return;
  const request=++balanceRequest;
  try {
    if(automatic&&!window.desktop.nativeBalance&&!await window.desktop.keyStatus(providerId))return;
    const response=await window.desktop.getBalance(providerId,resetAudit);
    if(request!==balanceRequest||selectedProvider()?.id!==providerId)return;
    const value=typeof response==='object'?response.balance:response;
    balanceAudit=typeof response==='object'?response.audit:null;
    $("balance").textContent=value;$("balance").title='Баланс обновлён';
    if(typeof renderSpending==='function')renderSpending();
    return true;
  } catch (error) {
    if(request!==balanceRequest||selectedProvider()?.id!==providerId)return;
    $("balance").textContent='—';$("balance").title='Не удалось обновить баланс: '+error.message;
    if(!automatic)setStatus(error.message,true);
    return false;
  }
}

async function refreshProviderAccount() {
  const providerId=selectedProvider().id;
  ++balanceRequest;$("balance").textContent='—';$("balance").title='';
  balanceAudit=null;
  try {
    const saved=await window.desktop.keyStatus(providerId);
    if(selectedProvider().id!==providerId)return;
    $("keyStatus").textContent=window.desktop.isWeb?(saved?'Генерация выполняется на сервере':'Подключение генерации будет настроено на сервере'):(saved?'Ключ сохранён в зашифрованном хранилище Windows':'Ключ ещё не сохранён');
    if(saved||window.desktop.nativeBalance)await refreshBalance({automatic:true});
  }catch(error){if(selectedProvider().id===providerId)$("keyStatus").textContent=error.message;}
}

async function collectInput() {
  const model = selectedModel(); const input = {};
  for (const field of model.fields) {
    if(structured.has(field.key)) { const value=await structured.get(field.key).read();if(value!==undefined){if(field.key==='__input')Object.assign(input,value);else input[field.key]=value;}continue; }
    const element = $('fields').querySelector(`[data-key="${field.key}"]`);
    if (field.type === "files") {
      const files = [...element.files];
      if(!files.length && restoredFiles[field.key]!==undefined){input[field.key]=restoredFiles[field.key];continue;}
      if (files.length > field.maxFiles) throw new Error(`Для «${field.label}» разрешено файлов: ${field.maxFiles}`);
      input[field.key] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (file.size > field.maxSizeMb * 1024 * 1024) throw new Error(`${file.name}: превышен лимит ${field.maxSizeMb} МБ`);
        input[field.key].push(await uploadNested(file));
      }
      if (!input[field.key].length) delete input[field.key];
      if (field.scalar && input[field.key]) input[field.key] = input[field.key][0];
    } else if (field.type === "boolean") input[field.key] = element.checked;
    else if (field.type === 'json' && element.value.trim()) { try { input[field.key] = JSON.parse(element.value); } catch { throw new Error(`Некорректный JSON: ${field.label}`); } }
    else if (field.type === "number" && element.value !== '') input[field.key] = Number(element.value);
    else if (field.type === 'select' && element.value !== '' && ['integer','number'].includes(field.schema?.type)) input[field.key] = Number(element.value);
    else if (field.type === 'select' && element.value !== '' && field.schema?.type === 'boolean') input[field.key] = element.value === 'true';
    else if (element.value !== "") input[field.key] = element.value;
  }
  return input;
}

function showResults(data, target=$('results')) {
  let parsed = data.resultJson;
  try { parsed = typeof parsed === "string" ? JSON.parse(parsed) : parsed; } catch { parsed = {}; }
  const urls = parsed?.resultUrls || [];
  target.replaceChildren(...urls.map((url) => {
    const media = document.createElement(data.kind === 'video' || /\.mp4(?:\?|$)/i.test(url) ? "video" : "img");
    if (!/^https:\/\//i.test(url)) return document.createElement('span');
    const local=data.localFiles?.find(file=>file.url===url&&file.exists&&/^file:\/\//.test(file.previewUrl));
    const frame=document.createElement('div');frame.className='media-frame';
    const note=document.createElement('p');note.className='hint';note.textContent=local?'Локальная копия · доступна без интернета':'По ссылке провайдера · для постоянного хранения скачайте результат';
    media.src = local?.previewUrl || url;
    media.addEventListener('error', () => {note.textContent=local?'Не удалось открыть локальный файл. Он мог быть перемещён или иметь неподдерживаемый формат.':'Результат недоступен: ссылка могла истечь или формат не поддерживается.';});
    if (media.tagName === "VIDEO") {media.controls = true;media.preload='metadata';}else media.alt='Результат генерации';
    const fullscreen=document.createElement('button');fullscreen.type='button';fullscreen.textContent='На весь экран';
    fullscreen.onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await frame.requestFullscreen();}catch(error){setStatus('Не удалось открыть полноэкранный просмотр: '+error.message,true);}};
    frame.append(media,fullscreen,note);return frame;
  }));
}

let historyPreviewId=null,historyPreviewSignature='';
function refreshHistoryPreview(){
  if(!$('historyPreview').open)return;
  const record=historyRecords.find(row=>row.id===historyPreviewId);
  if(!record){$('historyPreviewStatus').textContent='Запись не найдена';$('historyPreviewResults').replaceChildren();return;}
  $('historyPreviewTitle').textContent=record.modelName||'Просмотр генерации';
  const labels={success:'Готово',generating:'Генерация идёт. Результат появится здесь автоматически.',waiting:'Ожидаем результат провайдера',queuing:'В очереди провайдера',queued:'Ожидает отправки',preparing:'Загрузка исходников',submitting:'Отправка задачи',fail:'Ошибка генерации',unknown:'Статус отправки неизвестен',blocked:'Ошибка подготовки',cancelled:'Отменена',unconfirmed:'Пропущена'};
  $('historyPreviewStatus').textContent=(labels[record.state]||record.state)+(record.error?' · '+providerErrors.text(record):'');
  const signature=record.state==='success'?JSON.stringify([record.id,record.resultJson,record.localFiles]):'';
  if(signature!==historyPreviewSignature){historyPreviewSignature=signature;showResults(record,$('historyPreviewResults'));}
  if(record.state==='success'&&!$('historyPreviewResults').children.length)$('historyPreviewStatus').textContent='Готово, но провайдер не вернул файл для просмотра';
}
function openHistoryPreview(id){historyPreviewId=id;historyPreviewSignature='';$('historyPreviewResults').replaceChildren();$('historyPreview').showModal();refreshHistoryPreview();}
$('closeHistoryPreview').onclick=()=>$('historyPreview').close();
$('historyPreview').addEventListener('close',()=>{
  $('historyPreviewResults').querySelectorAll('video,audio').forEach(media=>{media.pause();media.removeAttribute('src');media.load();});
  $('historyPreviewResults').replaceChildren();historyPreviewId=null;historyPreviewSignature='';
});

function progressDetails(record) {
  const checked=record.lastCheckedAt && new Date(record.lastCheckedAt);
  const last=checked&&Number.isFinite(checked.getTime())?`Последний ответ Kie: ${checked.toLocaleTimeString('ru-RU')}.`:'Ожидаем обновление статуса от провайдера.';
  return `${record.error?'Не удалось обновить статус. ':''}${typeof record.progress==='number'&&Number.isFinite(record.progress)?'':'Процент готовности не передан. '}${last}`;
}

function updatePreview() {
  const activeStates=['preparing','submitting','waiting','queuing','generating'];
  const tabRecords=historyRecords.filter(r=>r.workspace===currentTab+1||(!r.workspace&&currentTab===0));
  const record=previewSelection ? historyRecords.find(r=>r.id===previewSelection) : tabRecords.find(r=>activeStates.includes(r.state)) || tabRecords.find(r=>r.state==='success') || tabRecords[0];
  previewRecord=record;$('editPreview').classList.toggle('hidden',!record);
  const labels={queued:'Ожидает отправки',preparing:'Загрузка исходников',submitting:'Отправка задачи',waiting:'Ожидание провайдера',queuing:'В очереди провайдера',generating:'Генерация',success:'Готово',fail:'Ошибка генерации',blocked:'Требуется исправление',unknown:'Статус отправки неизвестен',cancelled:'Отменена',unconfirmed:'Пропущена'};
  $('generationCost').textContent=record?recordCostText(record):'Стоимость появится после выбора задачи';
  $('previewModel').textContent=record ? `${record.providerName} · ${record.modelName}` : 'Результат появится здесь';
  const percent=typeof record?.progress==='number'&&Number.isFinite(record.progress)?Math.max(0,Math.min(100,record.progress)):null;
  const active=record&&activeStates.includes(record.state);
  const activeLabels={preparing:'Запуск генерации · загружаем исходники',submitting:'Запуск генерации · отправляем задачу',waiting:'Генерация запущена · ждём ответа провайдера',queuing:'Генерация запущена · в очереди провайдера',generating:'Генерация идёт · результат ещё не готов'};
  $('generationProgress').classList.toggle('is-active',Boolean(active));
  $('generationProgress').textContent=record ? `${activeLabels[record.state]||labels[record.state]||record.state}${active&&percent!==null?' — '+Math.round(percent)+'%':''}${record.error?' · '+providerErrors.text(record):''}` : 'Нет активной генерации';
  $('progressBar').classList.toggle('hidden',!active||percent===null||Boolean(record?.error));
  $('progressDetails').classList.toggle('hidden',!active);
  $('progressDetails').textContent=active?progressDetails(record):'';
  if(active&&record.error)$('generationProgress').textContent='Связь с провайдером прервана · результат пока неизвестен';
  if(percent!==null){$('progressBar').value=percent;$('progressBar').setAttribute('aria-label',`Прогресс генерации: ${Math.round(percent)}%`);}else{$('progressBar').removeAttribute('value');$('progressBar').setAttribute('aria-label','Генерация выполняется, точный прогресс неизвестен');}
  const signature=record?.state==='success'?`${record.id}:${JSON.stringify(record.resultJson)}:${JSON.stringify(record.localFiles)}`:'';
  if(!signature){
    $('results').querySelectorAll('video,audio').forEach(media=>{media.pause();media.removeAttribute('src');media.load();});
    $('results').replaceChildren();previewSignature='';
  }else if(signature!==previewSignature){previewSignature=signature;showResults(record);}
  $('previewEmpty').classList.toggle('hidden',Boolean($('results').children.length));
  $('previewEmpty').textContent=active?'Генерация выполняется…':record?.state==='success'?'Провайдер не вернул файл для предпросмотра':'Изображение или видео появится здесь после завершения задачи';
}

async function poll(providerId, taskId) {
  let delay = 2500;
  for (let attempt = 0; attempt < 100; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    const data = await window.desktop.getTask(providerId, taskId);
    await refreshHistory();
    setStatus(`Задача ${taskId}: ${data.state}${data.progress != null ? ` — ${data.progress}%` : ""}`);
    if (data.state === "success") {
      showResults(data); await refreshBalance();
      const cost = data.creditsConsumed;
      setStatus(`Готово. Списано: ${Number.isFinite(cost) ? cost : "не указано"} credits.${data.downloadError ? ' Файл не сохранён: '+data.downloadError : ''}`,Boolean(data.downloadError)); return;
    }
    if (data.state === "fail") throw new Error(data.failMsg || "Генерация завершилась ошибкой");
    delay = Math.min(Math.round(delay * 1.25), 10000);
  }
  throw new Error("Ожидание приостановлено. Продолжите проверку задачи из истории; повторная генерация не требуется.");
}

async function refreshHistory() {
  historyRecords = await window.desktop.getHistory();
  let refreshCredits=false;
  for(const record of historyRecords){
    if(!['success','fail'].includes(record.state))continue;
    const identity=`${record.providerId}:${record.id}`;
    if(!completedTasks.has(identity)){
      completedTasks.add(identity);
      if(historyInitialized&&record.providerId===selectedProvider()?.id)refreshCredits=true;
    }
  }
  historyInitialized=true;
  if(refreshCredits)void refreshBalance({automatic:true});
  renderHistory();
  updatePreview();
  const state=await window.desktop.queueStatus();
  refreshHistoryPreview();
  const pending=historyRecords.filter(item=>item.state==='queued').length;
  const active=historyRecords.filter(item=>item.providerId!=='codex'&&['preparing','submitting','waiting','queuing','generating'].includes(item.state));
  $('queueConcurrency').value=String(state.concurrency||2);
  visibleWorkTabs=state.concurrency||2;
  if(draftsReady&&!activeTask&&currentTab>=visibleWorkTabs)switchWorkTab(visibleWorkTabs-1);
  $('queueStatus').textContent=`Выполняется: ${active.length}/${state.concurrency||2} · ожидает: ${pending}${state.paused&&pending?' · ожидающие задачи приостановлены':''}${state.error?' · '+state.error:''}`;
  $('startQueue').hidden=!(state.paused&&pending>0);
  renderQueueTasks();
  renderSpending();
  renderWorkTabs();
}

const kieMayHaveCharged=record=>Boolean(record.providerAcceptedAt||['submitting','waiting','queuing','generating','unknown'].includes(record.state));
function renderQueueTasks(){
  const labels={queued:'Ожидает свободного места',preparing:'Загрузка исходников',submitting:'Отправка',waiting:'Ожидание провайдера',queuing:'Очередь провайдера',generating:'Генерация',unknown:'Проверьте отправку',blocked:'Ошибка подготовки',success:'Готово',fail:'Ошибка генерации'};
  const currentWorkspace=record=>record.workspace===currentTab+1||(!record.workspace&&currentTab===0);
  const unfinished=historyRecords.filter(r=>currentWorkspace(r)&&!r.queueHidden&&['queued','preparing','submitting','waiting','queuing','generating','unknown','blocked'].includes(r.state)).reverse();
  const live=['preparing','submitting','waiting','queuing','generating'];
  unfinished.sort((a,b)=>Number(!live.includes(a.state))-Number(!live.includes(b.state)));
  const recent=historyRecords.filter(r=>currentWorkspace(r)&&!r.queueHidden&&['success','fail'].includes(r.state)).slice(0,3);
  $('queueTasks').replaceChildren();$('recentQueueTasks').replaceChildren();$('recentQueue').hidden=!recent.length;let position=0;
  for(const record of [...unfinished,...recent]){
    const row=document.createElement('article');row.className='queue-task';
    const title=document.createElement('strong');title.textContent=`${record.workspace?'Вкладка '+record.workspace+' · ':''}${record.providerName} · ${record.modelName}`;
    const status=document.createElement('p');status.className=`hint${live.includes(record.state)?' live-status':''}`;status.textContent=(record.state==='queued'?`№${++position} · `:'')+(record.state==='generating'?'Генерация идёт':labels[record.state]);
    row.append(title,status);
    const charge=document.createElement('p');charge.className='hint';charge.textContent=recordCostText(record);row.append(charge);
    if(live.includes(record.state)&&typeof record.progress==='number'&&Number.isFinite(record.progress)&&!record.error){
      const progress=document.createElement('progress');progress.max=100;
      if(typeof record.progress==='number'&&Number.isFinite(record.progress)){progress.value=Math.max(0,Math.min(100,record.progress));status.textContent+=` · ${Math.round(progress.value)}%`;}
      progress.setAttribute('aria-label',`Прогресс: ${record.modelName}`);row.append(progress);
    }
    if(live.includes(record.state)){
      const detail=document.createElement('p');detail.className='hint';detail.textContent=progressDetails(record);row.append(detail);
      if(record.error)status.textContent='Не удалось обновить статус';
    }
    if(record.error){const error=document.createElement('p');error.className='hint';error.textContent=providerErrors.text(record);row.append(error);}
    const view=document.createElement('button');view.textContent='Показать';view.onclick=()=>{previewSelection=record.id;updatePreview();$('previewModel').scrollIntoView({block:'nearest'});};row.append(view);
    if(['queued','preparing','blocked'].includes(record.state)&&!kieMayHaveCharged(record)){
      const remove=document.createElement('button');remove.textContent='Удалить из очереди';remove.onclick=()=>{
        window.desktop.removeQueued(record.id).then(refreshHistory).catch(error=>setStatus(error.message,true));
      };row.append(remove);
    }
    (['success','fail'].includes(record.state)?$('recentQueueTasks'):$('queueTasks')).append(row);
  }
  if(!unfinished.length)$('queueTasks').textContent='Нет активных или ожидающих задач';
}

function generationTimeText(record,now=Date.now()){
  let milliseconds=Number(record.generationDurationMs);
  if(!Number.isFinite(milliseconds)||milliseconds<0){
    const started=Date.parse(record.generationStartedAt);
    const isRunning=['submitting','waiting','queuing','generating'].includes(record.state);
    if(!record.generationCompletedAt&&!isRunning)return '';
    const completed=record.generationCompletedAt?Date.parse(record.generationCompletedAt):now;
    if(!Number.isFinite(started)||!Number.isFinite(completed)||completed<started)return '';
    milliseconds=completed-started;
  }
  const seconds=Math.round(milliseconds/1000);
  if(seconds<1)return 'Общее ожидание: < 1 с';
  const hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60),remainder=seconds%60;
  const parts=[];
  if(hours)parts.push(`${hours} ч`);
  if(minutes)parts.push(`${minutes} мин`);
  if(remainder||!parts.length)parts.push(`${remainder} с`);
  return `Общее ожидание: ${parts.join(' ')}`;
}

function providerGenerationTimeText(record){
  let milliseconds=Number(record.providerDurationMs);
  if((!Number.isFinite(milliseconds)||milliseconds<0)&&record.costTime!=null){
    const raw=Number(record.costTime),created=Number(record.createTime),completed=Number(record.completeTime),elapsed=completed-created;
    if(Number.isFinite(raw)&&raw>=0)milliseconds=Number.isFinite(elapsed)&&elapsed>=0?(Math.abs(raw*1000-elapsed)<Math.abs(raw-elapsed)?raw*1000:raw):(raw<1000?raw*1000:raw);
  }
  if(!Number.isFinite(milliseconds)||milliseconds<0)return '';
  const totalSeconds=milliseconds/1000,hours=Math.floor(totalSeconds/3600),minutes=Math.floor(totalSeconds%3600/60),seconds=totalSeconds%60;
  const parts=[];
  if(hours)parts.push(`${hours} ч`);
  if(minutes)parts.push(`${minutes} мин`);
  if(seconds||!parts.length)parts.push(`${seconds.toLocaleString('ru-RU',{minimumFractionDigits:Number.isInteger(seconds)?0:1,maximumFractionDigits:1})} с`);
  return `Генерация Kie: ${parts.join(' ')}`;
}

function renderHistory() {
  const query = $('historySearch').value.toLowerCase();
  const states = {queued:'Ожидает отправки',preparing:'Загрузка исходников',blocked:'Требуется исправление',cancelled:'Отменена до отправки',unconfirmed:'Пропущена — результат неизвестен', submitting: 'Отправка', unknown: 'Статус неизвестен', waiting: 'Ожидание', queuing: 'В очереди провайдера', generating: 'Генерация', success: 'Готово', fail: 'Ошибка' };
  const filter=$('historyFilter').value;
  const working=['queued','preparing','submitting','waiting','queuing','generating'];
  const records = historyRecords.filter(r => `${r.input?.prompt || ''} ${r.providerName} ${r.modelName}`.toLowerCase().includes(query)&& (filter==='all'||(filter==='success'?r.state==='success':filter==='active'?working.includes(r.state):!working.includes(r.state)&&r.state!=='success')));
  const pages=Math.max(1,Math.ceil(records.length/historyPageSize));
  historyPage=Math.max(0,Math.min(historyPage,pages-1));
  const offset=historyPage*historyPageSize;
  $('historyCount').textContent=records.length?`${offset+1}–${Math.min(offset+historyPageSize,records.length)} из ${records.length}${query?' · найдено по всей истории':''}`:'Записей: 0';
  $('historyPage').textContent=`${historyPage+1} / ${pages}`;
  $('historyPrevious').disabled=historyPage===0;
  $('historyNext').disabled=historyPage>=pages-1;
  const expanded=new Set([...$('historyList').querySelectorAll('.history-entry[open]')].map(el=>el.dataset.recordId));
  $('historyList').replaceChildren();
  if (!records.length) { $('historyList').textContent = query||filter!=='all' ? 'Ничего не найдено' : 'Здесь появятся ваши генерации'; return; }
  for (const record of records.slice(offset,offset+historyPageSize)) {
    if (record.providerId === 'codex' && window.renderCodexHistory) { $('historyList').append(window.renderCodexHistory(record, states)); continue; }
    const card = document.createElement('article'); card.className = 'card compact-history';
    const title = document.createElement('strong'); title.textContent = `${record.providerName} · ${record.modelName}`;
    const meta = document.createElement('p'); meta.className = 'hint';
    meta.textContent = [new Date(record.createdAt).toLocaleString('ru-RU'),states[record.state] || record.state,providerGenerationTimeText(record),generationTimeText(record),recordCostText(record)].filter(Boolean).join(' · ');
    const prompt = document.createElement('p'); prompt.textContent = record.input?.prompt || 'Без промпта'; prompt.className = 'history-prompt';
    const actions = document.createElement('div'); actions.className = 'inline';
    const repeat = document.createElement('button'); repeat.textContent = 'Изменить и повторить';repeat.dataset.repeatId=record.id; repeat.disabled = Boolean(activeTask);
    repeat.onclick = () => {
      if(activeTask)return;
      if(!confirm('Загрузить настройки этой задачи в текущую вкладку? Её текущий черновик будет заменён. Генерация автоматически не запускается.'))return;
      const model = catalog.models.find(m => m.providerId === record.providerId && m.apiModel === record.model);
      if (!model) return setStatus('Эта модель больше не доступна в каталоге.', true);
      $('modelSearch').value = ''; $('mediaFilter').value = '';
      $('provider').value = record.providerId; $('provider').dispatchEvent(new Event('change'));
      $('model').value = model.id; renderModel();
      sourceFiles=[...(record.sourceFiles||[])];
      for (const field of model.fields) {
        if(structured.has(field.key)){structured.get(field.key).set(field.key==='__input'?record.input:record.input[field.key]);continue;}
        const input = $('fields').querySelector(`[data-key="${field.key}"]`);
        if(record.input[field.key]===undefined)continue;
        if(field.type==='files') {
          restoredFiles[field.key]=record.input[field.key];input.required=false;
          input.refreshFiles();
          continue;
        }
        if (field.type === 'boolean') input.checked = record.input[field.key]; else input.value = field.type === 'json' ? JSON.stringify(record.input[field.key], null, 2) : record.input[field.key];
        input.syncDuration?.();
      }
      setStatus('Настройки и сохранённые исходники восстановлены. Можно запускать генерацию. У старых записей без исходников ссылки могли истечь.');
      previewSelection=record.id;updatePreview();
      refreshCostPreview();
      switchAppPage('pageGeneration');
      // Scroll only the form pane: scrollIntoView also moves overflow-hidden
      // workspace ancestors and can push the entire interface off screen.
      document.querySelector('.input-panel').scrollTo({ top: 0, behavior: 'instant' });
    };
    actions.append(repeat);
    if(record.state==='queued') {
      const cancel=document.createElement('button');cancel.textContent='Убрать из очереди';
      cancel.onclick=()=>window.desktop.cancelQueued(record.id).then(refreshHistory).catch(error=>setStatus(error.message,true));actions.append(cancel);
    }
    if(record.state==='unknown') {
      const skip=document.createElement('button');skip.textContent='Пропустить без повторной отправки';
      skip.onclick=()=>window.desktop.acknowledgeTask(record.id).then(refreshHistory).catch(error=>setStatus(error.message,true));actions.append(skip);
    }
    if (record.state === 'success') {
      const save=document.createElement('button');save.textContent=downloading.has(record.id)?'Скачивание…':'Скачать результаты';save.disabled=downloading.has(record.id);
      save.onclick=async()=>{
        downloading.add(record.id);renderHistory();
        try{await window.desktop.saveResults(record.id);setStatus(window.desktop.isWeb?'Результаты сохранены на сервере. Скачивание отправлено в браузер.':'Результаты сохранены на компьютере');}
        catch(error){setStatus(error.message,true);}
        finally{downloading.delete(record.id);renderStorage(await window.desktop.storageSettings());await refreshHistory();}
      };
      actions.append(save);
    } else if (record.taskId && record.state !== 'fail') {
      const resume = document.createElement('button'); resume.textContent = 'Продолжить проверку'; resume.disabled = Boolean(activeTask);
      resume.onclick = () => window.desktop.startQueue().then(refreshHistory).catch(error=>setStatus(error.message,true));
      actions.append(resume);
    }
    const view=document.createElement('button');view.textContent='Просмотр';view.className='history-view';view.onclick=()=>openHistoryPreview(record.id);
    const detail = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Параметры и ID';
    const pre = document.createElement('pre'); pre.textContent = JSON.stringify({ taskId: record.taskId, input: record.input, error: record.error, errorInfo: providerErrors.forRecord(record) }, null, 2);
    detail.append(summary, pre);
    const entry=document.createElement('details');entry.className='history-entry';entry.dataset.recordId=record.id;entry.open=expanded.has(record.id);
    const heading=document.createElement('summary');heading.title='Раскрыть промпт, параметры и действия';
    const short=document.createElement('span');short.className='history-short';short.textContent=record.input?.prompt||'Без промпта';
    heading.append(title,short,meta);
    const body=document.createElement('div');body.className='history-body';body.append(prompt,actions,detail);entry.append(heading,body);card.append(entry,view);
    for(const [index,file] of (record.localFiles||[]).entries()) {
      const local=document.createElement('div'); local.className='local-file';
      const label=document.createElement('span'); label.textContent=file.exists ? 'Сохранено на компьютере' : 'Локальный файл не найден'; local.append(label);
      const reveal=document.createElement('button');reveal.textContent=window.desktop.isWeb?'Скачать файл':'Показать в папке';reveal.disabled=!file.exists;
      reveal.onclick=()=>window.desktop.revealResult(record.id,index).catch(error=>setStatus(error.message,true));
      local.append(reveal);body.append(local);
    }
    if(record.downloadError){const note=document.createElement('p');note.textContent='Ошибка скачивания: '+record.downloadError;body.append(note);}
    if(record.sourceFiles?.length){const note=document.createElement('p');note.className='hint';note.textContent=`Сохранено исходников: ${record.sourceFiles.length}`;body.append(note);}
    if (['unknown','unconfirmed'].includes(record.state)) { const note = document.createElement('p'); note.textContent = window.desktop.nativeAccount ? 'Статус уточняется. Резерв сохранён; обратитесь в поддержку перед повторным запуском.' : 'Проверьте журнал провайдера перед повторным запуском: запрос мог быть принят.'; body.append(note); }
    $('historyList').append(card);
  }
}

function setBusy(task) {
  activeTask = task;
  $('queueConcurrency').disabled=Boolean(task);
  if(!task&&draftsReady&&currentTab>=visibleWorkTabs)switchWorkTab(visibleWorkTabs-1);
  $('generate').disabled = Boolean(task);
  $('provider').disabled = Boolean(task);
  $('model').disabled = Boolean(task);
  $('modelSearch').disabled = Boolean(task);
  $('mediaFilter').disabled = Boolean(task);
  $('fields').inert=Boolean(task);
  renderHistory();
  renderWorkTabs();$('editPreview').disabled=Boolean(task);
}

async function init() {
  catalog = await window.desktop.getCatalog();
  favoriteModelIds=await window.desktop.getFavoriteModels();
  catalog.providers.forEach((p) => $("provider").add(new Option(p.name, p.id)));
  function loadModels() {
    const previous = $('model').value;
    const query = $('modelSearch').value.toLowerCase(); const kind = $('mediaFilter').value;
    $("model").replaceChildren(...catalog.models.filter(m => m.providerId === $('provider').value && (!kind || m.kind === kind) && `${m.name} ${m.apiModel}`.toLowerCase().includes(query)).map(m => new Option(m.name, m.id)));
    if ([...$('model').options].some(option => option.value === previous)) $('model').value = previous;
    else {const preferred=catalog.models.find(model=>model.startupDefault&&[...$('model').options].some(option=>option.value===model.id));if(preferred)$('model').value=preferred.id;}
    renderModel();
  }
  $('modelSearch').addEventListener('input', loadModels); $('mediaFilter').addEventListener('change', loadModels);
  $("provider").addEventListener("change", loadModels); $("model").addEventListener("change", renderModel); loadModels();
  $('toggleFavorite').addEventListener('click',async()=>{const model=selectedModel();if(!model)return;try{favoriteModelIds=await window.desktop.setFavoriteModels(favoriteModelIds.includes(model.id)?favoriteModelIds.filter(id=>id!==model.id):[...favoriteModelIds,model.id]);renderFavorites();}catch(error){setStatus(error.message,true);}});
  $("provider").addEventListener('change',()=>{void refreshProviderAccount();});
  void refreshProviderAccount();
  await refreshHistory();
  renderStorage(await window.desktop.storageSettings());
  await restoreWorkspaceDrafts();
  void initCosts();
}

function renderStorage(settings) {
  $('outputFolder').textContent=settings.directory || 'Папка не выбрана';
  if($('chooseFolder'))$('chooseFolder').textContent=settings.directory?'Изменить папку':'Выбрать папку';
  $('autoSave').checked=Boolean(settings.autoSave);
}
$('chooseFolder')?.addEventListener('click',async()=>{try{renderStorage(await window.desktop.chooseFolder());}catch(error){setStatus(error.message,true);}});
$('testNotification')?.addEventListener('click',async()=>{try{await window.desktop.testNotification();setStatus('Проверочное уведомление отправлено в системный трей');}catch(error){setStatus(error.message,true);}});
$('autoSave').addEventListener('change',async()=>{try{renderStorage(await window.desktop.setAutoSave($('autoSave').checked));}catch(error){$('autoSave').checked=false;setStatus(error.message,true);}});

$("saveKey")?.addEventListener("click", async () => { try { await window.desktop.saveKey(selectedProvider().id, $("apiKey").value); $("apiKey").value=""; $("keyStatus").textContent="Ключ сохранён в зашифрованном хранилище Windows"; await refreshBalance(); } catch(e){ setStatus(e.message,true); } });
$("refreshBalance").addEventListener("click", refreshBalance);
$("resetBalanceAudit").addEventListener("click",async()=>{if(await refreshBalance({resetAudit:true}))setStatus('Новая сверка расхода начата с текущего баланса.');});
$("generationForm").addEventListener("submit", async (event) => {
  event.preventDefault(); setBusy('new');
  try { const model=selectedModel(); const input=await collectInput(); const task=await window.desktop.createTask({providerId:model.providerId,modelId:model.id,model:model.apiModel,input,sourceFiles,workspace:currentTab+1,requestId:crypto.randomUUID()});previewSelection=task.id; await window.desktop.startQueue(); setStatus('Генерация запущена.'); }
  catch(error){ setStatus(error.message,true); } finally { setBusy(null); await refreshHistory(); }
});

$('historySearch').addEventListener('input',()=>{historyPage=0;renderHistory();$('historyList').scrollTop=0;});
$('historyFilter').addEventListener('change',()=>{historyPage=0;renderHistory();$('historyList').scrollTop=0;});
$('historyPrevious').addEventListener('click',()=>{historyPage--;renderHistory();$('historyList').scrollTop=0;});
$('historyNext').addEventListener('click',()=>{historyPage++;renderHistory();$('historyList').scrollTop=0;});
$('reloadHistory').addEventListener('click', () => refreshHistory().catch(error => setStatus(error.message, true)));
$('followCurrent').addEventListener('click',()=>{previewSelection=null;updatePreview();});
$('editPreview').addEventListener('click',()=>{const button=[...document.querySelectorAll('[data-repeat-id]')].find(b=>b.dataset.repeatId===previewRecord?.id);if(button)button.click();else { $('historySearch').value='';$('historyFilter').value='all';historyPage=Math.floor(Math.max(0,historyRecords.findIndex(record=>record.id===previewRecord?.id))/historyPageSize);renderHistory();[...document.querySelectorAll('[data-repeat-id]')].find(b=>b.dataset.repeatId===previewRecord?.id)?.click(); }});
$('startQueue').addEventListener('click',()=>window.desktop.startQueue().then(refreshHistory).catch(error=>setStatus(error.message,true)));
$('clearQueue').addEventListener('click',()=>{
  window.desktop.clearQueue().then(refreshHistory).catch(error=>setStatus(error.message,true));
});
$('queueConcurrency').addEventListener('change',async()=>{try{await window.desktop.setConcurrency(Number($('queueConcurrency').value));}catch(error){setStatus(error.message,true);}await refreshHistory();});
let queueRefresh;
window.desktop.onQueueChanged(()=>{clearTimeout(queueRefresh);queueRefresh=setTimeout(()=>refreshHistory().catch(error=>setStatus(error.message,true)),100);});

init().catch((error) => setStatus(error.message, true));
