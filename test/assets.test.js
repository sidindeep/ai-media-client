const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {Assets}=require('../src/assets');
async function temp(work){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ai-assets-test-'));try{await work(new Assets(dir),dir);}finally{for(const name of await fs.readdir(dir))await fs.unlink(path.join(dir,name));await fs.rmdir(dir);}}
test('sources persist after restart, nested references reupload once per task and on every repeat',()=>temp(async(assets,dir)=>{
  const file=await assets.save({name:'picture.png',type:'image/png',bytes:new Uint8Array([1,2,3])});
  const reopened=new Assets(dir);const input={images:[file.ref],elements:[{url:file.ref}],prompt:'Scene'};let count=0;
  const upload=async data=>{assert.deepEqual([...data.bytes],[1,2,3]);return 'https://provider.example/'+(++count);};
  const first=await reopened.resolve(input,[file],upload);assert.equal(first.images[0],first.elements[0].url);assert.equal(count,1);
  const second=await reopened.resolve(input,[file],upload);assert.equal(count,2);assert.notEqual(first.images[0],second.images[0]);assert.equal(input.images[0],file.ref);
}));
test('duplicate sources do not duplicate bytes; missing and corrupt files fail before upload',()=>temp(async(assets,dir)=>{
  const [a,b]=await Promise.all([assets.save({name:'a',bytes:[4,5]}),assets.save({name:'b',bytes:[4,5]})]);assert.equal(a.ref,b.ref);assert.equal((await fs.readdir(dir)).length,1);
  let uploads=0;await fs.writeFile(path.join(dir,assets.id(a.ref)),Buffer.from([0]));await assert.rejects(assets.resolve([a.ref],[a],async()=>{uploads++;}),/повреждён/);assert.equal(uploads,0);
  await fs.unlink(path.join(dir,assets.id(a.ref)));await assert.rejects(assets.resolve([a.ref],[a],async()=>{}),/не найден/);
}));
