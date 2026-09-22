import { object, array, id, integer, rational, add, mul, sub, div, cmp, fmt, ONE, ZERO } from './shared.mjs';

/** Exact upper-tail VaR and CVaR for an explicitly supplied finite loss distribution. */
export function evaluateFiniteTailRisk(input) {
  object(input,'tail risk',['scenarios','alpha','maxCvar'],['scenarios','alpha']);
  const alpha=rational(input.alpha,'alpha',{probability:true});
  if(cmp(alpha,ZERO)<=0 || cmp(alpha,ONE)>=0) throw new TypeError('alpha must be strictly between 0 and 1');
  const scenarios=array(input.scenarios,'scenarios',1,128).map((s,i)=>{
    object(s,`scenarios[${i}]`,['id','loss','probability']);
    return { id:id(s.id,`scenarios[${i}].id`), loss:integer(s.loss,`scenarios[${i}].loss`,-1000000000,1000000000), p:rational(s.probability,`scenarios[${i}].probability`,{probability:true})};
  });
  if(new Set(scenarios.map(s=>s.id)).size!==scenarios.length) throw new TypeError('scenario ids must be unique');
  if(cmp(scenarios.reduce((acc,s)=>add(acc,s.p),ZERO),ONE)!==0) throw new TypeError('scenario probabilities must sum exactly to 1');
  const ordered=[...scenarios].sort((a,b)=>a.loss-b.loss || a.id.localeCompare(b.id));
  let mass=ZERO; let varLoss=null;
  for(const s of ordered) {mass=add(mass,s.p); if(cmp(mass,alpha)>=0) {varLoss=s.loss;break;} }
  let above=ZERO, massAbove=ZERO;
  for(const s of scenarios) if(s.loss>varLoss){ massAbove=add(massAbove,s.p);above=add(above,mul([BigInt(s.loss),1n],s.p)); }
  const boundaryMass=sub(sub(ONE,alpha),massAbove);
  if(cmp(boundaryMass,ZERO)<0) throw new Error('internal tail mass inconsistency');
  const cvar=div(add(above,mul([BigInt(varLoss),1n],boundaryMass)),sub(ONE,alpha));
  const expected=scenarios.reduce((acc,s)=>add(acc,mul([BigInt(s.loss),1n],s.p)),ZERO);
  const limit=Object.hasOwn(input,'maxCvar')? rational(input.maxCvar,'maxCvar'):null;
  return {
    engine:'NEMESIS_FINITE_TAIL_RISK_V1', domain:'KNOWN_DISCRETE_LOSS_DISTRIBUTION',
    alpha:fmt(alpha), expectedLoss:fmt(expected), valueAtRisk:varLoss,
    conditionalValueAtRisk:fmt(cvar), probabilityStrictlyAboveVaR:fmt(massAbove),
    boundaryMassAtVaR:fmt(boundaryMass),
    ...(limit?{maxCvar:fmt(limit),withinLimit:cmp(cvar,limit)<=0,status:cmp(cvar,limit)<=0?'PASS':'BREACH'}:{}),
    note:'Exact upper-tail CVaR for supplied finite distribution; excludes unmodelled catastrophes and unknown probabilities.'
  };
}
