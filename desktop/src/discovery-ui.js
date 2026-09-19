// Presentation-only discovery controls for the generation workspace.
// Model schemas, queue rules and persistence remain owned by the existing renderer/domain modules.
(function discoveryUi(root){
  const scenarios=[
    {id:'product-hero',kind:'image',label:'Предметный hero-shot',hint:'Чистый коммерческий кадр',prompt:'Премиальный предметный кадр для лендинга: главный объект в центре, мягкий студийный свет, выразительная тень, чистый фон, фотореалистичная детализация.'},
    {id:'editorial-portrait',kind:'image',label:'Редакционный портрет',hint:'Обложка и соцсети',prompt:'Редакционный портрет человека с характером: естественная поза, выразительный свет, аккуратный фон, современная журнальная эстетика, высокая детализация.'},
    {id:'world-building',kind:'image',label:'Мир и атмосфера',hint:'Концепт-арт сцены',prompt:'Кинематографичная сцена с сильной атмосферой: ясный главный объект, продуманный передний и задний план, выразительный свет, богатая цветовая палитра, ощущение истории.'},
    {id:'cinematic-motion',kind:'video',label:'Кинематографичный клип',hint:'Движение и камера',prompt:'Короткий кинематографичный клип: плавное движение камеры вокруг героя, естественная физика, выразительный свет, аккуратный монтажный ритм, финальный кадр читается ясно.'},
    {id:'social-loop',kind:'video',label:'Социальный loop',hint:'Вертикальный формат',prompt:'Динамичный вертикальный ролик для социальных сетей: один понятный визуальный хук, быстрый, но плавный переход, выразительное действие, аккуратный финальный loop.'},
    {id:'before-after',kind:'video',label:'До → после',hint:'Трансформация',prompt:'Покажи убедительную визуальную трансформацию от исходного состояния к результату: плавный переход, стабильная композиция, одинаковая точка наблюдения, заметный финальный контраст.'}
  ];

  function renderScenarios(container, kind, onSelect){
    if(!container)return;
    const visible=scenarios.filter(item=>kind==='video'?item.kind==='video':item.kind==='image');
    container.replaceChildren(...visible.map(item=>{
      const button=document.createElement('button');
      button.type='button';button.className='scenario-card';button.dataset.scenarioId=item.id;
      const title=document.createElement('strong');title.textContent=item.label;
      const hint=document.createElement('span');hint.textContent=item.hint;
      button.append(title,hint);button.onclick=()=>onSelect(item);return button;
    }));
  }

  function renderModels(container, models, selectedId, onSelect){
    if(!container)return;
    const visible=models.slice(0,6);
    container.replaceChildren(...visible.map(model=>{
      const card=document.createElement('article');card.className='model-card';
      if(model.id===selectedId)card.classList.add('is-selected');
      const button=document.createElement('button');button.type='button';button.className='model-card-select';button.title=`Выбрать ${model.name}`;button.onclick=()=>onSelect(model);
      const kind=document.createElement('span');kind.className='model-card-kind';kind.textContent=model.kind==='video'?'VIDEO':'IMAGE';
      const name=document.createElement('strong');name.textContent=model.name;
      const description=document.createElement('span');description.className='model-card-description';description.textContent=model.description||'Универсальная модель для генерации медиа.';
      const footer=document.createElement('span');footer.className='model-card-footer';footer.textContent=model.pricing?.label||'Стоимость уточняется перед запуском';
      button.append(kind,name,description,footer);card.append(button);container.append(card);return card;
    }));
    if(!visible.length){const empty=document.createElement('p');empty.className='hint';empty.textContent='По текущему фильтру модели не найдены.';container.append(empty);}
  }

  root.discoveryUi={renderScenarios,renderModels,scenarios};
})(window);
