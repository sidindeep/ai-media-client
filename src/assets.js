const trace = require('./generation-log');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash,randomUUID} = require('node:crypto');
const prefix = 'https://local-assets.invalid/';
class Assets {
  constructor(directory) { this.directory=directory; this.uploads=new Map(); }
  id(value) { return typeof value==='string' && /^https:\/\/local-assets\.invalid\/[a-f0-9]{64}$/.test(value) ? value.slice(prefix.length) : null; }
  async save(file) {
    const bytes=Buffer.from(file.bytes);
    if(!bytes.length) throw new Error('Исходный файл пуст');
    const id=createHash('sha256').update(bytes).digest('hex');
    await fs.mkdir(this.directory,{recursive:true});
    const temporary=path.join(this.directory,`${id}-${randomUUID()}.part`);
    try {
      await fs.writeFile(temporary,bytes,{flag:'wx'});
      try {await fs.link(temporary,path.join(this.directory,id));}
      catch(error){if(error.code!=='EEXIST')throw error;}
    } finally {await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
    // Names are display-only: never use user filenames as filesystem paths.
    return {ref:prefix+id,name:path.basename(file.name || 'source'),type:file.type||'application/octet-stream',size:bytes.length};
  }
  async resolve(input, metadata, upload) {
    const cache=new Map();
    const visit=async value=>{
      const id=this.id(value);
      if(id) {
        if(!cache.has(id)) cache.set(id,(async()=>{
          const meta=metadata.find(item=>item.ref===value);
          if(!meta)throw new Error('Не найдены сведения о сохранённом исходнике');
          const key=`${id}:${meta.type}:${path.extname(meta.name).toLowerCase()}`;
          const cached=this.uploads.get(key);
          if(cached) {
            trace.write('source.upload.cache_hit',{ref:value,name:meta.name,size:meta.size,type:meta.type});
            return cached;
          }
          // Register the whole read/verify/upload operation before its first
          // await. Otherwise two queue items can both finish reading and start
          // duplicate provider uploads before either one enters the map.
          const operation=(async()=>{
            trace.write('source.read',{ref:value,name:meta.name,size:meta.size,type:meta.type});
            let bytes;try{bytes=await fs.readFile(path.join(this.directory,id));}catch(error){if(error.code==='ENOENT')throw new Error(`Исходник «${meta.name}» не найден. Выберите файл заново.`);throw error;}
            if(createHash('sha256').update(bytes).digest('hex')!==id)throw new Error(`Исходник «${meta.name}» повреждён. Выберите файл заново.`);
            trace.write('source.verified',{ref:value,bytes:bytes.length});
            return trace.step('source.upload',{ref:value,name:meta.name,size:bytes.length,type:meta.type},()=>upload({...meta,bytes}));
          })();
          this.uploads.set(key,operation);
          try { return await operation; }
          finally { if(this.uploads.get(key)===operation)this.uploads.delete(key); }
        })());
        return cache.get(id);
      }
      if(Array.isArray(value))return Promise.all(value.map(visit));
      if(value && typeof value==='object'){const entries=await Promise.all(Object.entries(value).map(async([key,v])=>[key,await visit(v)]));return Object.fromEntries(entries);}
      return value;
    };
    return visit(input);
  }
}
module.exports={Assets,prefix};
