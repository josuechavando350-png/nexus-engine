import { object, array, id, unique } from './shared.mjs';

/** Finite positive subclass closure with disjointness constraint checking; no closed-world negation. */
export function reasonCrossDomainOntology(input) {
  object(input,'ontology',['classes','subclassOf','equivalentClasses','disjointClasses','individuals','types','queries'],['classes','subclassOf','equivalentClasses','disjointClasses','individuals','types']);
  const classes=unique(array(input.classes,'classes',1,128).map((v,i)=>id(v,`classes[${i}]`)),'classes');
  const individuals=unique(array(input.individuals,'individuals',0,128).map((v,i)=>id(v,`individuals[${i}]`)),'individuals');
  const classSet=new Set(classes),individualSet=new Set(individuals);
  const parents=new Map(classes.map(v=>[v,new Set()]));
  function pair(value,field){
    array(value,field,2,2);for(const v of value)if(!classSet.has(v))throw new TypeError(`${field}: unknown class ${v}`);
    return value;
  }
  const subclassOf=array(input.subclassOf,'subclassOf',0,512);
  for(let i=0;i<subclassOf.length;i++){const [sub,sup]=pair(subclassOf[i],`subclassOf[${i}]`);parents.get(sub).add(sup);}
  const equivalentClasses=array(input.equivalentClasses,'equivalentClasses',0,256);
  for(let i=0;i<equivalentClasses.length;i++){const [a,b]=pair(equivalentClasses[i],`equivalentClasses[${i}]`);parents.get(a).add(b);parents.get(b).add(a);}
  const disjointClasses=array(input.disjointClasses,'disjointClasses',0,512).map((p,i)=>pair(p,`disjointClasses[${i}]`));
  const closure=new Map();
  for(const cls of classes){
    const seen=new Set([cls]), queue=[cls];
    for(let i=0;i<queue.length;i++)for(const p of parents.get(queue[i]))if(!seen.has(p)){seen.add(p);queue.push(p);}
    closure.set(cls,seen);
  }
  const assignments=new Map(individuals.map(v=>[v,new Set()]));
  for(const [i,triple] of array(input.types,'types',0,1024).entries()){
    object(triple,`types[${i}]`,['individual','class']);
    if(!individualSet.has(triple.individual)||!classSet.has(triple.class))throw new TypeError(`types[${i}]: unknown individual or class`);
    assignments.get(triple.individual).add(triple.class);
  }
  const inferred={};const contradictions=[];
  for(const individual of individuals){
    const classesFor=new Set();for(const declared of assignments.get(individual))for(const c of closure.get(declared))classesFor.add(c);
    inferred[individual]=classes.filter(c=>classesFor.has(c));
    for(const [a,b] of disjointClasses)if(classesFor.has(a)&&classesFor.has(b))contradictions.push({individual,disjoint:[a,b],assertedTypes:[...assignments.get(individual)]});
  }
  const queries=array(input.queries??[],'queries',0,512).map((query,i)=>{
    object(query,`queries[${i}]`,['individual','class']);
    if(!individualSet.has(query.individual)||!classSet.has(query.class))throw new TypeError('query references unknown symbol');
    const witness=[...assignments.get(query.individual)].find(c=>closure.get(c).has(query.class))??null;
    return {individual:query.individual,class:query.class,entailed:witness!==null,witnessAssertedType:witness,notEntailedDoesNotMeanFalse:true};
  });
  // A class with disjoint superclasses is unsatisfiable but DOES NOT make the
  // whole ontology inconsistent until an individual is asserted to inhabit it.
  const unsatisfiableClasses=[];
  for(const cls of classes)for(const [a,b] of disjointClasses)if(closure.get(cls).has(a)&&closure.get(cls).has(b))unsatisfiableClasses.push({class:cls,disjoint:[a,b]});
  return {engine:'NEMESIS_CROSS_DOMAIN_ONTOLOGY_V1',domain:'FINITE_POSITIVE_CLASS_HIERARCHY',status:contradictions.length===0?'PASS':'INCONSISTENT',consistent:contradictions.length===0,
    inferredTypes:inferred,queries,contradictions,unsatisfiableClasses,note:'Open-world positive subclass entailment. Unsatisfiable classes do not imply ontology inconsistency unless instantiated; no OWL completeness, arbitrary rules or inferred identity.'};
}
