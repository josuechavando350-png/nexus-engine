import test from 'node:test';
import assert from 'node:assert/strict';
import {
 linearStateSpaceTrajectory,finiteControllabilityGramian,finiteObservabilityGramian,
 exactControllabilityRank,exactObservabilityRank,scalarKalmanFilter,
 scalarRauchTungStriebelSmoother,boundedPidController,finiteHorizonDiagonalCostLqr,
 stableScalarLyapunovCertificate,scalarMinimumEnergyReachability,scalarIntervalReachability,
} from '../core/layers/control-systems.mjs';
let seed=0x66a1f081;function random(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/2**32;}
const rand=n=>Math.floor(random()*n);
function near(a,b,eps=1e-8){assert(Math.abs(a-b)<=eps*Math.max(1,Math.abs(a),Math.abs(b)),`${a} differs from ${b}`);}
test('linear state-space trajectory agrees with direct independent component recurrence',()=>{
 for(let run=0;run<200;run++){
  const A=[[random()-.5,random()-.5],[random()-.5,random()-.5]],B=[[random()-.5],[random()-.5]],x=[random(),random()],controls=Array.from({length:rand(8)},()=>[random()-.5]);
  const got=linearStateSpaceTrajectory({A,B,initial:x,controls}).states;let reference=x;
  for(let t=0;t<got.length;t++){
   got[t].forEach((v,i)=>near(v,reference[i]));
   if(t<controls.length){const [u]=controls[t];reference=[A[0][0]*reference[0]+A[0][1]*reference[1]+B[0][0]*u,A[1][0]*reference[0]+A[1][1]*reference[1]+B[1][0]*u];}
  }
 }
});
test('finite controllability and observability Gramians agree with explicit two-state power-series oracles',()=>{
 for(let run=0;run<140;run++){
  const a=random()-.5,b=random()-.5,c=random()-.5,horizon=rand(20);
  const W=finiteControllabilityGramian({A:[[a]],B:[[b]],horizon}).gramian[0][0];
  const O=finiteObservabilityGramian({A:[[a]],C:[[c]],horizon}).gramian[0][0];
  let wc=0,wo=0;for(let t=0;t<horizon;t++){wc+=b*b*a**(2*t);wo+=c*c*a**(2*t);}
  near(W,wc);near(O,wo);
 }
});
test('exact controllability and observability ranks match independent two-state determinant tests',()=>{
 for(let run=0;run<250;run++){
  const A=[[rand(5)-2,rand(5)-2],[rand(5)-2,rand(5)-2]],B=[[rand(5)-2],[rand(5)-2]],C=[[rand(5)-2,rand(5)-2]];
  const ab=[A[0][0]*B[0][0]+A[0][1]*B[1][0],A[1][0]*B[0][0]+A[1][1]*B[1][0]];
  const rankC=B[0][0]*ab[1]-B[1][0]*ab[0]!==0?2:B[0][0]||B[1][0]?1:0;
  const ca=[C[0][0]*A[0][0]+C[0][1]*A[1][0],C[0][0]*A[0][1]+C[0][1]*A[1][1]];
  const rankO=C[0][0]*ca[1]-C[0][1]*ca[0]!==0?2:C[0][0]||C[0][1]?1:0;
  assert.equal(exactControllabilityRank({A,B}).rank,rankC);assert.equal(exactObservabilityRank({A,C}).rank,rankO);
 }
});
test('scalar Kalman filter matches independent Gaussian precision-update oracle without process noise',()=>{
 for(let run=0;run<170;run++){
  const priorMean=random()*4-2,priorVariance=.1+random()*3,r=.2+random()*3,observations=Array.from({length:1+rand(15)},()=>random()*6-3);
  const got=scalarKalmanFilter({a:1,processVariance:0,measurementVariance:r,initialMean:priorMean,initialVariance:priorVariance,observations});
  for(let t=0;t<got.estimates.length;t++){
   const posteriorVariance=1/(1/priorVariance+(t+1)/r);
   const posteriorMean=posteriorVariance*(priorMean/priorVariance+observations.slice(0,t+1).reduce((a,b)=>a+b,0)/r);
   near(got.estimates[t].variance,posteriorVariance);near(got.estimates[t].mean,posteriorMean);
  }
 }
});
test('RTS smoothing agrees with static-latent posterior when a=1 and q=0',()=>{
 for(let run=0;run<150;run++){
  const observations=Array.from({length:1+rand(10)},()=>random()*10-5),args={a:1,processVariance:0,measurementVariance:1+random(),initialMean:random(),initialVariance:1+random(),observations};
  const end=scalarKalmanFilter(args).estimates.at(-1);
  const got=scalarRauchTungStriebelSmoother(args);
  got.smoothed.forEach(state=>{near(state.mean,end.mean);near(state.variance,end.variance);});
 }
});
test('PID controller commands match separate proportional-integral-derivative evaluation with anti-windup',()=>{
 for(let run=0;run<170;run++){
  const n=1+rand(12),targets=Array.from({length:n},()=>rand(10)-5),measurements=Array.from({length:n},()=>rand(10)-5),kp=random(),ki=random(),kd=random(),dt=.1+random(),integralLimit=1+rand(7);
  const got=boundedPidController({targets,measurements,kp,ki,kd,dt,integralLimit});let integral=0,previous=0;
  for(let t=0;t<n;t++){
   const e=targets[t]-measurements[t],derivative=t?(e-previous)/dt:0;
   integral=Math.max(-integralLimit,Math.min(integralLimit,integral+e*dt));near(got.commands[t],kp*e+ki*integral+kd*derivative);previous=e;
  }
  near(got.terminalIntegral,integral);
 }
});
test('finite-horizon vector LQR recovers separately derived one-step scalar feedback',()=>{
 for(let run=0;run<180;run++){
  const a=random()*2-1,b=.1+random(),q=random()*3,r=.1+random()*3,terminal=random()*4,initial=random()*4-2;
  const result=finiteHorizonDiagonalCostLqr({A:[[a]],B:[[b]],statePenalties:[q],controlPenalties:[r],terminalPenalties:[terminal],horizon:1,initialState:[initial]});
  const expectedGain=(a*b*terminal)/(r+b*b*terminal),u=-expectedGain*initial,next=a*initial+b*u;
  near(result.gains[0][0][0],expectedGain);near(result.controls[0][0],u);
  near(result.realizedCost,q*initial*initial+r*u*u+terminal*next*next);near(result.optimalCost,result.realizedCost);
 }
});
test('two-state two-step LQR agrees with an independent simultaneous quadratic control solve',()=>{
 for(let run=0;run<130;run++){
  const A=[[random()-.5,random()-.5],[random()-.5,random()-.5]],B=[[.2+random()],[.2+random()]],x0=[random()*2-1,random()*2-1];
  const statePenalties=[.2+random(),.2+random()],controlPenalties=[.2+random()],terminalPenalties=[.2+random(),.2+random()];
  const args={A,B,initialState:x0,statePenalties,controlPenalties,terminalPenalties,horizon:2};
  const J=(u0,u1)=>{let x=[...x0],total=0;
   for(const u of [u0,u1]){total+=x.reduce((v,c,i)=>v+statePenalties[i]*c*c,0)+controlPenalties[0]*u*u;
    x=[A[0][0]*x[0]+A[0][1]*x[1]+B[0][0]*u,A[1][0]*x[0]+A[1][1]*x[1]+B[1][0]*u];}
   return total+x.reduce((v,c,i)=>v+terminalPenalties[i]*c*c,0);
  };
  const zero=J(0,0),e0=J(1,0),e1=J(0,1),g0=(e0-J(-1,0))/2,g1=(e1-J(0,-1))/2;
  const h00=(e0+J(-1,0)-2*zero)/2,h11=(e1+J(0,-1)-2*zero)/2,h01=(J(1,1)-e0-e1+zero)/2;
  const det=h00*h11-h01*h01;
  const u0=(-h11*g0+h01*g1)/(2*det),u1=(h01*g0-h00*g1)/(2*det);
  const result=finiteHorizonDiagonalCostLqr(args);
  near(result.controls[0][0],u0,1e-7);near(result.controls[1][0],u1,1e-7);
  near(result.optimalCost,J(u0,u1),1e-7);near(result.realizedCost,J(u0,u1),1e-7);
 }
});
test('scalar Lyapunov variance matches separately summed infinite geometric series',()=>{
 for(let run=0;run<130;run++){
  const a=random()*1.5-.75,q=.1+random()*4;const got=stableScalarLyapunovCertificate({a,forcing:q});
  let sum=0;for(let i=0;i<250;i++)sum+=q*a**(2*i);
  near(got.variance,sum);near(got.residual,0);
 }
});
test('minimum-energy scalar reachability matches independent Cauchy-Schwarz lower bound',()=>{
 for(let run=0;run<180;run++){
  const a=random()*1.5-.75,b=.1+random()*2,initial=random()*3,target=random()*3-1,horizon=1+rand(12);
  const got=scalarMinimumEnergyReachability({a,b,initial,target,horizon}),weights=Array.from({length:horizon},(_,j)=>b*a**(horizon-1-j));
  const delta=target-a**horizon*initial,gram=weights.reduce((sum,v)=>sum+v*v,0);
  near(got.minimumEnergy,delta*delta/gram);near(got.terminalState,target);
  got.controls.forEach((u,i)=>near(u,delta*weights[i]/gram));
 }
});
test('interval reachability contains all independently enumerated extreme-control trajectories',()=>{
 for(let run=0;run<160;run++){
  const a=random()*3-1.5,b=random()*3-1.5,initial=random()*4-2,controlLower=-2,controlUpper=3,horizon=rand(9);
  const got=scalarIntervalReachability({a,b,initial,controlLower,controlUpper,horizon});
  for(let t=0;t<=horizon;t++){
   const values=[];for(let mask=0;mask<(1<<t);mask++){
    let x=initial;for(let j=0;j<t;j++)x=a*x+b*((mask&(1<<j))?controlUpper:controlLower);values.push(x);
   }
   near(got.bounds[t].lower,Math.min(...values));near(got.bounds[t].upper,Math.max(...values));
  }
 }
});
test('control operators reject malformed, unstable and over-budget systems',()=>{
 assert.throws(()=>linearStateSpaceTrajectory({A:[[1,2]],B:[[1]],initial:[1],controls:[]}),/square/);
 assert.throws(()=>finiteControllabilityGramian({A:[[1]],B:[[1]],horizon:61}),/integer/);
 assert.throws(()=>finiteObservabilityGramian({A:[[1]],C:[[1,1]],horizon:1}),/match/);
 assert.throws(()=>exactControllabilityRank({A:[[1.2]],B:[[1]]}),/integer/);
 assert.throws(()=>exactObservabilityRank({A:[[1]],C:[[1.2]]}),/integer/);
 assert.throws(()=>scalarKalmanFilter({a:1,processVariance:-1,measurementVariance:1,initialMean:0,initialVariance:1,observations:[]}),/nonnegative/);
 assert.throws(()=>scalarRauchTungStriebelSmoother({a:1,processVariance:0,measurementVariance:0,initialMean:0,initialVariance:1,observations:[1]}),/positive/);
 assert.throws(()=>boundedPidController({targets:[1],measurements:[],kp:1,ki:1,kd:1,dt:1,integralLimit:1}),/length/);
 assert.throws(()=>finiteHorizonDiagonalCostLqr({A:[[1]],B:[[1]],statePenalties:[1],controlPenalties:[0],terminalPenalties:[1],horizon:1,initialState:[1]}),/positive/);
 assert.throws(()=>stableScalarLyapunovCertificate({a:1.001,forcing:1}),/stable/);
 assert.throws(()=>scalarMinimumEnergyReachability({a:1,b:0,initial:0,target:1,horizon:2}),/unreachable/);
 assert.throws(()=>scalarIntervalReachability({a:1,b:1,initial:0,controlLower:2,controlUpper:1,horizon:1}),/exceed/);
});