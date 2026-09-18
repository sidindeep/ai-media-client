const {History}=require('./history');
const {randomUUID}=require('node:crypto');
class PromptTemplates {
  constructor(file,store){this.store=store||new History(file);}
  async list(){return (await this.store.list()).filter(row=>!row.deleted);}
  async save({id,name,text}){
    if(typeof name!=='string'||!name.trim()||name.length>120)throw new Error('Введите название до 120 символов');
    if(typeof text!=='string'||!text.trim()||text.length>200000)throw new Error('Введите текст шаблона до 200 000 символов');
    if(id&&!(await this.list()).some(row=>row.id===id))throw new Error('Шаблон не найден');
    return this.store.update(id||randomUUID(),{name:name.trim(),text,deleted:false});
  }
  async remove(id){
    if(!(await this.list()).some(row=>row.id===id))throw new Error('Шаблон не найден');
    await this.store.update(id,{deleted:true});
  }
}
module.exports={PromptTemplates};
