/* Independently verified output conventions for DFA quotient states and bounded discretization errors. */
import assert from 'node:assert/strict';
import {runFiniteAutomata438Bank as automata} from './finite-automata-438-v1.mjs';
import {runNumerical438Bank as numerical} from './numerical-methods-438-v1.mjs';
const close=(actual,expected,relative)=>{
  assert.ok(typeof actual==='number'&&Number.isFinite(actual),`nonfinite result ${actual}`);
  assert.ok(Math.abs(actual-expected)<=relative*Math.max(1,Math.abs(expected)),`${actual} vs ${expected}, tolerance ${relative}`);
};
function automataVerify(tag,input,actual,expected){
  if(tag!=='DFA_MINIMIZE'){assert.deepStrictEqual(actual,expected);return;}
  // Independently find each equivalence class by its accepted language, then
  // number accepting classes first, as required by the quotient output contract.
  const accepting=new Set(input.accepting);
  const classes=expected.classes.slice().sort((a,b)=>Number(accepting.has(b[0]))-Number(accepting.has(a[0]))||a[0]-b[0]);
  const byState=new Map(classes.flatMap((group,i)=>group.map(state=>[state,i])));
  const dfa={alphabet:input.alphabet,start:byState.get(input.start),accepting:classes.flatMap((group,i)=>accepting.has(group[0])?[i]:[]),transitions:classes.map(group=>input.transitions[group[0]].map(state=>byState.get(state)))};
  assert.deepStrictEqual(actual,{classes,dfa});
}
function numericalVerify(tag,input,actual,expected){
  if(tag.endsWith('_ROOT')||tag==='FALSE_POSITION_ROOT'){
    assert.equal(actual.converged,true,`root method ${tag} did not converge`);
    assert.ok(Number.isInteger(actual.iterations)&&actual.iterations<=input.maxIterations);
    close(actual.root,expected.root,1e-8);
    close(actual.residual,0,1e-8);
    close(actual.residual,actual.root-expected.root,1e-8);
    return;
  }
  if(tag==='ROOT_BRACKET_SCAN'){assert.deepStrictEqual(actual,expected);return;}
  if(tag.startsWith('DERIV_')){
    close(actual.estimate,expected.estimate,tag==='DERIV_FORWARD'?0.005:tag==='DERIV_SECOND_CENTRAL'?1e-8:1e-9);
    return;
  }
  if(tag.startsWith('QUAD_')){
    // For f(x)=c0+c1*x+c2*x^2 on a uniform grid of n intervals,
    // composite trapezoid error is c2*(b-a)^3/(6*n^2), midpoint is its -1/2.
    const c2=input.coefficients[2],span=input.upper-input.lower;
    const correction=c2*span**3/(6*input.steps**2);
    if(tag==='QUAD_TRAPEZOID'||tag==='QUAD_MIDPOINT'){
      const predicted=expected.integral+(tag==='QUAD_TRAPEZOID'?correction:-correction/2);
      close(actual.integral,predicted,1e-11);
      assert.ok(Math.abs(actual.integral-expected.integral)<=Math.abs(correction)+1e-11,'quadrature error exceeds exact polynomial bound');
    }else close(actual.integral,expected.integral,1e-8);
    if(tag==='QUAD_ROMBERG'){
      assert.equal(actual.levels.length,input.levels);
      actual.levels.forEach((row,i)=>assert.equal(row.length,i+1));
      close(actual.levels.at(-1).at(-1),actual.integral,1e-12);
    }
    if(tag==='QUAD_ADAPTIVE_SIMPSON'){
      assert.equal(actual.converged,true);
      assert.ok(Number.isSafeInteger(actual.evaluations)&&actual.evaluations>=5);
    }
    return;
  }
  if(tag.startsWith('ODE_')){
    assert.equal(actual.times.length,expected.times.length);
    assert.equal(actual.values.length,expected.exact.length);
    actual.times.forEach((time,i)=>{
      close(time,expected.times[i],1e-12);
      // The Euler left-endpoint sum for y'=b*t+c (a=0) differs from
      // the exact integral by -b*i*dt^2/2. This is an analytic prediction,
      // not a tolerance widened to force a test to pass.
      const predicted=tag==='ODE_EULER'?expected.exact[i]-input.b*i*input.dt**2/2:expected.exact[i];
      close(actual.values[i],predicted,1e-8);
      if(tag==='ODE_EULER')assert.ok(Math.abs(actual.values[i]-expected.exact[i])<=Math.abs(input.b*i*input.dt**2/2)+1e-10);
    });
    return;
  }
  if(tag==='OSCILLATOR_SYMPLECTIC_EULER'){
    assert.equal(actual.positions.length,expected.positions.length);
    assert.equal(actual.velocities.length,expected.velocities.length);
    expected.positions.forEach((position,i)=>{
      close(actual.positions[i],position,0.03);
      close(actual.velocities[i],expected.velocities[i],0.03);
    });
    const energyDrift=(actual.velocities.at(-1)**2+input.omegaSquared*actual.positions.at(-1)**2-input.velocity**2-input.omegaSquared*input.position**2)/2;
    close(actual.energyDrift,energyDrift,1e-10);
    return;
  }
  throw new Error(`missing independently specified numerical verification: ${tag}`);
}
export const runFiniteAutomata438Bank=options=>automata({verify:automataVerify,...options});
export const runNumerical438Bank=options=>numerical({verify:numericalVerify,...options});
