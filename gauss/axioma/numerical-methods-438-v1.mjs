/* Analytic references (not GAUSS methods): linear roots, polynomial derivatives/integrals and exact forced ODE trajectories. */
import assert from 'node:assert/strict';
import {runBatchBank,seq} from './batch-238-common.mjs';
const tags=['BISECTION_ROOT','FALSE_POSITION_ROOT','SECANT_ROOT','NEWTON_ROOT','HALLEY_ROOT','RIDDER_ROOT','ROOT_BRACKET_SCAN','DERIV_FORWARD','DERIV_CENTRAL','DERIV_FIVE_POINT','DERIV_SECOND_CENTRAL','DERIV_RICHARDSON','QUAD_MIDPOINT','QUAD_TRAPEZOID','QUAD_SIMPSON','QUAD_BOOLE','QUAD_GAUSS_2','QUAD_GAUSS_3','QUAD_ROMBERG','QUAD_ADAPTIVE_SIMPSON','ODE_EULER','ODE_HEUN','ODE_MIDPOINT','ODE_RK4','OSCILLATOR_SYMPLECTIC_EULER'];
const close=(a,b,eps)=>{assert.ok(typeof a==='number'&&Number.isFinite(a),`nonfinite number ${a}`);assert.ok(Math.abs(a-b)<=eps*Math.max(1,Math.abs(b)),`${a} vs ${b} exceeds ${eps}`);};
function input(tag,i,r){const root=(r(9)-4)/4,coefficients=[-root,1],lo=-2,hi=2;
 if(['BISECTION_ROOT','FALSE_POSITION_ROOT','RIDDER_ROOT'].includes(tag))return {coefficients,lower:lo,upper:hi,tolerance:1e-9,maxIterations:64};
 if(tag==='SECANT_ROOT')return {coefficients,x0:-1.5,x1:1.5,tolerance:1e-9,maxIterations:32};
 if(['NEWTON_ROOT','HALLEY_ROOT'].includes(tag))return {coefficients,x0:1.5,tolerance:1e-9,maxIterations:32};
 if(tag==='ROOT_BRACKET_SCAN')return {coefficients,lower:-2,upper:2,steps:16};
 const poly=[r(7)-3,r(7)-3,r(7)-3],at=(r(9)-4)/4;
 if(tag.startsWith('DERIV_'))return {coefficients:poly,at,h:0.001};
 if(tag.startsWith('QUAD_')){const x={coefficients:poly,lower:-1,upper:1};if(tag==='QUAD_ROMBERG')return {...x,levels:4};if(tag==='QUAD_ADAPTIVE_SIMPSON')return {...x,tolerance:1e-9,maxDepth:8};return {...x,steps:tag==='QUAD_BOOLE'?16:tag==='QUAD_SIMPSON'?16:16};}
 if(tag.startsWith('ODE_'))return {a:0,b:r(5)-2,c:r(5)-2,t0:-1,y0:r(9)-4,dt:0.05,steps:8};
 return {position:r(9)-4,velocity:r(9)-4,omegaSquared:1+r(4),dt:0.01,steps:8};
}
function reference(tag,x){const [c0,c1,c2]=x.coefficients??[],root=-c0/c1;
 if(tag.endsWith('_ROOT')||tag==='FALSE_POSITION_ROOT')return {root,degree:1};
 if(tag==='ROOT_BRACKET_SCAN'){const exact=seq(x.steps+1).map(i=>x.lower+(x.upper-x.lower)*i/x.steps).filter(t=>t===root),brackets=exact.length?[]:seq(x.steps).filter(i=>{const a=x.lower+(x.upper-x.lower)*i/x.steps,b=x.lower+(x.upper-x.lower)*(i+1)/x.steps;return a<root&&root<b;}).map(i=>[x.lower+(x.upper-x.lower)*i/x.steps,x.lower+(x.upper-x.lower)*(i+1)/x.steps]);return {exact,brackets};}
 if(tag.startsWith('DERIV_'))return {estimate:tag==='DERIV_SECOND_CENTRAL'?2*c2:c1+2*c2*x.at};
 if(tag.startsWith('QUAD_')){const F=t=>c0*t+c1*t*t/2+c2*t*t*t/3;return {integral:F(x.upper)-F(x.lower)};}
 if(tag.startsWith('ODE_')){const exact=t=>x.y0+x.b*(t*t-x.t0*x.t0)/2+x.c*(t-x.t0),times=seq(x.steps+1).map(i=>x.t0+i*x.dt);return {times,exact:times.map(exact)};}
 if(tag==='OSCILLATOR_SYMPLECTIC_EULER'){const w=Math.sqrt(x.omegaSquared),times=seq(x.steps+1).map(i=>i*x.dt);return {positions:times.map(t=>x.position*Math.cos(w*t)+x.velocity*Math.sin(w*t)/w),velocities:times.map(t=>x.velocity*Math.cos(w*t)-w*x.position*Math.sin(w*t))};}
 throw Error('missing numerical reference '+tag);
}
function verify(tag,x,actual,expected){if(tag.endsWith('_ROOT')||tag==='FALSE_POSITION_ROOT'){
  assert.equal(actual.converged,true,`root solver did not converge: ${tag}`);assert.ok(Number.isInteger(actual.iterations)&&actual.iterations<=x.maxIterations);close(actual.root,expected.root,1e-8);close(actual.residual,0,1e-8);close(actual.residual,actual.root-expected.root,1e-8);return;
 }
 if(tag==='ROOT_BRACKET_SCAN'){assert.deepStrictEqual(actual,expected);return;}
 if(tag.startsWith('DERIV_')){close(actual.estimate,expected.estimate,tag==='DERIV_FORWARD'?0.005:tag==='DERIV_SECOND_CENTRAL'?1e-8:1e-9);return;}
 if(tag.startsWith('QUAD_')){close(actual.integral,expected.integral,['QUAD_MIDPOINT','QUAD_TRAPEZOID'].includes(tag)?0.008:1e-8);if(tag==='QUAD_ROMBERG'){assert.equal(actual.levels.length,x.levels);actual.levels.forEach((row,i)=>assert.equal(row.length,i+1));close(actual.levels.at(-1).at(-1),actual.integral,1e-12);}if(tag==='QUAD_ADAPTIVE_SIMPSON'){assert.equal(actual.converged,true);assert.ok(Number.isSafeInteger(actual.evaluations)&&actual.evaluations>=5);}return;}
 if(tag.startsWith('ODE_')){assert.equal(actual.times.length,expected.times.length);assert.equal(actual.values.length,expected.exact.length);actual.times.forEach((t,i)=>{close(t,expected.times[i],1e-12);close(actual.values[i],expected.exact[i],tag==='ODE_EULER'?0.02:1e-8);});return;}
 if(tag==='OSCILLATOR_SYMPLECTIC_EULER'){assert.equal(actual.positions.length,expected.positions.length);assert.equal(actual.velocities.length,expected.velocities.length);expected.positions.forEach((p,i)=>{close(actual.positions[i],p,0.03);close(actual.velocities[i],expected.velocities[i],0.03);});close(actual.energyDrift,(actual.velocities.at(-1)**2+x.omegaSquared*actual.positions.at(-1)**2-x.velocity*x.velocity-x.omegaSquared*x.position*x.position)/2,1e-10);return;}
 throw Error('missing numerical verification '+tag);
}
export const runNumerical438Bank=options=>runBatchBank({name:'AXIOMA analytic numerical-method references 401–425',prefix:'CONTROL',start:401,tags,input,reference,verify,...options});
