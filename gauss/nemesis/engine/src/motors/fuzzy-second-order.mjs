import { object, array, id, unique, rational, cmp, fmt, ONE, ZERO, sub } from './shared.mjs';

/** Finite-domain, finite-interpretation Gödel fuzzy logic with predicate quantification. */
export function evaluateFiniteFuzzyLogic(input) {
  object(input,'fuzzy problem',['domain','predicates','predicateUniverse','formula','threshold'],['domain','predicates','predicateUniverse','formula']);
  const domain=unique(array(input.domain,'domain',1,8).map((x,i)=>id(x,`domain[${i}]`)),'domain');
  const interpretations={};
  function interpretation(map,name) {
    object(map,name,domain);
    for(const x of domain) interpretations[`${name}:${x}`]=rational(map[x],`${name}.${x}`,{probability:true});
    return Object.fromEntries(domain.map(x=>[x,interpretations[`${name}:${x}`]]));
  }
  object(input.predicates,'predicates',Object.keys(input.predicates));
  const predicates={};
  for(const [name,map] of Object.entries(input.predicates)) {
    id(name,'predicate name'); if(Object.hasOwn(predicates,name)) throw new TypeError('duplicate predicate');
    predicates[name]=interpretation(map,`predicates.${name}`);
  }
  if(Object.keys(predicates).length>16) throw new TypeError('too many predicates');
  const universe=array(input.predicateUniverse,'predicateUniverse',1,16).map((p,i)=>interpretation(p,`predicateUniverse[${i}]`));
  const threshold=Object.hasOwn(input,'threshold')?rational(input.threshold,'threshold',{probability:true}):null;
  let budget=0;
  function evalNode(node,env,depth) {
    if(++budget>100000 || depth>32) throw new RangeError('fuzzy evaluation budget/depth exceeded');
    object(node,'formula',['op','value','name','arg','left','right','var','pred','term'],['op']);
    const required=(...keys)=>object(node,`formula.${node.op}`,['op',...keys]);
    const evalChild=x=>evalNode(x,env,depth+1);
    const term=x=>{
      if(typeof x!=='string' || !Object.hasOwn(env.entities,x)) throw new TypeError(`unbound entity variable ${x}`);
      return env.entities[x];
    };
    switch(node.op) {
      case 'CONST': required('value');return rational(node.value,'constant',{probability:true});
      case 'PRED': {
        required('name','term');
        if(!Object.hasOwn(predicates,node.name)) throw new TypeError(`unknown fixed predicate ${node.name}`);
        return predicates[node.name][term(node.term)];
      }
      case 'APPLY': {
        required('pred','term');
        if(!Object.hasOwn(env.predicates,node.pred)) throw new TypeError(`unbound predicate variable ${node.pred}`);
        return env.predicates[node.pred][term(node.term)];
      }
      case 'NOT': required('arg');return sub(ONE,evalChild(node.arg));
      case 'AND': case 'OR': case 'IMPLIES': {
        required('left','right');const a=evalChild(node.left),b=evalChild(node.right);
        if(node.op==='AND') return cmp(a,b)<=0?a:b;
        if(node.op==='OR') return cmp(a,b)>=0?a:b;
        return cmp(a,b)<=0?ONE:b;
      }
      case 'FORALL': case 'EXISTS': case 'FORALL_PRED': case 'EXISTS_PRED': {
        required('var','arg');id(node.var,'quantifier var');
        const pred=node.op.endsWith('_PRED');
        const values=pred?universe:domain;
        let out=node.op.startsWith('FORALL')?ONE:ZERO;
        for(const value of values){
          const next=pred?{entities:env.entities,predicates:{...env.predicates,[node.var]:value}}:{entities:{...env.entities,[node.var]:value},predicates:env.predicates};
          const degree=evalNode(node.arg,next,depth+1);
          if(node.op.startsWith('FORALL')) { if(cmp(degree,out)<0)out=degree; }
          else if(cmp(degree,out)>0)out=degree;
        }
        return out;
      }
      default:throw new TypeError(`unsupported fuzzy operator ${node.op}`);
    }
  }
  const grade=evalNode(input.formula,{entities:{},predicates:{}},0);
  return {engine:'NEMESIS_FINITE_SECOND_ORDER_FUZZY_V1',semantics:'GODEL_MIN_MAX_RESIDUUM_WITH_STANDARD_NEGATION',
    domainSize:domain.length,predicateInterpretations:universe.length,grade:fmt(grade),
    ...(threshold?{threshold:fmt(threshold),meetsThreshold:cmp(grade,threshold)>=0,status:cmp(grade,threshold)>=0?'PASS':'THRESHOLD_NOT_MET'}:{}),evaluatedNodes:budget,
    note:'Second-order quantifiers range only over supplied finite predicate interpretations; not general undecidable higher-order logic.'};
}
