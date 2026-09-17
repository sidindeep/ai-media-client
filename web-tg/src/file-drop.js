// Route dropped files through the same change event as the native file chooser.
window.attachFileDrop=function(input,options={}){
  const zone=document.createElement('div');zone.className='file-drop-zone';
  input.before(zone);zone.append(input);
  const picker=document.createElement('label');picker.className='file-picker';
  const caption=document.createElement('span');caption.textContent=input.multiple?'Выбрать файлы':'Выбрать файл';
  input.before(picker);picker.append(input,caption);
  const hint=document.createElement('small');hint.className='drop-hint';hint.textContent='Перетащите файлы сюда или нажмите «Выбрать файлы»';zone.append(hint);
  input.dropFiles=files=>{
    if(input.disabled)return;
    const incoming=Array.from(files);if(!incoming.length)return;
    const max=options.maxFiles??(input.multiple?Infinity:1);
    const combined=max===1?incoming:[...input.files,...incoming];
    const unique=combined.filter((file,i,all)=>all.findIndex(f=>f.name===file.name&&f.size===file.size&&f.lastModified===file.lastModified)===i);
    const accepted=input.accept.split(',').map(v=>v.trim().toLowerCase()).filter(Boolean);
    const mimeByExt={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif',mp4:'video/mp4',mov:'video/quicktime',webm:'video/webm',mp3:'audio/mpeg',wav:'audio/wav',m4a:'audio/mp4'};
    if(unique.length>max){setStatus(`Можно добавить не более ${max} файлов в это поле.`,true);return;}
    for(const file of unique){
      const mime=(file.type||mimeByExt[file.name.split('.').pop().toLowerCase()]||'').toLowerCase();
      if(accepted.length&&!accepted.some(a=>a.startsWith('.')?file.name.toLowerCase().endsWith(a):a.endsWith('/*')?mime.startsWith(a.slice(0,-1)):mime===a)){setStatus(`Неподходящий формат файла: ${file.name}`,true);return;}
      if(options.maxSizeMb&&file.size>options.maxSizeMb*1024*1024){setStatus(`${file.name}: максимум ${options.maxSizeMb} МБ`,true);return;}
    }
    const transfer=new DataTransfer();unique.forEach(file=>transfer.items.add(file));input.files=transfer.files;
    input.dispatchEvent(new Event('change',{bubbles:true}));
  };
  zone.addEventListener('dragover',event=>{if(!Array.from(event.dataTransfer?.types||[]).includes('Files')||input.disabled)return;event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='copy';zone.classList.add('drag-over');});
  zone.addEventListener('dragleave',event=>{if(!zone.contains(event.relatedTarget))zone.classList.remove('drag-over');});
  zone.addEventListener('drop',event=>{event.preventDefault();event.stopPropagation();zone.classList.remove('drag-over');input.dropFiles(event.dataTransfer.files);});
};
document.addEventListener('dragover',event=>{if(Array.from(event.dataTransfer?.types||[]).includes('Files'))event.preventDefault();});
document.addEventListener('drop',event=>{
  if(!Array.from(event.dataTransfer?.types||[]).includes('Files'))return;
  event.preventDefault();document.querySelectorAll('.drag-over').forEach(zone=>zone.classList.remove('drag-over'));
  const targets=[...document.querySelectorAll('#fields input[type="file"]')].filter(input=>!input.disabled&&input.getClientRects().length&&input.dropFiles);
  if(targets.length===1)targets[0].dropFiles(event.dataTransfer.files);
  else if(targets.length)setStatus('Перетащите файл в нужное поле: начальный кадр, конечный кадр или референсы.',true);
});
