// Render the canonical product mark at Windows icon sizes; store PNG-compressed ICO frames.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
  let win;
  try{
    const folder=path.resolve(__dirname,'../src/assets');
    const source=await fs.readFile(path.resolve(__dirname,'../../public/brand-logo.png'));
    win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});
    await win.loadURL('about:blank');
    const frames=[];
    for(const size of [16,24,32,48,64,128,256]){
      const data=await win.webContents.executeJavaScript(`(async()=>{
        const img=new Image();img.src=${JSON.stringify('data:image/png;base64,'+source.toString('base64'))};await img.decode();
        const canvas=document.createElement('canvas');canvas.width=canvas.height=${size};canvas.getContext('2d').drawImage(img,0,0,${size},${size});return canvas.toDataURL('image/png').split(',')[1];
      })()`);
      frames.push({size,bytes:Buffer.from(data,'base64')});
    }
    const header=Buffer.alloc(6+16*frames.length);header.writeUInt16LE(1,2);header.writeUInt16LE(frames.length,4);
    let offset=header.length;
    frames.forEach(({size,bytes},i)=>{const at=6+i*16;header[at]=header[at+1]=size===256?0:size;header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);header.writeUInt32LE(bytes.length,at+8);header.writeUInt32LE(offset,at+12);offset+=bytes.length;});
    await fs.writeFile(path.join(folder,'icon.ico'),Buffer.concat([header,...frames.map(f=>f.bytes)]));
    await fs.writeFile(path.join(folder,'icon.png'),frames.at(-1).bytes);
    console.log('Created icon.ico (7 sizes) and icon.png');win.destroy();app.exit(0);
  }catch(error){console.error(error);win?.destroy();app.exit(1);}
});
