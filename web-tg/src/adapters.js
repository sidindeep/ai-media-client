const errors=require('./provider-errors');
const trace=require('./generation-log');
function buildRequest(model, input) {
  if(['wan/3-0-video','wan/3-0-video-prime'].includes(model.apiModel)) {
    if((input.first_frame_url||input.last_frame_url)&&Object.keys(input).some(k=>k.startsWith('reference_')&&input[k]?.length)) throw new Error('Wan: кадры нельзя совмещать с референсами');
    if(input.reference_file_urls?.length&&input.reference_link_urls?.length) throw new Error('Wan: выберите документ или ссылку');
    if(input.duration!==undefined&&input.duration!==-1&&(!Number.isInteger(input.duration)||input.duration<2||input.duration>30)) throw new Error('Wan: длительность 2–30 секунд или -1 для автоматического выбора');
  }
  if(model.apiModel==='kling-3.0/video') {
    if(input.multi_shots) {
      if(!input.multi_prompt?.length) throw new Error('Kling: добавьте сцены');
      if(input.image_urls?.length>1) throw new Error('Kling: для нескольких сцен разрешён только начальный кадр');
    } else if(!input.prompt?.trim()) throw new Error('Kling: заполните промпт');
    const names=(input.kling_elements||[]).map(e=>e.name);
    if(new Set(names).size!==names.length) throw new Error('Kling: имена персонажей должны быть уникальными');
    for(const element of input.kling_elements||[])if(element.start_time!==undefined&&element.end_time!==undefined&&element.end_time<=element.start_time)throw new Error('Kling: конец фрагмента должен быть позже начала');
  }
  if (!model.adapter) return {model:model.apiModel,input};
  const body={...input};
  if(model.wireModel) body.model=model.wireModel;
  if(model.adapter==='veo') {
    body.generationType=model.mode;
    if(model.mode==='FIRST_AND_LAST_FRAMES_2_VIDEO') {
      if(!body.firstFrame) throw new Error('Выберите начальный кадр');
      body.imageUrls=[body.firstFrame,...(body.lastFrame?[body.lastFrame]:[])];
    }
    delete body.firstFrame;delete body.lastFrame;
    if(model.mode==='TEXT_2_VIDEO') delete body.imageUrls;
  }
  if(model.adapter==='runway') {
    if(body.duration===10 && body.quality==='1080p') throw new Error('Runway: для 10 секунд выберите 720p');
    if(!body.imageUrl && !body.aspectRatio) throw new Error('Runway: выберите соотношение сторон');
  }
  if(model.adapter==='flux' && body.inputImage && body.safetyTolerance>2) throw new Error('Flux: для редактирования уровень модерации должен быть от 0 до 2');
  if(model.adapter==='4o' && !body.prompt?.trim() && !body.filesUrl?.length) throw new Error('Укажите промпт или загрузите изображение');
  return body;
}
function providerDuration(data){
  const raw=Number(data.costTime);
  if(!Number.isFinite(raw)||raw<0)return null;
  const created=Number(data.createTime),completed=Number(data.completeTime),elapsed=completed-created;
  if(Number.isFinite(elapsed)&&elapsed>=0)return Math.abs(raw*1000-elapsed)<Math.abs(raw-elapsed)?raw*1000:raw;
  return raw<1000?raw*1000:raw;
}
function normalizeTask(model, data) {
  if(!data || typeof data!=='object') throw new Error('API вернул некорректные данные задачи');
  const duration=providerDuration(data);
  const providerTiming=duration===null?{}:{providerDurationMs:duration};
  if(!model.adapter) return {...data,...providerTiming,kind:model.kind,...(data.state==='fail'?{failMsg:errors.safe(trace.clean(data.failMsg||data.errorMessage)),errorInfo:errors.classify({code:data.failCode??data.errorCode,message:trace.clean(data.failMsg||data.errorMessage),taskId:data.taskId})}:{})};
  let state;
  if(model.adapter==='runway') state=({wait:'waiting',queueing:'queuing'})[data.state] || data.state;
  else state=({0:'generating',1:'success',2:'fail',3:'fail'})[data.successFlag] || ({GENERATING:'generating',SUCCESS:'success',CREATE_TASK_FAILED:'fail',GENERATE_FAILED:'fail'})[data.status];
  if(!state) throw new Error('Неизвестный статус задачи; повторите проверку позже');
  let urls=[];
  if(model.adapter==='runway') urls=data.videoInfo?.videoUrl ? [data.videoInfo.videoUrl] : [];
  else if(model.adapter==='flux') urls=data.response?.resultImageUrl ? [data.response.resultImageUrl] : [];
  else urls=data.response?.resultUrls || [];
  return {taskId:data.taskId,state,kind:model.kind,resultJson:JSON.stringify({resultUrls:urls}),failCode:data.failCode??data.errorCode,failMsg:errors.safe(trace.clean(data.errorMessage||data.failMsg)),...(state==='fail'?{errorInfo:errors.classify({code:data.failCode??data.errorCode,message:trace.clean(data.errorMessage||data.failMsg),taskId:data.taskId})}:{}),creditsConsumed:data.creditsConsumed,progress:model.adapter==='4o' && data.progress!=null ? Math.round(Number(data.progress)*100) : data.progress,...providerTiming};
}
module.exports={buildRequest,normalizeTask};
