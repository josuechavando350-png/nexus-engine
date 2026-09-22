import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { object, array, id, unique } from './shared.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const tokens=text=>[...new Set((text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]{2,64}/gu)??[]))].sort();
const decoder=new TextDecoder('utf-8',{fatal:true});
/** Strict binary/text content catalog; opaque content is not interpreted or sent anywhere. */
export function catalogDarkData(input) {
  object(input,'catalog',['documents','query'],['documents']);
  const documents=array(input.documents,'documents',0,256);
  if(input.query!==undefined) {
    object(input.query,'query',['terms','tags','mode'],['terms']);
    if(input.query.mode!==undefined&&!['ALL','ANY'].includes(input.query.mode))throw new TypeError('query.mode must be ALL or ANY');
  }
  const identifiers=unique(documents.map((d,i)=>{object(d,`documents[${i}]`,['id','encoding','content','tags'],['id','encoding','content']);return id(d.id,`documents[${i}].id`);}), 'document ids');
  const indexed=[],dedup=new Map(),termIndex=new Map();
  for(let i=0;i<documents.length;i++){
    const d=documents[i];if(!['utf8','base64'].includes(d.encoding))throw new TypeError('encoding must be utf8 or base64');
    if(typeof d.content!=='string')throw new TypeError('content must be a string');
    if(d.encoding==='base64' && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(d.content)))throw new TypeError('noncanonical base64');
    const buffer=Buffer.from(d.content,d.encoding==='base64'?'base64':'utf8');
    if(buffer.length>262144)throw new TypeError('document exceeds 256 KiB');
    if(d.encoding==='base64'&&buffer.toString('base64')!==d.content)throw new TypeError('invalid base64 pad bits');
    // Plain text must round-trip; no lossy replacement of invalid scalar sequences.
    const text=d.encoding==='utf8'?decoder.decode(buffer):null;
    if(text!==null&&text!==d.content)throw new TypeError('invalid UTF-8 text (unpaired surrogate)');
    if(text!==null&&Buffer.from(text,'utf8').toString('hex')!==buffer.toString('hex'))throw new TypeError('invalid UTF-8');
    const tags=unique(array(d.tags??[],'tags',0,32).map((tag,j)=>id(tag,`tags[${j}]`)),'tags').sort();
    const digest=sha(buffer);if(!dedup.has(digest))dedup.set(digest,[]);dedup.get(digest).push(d.id);
    const terms=text!==null?tokens(text):[];
    for(const term of terms){if(!termIndex.has(term))termIndex.set(term,new Set());termIndex.get(term).add(d.id);}
    indexed.push({id:d.id,sha256:digest,bytes:buffer.length,encoding:d.encoding,tags,tokenCount:terms.length});
  }
  const query=input.query??null;let matches=[];
  if(query){
    const words=unique(array(query.terms,'query.terms',0,16).map((v,i)=>{
      if(typeof v!=='string')throw new TypeError(`query.terms[${i}] must be text`);
      const parts=tokens(v);if(parts.length!==1)throw new TypeError('each query term must tokenize to one word');return parts[0];
    }),'query terms');
    const requiredTags=unique(array(query.tags??[],'query.tags',0,16).map((v,i)=>id(v,`query.tags[${i}]`)),'query tags');
    matches=indexed.filter(d=>(words.length===0 || (query.mode==='ANY'?words.some(w=>termIndex.get(w)?.has(d.id)):words.every(w=>termIndex.get(w)?.has(d.id))))&&requiredTags.every(t=>d.tags.includes(t))).map(d=>d.id);
  }
  return {engine:'NEMESIS_DARK_DATA_CATALOG_V1',domain:'EXPLICIT_LOCAL_BYTES_AND_EXACT_TOKEN_INDEX',documentCount:indexed.length,
    uniqueBlobCount:dedup.size,documents:indexed,duplicates:[...dedup].filter(([,ids])=>ids.length>1).map(([sha256,ids])=>({sha256,ids})),matches,
    note:'No semantic inference, OCR, external discovery, storage, or automatic PII anonymization. Text search is exact NFKC lowercase token match; binary remains opaque.'};
}
