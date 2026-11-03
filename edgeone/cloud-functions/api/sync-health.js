import { isSessionTokenValid } from "../login.js";

export async function onRequest({ request, env }) {
  const cookie = request.headers.get("cookie")?.match(/(?:^|;\s*)lexi_session=([^;]+)/)?.[1] ?? "";
  if (!env?.SESSION_SECRET || !(await isSessionTokenValid(cookie, env.SESSION_SECRET))) {
    return new Response(null, {status:401});
  }
  const probes = await Promise.all([
    ["blob-auth", "https://blob-sts.edgeone.site/"],
    ["legacy-read", new URL("/api/legacy-tasks", request.url).href],
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
  return Response.json({probes,host:new URL(request.url).host},{headers:{"cache-control":"no-store"}});
}
