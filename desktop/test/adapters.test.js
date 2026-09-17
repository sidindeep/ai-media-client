const {test}=require('node:test');
const assert=require('node:assert/strict');
const {models}=require('../src/catalog');
const {buildRequest,normalizeTask}=require('../src/adapters');
const Ajv=require('ajv');
const find=(id)=>models.find(m=>m.apiModel===id);
test('Veo sends first and last frames in order without internal fields',()=>{
  const model=find('veo3_fast:FIRST_AND_LAST_FRAMES_2_VIDEO');
  const payload=buildRequest(model,{prompt:'Pan',firstFrame:'https://example.com/first.png',lastFrame:'https://example.com/last.png'});
  assert.deepEqual(payload,{prompt:'Pan',model:'veo3_fast',generationType:'FIRST_AND_LAST_FRAMES_2_VIDEO',imageUrls:['https://example.com/first.png','https://example.com/last.png']});
  assert.throws(()=>buildRequest(model,{lastFrame:'https://example.com/last.png'}));
});
test('Veo reference mode rejects 4 second clips and accepts 8 seconds',()=>{
  const model=find('veo3_fast:REFERENCE_2_VIDEO');
  const validate=new Ajv({strict:false,validateFormats:false}).compile(model.inputSchema);
  assert.equal(validate({prompt:'Scene',imageUrls:['https://example.com/ref.png'],duration:4}),false);
  assert.equal(validate({prompt:'Scene',imageUrls:['https://example.com/ref.png'],duration:8}),true);
});
test('special endpoints enforce cross-field constraints',()=>{
  assert.throws(()=>buildRequest(find('runway'),{duration:10,quality:'1080p'}));
  assert.throws(()=>buildRequest(find('gpt4o-image'),{size:'1:1'}));
  assert.throws(()=>buildRequest(find('flux-kontext-pro'),{inputImage:'https://example.com/a.png',safetyTolerance:6}));
});
test('different API responses normalize into the shared history format',()=>{
  const cases=[
    ['veo3:TEXT_2_VIDEO',{successFlag:1,response:{resultUrls:['https://example.com/video']}}],
    ['runway',{state:'success',videoInfo:{videoUrl:'https://example.com/video'}}],
    ['flux-kontext-pro',{successFlag:1,response:{resultImageUrl:'https://example.com/video'}}],
    ['gpt4o-image',{status:'SUCCESS',response:{resultUrls:['https://example.com/video']},progress:'1.00'}]
  ];
  for(const [id,response]of cases){const result=normalizeTask(find(id),response);assert.equal(result.state,'success');assert.deepEqual(JSON.parse(result.resultJson).resultUrls,['https://example.com/video']);}
  assert.equal(normalizeTask(find('gpt4o-image'),cases[3][1]).progress,100);
  assert.equal(normalizeTask(find('bytedance/seedance-1.5-pro'),{state:'success',costTime:'41400'}).providerDurationMs,41400);
  assert.equal(normalizeTask(find('bytedance/seedance-1.5-pro'),{state:'success',costTime:101,createTime:1000,completeTime:102672}).providerDurationMs,101000);
  assert.equal(normalizeTask(find('runway'),{state:'queueing'}).state,'queuing');
  assert.equal(normalizeTask(find('veo3:TEXT_2_VIDEO'),{successFlag:3,errorMessage:'Failed'}).state,'fail');
  assert.throws(()=>normalizeTask(find('gpt4o-image'),{}));
});
