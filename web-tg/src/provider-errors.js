((root,factory)=>{const api=factory();if(typeof module==='object')module.exports=api;else root.providerErrors=api;})(globalThis,()=>{
  function safe(value){return String(value??'').replace(/https?:\/\/[^\s"<>]+/gi,'[ссылка скрыта]').replace(/Bearer\s+[^\s"']+/gi,'Bearer [скрыто]').replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}/g,'[токен скрыт]').replace(/((?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*)[^\s,;]+/gi,'$1[скрыто]').slice(0,1500);}
  function classify({code,message,taskId,stage='generation',outcome}={}){
    const raw=safe(message),number=Number(code);let category='unknown',text='Провайдер не сообщил точную причину ошибки.',action='Обратитесь в поддержку с ID задачи.',retryable=false;
    if(outcome==='unknown'){category='submission_unknown';text='Не удалось подтвердить отправку задачи. Она могла быть принята провайдером.';action='Проверьте историю Kie перед повторной отправкой.';}
    else if(number===524||/\btimeout\b|timed out/i.test(raw)){category='timeout';text='Провайдер не завершил обработку вовремя.';action='Попробуйте позже. Новый запуск может быть платным.';retryable=true;}
    else if(/content.*(?:violat|policy|blocked)|nsfw|moderation|inappropriate content|safety filter/i.test(raw)){category='content_policy';text='Провайдер отклонил содержимое запроса.';action='Проверьте промпт и исходники с учётом правил модели.';}
    else if(number===402||code==='INSUFFICIENT_CREDITS'||/insufficient credits?|credits? insufficient/i.test(raw)){category='credits';text='Недостаточно кредитов провайдера.';action='Пополните баланс перед новым запуском.';}
    else if(number===401||number===403){category='authorization';text='Провайдер отказал в доступе.';action='Проверьте ключ и права сервисного аккаунта.';}
    else if(number===429){category='rate_limit';text='Достигнут лимит запросов провайдера.';action='Подождите и повторите вручную.';retryable=true;}
    else if(number===422||/invalid (?:parameter|input)|unsupported (?:format|resolution)|max(?:imum)? .*(?:size|length)|file too large/i.test(raw)){category='validation';text='Провайдер отклонил параметры или исходный файл.';action='Исправьте данные согласно подробностям ошибки.';}
    else if(number===400){category='request_rejected';text='Провайдер отклонил запрос; причина требует уточнения.';action='Проверьте подробности ошибки. Код 400 сам по себе не доказывает нарушение контента.';}
    else if(code==='NETWORK_ERROR'||code==='TRANSPORT_ERROR'){category='connection';text='Не удалось получить ответ провайдера.';action=stage==='poll'?'Продолжим проверку существующей задачи без повторной отправки.':'Проверьте подключение.';retryable=stage==='poll';}
    else if(number>=500&&number<=599){category='provider_failure';text='Генерация завершилась ошибкой у провайдера.';action='Попробуйте позже или обратитесь в поддержку с ID задачи.';retryable=true;}
    if(stage==='poll')action='Проверка статуса не удалась. Задача продолжает проверяться; новую генерацию отправлять не нужно.';
    return {category,providerCode:code==null?null:safe(code),providerMessage:raw||null,message:text,action,retryable,automaticRetry:false,taskId:taskId||null,stage};
  }
  function forRecord(record){if(record.errorInfo)return record.errorInfo;if(!record.error&&!record.failMsg)return null;return classify({code:record.failCode??record.errorCode??record.failureCode,message:record.failMsg||record.error,taskId:record.taskId,stage:['waiting','queuing','generating'].includes(record.state)?'poll':'generation',outcome:record.state==='unknown'?'unknown':undefined});}
  function text(record){const e=forRecord(record);return e?`${e.message} ${e.action}${e.providerCode?' Код: '+e.providerCode+'.':''}${e.providerMessage?' Детали Kie: '+e.providerMessage:''}${e.taskId?' · ID: '+e.taskId:''}`:'';}
  return {safe,classify,forRecord,text};
});
