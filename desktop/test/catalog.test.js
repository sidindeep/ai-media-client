const { test } = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');
const { models } = require('../src/catalog');

test('every imported model has a compilable input schema and distinct identity', () => {
  const ajv = new Ajv({ strict:false, validateFormats:false });
  assert.equal(new Set(models.map(m=>m.id)).size, models.length);
  for (const model of models) {
    if (model.inputSchema) ajv.compile(model.inputSchema);
    assert.ok(['image','video','audio'].includes(model.kind));
  }
});

test('Kling keeps first and last frame distinct and duration as a string', () => {
  const model = models.find(m=>m.apiModel === 'kling/v2-1-pro');
  assert.equal(model.fields.find(f=>f.key === 'image_url').scalar, true);
  assert.equal(model.fields.find(f=>f.key === 'image_url').label, 'Начальный кадр');
  assert.equal(model.fields.find(f=>f.key === 'tail_image_url').label, 'Конечный кадр');
  const validate = new Ajv({strict:false,validateFormats:false}).compile(model.inputSchema);
  assert.ok(validate({prompt:'A moving camera', image_url:'https://example.com/start.png', duration:'5'}));
  assert.equal(validate({prompt:'A moving camera', image_url:'https://example.com/start.png', duration:5}), false);
});

test('audio catalog exposes Kie speech, music and audio uploads', () => {
  const audio = models.filter(model => model.kind === 'audio');
  assert.equal(audio.length, 27);
  assert.ok(audio.some(model => model.apiModel === 'elevenlabs/text-to-speech-turbo-2-5'));
  assert.ok(audio.some(model => model.apiModel === 'ai-music-api/generate'));
  assert.ok(audio.some(model => model.apiModel === 'ai-music-api/sounds'));
  assert.equal(audio.find(model => model.apiModel === 'elevenlabs/audio-isolation').fields.find(field => field.key === 'audio_url').type, 'files');
  assert.equal(audio.find(model => model.apiModel === 'ai-music-api/upload-and-cover-audio').fields.find(field => field.key === 'upload_url').accept, 'audio/*');
});

test('Kling 2.5 image mode exposes both frames and CFG; every file field has a limit',()=>{
  const model=models.find(m=>m.apiModel==='kling/v2-5-turbo-image-to-video-pro');
  assert.ok(model);
  assert.deepEqual(model.fields.filter(f=>f.type==='files').map(f=>[f.key,f.maxFiles]),[['image_url',1],['tail_image_url',1]]);
  const cfg=model.fields.find(f=>f.key==='cfg_scale');assert.equal(cfg.min,0);assert.equal(cfg.max,1);assert.equal(cfg.step,0.1);
  for(const item of models.flatMap(m=>m.fields.filter(f=>f.type==='files').map(f=>({model:m.apiModel,field:f}))))assert.ok(Number.isInteger(item.field.maxFiles)&&item.field.maxFiles>0,`${item.model}: ${item.field.key}`);
});
