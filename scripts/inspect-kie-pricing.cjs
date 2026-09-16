// Read-only inspection of public site bundles. No credentials or generation requests.
(async()=>{
  const html=await(await fetch('https://kie.ai/grok-imagine-video-1.5')).text();
  const sources=[...html.matchAll(/<script[^>]+src="([^"]+)/g)].map(m=>new URL(m[1],'https://kie.ai').href).filter(u=>u.startsWith('https://kie.ai/')&&!/polyfills|framework|main-/.test(u));
  for(const url of sources){
    const body=await(await fetch(url)).text();
    const terms=process.argv.slice(2);const hits=[];
    for(const term of terms){let at=-1,count=0;while((at=body.indexOf(term,at+1))>=0&&count++<8)hits.push(body.slice(Math.max(0,at-150),at+350));}
    if(hits.length)console.log(JSON.stringify({url,hits}));
  }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
