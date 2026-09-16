const fs = require('node:fs/promises');
const YAML = require('yaml');
const {field,get} = require('./import-kie');
const definitions = [
  ['veo', 'veo3-api/generate-veo-3-video', '/api/v1/veo/record-info', 'video'],
  ['runway', 'runway-api/generate-ai-video', '/api/v1/runway/record-detail', 'video'],
  ['flux', 'flux-kontext-api/generate-or-edit-image', '/api/v1/flux/kontext/record-info', 'image'],
  ['4o', '4o-image-api/generate-4-o-image', '/api/v1/gpt4o-image/record-info', 'image']
];
async function run() {
  const result=[];
  for (const [adapter,page,taskPath,kind] of definitions) {
    const source=`https://docs.kie.ai/${page}.md`;
    const markdown=await get(source);
    const spec=YAML.parse(markdown.match(/```yaml\s*\n([\s\S]*?)```/)[1]);
    const [createPath, operations]=Object.entries(spec.paths).find(([,ops])=>ops.post);
    const schema=operations.post.requestBody.content['application/json'].schema;
    const variants=schema.properties.model?.enum || [adapter === '4o' ? 'gpt4o-image' : 'runway'];
    for (const variant of variants) {
      const modes=adapter === 'veo' ? ['TEXT_2_VIDEO','FIRST_AND_LAST_FRAMES_2_VIDEO', ...(variant === 'veo3' ? [] : ['REFERENCE_2_VIDEO'])] : ['default'];
      for (const mode of modes) {
        const inputSchema=structuredClone(schema);
        delete inputSchema.properties.model; delete inputSchema.properties.generationType;
        for(const [key,value] of Object.entries(inputSchema.properties)) if (value.deprecated || key === 'callBackUrl' && adapter !== 'runway') delete inputSchema.properties[key];
        inputSchema.required=(inputSchema.required||[]).filter(key=>inputSchema.properties[key]);
        const fields=Object.entries(inputSchema.properties).map(([key,value])=>field(key,value,inputSchema.required.includes(key),inputSchema.properties));
        for(const f of fields) {
          if (['imageUrls','filesUrl','imageUrl','inputImage'].includes(f.key)) Object.assign(f,{type:'files', scalar:f.schema.type === 'string',accept:'image/*',label: f.key === 'imageUrl' || f.key === 'inputImage' ? 'Исходное изображение' : 'Референсные изображения',maxFiles:f.schema.type === 'string' ? 1 : adapter === '4o' ? 5 : 3});
          const translations={aspectRatio:'Соотношение сторон',enableTranslation:'Перевод промпта на английский',quality:'Разрешение',outputFormat:'Формат результата',size:'Соотношение сторон',watermark:'Водяной знак',waterMark:'Водяной знак',safetyTolerance:'Уровень модерации',promptUpsampling:'Расширение промпта',callBackUrl:'URL обратного вызова (если используется)'};
          if(translations[f.key]) f.label=translations[f.key];
        }
        if(adapter === 'runway') {
          Object.assign(inputSchema.properties.duration,{enum:[5,10],default:5});
          Object.assign(inputSchema.properties.quality,{enum:['720p','1080p'],default:'720p'});
          for(const key of ['duration','quality']) Object.assign(fields.find(f=>f.key===key),{type:'select',options:inputSchema.properties[key].enum,default:inputSchema.properties[key].default});
        }
        if(adapter === 'veo') {
          fields.splice(fields.findIndex(f=>f.key==='imageUrls'),1); delete inputSchema.properties.imageUrls;
          if(mode === 'FIRST_AND_LAST_FRAMES_2_VIDEO') {
            for(const [key,label,required] of [['firstFrame','Начальный кадр',true],['lastFrame','Конечный кадр',false]]) {
              inputSchema.properties[key]={type:'string'}; if(required)inputSchema.required.push(key);
              fields.splice(1,0,{key,label,required,type:'files',scalar:true,maxFiles:1,accept:'image/*'});
            }
          } else if(mode === 'REFERENCE_2_VIDEO') {
            inputSchema.properties.imageUrls={type:'array',items:{type:'string'},minItems:1,maxItems:3}; inputSchema.required.push('imageUrls');
            fields.splice(1,0,{key:'imageUrls',label:'Референсные изображения',required:true,type:'files',maxFiles:3,accept:'image/*'});
            Object.assign(inputSchema.properties.duration,{enum:[8],default:8});
            Object.assign(fields.find(f=>f.key==='duration'),{options:[8],default:8});
          }
        }
        const names={veo3:'Veo 3.1 Quality',veo3_fast:'Veo 3.1 Fast',veo3_lite:'Veo 3.1 Lite','gpt4o-image':'GPT 4o Image',runway:'Runway','flux-kontext-pro':'Flux Kontext Pro','flux-kontext-max':'Flux Kontext Max'};
        const suffix={TEXT_2_VIDEO:'Текст → видео',FIRST_AND_LAST_FRAMES_2_VIDEO:'Начальный / конечный кадр',REFERENCE_2_VIDEO:'Референсы → видео'};
        const apiModel=mode==='default'? variant : `${variant}:${mode}`;
        result.push({id:`kie:${apiModel}`,providerId:'kie',apiModel,wireModel:schema.properties.model ? variant : null,adapter,createPath,taskPath,mode,kind,name:`${names[variant]}${suffix[mode]?' · '+suffix[mode]:''}`,description:'Отдельный API Kie.ai',source,inputSchema,fields,pricing:{type:'reported',label:'Стоимость до запуска пока не подключена'}});
      }
    }
  }
  await fs.writeFile('src/kie-special.json',JSON.stringify(result,null,2));
  console.log(`Imported ${result.length} model/mode combinations`);
}
run().catch(e=>{console.error(e);process.exitCode=1});
