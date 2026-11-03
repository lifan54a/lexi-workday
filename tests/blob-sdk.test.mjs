import assert from 'node:assert/strict';
import test from 'node:test';
import { getStore } from '@edgeone/pages-blob';

test('conditional Blob writes use the COS forbid-overwrite header', async () => {
  const originalFetch=globalThis.fetch;
  let writes=0;
  globalThis.fetch=async (url, options)=> {
    if (String(url).startsWith('https://blob-sts.edgeone.site/')) return Response.json({
      tmpSecretId:'test-secret-id',tmpSecretKey:'test-secret-key',sessionToken:'test-session',
      expiredTime:Math.floor(Date.now()/1000)+3600,appId:'123',zoneId:'zone-test',projectId:'makers-test',
      resourcePrefix:'123/zone-test/makers-test/*',cosMainland:{bucket:'test',region:'ap-guangzhou'},
    },{headers:{'X-Edge-Region':'CN'}});
    assert.equal(options.method,'PUT');
    const headers=new Headers(options.headers);
    assert.equal(headers.get('x-cos-forbid-overwrite'),'true');
    assert.equal(headers.has('if-none-match'),false);
    writes+=1;
    return new Response(null,{status:200});
  };
  try {
    await getStore({name:'test-store',projectId:'makers-test',token:'test-token',consistency:'strong'})
      .setJSON('operations/test.json',{changes:[]},{onlyIfNew:true});
    assert.equal(writes,1);
  } finally {globalThis.fetch=originalFetch;}
});
