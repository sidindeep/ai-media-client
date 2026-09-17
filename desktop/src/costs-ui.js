let creditRate=0.51,tariffData={rows:[]},kieAccountEstimate=null,kieQuoteTimer,kieQuoteSequence=0;
let priceAuditRunning=false,priceAuditStop=false,priceAuditData=null;
let tariffDescriptions={entries:{}};
let checkingKieAuth=false;
async function refreshKieAuth(){
  if(checkingKieAuth||!window.desktop.kieSessionStatus)return;
  checkingKieAuth=true;
  try{
    const status=await window.desktop.kieSessionStatus();
    const label=document.getElementById('kieAuthStatus');
    label.textContent=status.state==='signed-in'?(status.live?'✓ Вход в Kie выполнен':'✓ Вход был подтверждён — откройте Kie для повторной проверки'):status.state==='signed-out'?'Вход в Kie не выполнен':'Вход Kie: ещё не подтверждён. Откройте кабинет для проверки.';
    document.getElementById('openKieSession').textContent=status.state==='signed-in'?'Открыть кабинет Kie':'Войти / открыть Kie';
  }catch{document.getElementById('kieAuthStatus').textContent='Не удалось проверить вход Kie';}
  finally{checkingKieAuth=false;}
}
void refreshKieAuth();
setInterval(refreshKieAuth,4000);
window.addEventListener('focus',refreshKieAuth);
document.getElementById('refreshKieDiagnostics').onclick=async()=>{
  const labels={window_opened:'Открыто окно',navigation_allowed:'Переход разрешён',navigation_blocked:'Переход заблокирован приложением',popup_allowed:'Всплывающее окно разрешено',popup_blocked:'Всплывающее окно заблокировано приложением',page_loaded:'Страница загружена',load_failed:'Ошибка загрузки',renderer_stopped:'Процесс окна остановлен'};
  try{const rows=await window.desktop.kieSessionDiagnostics();document.getElementById('kieDiagnostics').value=rows.length?rows.map(row=>`${row.time} | ${labels[row.event]||'Событие'} | ${row.origin}${row.code!==undefined?' | код '+row.code:''}`).join('\n'):'Событий пока нет. Откройте окно Kie и повторите вход. Диагностика начнётся только в этой версии приложения.';}catch{document.getElementById('kieDiagnostics').value='Не удалось получить диагностику.';}
};
document.getElementById('openKieSession').onclick=async()=>{
  try{await window.desktop.openKieSession();}catch{document.getElementById('kieSessionStatus').textContent='Не удалось открыть Kie. Проверьте соединение и попробуйте снова.';}
};
document.getElementById('clearKieSession').onclick=async()=>{
  if(!confirm('Удалить сохранённый вход Kie на этом компьютере? Окна кабинета закроются. API-ключ, история и черновики останутся.'))return;
  try{await window.desktop.clearKieSession();await refreshKieAuth();document.getElementById('kieSessionStatus').textContent='Сохранённый вход удалён. API-ключ, история и черновики не изменены.';}catch{document.getElementById('kieSessionStatus').textContent='Не удалось удалить сессию Kie. Попробуйте ещё раз.';}
};
const formatCost=value=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(value);
function recordCostText(record){
  const value=costs.breakdown(record,creditRate);
  const estimate=value.estimate.credits===null?'Оценка: неизвестна':`Оценка: ${formatCost(value.estimate.credits)} кредитов · ${formatCost(value.estimate.rubles)} ₽${value.estimate.stale?' (тариф требует обновления)':''}`;
  const actual=value.actual.known?`Списано: ${formatCost(value.actual.credits)} кредитов · ${formatCost(value.actual.rubles)} ₽`:['queued','preparing','submitting','waiting','queuing','generating'].includes(record.state)?'Списание: ожидается ответ Kie':'Списание: неизвестно — Kie не сообщил стоимость';
  return estimate+' · '+actual+(record.rubPerCredit==null?' (рубли по текущему курсу)':'');
}
function refreshCostPreview(){
  if(!catalog)return;
  document.querySelectorAll('#fields select').forEach(select=>select.syncChoices?.());
  document.querySelectorAll('#fields [data-key="duration"]').forEach(input=>input.syncDuration?.());
  const model=selectedModel();const input={};
  for(const field of model?.fields||[]){
    if(field.key==='kling_elements'&&structured.get(field.key)?.element.querySelector('.structured-row'))input.kling_elements=[true];
    const element=$('fields').querySelector(`[data-key="${field.key}"]`);if(!element)continue;
    input[field.key]=field.type==='boolean'?element.checked:field.type==='files'?(element.files.length?Array.from(element.files,()=>true):restoredFiles[field.key]):element.value;
  }
  const estimate=costs.quote(model,input,tariffData);
  const description=tariffDescriptions.entries?.[model?.id];
  $('tariffDescription').textContent=description?.text||'Для этой модели тарифное описание пока не найдено. Это не означает бесплатную генерацию.';
  $('tariffDescriptionSource').textContent=description?`Оригинал Kie (английский). Источник: ${description.source}. Проверено: ${new Date(tariffDescriptions.checkedAt).toLocaleDateString('ru-RU')}. Это справочный тариф, не подтверждение суммы списания. Описания включены в сборку и обновляются отдельно от таблицы тарифов.`:'';
  kieAccountEstimate=null;
  const shown=estimate;
  $('estimatedCost').textContent=shown?`${kieAccountEstimate?'Расчёт кабинета Kie':'По тарифу Kie'}: ${formatCost(shown.credits)} кредитов · ${formatCost(costs.round(shown.credits*creditRate))} ₽${!kieAccountEstimate&&tariffData.stale?' · тарифы не обновлены':''}. Фактическое списание учитывается отдельно.`:'Стоимость до запуска не определена для этих параметров. Проверяю кабинет Kie…';
  clearTimeout(kieQuoteTimer);const sequence=++kieQuoteSequence;
  if(model?.providerId==='kie')kieQuoteTimer=setTimeout(async()=>{
    try{const result=await window.desktop.getKieSessionQuote({model:model.apiModel,input});if(sequence!==kieQuoteSequence)return;kieAccountEstimate=result;$('estimatedCost').textContent=result?`Расчёт кабинета Kie: ${formatCost(result.credits)} кредитов · ${formatCost(costs.round(result.credits*creditRate))} ₽. Фактическое списание учитывается отдельно.`:estimate?`По тарифу Kie: ${formatCost(estimate.credits)} кредитов · ${formatCost(costs.round(estimate.credits*creditRate))} ₽${tariffData.stale?' · тарифы не обновлены':''}. Фактическое списание учитывается отдельно.`:'Стоимость до запуска не определена для этих параметров. Это не означает бесплатную генерацию.';}
    catch{if(sequence===kieQuoteSequence)$('estimatedCost').textContent=estimate?`По тарифу Kie: ${formatCost(estimate.credits)} кредитов · ${formatCost(costs.round(estimate.credits*creditRate))} ₽. Кабинет Kie недоступен.`:'Стоимость до запуска не определена: кабинет Kie недоступен.';}
  },600);
}
function renderSpending(){
  const total=costs.summary(historyRecords,creditRate,$('spendPeriod').value);
  $('spendSummary').textContent=`Подтверждено API: ${formatCost(total.credits)} кредитов · ${formatCost(total.rubles)} ₽. Задач с указанным расходом: ${total.known}; без подтверждённого расхода: ${total.unknown}.${total.legacy?' Для '+total.legacy+' старых задач рубли рассчитаны по текущей цене кредита.':''}`;
  const audit=balanceAudit?.reconciliation,baseline=balanceAudit?.baseline,current=balanceAudit?.current;
  if(!audit||!baseline||!current||baseline.at===current.at){
    $('balanceAudit').textContent='Сверка по балансу начнётся после следующего обновления баланса.';
  }else{
    const difference=Math.abs(audit.difference)<0.01?0:audit.difference;
    const verdict=difference===0?'расход совпадает':difference>0?`по балансу списано на ${formatCost(difference)} кредита больше`:`по балансу списано на ${formatCost(Math.abs(difference))} кредита меньше`;
    const unknown=Math.max(0,(current.unknown||0)-(baseline.unknown||0));
    $('balanceAudit').textContent=`Сверка с ${new Date(baseline.at).toLocaleString('ru-RU')}: по балансу ${formatCost(audit.balanceSpent)} кредита · по данным задач ${formatCost(audit.apiSpent)} кредита — ${verdict}.${unknown?` Новых задач без указанного расхода: ${unknown}.`:''}`;
  }
  $('spendModels').replaceChildren(...total.models.map(row=>{const p=document.createElement('p');p.textContent=`${row.name}: ${formatCost(row.credits)} кредитов · ${formatCost(row.rubles)} ₽`;return p;}));
}
function renderPriceAudit(data=priceAuditData){
  priceAuditData=data;if(!data?.results?.length)return;
  const counts={match:0,mismatch:0,confirmed:0,'tariff-only':0,unavailable:0};
  for(const row of data.results)counts[row.status]=(counts[row.status]||0)+1;
  const accountModels=new Set(data.results.filter(row=>['match','mismatch','confirmed'].includes(row.status)).map(row=>row.modelId));
  $('priceAuditSummary').textContent=`Последняя проверка: ${new Date(data.checkedAt).toLocaleString('ru-RU')}. Проверено вариантов: ${data.results.length}. Кабинет Kie вернул цену для ${counts.match+counts.mismatch+counts.confirmed} вариантов, моделей: ${accountModels.size}/${catalog.models.filter(model=>model.providerId==='kie').length}. Совпало с локальным тарифом: ${counts.match}; расхождений: ${counts.mismatch}; только локальный тариф: ${counts['tariff-only']}; цена не получена: ${counts.unavailable}.`;
  const labels={mismatch:'Расхождение',unavailable:'Цена не получена','tariff-only':'Только локальный тариф'};
  const rows=data.results.filter(row=>labels[row.status]).slice(0,500).map(row=>{
    const element=document.createElement('div');element.className='price-audit-row';
    const account=row.accountCredits===null?'—':`${formatCost(row.accountCredits)} кр.`;const local=row.localCredits===null?'—':`${formatCost(row.localCredits)} кр.`;
    element.textContent=`${labels[row.status]} · ${row.modelName} · кабинет: ${account} · тариф: ${local}`;return element;
  });
  $('priceAuditReport').replaceChildren(...rows);
}
async function savePriceAudit(results){
  priceAuditData=await window.desktop.savePriceAudit({version:1,checkedAt:new Date().toISOString(),results});renderPriceAudit();
}
async function runPriceAudit(){
  if(priceAuditRunning)return;priceAuditRunning=true;priceAuditStop=false;
  $('auditPrices').disabled=true;$('stopPriceAudit').disabled=false;
  try{
    const plan=window.priceAudit.plan(catalog.models,window.durationRules),previous=priceAuditData?.results||[];
    const saved=new Map(previous.map(row=>[row.key,row])),freshMs=7*86400000,results=[];
    $('priceAuditProgress').max=plan.length;$('priceAuditProgress').value=0;
    for(let index=0;index<plan.length;index++){
      if(priceAuditStop)break;
      const testCase=plan[index],cached=saved.get(testCase.key),cacheFresh=cached&&Date.now()-Date.parse(cached.checkedAt)<freshMs&&['match','mismatch','confirmed'].includes(cached.status);
      let row=cached;
      if(!cacheFresh){
        const model=catalog.models.find(item=>item.id===testCase.modelId);
        const account=await window.desktop.getKieSessionQuote({model:testCase.apiModel,input:testCase.input}).catch(()=>null);
        if(index===0&&!account&&(await window.desktop.kieSessionStatus().catch(()=>null))?.state==='signed-out')throw new Error('Вход в Kie не выполнен. Откройте кабинет Kie, войдите и запустите проверку снова.');
        const local=costs.quote(model,testCase.input,tariffData);
        row={key:testCase.key,modelId:testCase.modelId,modelName:testCase.modelName,status:window.priceAudit.compare(account,local),accountCredits:account?.credits??null,localCredits:local?.credits??null,checkedAt:new Date().toISOString()};
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      results.push(row);$('priceAuditProgress').value=index+1;
      $('priceAuditSummary').textContent=`Проверка цен: ${index+1} из ${plan.length} вариантов · ${testCase.modelName}`;
      if(results.length%10===0)await savePriceAudit(results);
    }
    await savePriceAudit(results);
    if(priceAuditStop)$('priceAuditSummary').textContent=`Проверка остановлена. Сохранено вариантов: ${results.length} из ${plan.length}. Нажмите кнопку ещё раз, чтобы продолжить.`;
  }catch(error){$('priceAuditSummary').textContent='Проверка цен остановлена: '+error.message;}
  finally{priceAuditRunning=false;$('auditPrices').disabled=false;$('stopPriceAudit').disabled=true;}
}
async function loadTariffs(force=false){
  $('refreshTariffs').disabled=true;
  try{tariffData=await window.desktop.getTariffs(force);$('tariffStatus').textContent=`${tariffData.fetchedAt?'Тарифы от '+new Date(tariffData.fetchedAt).toLocaleString('ru-RU'):'Тарифы не загружены'}${tariffData.stale?' · обновление недоступно':''}. Источник: kie.ai/pricing. Расчёт: проверенные сочетания Nano Banana Pro/2/2 Lite, Grok 1.5, Kling 2.6/3.0, Veo 3.1, Hailuo 02/2.3, Seedance 1.5 Pro, Imagen 4, Seedream 4.5/5.0 Lite. Остальные параметры могут не поддерживаться.`;refreshCostPreview();}
  catch(error){$('tariffStatus').textContent=error.message;}
  finally{$('refreshTariffs').disabled=false;}
}
async function initCosts(){
  try{renderPriceAudit(await window.desktop.getPriceAudit());}catch{/* The first price audit has not been run yet. */}
  try{tariffDescriptions=await window.desktop.getTariffDescriptions();refreshCostPreview();}catch{/* Reference descriptions are optional; live rate calculations still work. */}
  try{const settings=await window.desktop.costSettings();creditRate=settings.rubPerCredit;$('creditPackRub').value=String(costs.round(creditRate*1000));refreshCostPreview();renderHistory();renderSpending();await loadTariffs();if(await window.desktop.autoPriceAudit())void runPriceAudit();}catch(error){setStatus('Настройки стоимости: '+error.message,true);}
}
document.getElementById('spendPeriod').onchange=renderSpending;
document.getElementById('refreshTariffs').onclick=()=>loadTariffs(true);
document.getElementById('auditPrices').onclick=runPriceAudit;
document.getElementById('stopPriceAudit').onclick=()=>{priceAuditStop=true;$('stopPriceAudit').disabled=true;};
document.getElementById('saveCreditRate').onclick=async()=>{
  const value=Number($('creditPackRub').value)/1000;
  try{const settings=await window.desktop.setCreditRate(value);creditRate=settings.rubPerCredit;refreshCostPreview();renderHistory();renderSpending();setStatus('Цена кредита сохранена. Стоимость уже добавленных задач не пересчитывается.');}catch(error){setStatus(error.message,true);}
};
document.addEventListener('input',event=>{if(event.target.closest('#fields'))refreshCostPreview();});
document.addEventListener('change',event=>{if(event.target.closest('#fields'))refreshCostPreview();});
