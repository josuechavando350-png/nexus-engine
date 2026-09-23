import {object,array,integer,id} from './finite-tools.mjs';
/** Model check a single-view authenticated prepare/commit quorum transcript (not a deployed consensus stack). */
export function verifyByzantineQuorums(input){
 object(input,'byzantine',['replicas','faults','messages'],['replicas','faults','messages']);const replicas=array(input.replicas,'replicas',4,100).map((s,i)=>id(s,`replicas[${i}]`));
 if(new Set(replicas).size!==replicas.length)throw new TypeError('duplicate replica');const n=replicas.length,f=integer(input.faults,'faults',0,33);
 if(n<3*f+1)throw new TypeError('requires n >= 3f+1');const threshold=n-f, messages=array(input.messages,'messages',0,1000);
 const vote=new Map(),equivocators=new Set();
 for(let i=0;i<messages.length;i++){const m=object(messages[i],`messages[${i}]`,['replica','phase','value']);id(m.replica,'replica');id(m.value,'value');
 if(!replicas.includes(m.replica)||!['PREPARE','COMMIT'].includes(m.phase))throw new TypeError('unknown replica or phase');
 const key=m.replica+':'+m.phase;const prev=vote.get(key);if(prev!==undefined&&prev!==m.value)equivocators.add(m.replica);vote.set(key,m.value);
 }
 const tally=phase=>{const counts=new Map();for(const [key,value] of vote)if(key.endsWith(':'+phase)&&!equivocators.has(key.split(':')[0]))counts.set(value,(counts.get(value)??0)+1);return [...counts].map(([value,count])=>({value,count})).sort((a,b)=>b.count-a.count||a.value.localeCompare(b.value));};
 const prepares=tally('PREPARE'),commits=tally('COMMIT'),certificates=commits.filter(c=>c.count>=threshold&&prepares.some(p=>p.value===c.value&&p.count>=threshold));
 if(certificates.length>1)throw new Error('conflicting commit certificates: transcript violates quorum assumptions');
 return {domain:'AUTHENTICATED_SINGLE_VIEW_TRANSCRIPT',replicaCount:n,faultBound:f,quorum:threshold,equivocators:[...equivocators].sort(),prepareTallies:prepares,commitTallies:commits,certificate:certificates[0]??null,status:certificates.length?'QUORUM_CERTIFIED':'INSUFFICIENT_QUORUM',note:'Transcript analysis assumes authenticated, unique replica identities and <= f Byzantine nodes; quorum n-f ensures intersecting certificates under the claimed fault bound; no networking, leader-change, liveness or signature verification.'};
}
