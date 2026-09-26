const sharedFetches = new WeakMap();
async function fetchPublic(fetcher) {
  const existing = sharedFetches.get(fetcher);
  if (existing) return existing;
  const operation = (async () => {
    const rows=[];let pages=1;
    for(let pageNum=1;pageNum<=pages;pageNum++){
      const response=await fetcher('https://api.kie.ai/client/v1/model-pricing/page',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pageNum,pageSize:100}),signal:AbortSignal.timeout(15000)});
      const body=await response.json();
      if(!response.ok||body.code!==200||!Array.isArray(body.data?.records)||!Number.isInteger(body.data.pages)||body.data.pages<1||body.data.pages>30)throw new Error('Не удалось загрузить тарифы Kie');
      pages=body.data.pages;rows.push(...body.data.records.map(({modelDescription,creditPrice,creditUnit,anchor,interfaceType,provider})=>({modelDescription,creditPrice,creditUnit,anchor,interfaceType,provider})));
    }
    return {schemaVersion:2,rows,fetchedAt:new Date().toISOString()};
  })();
  sharedFetches.set(fetcher, operation);
  try { return await operation; }
  finally { if (sharedFetches.get(fetcher) === operation) sharedFetches.delete(fetcher); }
}
class Tariffs {
  constructor(preferences,fetcher=fetch){this.preferences=preferences;this.fetcher=fetcher;this.pending=null;this.cached=null;}
  async get(force=false){
    const fresh=data=>data?.schemaVersion===2&&Date.now()-Date.parse(data.fetchedAt)<86400000;
    if(!force&&fresh(this.cached))return this.cached;
    if(this.pending)return this.pending;
    this.pending=(async()=>{
      let cached=this.cached;
      try{
        if(!cached){
          try{cached=(typeof this.preferences.get==='function'
            ? await this.preferences.get('kie-tariffs')
            : (await this.preferences.list()).find(row=>row.id==='kie-tariffs'))?.data;this.cached=cached||null;}
          catch{cached=null;}
        }
        if(!force&&fresh(cached))return cached;
        const data=await fetchPublic(this.fetcher);this.cached=data;
        void this.preferences.update('kie-tariffs',{data}).catch(()=>{});
        return data;
      }catch(error){return {...(cached||{rows:[]}),stale:true,error:error.message};}
    })();
    try{return await this.pending;}finally{this.pending=null;}
  }
}
module.exports={Tariffs};
