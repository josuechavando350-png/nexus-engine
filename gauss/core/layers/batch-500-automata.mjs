import {keys,integer,array,out,tuple} from './batch-500-common.mjs';
const word=(w,a)=>{if(typeof w!=='string'||[...w].length>128||[...w].some(c=>!a.includes(c)))throw new TypeError('word must contain bounded alphabet symbols');return [...w];};
function dfa(x){
 keys(x,['alphabet','start','accepting','transitions']);
 const a=array(x.alphabet,'alphabet',1,4);
 if(a.some(s=>typeof s!=='string'||[...s].length!==1||s.length!==1)||new Set(a).size!==a.length)throw new TypeError('unique single-unit alphabet symbols required');
 const t=array(x.transitions,'transitions',1,12),n=t.length;
 const start=integer(x.start,'start',0,n-1),accept=array(x.accepting,'accepting',0,n).map((v,i)=>integer(v,`accepting[${i}]`,0,n-1));
 if(new Set(accept).size!==accept.length)throw new TypeError('duplicate accepting state');
 const tr=t.map((row,i)=>array(row,`transitions[${i}]`,a.length,a.length).map((v,j)=>integer(v,`transitions[${i}][${j}]`,0,n-1)));
 return {a,t:tr,n,start,accept:new Set(accept)};
}
function reach(z,starts=[z.start]){const q=[...starts],seen=new Set(q);for(let k=0;k<q.length;k++)for(const v of z.t[q[k]])if(!seen.has(v)){seen.add(v);q.push(v);}return q.sort((a,b)=>a-b);}
function coreach(z){const q=[...z.accept],seen=new Set(q);for(let k=0;k<q.length;k++)for(let i=0;i<z.n;i++)if(z.t[i].includes(q[k])&&!seen.has(i)){seen.add(i);q.push(i);}return q.sort((a,b)=>a-b);}
function witness(z,pred){const q=[[z.start,'']],seen=new Set([z.start]);for(let k=0;k<q.length;k++){const [s,w]=q[k];if(pred(s))return w;for(let j=0;j<z.a.length;j++){const v=z.t[s][j];if(!seen.has(v)){seen.add(v);q.push([v,w+z.a[j]]);}}}return null;}
function pair(a,b){if(JSON.stringify(a.a)!==JSON.stringify(b.a))throw new TypeError('DFA alphabets must agree in order');return {a,b};}
function product(a,b,pred){pair(a,b);const states=[[a.start,b.start]],ids=new Map([[`${a.start}:${b.start}`,0]]),rows=[],final=[];
 for(let k=0;k<states.length;k++){const [u,v]=states[k];if(pred(a.accept.has(u),b.accept.has(v)))final.push(k);const row=[];
 for(let j=0;j<a.a.length;j++){const p=[a.t[u][j],b.t[v][j]],key=p.join(':');if(!ids.has(key)){if(states.length>=144)throw new RangeError('DFA product too large');ids.set(key,states.length);states.push(p);}row.push(ids.get(key));}rows.push(row);}
 return out({alphabet:a.a.slice(),start:0,accepting:final,transitions:rows});}
function pairWitness(a,b,pred){pair(a,b);const q=[[a.start,b.start,'']],seen=new Set([`${a.start}:${b.start}`]);for(let k=0;k<q.length;k++){const [u,v,w]=q[k];if(pred(a.accept.has(u),b.accept.has(v)))return w;
 for(let j=0;j<a.a.length;j++){const x=a.t[u][j],y=b.t[v][j],key=`${x}:${y}`;if(!seen.has(key)){seen.add(key);q.push([x,y,w+a.a[j]]);}}}return null;}
function two(x){keys(x,['left','right']);return pair(dfa(x.left),dfa(x.right));}
function nw(x){keys(x,['dfa','word']);const z=dfa(x.dfa);return {z,w:word(x.word,z.a)};}
function nfa(x){
 keys(x,['alphabet','starts','accepting','transitions','epsilon']);const a=array(x.alphabet,'alphabet',1,3);
 if(a.some(s=>typeof s!=='string'||s.length!==1)||new Set(a).size!==a.length)throw new TypeError('invalid NFA alphabet');
 const t=array(x.transitions,'transitions',1,9),n=t.length,states=(v,k)=>{const s=array(v,k,0,n).map((i,j)=>integer(i,`${k}[${j}]`,0,n-1));if(new Set(s).size!==s.length)throw new TypeError(`${k} duplicates`);return s;};
 const starts=states(x.starts,'starts'),accepting=states(x.accepting,'accepting');
 const tr=t.map((r,i)=>array(r,`transition row ${i}`,a.length,a.length).map((v,j)=>states(v,`transition[${i}][${j}]`)));
 const eps=array(x.epsilon,'epsilon',0,81).map((p,i)=>array(p,`epsilon[${i}]`,2,2).map((v,j)=>integer(v,`epsilon[${i}][${j}]`,0,n-1)));
 if(new Set(eps.map(p=>p.join(':'))).size!==eps.length)throw new TypeError('duplicate epsilon edge');
 return {a,t:tr,n,starts,accepting,eps};
}
function closure(z,ss){const seen=new Set(ss),q=[...ss];for(let k=0;k<q.length;k++)for(const [u,v]of z.eps)if(u===q[k]&&!seen.has(v)){seen.add(v);q.push(v);}return [...seen].sort((a,b)=>a-b);}
const filter=(z,accept)=>({alphabet:z.a,start:z.start,accepting:[...accept].sort((a,b)=>a-b),transitions:z.t});
export function dfaAccept(x){const {z,w}=nw(x);let s=z.start;for(const c of w)s=z.t[s][z.a.indexOf(c)];return out({accepted:z.accept.has(s),finalState:s});}
export function dfaTrace(x){const {z,w}=nw(x);const states=[z.start];for(const c of w)states.push(z.t[states.at(-1)][z.a.indexOf(c)]);return out({states,accepted:z.accept.has(states.at(-1))});}
export function dfaReachable(x){return out({states:reach(dfa(x))});}
export function dfaCoaccessible(x){return out({states:coreach(dfa(x))});}
export function dfaTrim(x){const z=dfa(x),r=reach(z),c=new Set(coreach(z)),keep=r.filter(s=>c.has(s));if(!keep.length)return out({empty:true,states:[]});
 // Trim to productive edges: an edge into a dead state is retained as an explicit sink.
 const live=new Set(keep),sink=z.n,order=[...keep],needsSink=keep.some(s=>z.t[s].some(v=>!live.has(v)));
 if(needsSink)order.push(sink);const index=new Map(order.map((s,i)=>[s,i]));return out({empty:false,originalStates:keep,dfa:{alphabet:z.a,start:index.get(z.start),accepting:keep.filter(s=>z.accept.has(s)).map(s=>index.get(s)),transitions:order.map(s=>s===sink?z.a.map(()=>index.get(sink)):z.t[s].map(v=>index.get(live.has(v)?v:sink)))}});}
export function dfaNonEmptyWitness(x){const z=dfa(x),w=witness(z,s=>z.accept.has(s));return out({nonempty:w!==null,witness:w});}
export function dfaRejectionWitness(x){const z=dfa(x),w=witness(z,s=>!z.accept.has(s));return out({rejectsSome:w!==null,witness:w});}
export function dfaFiniteLanguage(x){const z=dfa(x),live=new Set(coreach(z)),reachable=new Set(reach(z)),color=Array(z.n).fill(0);let cycle=false;
 function visit(s){color[s]=1;for(const v of z.t[s])if(live.has(v)&&reachable.has(v)){if(color[v]===1)cycle=true;else if(color[v]===0)visit(v);}color[s]=2;}
 for(const s of reachable)if(live.has(s)&&color[s]===0)visit(s);return out({finite:!cycle});}
export function dfaShortestAcceptedLength(x){const z=dfa(x),w=witness(z,s=>z.accept.has(s));return out({length:w===null?null:w.length});}
function countWords(x,accept){keys(x,['dfa','length']);const z=dfa(x.dfa),length=integer(x.length,'length',0,64);let counts=Array(z.n).fill(0n);counts[z.start]=1n;
 for(let i=0;i<length;i++){const next=Array(z.n).fill(0n);for(let s=0;s<z.n;s++)for(const v of z.t[s])next[v]+=counts[s];counts=next;}
 return out({count:String(counts.reduce((sum,v,s)=>sum+(z.accept.has(s)===accept?v:0n),0n))});}
export function dfaAcceptedWordCount(x){return countWords(x,true);}
export function dfaRejectedWordCount(x){return countWords(x,false);}
export function dfaComplement(x){const z=dfa(x);return out(filter(z,new Set(Array.from({length:z.n},(_,i)=>i).filter(s=>!z.accept.has(s)))));}
export function dfaIntersection(x){const {a,b}=two(x);return product(a,b,(u,v)=>u&&v);}
export function dfaUnion(x){const {a,b}=two(x);return product(a,b,(u,v)=>u||v);}
export function dfaDifference(x){const {a,b}=two(x);return product(a,b,(u,v)=>u&&!v);}
export function dfaSymmetricDifference(x){const {a,b}=two(x);return product(a,b,(u,v)=>u!==v);}
export function dfaEquivalence(x){const {a,b}=two(x),w=pairWitness(a,b,(u,v)=>u!==v);return out({equivalent:w===null,witness:w});}
export function dfaInclusion(x){const {a,b}=two(x),w=pairWitness(a,b,(u,v)=>u&&!v);return out({included:w===null,counterexample:w});}
export function dfaDisjointness(x){const {a,b}=two(x),w=pairWitness(a,b,(u,v)=>u&&v);return out({disjoint:w===null,commonWord:w});}
export function dfaMinimize(x){const z=dfa(x),r=reach(z),partition=[r.filter(s=>z.accept.has(s)),r.filter(s=>!z.accept.has(s))].filter(p=>p.length);
 let groups=partition;while(true){const index=new Map(groups.flatMap((g,i)=>g.map(s=>[s,i]))),buckets=new Map();for(const s of r){const key=JSON.stringify([z.accept.has(s),...z.t[s].map(v=>index.get(v))]);if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(s);}
 const next=[...buckets.values()].map(p=>p.sort((a,b)=>a-b));if(next.length===groups.length&&next.every(g=>groups.some(h=>JSON.stringify(g)===JSON.stringify(h))))break;groups=next;}
 const id=new Map(groups.flatMap((g,i)=>g.map(s=>[s,i])));return out({classes:groups,dfa:{alphabet:z.a,start:id.get(z.start),accepting:groups.flatMap((g,i)=>z.accept.has(g[0])?[i]:[]),transitions:groups.map(g=>z.t[g[0]].map(s=>id.get(s)))}});}
export function dfaCanonicalSignature(x){const m=dfaMinimize(x).dfa,z=dfa(m),q=[z.start],index=new Map([[z.start,0]]),rows=[],accept=[];
 for(let k=0;k<q.length;k++){const s=q[k];if(z.accept.has(s))accept.push(k);rows.push(z.t[s].map(v=>{if(!index.has(v)){index.set(v,q.length);q.push(v);}return index.get(v);}));}
 return out({alphabet:z.a,accepting:accept,transitions:rows});}
export function reverseDfaToNfa(x){const z=dfa(x),t=Array.from({length:z.n},()=>z.a.map(()=>[]));for(let s=0;s<z.n;s++)for(let j=0;j<z.a.length;j++)t[z.t[s][j]][j].push(s);return out({alphabet:z.a,starts:[...z.accept].sort((a,b)=>a-b),accepting:[z.start],transitions:t,epsilon:[]});}
export function nfaEpsilonClosure(x){keys(x,['nfa','states']);const z=nfa(x.nfa),ss=array(x.states,'states',0,z.n).map((s,i)=>integer(s,`states[${i}]`,0,z.n-1));return out({states:closure(z,ss)});}
export function nfaDeterminize(x){const z=nfa(x);if(z.n>8)throw new RangeError('NFA determinization supports at most 8 states');const start=closure(z,z.starts),q=[start],id=new Map([[start.join(','),0]]),rows=[],accept=[];
 for(let k=0;k<q.length;k++){const ss=q[k];if(ss.some(s=>z.accepting.includes(s)))accept.push(k);const row=[];for(let j=0;j<z.a.length;j++){const target=closure(z,ss.flatMap(s=>z.t[s][j])),key=target.join(',');if(!id.has(key)){id.set(key,q.length);q.push(target);}row.push(id.get(key));}rows.push(row);}
 return out({dfa:{alphabet:z.a,start:0,accepting:accept,transitions:rows},subsets:q});}
export function nfaAccept(x){keys(x,['nfa','word']);const z=nfa(x.nfa),w=word(x.word,z.a);let ss=closure(z,z.starts);for(const symbol of w)ss=closure(z,ss.flatMap(s=>z.t[s][z.a.indexOf(symbol)]));return out({accepted:ss.some(s=>z.accepting.includes(s)),finalStates:ss});}
const sample={alphabet:['0','1'],start:0,accepting:[1],transitions:[[0,1],[1,0]]};
const other={alphabet:['0','1'],start:0,accepting:[0],transitions:[[1,0],[0,1]]};
const sampleNfa={alphabet:['0','1'],starts:[0],accepting:[2],transitions:[[[0],[1]],[[],[2]],[[],[]]],epsilon:[[0,1]]};
const ab={left:sample,right:other},nwSample={dfa:sample,word:'1011'};
const definitions=[
 ['DFA_ACCEPT','Deterministic finite automaton membership and final state',dfaAccept,nwSample],
 ['DFA_TRACE','Complete DFA state trajectory on a bounded word',dfaTrace,nwSample],
 ['DFA_REACHABLE','Reachable DFA states by breadth-first search',dfaReachable,sample],
 ['DFA_COACCESSIBLE','States with a path to an accepting DFA state',dfaCoaccessible,sample],
 ['DFA_TRIM','Reachable and productive DFA with explicit dead sink',dfaTrim,sample],
 ['DFA_NONEMPTY_WITNESS','Shortest lexicographic accepted-word witness',dfaNonEmptyWitness,sample],
 ['DFA_REJECT_WITNESS','Shortest lexicographic rejected-word witness',dfaRejectionWitness,sample],
 ['DFA_LANGUAGE_FINITE','Productive reachable cycle test for finite DFA language',dfaFiniteLanguage,sample],
 ['DFA_MIN_ACCEPT_LENGTH','Shortest accepted word length or null',dfaShortestAcceptedLength,sample],
 ['DFA_ACCEPT_COUNT','Exact number of accepted words of specified length',dfaAcceptedWordCount,{dfa:sample,length:12}],
 ['DFA_REJECT_COUNT','Exact number of rejected words of specified length',dfaRejectedWordCount,{dfa:sample,length:12}],
 ['DFA_COMPLEMENT','Complete DFA language complement',dfaComplement,sample],
 ['DFA_INTERSECTION','Reachable product automaton for language intersection',dfaIntersection,ab],
 ['DFA_UNION','Reachable product automaton for language union',dfaUnion,ab],
 ['DFA_DIFFERENCE','Reachable product automaton for left-minus-right language',dfaDifference,ab],
 ['DFA_XOR','Reachable product automaton for symmetric language difference',dfaSymmetricDifference,ab],
 ['DFA_EQUIVALENCE','Product BFS language-equivalence counterexample',dfaEquivalence,ab],
 ['DFA_INCLUSION','Shortest counterexample for language inclusion',dfaInclusion,ab],
 ['DFA_DISJOINT','Shortest common-word witness of non-disjoint languages',dfaDisjointness,ab],
 ['DFA_MINIMIZE','Reachable DFA minimization by partition refinement',dfaMinimize,sample],
 ['DFA_CANONICAL','BFS canonical signature of minimal DFA',dfaCanonicalSignature,sample],
 ['DFA_REVERSE_NFA','Language reversal using transition-edge reversal',reverseDfaToNfa,sample],
 ['NFA_EPS_CLOSURE','Epsilon reachable NFA state closure',nfaEpsilonClosure,{nfa:sampleNfa,states:[0]}],
 ['NFA_DETERMINIZE','Epsilon NFA subset construction with explicit subsets',nfaDeterminize,sampleNfa],
 ['NFA_ACCEPT','Epsilon NFA word membership by state-set simulation',nfaAccept,{nfa:sampleNfa,word:'11'}],
];
export const FINITE_AUTOMATA_500=tuple(definitions,'CS','COMPUTER_SCIENCE');
