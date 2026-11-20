import { get, put, del, head } from '@vercel/blob';
import { createHash, randomUUID } from 'node:crypto';

// Temporary, expiring diagnostic for an isolated file; never reads order data.
export function authorizedProbe(req) {
  const token=req.headers['x-checkout-diagnostic'];
  return req.method==='GET' && req.url.split('?')[0]==='/api/catalog' && Date.now()<1795135351909 &&
    typeof token==='string' && createHash('sha256').update(token).digest('hex')==='344ffd84e0129c0ed5fb986cc974f8100d55f8e212230f044bfd57466e5eeb51';
}
export async function probeStorage() {
  const results=[];
  for(const identity of [false,true]) {
    const path=`psico/diagnostics/${randomUUID()}.json`;
    const options={access:'private',addRandomSuffix:false,contentType:'application/json',ttlDays:1};
    let created=false;
    try {
      const uploaded=await put(path,JSON.stringify({revision:1,padding:'storage-test '.repeat(500)}),options);
      created=true;
      const read=await get(path,{access:'private',useCache:false,...(identity?{headers:{'Accept-Encoding':'identity'}}:{})});
      const result={identity,readStatus:read?.statusCode,weakETag:read?.blob.etag.startsWith('W/'),matchesUpload:read?.blob.etag===uploaded.etag,
        encoding:read?.headers.get('content-encoding'),readRevision:read?.stream?(await new Response(read.stream).json()).revision:null};
      if(read?.blob.etag) {
        try { await put(path,JSON.stringify({revision:2}),{...options,allowOverwrite:true,ifMatch:read.blob.etag});result.conditionalWrite='ok'; }
        catch(e){result.conditionalWrite=e.constructor.name;}
      }
      const metadata=await head(path);
      result.headMatchesRead=metadata.etag===read?.blob.etag;
      try { await put(path,JSON.stringify({revision:3}),{...options,allowOverwrite:true,ifMatch:metadata.etag});result.headConditionalWrite='ok'; }
      catch(e){result.headConditionalWrite=e.constructor.name;}
      results.push(result);
    } finally { if(created)await del(path); }
  }
  return results;
}
