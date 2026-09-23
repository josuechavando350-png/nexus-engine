import {object,array,id,unique,integer} from './shared.mjs';
/** Exhaustive inductive invariant checking over finite Boolean valuations, distinct from CTL graph checking. */
export function verifyInductiveInvariant(input){
 object(input,'invariant',['variables','initial','invariant','rules']);
 const variables=unique(array(input.variables,'variables',1,12).map(v=>id(v,'variable')),'variables'),n=variables.length,ids=new Map(variables.map((v,i)=>[v,i]));
 const parse=(term,label)=>{object(term,label,['variable','equals']);if(!ids.has(term.variable)||typeof term.equals!=='boolean')throw new TypeError('invalid predicate');return [ids.get(term.variable),term.equals];};
 const initial=array(input.initial,'initial',n,n).map((v,i)=>{if(typeof v!=='boolean')throw new TypeError(`initial ${i} not boolean`);return v;});
 const invariant=array(input.invariant,'invariant',1,64).map((v,i)=>parse(v,`invariant[${i}]`));
 const rules=array(input.rules,'rules',0,256).map((r,i)=>{object(r,`rule[${i}]`,['name','guard','assign']);id(r.name,'rule name');const guard=array(r.guard,'guard',0,64).map(x=>parse(x,'guard'));const assign=array(r.assign,'assign',1,n).map(x=>parse(x,'assign'));unique(assign.map(x=>x[0]),'assigned variables');return {name:r.name,guard,assign};});unique(rules.map(r=>r.name),'rule names');
 const mask=initial.reduce((a,v,i)=>a+(v?2**i:0),0),sat=(s,clauses)=>clauses.every(([i,v])=>Boolean(s&(2**i))===v);
 const apply=(s,rule)=>rule.assign.reduce((m,[i,v])=>v?m|(1<<i):m&~(1<<i),s);
 const toState=s=>Object.fromEntries(variables.map((v,i)=>[v,Boolean(s&(1<<i))]));
 const initiated=sat(mask,invariant);let counterexample=null;
 // A valid inductive invariant must hold for ALL valuations satisfying the predicate, not only reachable states.
 for(let s=0;s<2**n&&!counterexample;s++)if(sat(s,invariant))for(const r of rules)if(sat(s,r.guard)&&!sat(apply(s,r),invariant)){counterexample={state:toState(s),rule:r.name,nextState:toState(apply(s,r))};break;}
 const inductive=counterexample===null;
 // Independently explore reachable states and return a shortest violating trace.
 const seen=new Set([mask]),queue=[mask],parent=new Map([[mask,null]]);let violated=null;
 for(let i=0;i<queue.length;i++){const s=queue[i];if(!sat(s,invariant)){violated=s;break;}for(const r of rules)if(sat(s,r.guard)){const next=apply(s,r);if(!seen.has(next)){seen.add(next);parent.set(next,{previous:s,rule:r.name});queue.push(next);}}}
 let witness=null;if(violated!==null){witness=[];for(let s=violated;s!==mask;s=parent.get(s).previous)witness.push({state:toState(s),via:parent.get(s).rule});witness.push({state:toState(mask),via:null});witness.reverse();}
 return {domain:'FINITE_BOOLEAN_INDUCTIVE_INVARIANTS',initiated,inductive,provenByInduction:initiated&&inductive,reachableStateCount:seen.size,reachableInvariantHolds:violated===null,counterexample,witness,note:'Proof is over supplied Boolean transition DSL only, not arbitrary source code or external runtime behavior.'};
}
