// Object URLs live only while their thumbnail is attached to the form.
const sourceObjectUrls=new Map();
new MutationObserver(()=>{
  for(const [element,url] of sourceObjectUrls)if(!element.isConnected){URL.revokeObjectURL(url);sourceObjectUrls.delete(element);}
}).observe(document.body,{childList:true,subtree:true});
window.showSourceThumbnails=async(holder,files,onRemove)=>{
  const revision={};holder.previewRevision=revision;holder.replaceChildren();
  for(const [index,file] of files.entries()){
    const item=document.createElement('figure');
    const caption=document.createElement('figcaption');caption.textContent=file.name||'Сохранённый исходник';
    item.append(caption);
    if(onRemove){
      const remove=document.createElement('button');remove.type='button';remove.className='source-thumbnail-remove';remove.textContent='×';remove.title=`Удалить ${file.name||'исходник'}`;remove.setAttribute('aria-label',remove.title);
      remove.onclick=event=>{event.preventDefault();event.stopPropagation();onRemove(index,file);};item.append(remove);
    }
    holder.append(item);
    const kind=(file.type||'').split('/')[0];
    if(!['image','video','audio'].includes(kind))continue;
    try{
      const url=file instanceof File?URL.createObjectURL(file):await window.desktop.sourcePreview(file.ref);
      if(holder.previewRevision!==revision||!item.isConnected){if(file instanceof File)URL.revokeObjectURL(url);continue;}
      if(file instanceof File)sourceObjectUrls.set(item,url);
      const media=document.createElement(kind==='image'?'img':kind);media.src=url;
      if(kind==='image')media.alt=file.name||'Исходник';else {media.controls=true;media.preload='metadata';}
      media.onerror=()=>{caption.textContent=(file.name||'Исходник')+' · предпросмотр недоступен';};
      item.prepend(media);
    }catch{caption.textContent=(file.name||'Исходник')+' · файл не найден';}
  }
};
