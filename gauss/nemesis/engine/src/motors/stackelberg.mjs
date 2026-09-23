import {object,array,id,unique,number} from './shared.mjs';
/** Perfect-information three-stage Stackelberg game. Followers observe earlier choices; lexicographic tie breaking. */
export function solveMultilayerStackelberg(input){
 object(input,'Stackelberg',['leaderActions','follower1Actions','follower2Actions','payoffs']);
 const acts=['leaderActions','follower1Actions','follower2Actions'].map(name=>unique(array(input[name],name,1,16).map((v,i)=>id(v,`${name}[${i}]`)),name));
 const [a,b,c]=acts;
 const payoffs=array(input.payoffs,'payoffs',a.length,a.length).map((rows,i)=>array(rows,`payoffs[${i}]`,b.length,b.length).map((cols,j)=>array(cols,`payoffs[${i}][${j}]`,c.length,c.length).map((v,k)=>array(v,`payoffs[${i}][${j}][${k}]`,3,3).map((p,l)=>number(p,`payoff[${i}][${j}][${k}][${l}]`)))));
 // Strict > preserves deterministic first-index tie breaks.
 const follower2=a.map((_,i)=>b.map((_,j)=>{let k=0;for(let v=1;v<c.length;v++)if(payoffs[i][j][v][2]>payoffs[i][j][k][2])k=v;return k;}));
 const follower1=a.map((_,i)=>{let j=0;for(let v=1;v<b.length;v++)if(payoffs[i][v][follower2[i][v]][1]>payoffs[i][j][follower2[i][j]][1])j=v;return j;});
 let leader=0;for(let i=1;i<a.length;i++)if(payoffs[i][follower1[i]][follower2[i][follower1[i]]][0]>payoffs[leader][follower1[leader]][follower2[leader][follower1[leader]]][0])leader=i;
 const f1=follower1[leader],f2=follower2[leader][f1];
 return {domain:'FINITE_THREE_STAGE_PERFECT_INFORMATION_GAME',leader:a[leader],follower1:b[f1],follower2:c[f2],payoffs:payoffs[leader][f1][f2],follower1Responses:follower1.map((j,i)=>({leader:a[i],follower1:b[j]})),follower2Responses:follower2.map((row,i)=>row.map((k,j)=>({leader:a[i],follower1:b[j],follower2:c[k]}))),note:'Subgame-perfect backward induction for one leader and two sequential followers; not arbitrary multilayer or simultaneous game equilibria.'};
}
