window.attachChoiceButtons=function(select){
  if(select.options.length<2||select.options.length>12)return;
  const group=document.createElement('div');group.className='choice-buttons';group.setAttribute('role','group');
  group.setAttribute('aria-label',select.closest('.field,.structured-field')?.querySelector('label')?.textContent||'Выбор параметра');
  select.after(group);select.classList.add('choice-source');select.tabIndex=-1;select.setAttribute('aria-hidden','true');
  const buttons=[...select.options].map(option=>{
    const button=document.createElement('button');button.type='button';button.textContent=option.textContent;button.dataset.value=option.value;
    button.onclick=()=>{if(select.disabled)return;select.value=option.value;select.dispatchEvent(new Event('change',{bubbles:true}));};group.append(button);return button;
  });
  select.syncChoices=()=>buttons.forEach(button=>{const active=button.dataset.value===select.value;button.classList.toggle('selected',active);button.setAttribute('aria-pressed',String(active));button.disabled=select.disabled;});
  select.addEventListener('change',select.syncChoices);select.addEventListener('input',select.syncChoices);select.syncChoices();
};
