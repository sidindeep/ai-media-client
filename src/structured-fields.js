/* Recursive editors for documented objects, lists and alternative input modes. */
window.structuredField = function build(schema, name, required = false, initial, upload) {
  const labels = {multi_prompt:'Сцены',elements:'Персонажи и объекты',kling_elements:'Персонажи и объекты',prompt:'Промпт',duration:'Длительность, сек.',name:'Имя',description:'Описание',image_url:'Изображение',image_urls:'Изображения',video_urls:'Видео',reference_video_urls:'Референсные видео',reference_audio_urls:'Референсное аудио',reference_image:'Референсные изображения',element_input_urls:'Изображения или видео персонажа',element_input_audio_urls:'Аудио персонажа',image_references:'Референсы',ref_name:'Имя для ссылки в промпте',type:'Тип',hex:'Цвет HEX',ratio:'Доля, %',color_palette:'Палитра',bbox_list:'Области редактирования',video_list:'Видеофрагменты',url:'Ссылка',start:'Начало',ends:'Конец',task_id:'ID задачи',mask_indexs:'Номера масок',audio_ids:'ID аудио',character_ids:'ID персонажей'};
  const root=document.createElement('div');root.className='structured-field';
  const label=document.createElement('label');label.textContent=ru.label(name,labels[name]||ru.label(name+'s'))+(required?' *':'');if(name)root.append(label);
  const important=ru.importantHint(name,schema);
  if(schema.description&&important){const details=document.createElement('details');const summary=document.createElement('summary');summary.textContent='Особенности и ограничения';const text=document.createElement('p');text.textContent=important;const original=document.createElement('details');const title=document.createElement('summary');title.textContent='Документация Kie';const body=document.createElement('p');body.textContent=schema.description;original.append(title,body);details.append(summary,text,original);root.append(details);}
  const variants=schema.oneOf||schema.anyOf;
  const missing=value=>value===undefined || value===null || value==='';
  const result={element:root};
  if(variants){
    const select=document.createElement('select');root.append(select);const holder=document.createElement('div');root.append(holder);let child;
    const titles={'No Video Input':'Без входного видео','With Video Input':'С входным видео','Single First Frame':'Начальный кадр','First and Last Frames':'Начальный и конечный кадры',task_id:'По ID задачи',image_url:'По изображению'};
    variants.forEach((v,i)=>select.add(new Option(titles[v.title]||`Вариант ${i+1}`,String(i))));
    function show(value){child=build(variants[Number(select.value)],'',required,value,upload);holder.replaceChildren(child.element);}
    select.onchange=()=>show();
    result.set=value=>{const index=variants.findIndex(v=>(v.required||[]).every(k=>value?.[k]!==undefined)&&Object.keys(value||{}).every(k=>!v.properties||k in v.properties));select.value=String(Math.max(0,index));show(value);};
    result.snapshot=async save=>({variant:Number(select.value),child:await child.snapshot(save)});
    result.restore=draft=>{select.value=String(Math.min(variants.length-1,Math.max(0,draft.variant||0)));show();child.restore(draft.child);};
    result.read=()=>child.read();result.set(initial);return result;
  }
  if(schema.type==='object' && Object.keys(schema.properties||{}).length){
    const group=document.createElement('fieldset');root.append(group);
    const enable=document.createElement('input');enable.type='checkbox';enable.checked=required||initial!==undefined;
    if(!required){const toggle=document.createElement('label');toggle.className='check';toggle.append(enable,document.createTextNode('Использовать'));root.insertBefore(toggle,group);}
    const children=Object.entries(schema.properties).map(([key,s])=>[key,build(s,key,(schema.required||[]).includes(key),initial?.[key],upload)]);
    for(const [,child]of children)group.append(child.element);
    const sync=()=>{group.disabled=!enable.checked;};enable.onchange=sync;sync();
    result.read=async()=>{if(!enable.checked)return undefined;const value={};for(const [key,child]of children){const v=await child.read();if(v!==undefined)value[key]=v;}return value;};
    result.set=value=>{enable.checked=required||value!==undefined;for(const [key,child]of children)child.set(value?.[key]);sync();};
    result.snapshot=async save=>({enabled:enable.checked,children:Object.fromEntries(await Promise.all(children.map(async([key,child])=>[key,await child.snapshot(save)])))});
    result.restore=draft=>{enable.checked=required||Boolean(draft.enabled);for(const [key,child]of children)if(draft.children?.[key])child.restore(draft.children[key]);sync();};
    return result;
  }
  if(schema.type==='array' && schema.items){
    const rows=document.createElement('div');root.append(rows);let children=[];
    const add=document.createElement('button');add.type='button';add.textContent='Добавить';root.append(add);
    function sync(){add.disabled=children.length>=(schema.maxItems??Infinity);children.forEach((item,i)=>{item.number.textContent=String(i+1);item.up.disabled=i===0;item.down.disabled=i===children.length-1;rows.append(item.row);});}
    function append(value){const row=document.createElement('div');row.className='structured-row';const number=document.createElement('span');const child=build(schema.items,name.replace(/s$/,''),true,value,upload);const remove=document.createElement('button');remove.type='button';remove.textContent='Удалить';const up=document.createElement('button');up.type='button';up.textContent='↑';const down=document.createElement('button');down.type='button';down.textContent='↓';
      const item={row,child,number,up,down};remove.onclick=()=>{children=children.filter(c=>c!==item);row.remove();sync();};
      const move=delta=>{const index=children.indexOf(item);[children[index],children[index+delta]]=[children[index+delta],children[index]];sync();};up.onclick=()=>move(-1);down.onclick=()=>move(1);row.append(number,child.element,up,down,remove);children.push(item);sync();}
    add.onclick=()=>append();
    result.set=value=>{children=[];rows.replaceChildren();for(const item of (Array.isArray(value)?value:required?Array.from({length:schema.minItems||0}):[]))append(item);sync();};
    result.read=async()=>{if(!children.length&&!required)return undefined;if(children.length<(schema.minItems||0)||children.length>(schema.maxItems??Infinity))throw new Error(`${labels[name]||name}: проверьте количество элементов`);return Promise.all(children.map(item=>item.child.read()));};
    result.snapshot=async save=>({rows:await Promise.all(children.map(item=>item.child.snapshot(save)))});
    result.restore=draft=>{result.set([]);for(const row of draft.rows||[]){append();children.at(-1).child.restore(row);}};
    result.set(initial??schema.default);return result;
  }
  const input=document.createElement(schema.enum?'select':schema.type==='object'||schema.type==='array'||/prompt|description/.test(name)?'textarea':'input');root.append(input);
  const isJson=schema.type==='object'||schema.type==='array';
  if(isJson){const note=document.createElement('small');note.textContent='В документации нет структуры этого значения. Введите JSON вручную.';root.append(note);}
  if(schema.enum){if(!required)input.add(new Option('Не задавать',''));schema.enum.forEach(v=>input.add(new Option(ru.option(v),JSON.stringify(v))));}
  else if(schema.type==='boolean'){input.type='checkbox';}
  else if(['number','integer'].includes(schema.type)){input.type='number';input.step=schema.type==='integer'?'1':'any';if(schema.minimum!==undefined)input.min=schema.minimum;if(schema.maximum!==undefined)input.max=schema.maximum;}
  else if(input.tagName==='INPUT')input.type='text';
  if(schema.maxLength!==undefined)input.maxLength=schema.maxLength;
  if(input.tagName==='TEXTAREA'&&!isJson&&/prompt/i.test(name))window.attachPromptTemplates(root,input);
  // A required boolean may legitimately be false; HTML checkbox required is unsuitable.
  input.required=required&&schema.type!=='boolean';
  let file, savedRef;
  const thumbnails=document.createElement('div');thumbnails.className='source-thumbnails';
  if(schema.type==='string' && /url|reference_image|reference_video|mask_url/.test(name) && /image|video|audio|mask|element_input/.test(name)){
    file=document.createElement('input');file.type='file';file.accept=/audio/.test(name)?'audio/*':/video/.test(name)?'video/*':/element_input/.test(name)?'image/*,video/*':'image/*';root.append(file);
    root.append(thumbnails);
    const renderFile=()=>{const selected=[...file.files];const meta=savedRef?sourceFiles.find(item=>item.ref===savedRef)||{ref:savedRef,name:'Сохранённый исходник'}:null;window.showSourceThumbnails(thumbnails,selected.length?selected:meta?[meta]:[],()=>{file.value='';savedRef=undefined;input.required=required&&!input.value.trim();renderFile();file.dispatchEvent(new Event('change',{bubbles:true}));});};
    input.placeholder='HTTPS-ссылка или выберите файл';file.onchange=()=>{savedRef=undefined;input.required=required&&!file.files.length&&!input.value.trim();renderFile();};file.renderPreview=renderFile;
    window.attachFileDrop(file,{maxFiles:1});
  }
  input.addEventListener('input',()=>{savedRef=undefined;input.required=required&&schema.type!=='boolean'&&!file?.files.length;});
  result.set=value=>{if(file)file.value='';const v=value??schema.default;savedRef=typeof v==='string'&&v.startsWith('https://local-assets.invalid/')?v:undefined;if(schema.type==='boolean')input.checked=Boolean(v);else input.value=savedRef?'':missing(v)?'':schema.enum||isJson?JSON.stringify(v):v;if(savedRef){input.placeholder='Сохранённый исходник — замените ссылкой или файлом';input.required=false;}};
  const setValue=result.set;
  result.set=value=>{setValue(value);if(file)file.renderPreview();};
  result.read=async()=>{
    if(file?.files.length)return upload(file.files[0]);
    if(savedRef)return savedRef;
    if(schema.type==='boolean')return input.checked;
    if(!input.value.trim()){if(required)throw new Error(`Заполните: ${labels[name]||name}`);return undefined;}
    if(!input.checkValidity())throw new Error(`Проверьте: ${labels[name]||name}`);
    if(schema.enum||isJson){try{return JSON.parse(input.value);}catch{throw new Error(`Некорректный JSON: ${name}`);}}
    if(['number','integer'].includes(schema.type))return Number(input.value);
    return input.value;
  };
  result.snapshot=async save=>{const value=input.value,checked=Boolean(input.checked),selected=file?.files[0],ref=savedRef;return {value,checked,ref:selected?await save(selected):ref};};
  result.restore=draft=>{result.set(draft.ref);if(!draft.ref){input.value=draft.value??'';input.checked=Boolean(draft.checked);}};
  result.set(initial);if(schema.enum&&name!=='duration')window.attachChoiceButtons(input);return result;
};
