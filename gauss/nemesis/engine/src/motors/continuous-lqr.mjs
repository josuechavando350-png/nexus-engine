import {object,number,integer,assertFinite} from './finite-tools.mjs';
/** Scalar continuous-time stochastic LQR via backward Riccati ODE RK4 and deterministic feedback. */
export function solveScalarStochasticLQR(input){object(input,'lqr',['a','b','q','r','terminal','horizon','steps','noise'],['a','b','q','r','terminal','horizon','steps']);
 const a=number(input.a,'a',-100,100),b=number(input.b,'b',-100,100),q=number(input.q,'q',0,1e6),r=number(input.r,'r',1e-9,1e6),terminal=number(input.terminal,'terminal',0,1e6),T=number(input.horizon,'horizon',1e-5,100),steps=integer(input.steps,'steps',10,100000),sigma=number(input.noise??0,'noise',0,1e3),dt=T/steps,c=b*b/r;
 // dP/dtau = 2aP - cP² + q with tau=T-t, P(0)=terminal.
 const f=P=>2*a*P-c*P*P+q;const backward=[terminal];let P=terminal;for(let i=0;i<steps;i++){const k1=f(P),k2=f(P+dt*k1/2),k3=f(P+dt*k2/2),k4=f(P+dt*k3);P+=dt*(k1+2*k2+2*k3+k4)/6;if(!Number.isFinite(P)||P< -1e-7)throw new RangeError('Riccati numerical divergence; refine steps');P=Math.max(0,P);backward.push(P);}
 const trajectory=backward.slice().reverse().map((p,i)=>({time:i*dt,riccati:p,gain:b*p/r}));
 // Value V(t,x)=P(t)*x² + sigma² ∫_t^T P(s)ds under additive Brownian diffusion.
 const noiseOffset=sigma*sigma*dt*(backward.reduce((s,v)=>s+v,0)-(backward[0]+backward.at(-1))/2);
 return {domain:'SCALAR_CONTINUOUS_TIME_STOCHASTIC_LQR',initialRiccati:assertFinite(P),initialGain:b*P/r,noiseValueOffset:assertFinite(noiseOffset),trajectory,note:'Finite-horizon scalar linear dynamics dx=(a*x+b*u)dt+noise*dW, quadratic expected cost. Numerical RK4 solution; no unconstrained nonlinear control or general HJB.'};
}
