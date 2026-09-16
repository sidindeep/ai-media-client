const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {PromptTemplates}=require('../src/prompt-templates');
test('manual templates persist exact text, edit by id and remove from library',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'prompt-templates-'));
  const filename=path.join(folder,'templates.json');
  try{
    const store=new PromptTemplates(filename);assert.deepEqual(await store.list(),[]);
    await assert.rejects(store.save({name:'',text:'text'}));
    const row=await store.save({name:'Вертолёт',text:'  Helicopter\nabove water  '});
    const reopened=new PromptTemplates(filename);assert.equal((await reopened.list())[0].text,'  Helicopter\nabove water  ');
    await reopened.save({id:row.id,name:'Полёт',text:'New prompt'});assert.equal((await reopened.list()).length,1);
    await reopened.remove(row.id);assert.deepEqual(await reopened.list(),[]);
    await assert.rejects(reopened.save({id:row.id,name:'Missing',text:'x'}));
  }finally{await fs.rm(folder,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
