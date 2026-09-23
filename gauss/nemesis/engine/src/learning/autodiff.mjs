/** Reverse-mode scalar tape. All arithmetic is finite and tape size is bounded. */
export function createTape(limit=200000){
 const nodes=[];
 function node(value,parents=[]){if(!Number.isFinite(value))throw new RangeError('autodiff nonfinite value');if(nodes.length>=limit)throw new RangeError('autodiff tape budget exceeded');const n={value,gradient:0,parents};nodes.push(n);return n;}
 const constant=value=>node(value);
 const add=(a,b)=>node(a.value+b.value,[[a,1],[b,1]]);
 const mul=(a,b)=>node(a.value*b.value,[[a,b.value],[b,a.value]]);
 const scale=(a,v)=>node(a.value*v,[[a,v]]);
 const sub=(a,b)=>node(a.value-b.value,[[a,1],[b,-1]]);
 const tanh=a=>{const v=Math.tanh(a.value);return node(v,[[a,1-v*v]]);};
 const sigmoid=a=>{const v=a.value>=0?1/(1+Math.exp(-a.value)):Math.exp(a.value)/(1+Math.exp(a.value));return node(v,[[a,v*(1-v)]]);};
 const sin=a=>node(Math.sin(a.value),[[a,Math.cos(a.value)]]);
 const cos=a=>node(Math.cos(a.value),[[a,-Math.sin(a.value)]]);
 const exp=a=>{const v=Math.exp(a.value);return node(v,[[a,v]]);};
 const log=a=>{if(a.value<=0)throw new RangeError('log domain');return node(Math.log(a.value),[[a,1/a.value]]);};
 const sum=xs=>xs.reduce(add,constant(0));
 const dot=(a,b)=>sum(a.map((v,i)=>mul(v,b[i])));
 const logsumexp=xs=>{const m=Math.max(...xs.map(x=>x.value));return add(log(sum(xs.map(x=>exp(sub(x,constant(m)))))),constant(m));};
 function backward(loss){nodes.forEach(n=>n.gradient=0);loss.gradient=1;for(let i=nodes.length-1;i>=0;i--)for(const [p,d] of nodes[i].parents)p.gradient+=nodes[i].gradient*d;if(nodes.some(n=>!Number.isFinite(n.gradient)))throw new RangeError('autodiff nonfinite gradient');}
 return {constant,add,mul,scale,sub,tanh,sigmoid,sin,cos,exp,log,sum,dot,logsumexp,backward,size:()=>nodes.length};
}
