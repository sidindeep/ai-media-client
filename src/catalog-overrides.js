// Explicit corrections backed by Kie Playground and documented request examples.
// Kept separate from generated OpenAPI imports so refreshes preserve these fixes.
function applyOverrides(models) {
  const result=structuredClone(models);
  const fileLabels={video_url:'Исходное видео',video_urls:'Исходные видео',reference_video_urls:'Референсные видео',audio_url:'Исходное аудио',audio_urls:'Исходное аудио',reference_audio_urls:'Референсное аудио',driving_audio_url:'Управляющее аудио',upload_url:'Исходное аудио',upload_url_list:'Исходные аудиофайлы',verify_url:'Запись для проверки',voice_url:'Запись голоса',mask_url:'Маска',reference_mask_urls:'Референсные маски'};
  for(const model of result)for(const field of model.fields){
    const schema=field.schema;
    const genericAudio=model.kind==='audio'&&/^(upload_url|upload_url_list|verify_url|voice_url)$/.test(field.key);
    if(!schema||field.type==='files'||(!genericAudio&&!/(image|video|audio|mask).*url|url.*(image|video|audio|mask)/i.test(field.key))||!['string','array'].includes(schema.type))continue;
    const kind=genericAudio||/audio/i.test(field.key)?'audio':/video/i.test(field.key)?'video':'image';
    const accept=kind==='audio'?'audio/*':kind==='video'?'video/mp4,video/quicktime,video/webm':'image/*';
    const size=(schema.description||'').match(/(?:max(?:imum)?(?: file)? size:?|not exceed(?:ing)?|no larger than|less than)\s*`?([\d.]+)\s*MB/i)?.[1];
    Object.assign(field,{type:'files',scalar:schema.type==='string',maxFiles:schema.type==='string'?1:field.key==='upload_url_list'?2:schema.maxItems,maxSizeMb:size?Number(size):undefined,accept,label:fileLabels[field.key]||field.label});
  }
  const audioLabels={prompt:'Описание или текст',text:'Текст для озвучивания',voice:'Голос',dialogue:'Реплики',language_code:'Язык',style:'Стиль',title:'Название',model:'Версия модели',instrumental:'Инструментальная музыка',custom_mode:'Расширенные настройки',negative_tags:'Исключить стили',lyrics:'Текст песни',duration:'Длительность, сек.',sound_loop:'Зациклить звук',sound_tempo:'Темп, BPM',sound_key:'Тональность',grab_lyrics:'Получить субтитры',task_id:'ID исходной задачи',audio_id:'ID аудио'};
  const audioNames={'elevenlabs/text-to-dialogue-v3':'ElevenLabs · Диалог','elevenlabs/text-to-speech-multilingual-v2':'ElevenLabs · Многоязычная речь','elevenlabs/text-to-speech-turbo-2-5':'ElevenLabs · Быстрая речь','elevenlabs/audio-isolation':'ElevenLabs · Очистка аудио','ai-music-api/generate':'Suno · Создать музыку','ai-music-api/sounds':'Suno · Создать звук','google/gemini-2-5-pro-tts':'Gemini 2.5 Pro · Озвучивание','google/gemini-3-1-flash-tts':'Gemini 3.1 Flash · Озвучивание'};
  for(const model of result.filter(item=>item.kind==='audio')){
    if(audioNames[model.apiModel])model.name=audioNames[model.apiModel];
    for(const field of model.fields)if(audioLabels[field.key])field.label=audioLabels[field.key];
  }
  // Some Kie schemas describe file limits in prose but omit maxItems.
  for(const model of result)for(const field of model.fields.filter(f=>f.type==='files'&&!f.scalar)){
    const text=field.schema?.description||'';let max=field.maxFiles;
    const match=text.match(/(?:maximum of|max(?:imum)?(?: number of)?|up to|only)\s*`?(\d+)`?\s*(?:images?|files?)?/i);
    if(!Number.isInteger(max)&&match)max=Number(match[1]);
    if(!Number.isInteger(max)&&/(?:include|url of) (?:an|the) image|include (?:a|an) video url|currently only 1 image/i.test(text))max=1;
    if(!Number.isInteger(max)&&model.kind==='audio'&&field.key==='audio_urls')max=10;
    if(!Number.isInteger(max)&&model.kind==='audio'&&field.key==='upload_url_list')max=2;
    if(!Number.isInteger(max)&&model.apiModel==='ideogram/character-remix'&&field.key==='image_urls')max=5;
    if(Number.isInteger(max)){field.maxFiles=max;if(field.schema)field.schema.maxItems=max;if(model.inputSchema?.properties?.[field.key])model.inputSchema.properties[field.key].maxItems=max;}
  }
  for(const model of result.filter(m=>['wan/3-0-video','wan/3-0-video-prime'].includes(m.apiModel))) {
    model.correctionSource='https://kie.ai/'+(model.apiModel.endsWith('prime')?'wan3.0-video-prime':'wan3.0-video');
    const mappings={first_frame_url:['Начальный кадр',true,1,20,'image/jpeg,image/png,image/webp,image/bmp'],last_frame_url:['Конечный кадр',true,1,20,'image/jpeg,image/png,image/webp,image/bmp'],reference_image_urls:['Референсные изображения',false,10,20,'image/jpeg,image/png,image/webp,image/bmp'],reference_video_urls:['Референсные видео',false,5,100,'video/mp4,video/quicktime'],reference_audio_urls:['Референсное аудио',false,5,15,'audio/wav,audio/mpeg'],reference_file_urls:['Документы-референсы',false,1,100,'.docx,.doc,.xlsx,.xls,.pptx,.ppt,.pdf,.txt,.key,.pages,.numbers,.md']};
    for(const [key,[label,scalar,maxFiles,maxSizeMb,accept]]of Object.entries(mappings)) {
      const previous=model.inputSchema.properties[key];
      const schema={...previous,type:scalar?'string':'array'};
      delete schema.properties;
      if(!scalar)schema.items={type:'string',format:'uri'};
      model.inputSchema.properties[key]=schema;
      const field=model.fields.find(f=>f.key===key);
      Object.assign(field,{schema,type:'files',scalar,maxFiles,maxSizeMb,accept,label});
    }
    const key='reference_link_urls';
    model.inputSchema.properties[key]={...model.inputSchema.properties[key],items:{type:'string',format:'uri'}};
    Object.assign(model.fields.find(f=>f.key===key),{schema:model.inputSchema.properties[key],label:'Ссылка на веб-страницу'});
  }
  if(!result.some(m=>m.apiModel==='kling-3.0/video')) {
    const uri={type:'string',format:'uri'};
    const schema={type:'object',required:['duration','mode','multi_shots'],properties:{
      prompt:{type:'string'},
      image_urls:{type:'array',maxItems:2,items:uri},
      sound:{type:'boolean',default:true},
      duration:{type:'string',enum:Array.from({length:13},(_,i)=>String(i+3)),default:'5'},
      aspect_ratio:{type:'string',enum:['16:9','9:16','1:1']},
      mode:{type:'string',enum:['std','pro','4K'],default:'pro'},
      multi_shots:{type:'boolean',default:false},
      multi_prompt:{type:'array',items:{type:'object',required:['prompt','duration'],properties:{prompt:{type:'string',minLength:1,maxLength:500},duration:{type:'integer',minimum:1,maximum:12}}}},
      kling_elements:{type:'array',maxItems:3,items:{type:'object',required:['name','description','element_input_urls'],properties:{name:{type:'string',minLength:1},description:{type:'string'},element_input_urls:{type:'array',minItems:1,maxItems:4,items:uri,description:'2–4 изображения JPG/PNG до 10 МБ каждое или одно видео MP4/MOV. Видео: от 3 сек., используемый фрагмент 3–8 сек.'},element_input_audio_urls:{type:'array',maxItems:1,items:uri,description:'Не более одного аудиофайла, длительность 5–30 сек.'},start_time:{type:'integer',minimum:0,description:'Начало видеофрагмента, миллисекунды'},end_time:{type:'integer',minimum:0,description:'Конец видеофрагмента, миллисекунды'}}}}
    }};
    const labels={prompt:'Промпт',sound:'Звук',duration:'Длительность, сек.',aspect_ratio:'Соотношение сторон',mode:'Качество',multi_shots:'Несколько сцен',multi_prompt:'Сцены',kling_elements:'Персонажи и объекты'};
    const fields=Object.entries(schema.properties).map(([key,s])=>({key,label:labels[key]||key,schema:s,required:schema.required.includes(key),default:s.default,type:s.enum?'select':s.type==='boolean'?'boolean':s.type==='array'?'json':'textarea',options:s.enum}));
    Object.assign(fields.find(f=>f.key==='image_urls'),{type:'files',label:'Кадры: первый — начальный, второй — конечный',maxFiles:2,scalar:false,accept:'image/jpeg,image/png',hint:'В режиме нескольких сцен разрешён только начальный кадр.'});
    result.push({id:'kie:kling-3.0/video',providerId:'kie',apiModel:'kling-3.0/video',name:'Kling 3.0',kind:'video',description:'Одна или несколько сцен, кадры и персонажи',source:'https://docs.kie.ai/market/kling/kling-3-0',inputSchema:schema,fields,pricing:{type:'reported',label:'Стоимость до запуска пока не подключена'}});
  }
  if(!result.some(m=>m.apiModel==='kling/v2-5-turbo-image-to-video-pro')){
    const properties={
      prompt:{type:'string',maxLength:2500,description:'The text prompt describing the video to generate (Max length: 2500 characters)'},
      image_url:{type:'string',description:'Initial frame image. JPEG or PNG, maximum 10 MB.'},
      tail_image_url:{type:'string',description:'Optional final frame image. JPEG or PNG, maximum 10 MB.'},
      duration:{type:'string',enum:['5','10'],default:'5',description:'Video duration: 5 or 10 seconds.'},
      negative_prompt:{type:'string',maxLength:500,description:'Elements to avoid in the generated video.'},
      cfg_scale:{type:'number',minimum:0,maximum:1,default:0.5,description:'Prompt adherence. Min 0, max 1, step 0.1.'}
    };
    const schema={type:'object',required:['prompt','image_url'],properties};
    const fields=[
      {key:'prompt',label:'Промпт',required:true,schema:properties.prompt,hint:properties.prompt.description,type:'textarea',maxLength:2500},
      {key:'image_url',label:'Начальный кадр',required:true,schema:properties.image_url,hint:properties.image_url.description,type:'files',scalar:true,maxFiles:1,maxSizeMb:10,accept:'image/jpeg,image/png'},
      {key:'tail_image_url',label:'Конечный кадр',required:false,schema:properties.tail_image_url,hint:properties.tail_image_url.description,type:'files',scalar:true,maxFiles:1,maxSizeMb:10,accept:'image/jpeg,image/png'},
      {key:'duration',label:'Длительность, сек.',required:false,schema:properties.duration,hint:properties.duration.description,type:'select',options:['5','10'],default:'5'},
      {key:'negative_prompt',label:'Негативный промпт',required:false,schema:properties.negative_prompt,hint:properties.negative_prompt.description,type:'textarea',maxLength:500},
      {key:'cfg_scale',label:'Следование промпту',required:false,schema:properties.cfg_scale,hint:properties.cfg_scale.description,type:'number',min:0,max:1,step:0.1,default:0.5}
    ];
    result.push({id:'kie:kling/v2-5-turbo-image-to-video-pro',providerId:'kie',apiModel:'kling/v2-5-turbo-image-to-video-pro',name:'Kling - V2.5 Turbo Image to Video Pro',kind:'video',description:'Kling 2.5 Turbo: начальный и конечный кадры',source:'https://docs.kie.ai/market/kling/v25-turbo-image-to-video-pro.md',inputSchema:schema,fields,pricing:{type:'reported',label:'Стоимость до запуска пока не подключена'}});
  }
  const quickStart=result.find(model=>model.apiModel==='nano-banana-2-lite');
  if(quickStart){
    quickStart.startupDefault=true;
    const image=quickStart.fields.find(field=>field.key==='image_urls');
    if(image){image.required=false;image.label='Исходные изображения (необязательно)';image.hint='Без изображения — генерация по тексту. Добавьте изображения, если нужны референсы.';}
    quickStart.inputSchema.required=quickStart.inputSchema.required.filter(key=>key!=='image_urls');
    quickStart.fields.sort((a,b)=>(a.key==='prompt'?-1:b.key==='prompt'?1:0));
  }
  return result;
}
module.exports={applyOverrides};
