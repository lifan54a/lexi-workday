import { isSessionTokenValid } from "../login.js";
import { getStore } from "@edgeone/pages-blob";

export async function onRequest({ request, env }) {
  const cookie = request.headers.get("cookie")?.match(/(?:^|;\s*)lexi_session=([^;]+)/)?.[1] ?? "";
  if (!env?.SESSION_SECRET || !(await isSessionTokenValid(cookie, env.SESSION_SECRET))) {
    return new Response(null, {status:401});
  }
  const probes = await Promise.all([
    ["blob-auth", "https://blob-sts.edgeone.site/"],
    ["legacy-read", new URL("/api/legacy-tasks", env.LEXI_PUBLIC_ORIGIN || "https://work.yoube.cloud").href],
  ].map(async ([name,url]) => {
    const started=Date.now();
    try {
      const response=await fetch(url,{signal:AbortSignal.timeout(4000),
        headers:name === "legacy-read" ? {cookie:request.headers.get("cookie")??""} : {}});
      await response.body?.cancel();
      return {name,status:response.status,milliseconds:Date.now()-started};
    } catch(error) {
      return {name,error:error?.name,cause:error?.cause?.code,milliseconds:Date.now()-started};
    }
  }));
  const started=Date.now();
  let timer;
  try {
    const result=await Promise.race([
      getStore({name:"lexi-workday-state",consistency:"strong"}).list({prefix:"snapshots/"}),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("storage probe timeout")),6000);}),
    ]);
    probes.push({name:"blob-list",count:result.blobs.length,milliseconds:Date.now()-started});
  } catch(error) {probes.push({name:"blob-list",error:error?.code??error?.name,milliseconds:Date.now()-started});}
  finally {clearTimeout(timer);}
  return Response.json({probes,host:new URL(request.url).host},{headers:{"cache-control":"no-store"}});
}
