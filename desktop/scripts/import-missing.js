const fs=require('node:fs/promises');
const YAML=require('yaml');
const {get}=require('./import-kie');
async function run(){
  const models=JSON.parse(await fs.readFile('src/kie-models.json','utf8'));
  const report=JSON.parse(await fs.readFile('src/kie-import-report.json','utf8'));
  const fixed=[];
  for(const entry of report.skipped.filter(e=>e.reason==='Не найдена схема input')){
    const text=await get(entry.url);const spec=YAML.parse(text.match(/```yaml\s*\n([\s\S]*?)```/)[1]);
    const op=spec.paths['/api/v1/jobs/createTask'].post;
    const schema=op.requestBody?.content?.['application/json']?.schema;
    const input=schema?.properties?.input;
    const apiModel=schema?.properties?.model?.default||schema?.properties?.model?.enum?.[0];
    if(!apiModel||!(input?.oneOf||input?.anyOf)) {console.log('Still missing schema:',entry.url);continue;}
    const model={id:`kie:${apiModel}`,providerId:'kie',apiModel,name:op.summary,kind:/Video/.test((op.tags||[]).join(' '))?'video':'image',description:op.summary,source:entry.url,inputSchema:input,pricing:{type:'reported',label:'Стоимость до запуска пока не подключена'},fields:[{key:'__input',label:'Режим генерации',required:true,type:'json',schema:input}]};
    const index=models.findIndex(m=>m.id===model.id);if(index<0)models.push(model);else models[index]=model;fixed.push(entry.url);
  }
  await fs.writeFile('src/kie-models.json',JSON.stringify(models,null,2));
  report.skipped=report.skipped.filter(e=>!fixed.includes(e.url));report.count=models.length;report.updatedAt=new Date().toISOString();
  await fs.writeFile('src/kie-import-report.json',JSON.stringify(report,null,2));
  console.log('Added alternative schemas:',fixed.length);
}
run().catch(error=>{console.error(error);process.exitCode=1});
