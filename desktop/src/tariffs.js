class Tariffs {
  constructor(preferences,fetcher=fetch){this.preferences=preferences;this.fetcher=fetcher;this.pending=null;}
  async get(force=false){
    const cached=(await this.preferences.list()).find(row=>row.id==='kie-tariffs')?.data;
    if(!force&&cached&&Date.now()-Date.parse(cached.fetchedAt)<86400000)return cached;
    if(this.pending)return this.pending;
    this.pending=(async()=>{
      try{
        const rows=[];let pages=1;
        for(let pageNum=1;pageNum<=pages;pageNum++){
          const response=await this.fetcher('https://api.kie.ai/client/v1/model-pricing/page',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pageNum,pageSize:100}),signal:AbortSignal.timeout(15000)});
          const body=await response.json();
          if(!response.ok||body.code!==200||!Array.isArray(body.data?.records)||!Number.isInteger(body.data.pages)||body.data.pages<1||body.data.pages>30)throw new Error('Не удалось загрузить тарифы Kie');
          pages=body.data.pages;rows.push(...body.data.records.map(({modelDescription,creditPrice,creditUnit})=>({modelDescription,creditPrice,creditUnit})));
        }
        const data={rows,fetchedAt:new Date().toISOString()};await this.preferences.update('kie-tariffs',{data});return data;
      }catch(error){return {...(cached||{rows:[]}),stale:true,error:error.message};}
    })();
    try{return await this.pending;}finally{this.pending=null;}
  }
}
module.exports={Tariffs};
