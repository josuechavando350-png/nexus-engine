/* Reference DFA/NFA semantics from bounded exhaustive words, state-pair reachability and explicit subsets. */
import assert from 'node:assert/strict';
import {runBatchBank,seq} from './batch-238-common.mjs';
const tags=['DFA_ACCEPT','DFA_TRACE','DFA_REACHABLE','DFA_COACCESSIBLE','DFA_TRIM','DFA_NONEMPTY_WITNESS','DFA_REJECT_WITNESS','DFA_LANGUAGE_FINITE','DFA_MIN_ACCEPT_LENGTH','DFA_ACCEPT_COUNT','DFA_REJECT_COUNT','DFA_COMPLEMENT','DFA_INTERSECTION','DFA_UNION','DFA_DIFFERENCE','DFA_XOR','DFA_EQUIVALENCE','DFA_INCLUSION','DFA_DISJOINT','DFA_MINIMIZE','DFA_CANONICAL','DFA_REVERSE_NFA','NFA_EPS_CLOSURE','NFA_DETERMINIZE','NFA_ACCEPT'];
const sorted=a=>[...new Set(a)].sort((a,b)=>a-b),cmp=(a,b)=>a.length-b.length||a.localeCompare(b),alphabet=['0','1'];
const words=(a,max)=>{let current=[''],out=[''];for(let i=1;i<=max;i++){current=current.flatMap(w=>a.map(c=>w+c));out=out.concat(current);}return out;};
const go=(z,word,s=z.start)=>[...word].reduce((v,c)=>z.transitions[v][z.alphabet.indexOf(c)],s);
const accept=(z,w,s=z.start)=>z.accepting.includes(go(z,w,s));
const reached=(z,starts=[z.start])=>{const found=new Set(starts),q=[...starts];for(let i=0;i<q.length;i++)for(const t of z.transitions[q[i]])if(!found.has(t)){found.add(t);q.push(t);}return sorted(q);};
const productive=z=>seq(z.transitions.length).filter(s=>reached({...z,start:s}).some(v=>z.accepting.includes(v)));
const shortest=(z,pred)=>words(z.alphabet,z.transitions.length).find(w=>pred(go(z,w)))??null;
const witness=(a,b,pred)=>{const limit=a.transitions.length*b.transitions.length;return words(a.alphabet,limit).find(w=>pred(accept(a,w),accept(b,w)))??null;};
const pairs=(a,b,pred)=>{const states=[[a.start,b.start]],ids=new Map([[a.start+','+b.start,0]]),transitions=[],accepting=[];for(let i=0;i<states.length;i++){const [s,t]=states[i];if(pred(a.accepting.includes(s),b.accepting.includes(t)))accepting.push(i);transitions.push(a.alphabet.map((_,j)=>{const next=[a.transitions[s][j],b.transitions[t][j]],key=next.join(',');if(!ids.has(key)){ids.set(key,states.length);states.push(next);}return ids.get(key);}));}return {alphabet:a.alphabet,start:0,accepting,transitions};};
const nfaClosure=(z,s)=>{const seen=new Set(s);for(let k=0,arr=[...s];k<arr.length;k++)for(const [u,v] of z.epsilon)if(u===arr[k]&&!seen.has(v)){seen.add(v);arr.push(v);}return sorted([...seen]);};
const nfaStep=(z,s,j)=>nfaClosure(z,s.flatMap(v=>z.transitions[v][j]));
const nfaDet=z=>{const start=nfaClosure(z,z.starts),subsets=[start],id=new Map([[start.join(','),0]]),transitions=[],accepting=[];for(let k=0;k<subsets.length;k++){const s=subsets[k];if(s.some(v=>z.accepting.includes(v)))accepting.push(k);transitions.push(z.alphabet.map((_,j)=>{const next=nfaStep(z,s,j),key=next.join(',');if(!id.has(key)){id.set(key,subsets.length);subsets.push(next);}return id.get(key);}));}return {dfa:{alphabet:z.alphabet,start:0,accepting,transitions},subsets};};
function input(tag,i,r){const n=1+i%3,dfa=()=>({alphabet:alphabet.slice(),start:r(n),accepting:seq(n).filter(()=>r(2)),transitions:seq(n).map(()=>seq(2).map(()=>r(n)))}),a=dfa();
 if(['DFA_ACCEPT','DFA_TRACE'].includes(tag))return {dfa:a,word:seq(i%7).map(()=>alphabet[r(2)]).join('')};
 if(['DFA_ACCEPT_COUNT','DFA_REJECT_COUNT'].includes(tag))return {dfa:a,length:i%8};
 if(['DFA_INTERSECTION','DFA_UNION','DFA_DIFFERENCE','DFA_XOR','DFA_EQUIVALENCE','DFA_INCLUSION','DFA_DISJOINT'].includes(tag))return {left:a,right:dfa()};
 const m=1+i%3,nfa={alphabet:alphabet.slice(),starts:seq(m).filter(()=>r(2)),accepting:seq(m).filter(()=>r(2)),transitions:seq(m).map(()=>seq(2).map(()=>seq(m).filter(()=>r(2)))),epsilon:seq(m).flatMap(u=>seq(m).filter(v=>u!==v&&r(5)===0).map(v=>[u,v]))};
 if(tag==='NFA_EPS_CLOSURE')return {nfa,states:seq(m).filter(()=>r(2))};
 if(tag==='NFA_ACCEPT')return {nfa,word:seq(i%6).map(()=>alphabet[r(2)]).join('')};
 if(tag==='NFA_DETERMINIZE')return nfa;
 return a;
}
function reference(tag,x){const z=x.dfa??x.left??x,a=x.left,b=x.right,n=z.transitions?.length,v=seq(n??0);
 switch(tag){
 case 'DFA_ACCEPT':{const finalState=go(z,x.word);return {accepted:z.accepting.includes(finalState),finalState};}
 case 'DFA_TRACE':{const states=[z.start];for(const c of x.word)states.push(z.transitions[states.at(-1)][z.alphabet.indexOf(c)]);return {states,accepted:z.accepting.includes(states.at(-1))};}
 case 'DFA_REACHABLE':return {states:reached(z)};
 case 'DFA_COACCESSIBLE':return {states:productive(z)};
 case 'DFA_TRIM':{const keep=reached(z).filter(s=>productive(z).includes(s));if(!keep.length)return {empty:true,states:[]};const sink=n,needsSink=keep.some(s=>z.transitions[s].some(j=>!keep.includes(j))),order=needsSink?[...keep,sink]:keep,id=new Map(order.map((s,i)=>[s,i]));return {empty:false,originalStates:keep,dfa:{alphabet:z.alphabet,start:id.get(z.start),accepting:keep.filter(s=>z.accepting.includes(s)).map(s=>id.get(s)),transitions:order.map(s=>s===sink?alphabet.map(()=>id.get(sink)):z.transitions[s].map(t=>id.get(keep.includes(t)?t:sink)))}};}
 case 'DFA_NONEMPTY_WITNESS':{const w=shortest(z,s=>z.accepting.includes(s));return {nonempty:w!==null,witness:w};}
 case 'DFA_REJECT_WITNESS':{const w=shortest(z,s=>!z.accepting.includes(s));return {rejectsSome:w!==null,witness:w};}
 case 'DFA_LANGUAGE_FINITE':{const live=new Set(productive(z)),reach=new Set(reached(z)),color=Array(n).fill(0);let cycle=false;function visit(s){color[s]=1;for(const t of z.transitions[s])if(live.has(t)&&reach.has(t)){if(color[t]===1)cycle=true;else if(!color[t])visit(t);}color[s]=2;}for(const s of reach)if(live.has(s)&&!color[s])visit(s);return {finite:!cycle};}
 case 'DFA_MIN_ACCEPT_LENGTH':{const w=shortest(z,s=>z.accepting.includes(s));return {length:w===null?null:w.length};}
 case 'DFA_ACCEPT_COUNT':case 'DFA_REJECT_COUNT':return {count:String(words(z.alphabet,x.length).filter(w=>w.length===x.length&&accept(z,w)===(tag==='DFA_ACCEPT_COUNT')).length)};
 case 'DFA_COMPLEMENT':return {...z,accepting:v.filter(s=>!z.accepting.includes(s))};
 case 'DFA_INTERSECTION':return pairs(a,b,(l,r)=>l&&r);
 case 'DFA_UNION':return pairs(a,b,(l,r)=>l||r);
 case 'DFA_DIFFERENCE':return pairs(a,b,(l,r)=>l&&!r);
 case 'DFA_XOR':return pairs(a,b,(l,r)=>l!==r);
 case 'DFA_EQUIVALENCE':{const w=witness(a,b,(l,r)=>l!==r);return {equivalent:w===null,witness:w};}
 case 'DFA_INCLUSION':{const w=witness(a,b,(l,r)=>l&&!r);return {included:w===null,counterexample:w};}
 case 'DFA_DISJOINT':{const w=witness(a,b,(l,r)=>l&&r);return {disjoint:w===null,commonWord:w};}
 case 'DFA_MINIMIZE':{const reach=reached(z),same=(p,q)=>words(z.alphabet,n*n).every(w=>accept(z,w,p)===accept(z,w,q)),classes=[];for(const s of reach){const group=classes.find(g=>same(g[0],s));if(group)group.push(s);else classes.push([s]);}const id=new Map(classes.flatMap((g,i)=>g.map(s=>[s,i])));return {classes,dfa:{alphabet:z.alphabet,start:id.get(z.start),accepting:classes.flatMap((g,i)=>z.accepting.includes(g[0])?[i]:[]),transitions:classes.map(g=>z.transitions[g[0]].map(s=>id.get(s)))}};}
 case 'DFA_CANONICAL':{const m=reference('DFA_MINIMIZE',x).dfa,q=[m.start],ids=new Map([[m.start,0]]),rows=[],final=[];for(let k=0;k<q.length;k++){const s=q[k];if(m.accepting.includes(s))final.push(k);rows.push(m.transitions[s].map(v=>{if(!ids.has(v)){ids.set(v,q.length);q.push(v);}return ids.get(v);}));}return {alphabet:z.alphabet,accepting:final,transitions:rows};}
 case 'DFA_REVERSE_NFA':{const t=v.map(()=>z.alphabet.map(()=>[]));for(const s of v)for(const j of seq(z.alphabet.length))t[z.transitions[s][j]][j].push(s);return {alphabet:z.alphabet,starts:sorted(z.accepting),accepting:[z.start],transitions:t,epsilon:[]};}
 case 'NFA_EPS_CLOSURE':return {states:nfaClosure(x.nfa,x.states)};
 case 'NFA_DETERMINIZE':return nfaDet(x);
 case 'NFA_ACCEPT':{let states=nfaClosure(x.nfa,x.nfa.starts);for(const c of x.word)states=nfaStep(x.nfa,states,x.nfa.alphabet.indexOf(c));return {accepted:states.some(s=>x.nfa.accepting.includes(s)),finalStates:states};}
 default:throw Error('missing finite automata reference '+tag);
 }
}
function verify(tag,input,actual,expected){if(['DFA_INTERSECTION','DFA_UNION','DFA_DIFFERENCE','DFA_XOR','DFA_MINIMIZE','DFA_CANONICAL'].includes(tag)){assert.deepStrictEqual(actual,expected);return;}assert.deepStrictEqual(actual,expected);}
export const runFiniteAutomata438Bank=options=>runBatchBank({name:'AXIOMA finite automata independent word-language references 401–425',prefix:'CS',start:401,tags,input,reference,verify,...options});
