const {test}=require('node:test');
const assert=require('node:assert/strict');
const Ajv=require('ajv');
const {models}=require('../src/catalog');
const {buildRequest}=require('../src/adapters');
test('Wan frame strings replace empty objects and reference conflicts are rejected',()=>{
  for(const id of ['wan/3-0-video','wan/3-0-video-prime']){
    const model=models.find(m=>m.apiModel===id);
    const validate=new Ajv({strict:false,validateFormats:false}).compile(model.inputSchema);
    const input={prompt:'Scene',first_frame_url:'https://example.com/start.png'};
    assert.ok(validate(input),JSON.stringify(validate.errors));
    assert.equal(validate({...input,first_frame_url:{}}),false);
    assert.equal(model.fields.find(f=>f.key==='first_frame_url').type,'files');
    assert.throws(()=>buildRequest(model,{...input,reference_video_urls:['https://example.com/v.mp4']}));
  }
});
test('Kling documented single and multi shot request types',()=>{
  const model=models.find(m=>m.apiModel==='kling-3.0/video');
  const validate=new Ajv({strict:false,validateFormats:false}).compile(model.inputSchema);
  const input={prompt:'Scene',duration:'5',mode:'pro',multi_shots:false,sound:false};
  assert.ok(validate(input));assert.equal(buildRequest(model,input).input.duration,'5');
  const multi={duration:'5',mode:'pro',multi_shots:true,multi_prompt:[{prompt:'Shot one',duration:3},{prompt:'Shot two',duration:2}]};
  assert.ok(validate(multi));assert.doesNotThrow(()=>buildRequest(model,multi));
  assert.throws(()=>buildRequest(model,{...multi,image_urls:['https://example.com/a','https://example.com/b']}));
  assert.throws(()=>buildRequest(model,{...multi,multi_prompt:[]}));
});
