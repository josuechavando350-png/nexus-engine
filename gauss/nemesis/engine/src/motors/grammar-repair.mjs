import { object, array, id, integer, unique } from './shared.mjs';

const OPS=new Set(['ADD','SUB','MUL']);
/** Bounded AST one/two-edit repair of a pure integer expression against given examples. */
export function repairFiniteExpression(input){
  object(input,'repair problem',['variables','expression','examples','candidateConstants','maxEdits','maxCandidates'],['variables','expression','examples','candidateConstants']);
  const vars=unique(array(input.variables,'variables',1,6).map((v,i)=>id(v,`variables[${i}]`)),'variables');
  const constants=unique(array(input.candidateConstants,'candidateConstants',1,16).map((c,i)=>integer(c,`candidateConstants[${i}]`,-1000000,1000000)),'candidateConstants');
  const maxEdits=Object.hasOwn(input,'maxEdits')?integer(input.maxEdits,'maxEdits',0,2):1;
  const maxCandidates=Object.hasOwn(input,'maxCandidates')?integer(input.maxCandidates,'maxCandidates',1,20000):20000;
  let size=0;
  function checkNode(node,depth=0){
    if(++size>31 || depth>8)throw new RangeError('expression size/depth limit exceeded');
    object(node,'expression',['op','value','name','left','right'],['op']);
    if(node.op==='CONST'){object(node,'CONST',['op','value']);integer(node.value,'constant',-1000000,1000000);}
    else if(node.op==='VAR'){object(node,'VAR',['op','name']);if(!vars.includes(node.name))throw new TypeError('unknown variable');}
    else if(OPS.has(node.op)){object(node,node.op,['op','left','right']);checkNode(node.left,depth+1);checkNode(node.right,depth+1);}
    else throw new TypeError(`unknown arithmetic operator ${node.op}`);
  }
  checkNode(input.expression);
  const examples=array(input.examples,'examples',2,64).map((example,i)=>{
    object(example,`examples[${i}]`,['inputs','expected']);
    object(example.inputs,`examples[${i}].inputs`,vars);
    const inputs=Object.fromEntries(vars.map(v=>[v,integer(example.inputs[v],`${i}.inputs.${v}`,-1000000,1000000)]));
    return {inputs,expected:integer(example.expected,`${i}.expected`,-1000000000,1000000000)};
  });
  function evalExpr(node,env){
    if(node.op==='CONST')return node.value;
    if(node.op==='VAR')return env[node.name];
    const a=evalExpr(node.left,env),b=evalExpr(node.right,env);
    const out=node.op==='ADD'?a+b:node.op==='SUB'?a-b:a*b;
    if(!Number.isSafeInteger(out))throw new RangeError('arithmetic overflow');
    return out;
  }
  function passes(node){
    try{return examples.every(e=>evalExpr(node,e.inputs)===e.expected);}catch(error){if(error instanceof RangeError)return false;throw error;}
  }
  const original=structuredClone(input.expression);
  if(passes(original))return {engine:'NEMESIS_BOUNDED_AST_REPAIR_V1',status:'ALREADY_PASSING',expression:original,edits:[],testedCandidates:1,passedExamples:examples.length};
  if(maxEdits===0)return {engine:'NEMESIS_BOUNDED_AST_REPAIR_V1',status:'NO_REPAIR_IN_BUDGET',testedCandidates:1,maxCandidates,maxEdits};
  function nodes(node,path=[],out=[]){out.push({node,path});if(OPS.has(node.op)){nodes(node.left,[...path,'left'],out);nodes(node.right,[...path,'right'],out);}return out;}
  function variants(ast){
    const out=[];
    for(const {node,path} of nodes(ast)) {
      const replacements=[];
      if(node.op==='CONST'){ for(const value of constants)if(node.value!==value)replacements.push({op:'CONST',value}); }
      else if(node.op==='VAR'){ for(const name of vars)if(node.name!==name)replacements.push({op:'VAR',name}); }
      else { for(const op of OPS)if(node.op!==op)replacements.push({...node,op}); }
      for(const replacement of replacements){
        const next=structuredClone(ast);let cursor=next;
        for(let i=0;i<path.length-1;i++)cursor=cursor[path[i]];
        if(path.length)cursor[path.at(-1)]=replacement;
        else out.push({expression:replacement,edit:{path:'root',before:node,after:replacement}});
        if(path.length)out.push({expression:next,edit:{path:path.join('.'),before:node,after:replacement}});
      }
    }
    return out;
  }
  const seen=new Set([JSON.stringify(original)]);
  let frontier=[{expression:original,edits:[]}],tested=1;
  for(let depth=1;depth<=maxEdits;depth++) {
    const nextFrontier=[];
    for(const previous of frontier)for(const {expression,edit} of variants(previous.expression)){
      const key=JSON.stringify(expression);if(seen.has(key))continue;seen.add(key);
      if(tested>=maxCandidates)return {engine:'NEMESIS_BOUNDED_AST_REPAIR_V1',status:'NO_REPAIR_IN_BUDGET',testedCandidates:tested,maxCandidates,maxEdits,limitReached:true};
      tested++;
      if(passes(expression))return {engine:'NEMESIS_BOUNDED_AST_REPAIR_V1',status:'REPAIRED',expression,edits:[...previous.edits,edit],editCount:depth,testedCandidates:tested,passedExamples:examples.length,
        note:'Repair passes only provided examples for a pure arithmetic AST; no proof of correctness for unseen inputs or general source code.'};
      if(depth<maxEdits)nextFrontier.push({expression,edits:[...previous.edits,edit]});
    }
    frontier=nextFrontier;
  }
  return {engine:'NEMESIS_BOUNDED_AST_REPAIR_V1',status:'NO_REPAIR_IN_BUDGET',testedCandidates:tested,maxCandidates,maxEdits,limitReached:false};
}
