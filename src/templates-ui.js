window.attachPromptTemplates=(holder,input)=>{
  const actions=document.createElement('div');actions.className='inline prompt-template-actions';
  for(const [label,mode]of [['Сохранить шаблон','save'],['Мои шаблоны','browse']]){
    const button=document.createElement('button');button.type='button';button.textContent=label;
    button.onclick=()=>openPromptLibrary(input,mode);actions.append(button);
  }
  holder.append(actions);
};
async function openPromptLibrary(target,mode){
  const dialog=document.createElement('dialog');dialog.className='prompt-library';
  const title=document.createElement('h2');title.textContent='Мои шаблоны промптов';
  const note=document.createElement('p');note.className='hint';note.textContent='Только ручное сохранение. Шаблон заменяет текст промпта, не меняя модель и исходники.';
  const search=document.createElement('input');search.type='search';search.placeholder='Поиск по названию или тексту, например: вертолёт';search.setAttribute('aria-label','Поиск шаблонов');
  const list=document.createElement('div');list.className='template-list';
  const editor=document.createElement('form');
  const name=document.createElement('input');name.required=true;name.maxLength=120;name.placeholder='Название шаблона';name.setAttribute('aria-label','Название шаблона');
  const body=document.createElement('textarea');body.required=true;body.maxLength=200000;body.placeholder='Текст промпта';body.setAttribute('aria-label','Текст шаблона');
  const save=document.createElement('button');save.type='submit';save.textContent='Сохранить новый шаблон';
  const fresh=document.createElement('button');fresh.type='button';fresh.textContent='Новый из текущего промпта';
  const close=document.createElement('button');close.type='button';close.textContent='Закрыть';close.onclick=()=>dialog.close();
  const status=document.createElement('p');status.role='status';
  let rows=[],editing=null,busy=false;
  const normalize=value=>value.toLocaleLowerCase('ru-RU').replaceAll('ё','е');
  function render(){
    const query=normalize(search.value.trim());list.replaceChildren();
    for(const row of rows.filter(r=>normalize(r.name+' '+r.text).includes(query))){
      const item=document.createElement('article');item.className='queue-task';
      const label=document.createElement('strong');label.textContent=row.name;
      const textDetails=document.createElement('details');textDetails.className='template-text';
      const textSummary=document.createElement('summary');textSummary.textContent='Показать текст промпта';
      const preview=document.createElement('p');preview.textContent=row.text;
      textDetails.append(textSummary,preview);
      const use=document.createElement('button');use.type='button';use.textContent='Подставить';use.disabled=busy;
      use.onclick=()=>{
        if(target.maxLength>=0&&row.text.length>target.maxLength){status.textContent=`Шаблон длиннее лимита этой модели (${target.maxLength} символов). Отредактируйте текст.`;return;}
        if(target.value.trim()&&target.value!==row.text&&!confirm('Заменить текущий промпт выбранным шаблоном?'))return;
        target.value=row.text;target.dispatchEvent(new Event('input',{bubbles:true}));dialog.close();target.focus();
      };
      const edit=document.createElement('button');edit.type='button';edit.textContent='Редактировать';edit.disabled=busy;edit.onclick=()=>{editing=row.id;name.value=row.name;body.value=row.text;save.textContent='Сохранить изменения';name.focus();};
      const remove=document.createElement('button');remove.type='button';remove.textContent='Удалить';remove.disabled=busy;
      remove.onclick=async()=>{if(!confirm(`Удалить шаблон «${row.name}» из библиотеки?`))return;await operation(async()=>{await window.desktop.removeTemplate(row.id);if(editing===row.id)reset();});};
      const itemActions=document.createElement('div');itemActions.className='template-item-actions';itemActions.append(use,edit,remove);
      item.append(label,itemActions,textDetails);list.append(item);
    }
    if(!list.children.length)list.textContent=query?'Ничего не найдено':'Пока нет сохранённых шаблонов';
  }
  function reset(){editing=null;name.value='';body.value=target.value;save.textContent='Сохранить новый шаблон';}
  async function operation(action){
    if(busy)return;busy=true;save.disabled=fresh.disabled=true;render();
    try{await action();rows=await window.desktop.listTemplates();status.textContent='Библиотека обновлена';}
    catch(error){status.textContent=error.message;}
    finally{busy=false;save.disabled=fresh.disabled=false;render();}
  }
  editor.onsubmit=event=>{event.preventDefault();void operation(async()=>{const row=await window.desktop.saveTemplate({id:editing,name:name.value,text:body.value});editing=row.id;save.textContent='Сохранить изменения';});};
  fresh.onclick=reset;search.oninput=render;
  editor.append(name,body,save,fresh);dialog.append(title,note,search,list,editor,status,close);
  dialog.addEventListener('close',()=>dialog.remove(),{once:true});document.body.append(dialog);reset();dialog.showModal();
  try{rows=await window.desktop.listTemplates();render();if(mode==='save')name.focus();else search.focus();}catch(error){status.textContent=error.message;}
}
