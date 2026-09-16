// Public pricing metadata only. No authentication, uploads or task creation.
const fs=require('node:fs/promises');const path=require('node:path');
const {models}=require('../src/catalog');
async function run(){
  const rows=[];let pages=1;
  for(let pageNum=1;pageNum<=pages;pageNum++){
    const response=await fetch('https://api.kie.ai/client/v1/model-pricing/page',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pageNum,pageSize:100}),signal:AbortSignal.timeout(20000)});
    const result=await response.json();if(result.code!==200||!Array.isArray(result.data?.records))throw new Error('Pricing list unavailable');
    pages=result.data.pages;if(pages>30)throw new Error('Unexpected page count');rows.push(...result.data.records);
  }
  const urls=[...new Set(rows.map(row=>{try{const url=new URL(row.anchor);return url.origin==='https://kie.ai'?url.origin+url.pathname:null;}catch{return null;}}).filter(Boolean))];
  const found=new Map(),errors=[];
  let cursor=0;
  await Promise.all(Array.from({length:4},async()=>{
    while(cursor<urls.length){const url=urls[cursor++];
      try{
        const response=await fetch(url,{signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('HTTP '+response.status);
        const html=await response.text();const match=html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);if(!match)throw new Error('No page metadata');
        const groups=JSON.parse(match[1]).props?.pageProps?.pageData?.groupData||[];
        for(const group of groups){const model=group.userPath+(group.path?'/'+group.path:'');if(typeof group.pricingDesc==='string'&&group.pricingDesc.trim())found.set(model,{model,text:group.pricingDesc,source:url});}
      }catch(error){errors.push({url,error:error.message});}
    }
  }));
  const entries={};const missing=[];
  for(const model of models){
    const entry=found.get(model.adapter==='veo'?'veo-3-1':model.apiModel);
    if(entry)entries[model.id]=entry;else missing.push({id:model.id,name:model.name});
  }
  const report={checkedAt:new Date().toISOString(),source:'https://kie.ai/pricing',tariffRows:rows.length,pagesChecked:urls.length,totalModels:models.length,coveredModels:Object.keys(entries).length,entries,missing,errors};
  await fs.writeFile(path.resolve(__dirname,'../src/kie-price-descriptions.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({tariffRows:rows.length,pagesChecked:urls.length,totalModels:models.length,coveredModels:report.coveredModels,missing:missing.length,errors}));
}
run().catch(error=>{console.error(error.message);process.exitCode=1;});
