import {object,array,number,integer} from './shared.mjs';
import {matrix,seeded} from './numerics.mjs';
const sum=a=>a.reduce((s,v)=>s+v,0);
function validate(input){
  const counts=array(input.counts,'counts',2,32).map(v=>integer(v,'count',0,1000000)),n=counts.length,N=sum(counts);
  if(N<1||N>1000000)throw new RangeError('population must contain 1..1000000 individuals');
  const payoffs=matrix(input.payoffs,'payoffs',n,n).map(r=>r.map(v=>number(v,'payoff',-1e6,1e6)));
  const mutation=matrix(input.mutation,'mutation',n,n).map(r=>{r.forEach(v=>number(v,'mutation probability',0,1));if(Math.abs(sum(r)-1)>1e-10)throw new TypeError('mutation rows must sum to one');return r;});
  return {counts,n,N,payoffs,mutation,selection:number(input.selection??1,'selection',0,100)};
}
function offspring(p,counts){
  const frequencies=counts.map(c=>c/p.N),pay=p.payoffs.map(r=>sum(r.map((v,j)=>v*frequencies[j]))),min=Math.min(...pay),fitness=pay.map(v=>1+p.selection*(v-min)),normalizer=sum(frequencies.map((v,j)=>v*fitness[j]));
  const parents=frequencies.map((v,j)=>v*fitness[j]/normalizer);
  const probabilities=Array.from({length:p.n},(_,j)=>sum(parents.map((v,i)=>v*p.mutation[i][j])));
  // Roundoff normalization only; stochastic matrices were already checked.
  const z=sum(probabilities);return probabilities.map(v=>v/z);
}
export function finitePopulationMoments(input){
  object(input,'population moments',['counts','payoffs','mutation','selection'],['counts','payoffs','mutation']);
  const p=validate(input),probabilities=offspring(p,p.counts);
  return {domain:'WRIGHT_FISHER_REPLICATOR_MUTATOR_MOMENTS',offspringProbabilities:probabilities,expectedCounts:probabilities.map(v=>p.N*v),covariance:probabilities.map((a,i)=>probabilities.map((b,j)=>p.N*((i===j?a:0)-a*b)))};
}
export function simulateFinitePopulationGame(input){
  object(input,'population simulation',['counts','payoffs','mutation','selection','generations','seed','replicates'],['counts','payoffs','mutation','generations','seed']);
  const p=validate(input),generations=integer(input.generations,'generations',1,10000),replicates=integer(input.replicates??1,'replicates',1,10000),rng=seeded(integer(input.seed,'seed',0,2**32-1));
  if(p.N*generations*replicates>10000000||p.n*(generations+1)*replicates>1000000)throw new RangeError('finite population simulation work or output budget exceeded');
  const trajectories=[];
  for(let r=0;r<replicates;r++){
    let counts=[...p.counts];const history=[counts];
    for(let g=0;g<generations;g++){
      const probabilities=offspring(p,counts),cumulative=[];let z=0;for(const v of probabilities)cumulative.push(z+=v);cumulative[p.n-1]=1;
      const next=Array(p.n).fill(0);
      for(let k=0;k<p.N;k++){const u=rng();let j=0;while(u>=cumulative[j])j++;next[j]++;}
      counts=next;history.push(counts);
    }
    trajectories.push(history);
  }
  const finalCounts=trajectories.map(h=>h.at(-1));
  const meanFinalCounts=Array.from({length:p.n},(_,j)=>sum(finalCounts.map(c=>c[j]))/replicates);
  const sampleCovariance=replicates<2?null:meanFinalCounts.map((a,i)=>meanFinalCounts.map((b,j)=>sum(finalCounts.map(c=>(c[i]-a)*(c[j]-b)))/(replicates-1)));
  return {domain:'FINITE_POPULATION_WRIGHT_FISHER_REPLICATOR_MUTATOR',population:p.N,seed:input.seed,replicates,trajectories,meanFinalCounts,sampleCovariance,model:'non-overlapping generations, multinomial offspring, linear nonnegative relative fitness, supplied mutation'};
}
