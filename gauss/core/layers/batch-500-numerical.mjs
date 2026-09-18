import {keys,integer,finite,array,out,tuple} from './batch-500-common.mjs';
function coefficients(x){const a=array(x,'coefficients',1,10).map((v,i)=>finite(v,`coefficients[${i}]`,-100,100));return a;}
const check=(v,label)=>{if(!Number.isFinite(v)||Math.abs(v)>1e15)throw new RangeError(`${label}: numerical overflow`);return v;};
function evalP(a,x){let v=0;for(let i=a.length-1;i>=0;i--)v=check(v*x+a[i],'polynomial evaluation');return v;}
function derive(a){return a.slice(1).map((v,i)=>v*(i+1));}
function rootBasic(x,required){keys(x,['coefficients',...required]);return coefficients(x.coefficients);}
function rootResult(a,x,n,ok){return out({root:check(x,'root'),residual:evalP(a,x),iterations:n,converged:ok});}
function bracket(x){const a=rootBasic(x,['lower','upper','tolerance','maxIterations']),lo=finite(x.lower,'lower',-100,100),hi=finite(x.upper,'upper',-100,100),tol=finite(x.tolerance,'tolerance',1e-14,1),max=integer(x.maxIterations,'maxIterations',1,128);if(lo>=hi)throw new RangeError('lower < upper required');const fl=evalP(a,lo),fh=evalP(a,hi);if(fl*fh>0)throw new RangeError('root bracket lacks opposite endpoint signs');return {a,lo,hi,tol,max,fl,fh};}
function stop(f,width,tol){return Math.abs(f)<=tol||width<=tol;}
export function bisection(x){let {a,lo,hi,tol,max,fl}=bracket(x);if(!fl)return rootResult(a,lo,0,true);if(!evalP(a,hi))return rootResult(a,hi,0,true);
 for(let n=1;n<=max;n++){const mid=(lo+hi)/2,f=evalP(a,mid);if(stop(f,hi-lo,tol))return rootResult(a,mid,n,true);if((fl<0)===(f<0)){lo=mid;fl=f;}else hi=mid;}return rootResult(a,(lo+hi)/2,max,false);}
export function regulaFalsi(x){let {a,lo,hi,tol,max,fl,fh}=bracket(x);if(!fl)return rootResult(a,lo,0,true);if(!fh)return rootResult(a,hi,0,true);let mid=lo;
 for(let n=1;n<=max;n++){const den=fh-fl;if(!den)throw new RangeError('flat false-position secant');mid=(lo*fh-hi*fl)/den;const f=evalP(a,mid);if(stop(f,hi-lo,tol))return rootResult(a,mid,n,true);if((fl<0)===(f<0)){lo=mid;fl=f;}else{hi=mid;fh=f;}}return rootResult(a,mid,max,false);}
function guesses(x,required){const a=rootBasic(x,[...required,'tolerance','maxIterations']),tol=finite(x.tolerance,'tolerance',1e-14,1),max=integer(x.maxIterations,'maxIterations',1,128);return {a,tol,max};}
export function secantRoot(x){const {a,tol,max}=guesses(x,['x0','x1']);let p=finite(x.x0,'x0',-100,100),q=finite(x.x1,'x1',-100,100),fp=evalP(a,p),fq=evalP(a,q);if(Math.abs(fp)<=tol)return rootResult(a,p,0,true);if(Math.abs(fq)<=tol)return rootResult(a,q,0,true);
 for(let n=1;n<=max;n++){if(fq===fp)return rootResult(a,q,n-1,false);const next=check(q-fq*(q-p)/(fq-fp),'secant');p=q;fp=fq;q=next;fq=evalP(a,q);if(Math.abs(fq)<=tol||Math.abs(q-p)<=tol)return rootResult(a,q,n,true);}return rootResult(a,q,max,false);}
export function newtonRoot(x){const {a,tol,max}=guesses(x,['x0']),d=derive(a);let p=finite(x.x0,'x0',-100,100);
 for(let n=0;n<=max;n++){const v=evalP(a,p);if(Math.abs(v)<=tol)return rootResult(a,p,n,true);if(n===max)return rootResult(a,p,n,false);const dv=evalP(d,p);if(!dv)return rootResult(a,p,n,false);p=check(p-v/dv,'newton');}throw new Error('unreachable');}
export function halleyRoot(x){const {a,tol,max}=guesses(x,['x0']),d=derive(a),dd=derive(d);let p=finite(x.x0,'x0',-100,100);
 for(let n=0;n<=max;n++){const v=evalP(a,p);if(Math.abs(v)<=tol)return rootResult(a,p,n,true);if(n===max)return rootResult(a,p,n,false);const dv=evalP(d,p),ddv=evalP(dd,p),den=2*dv*dv-v*ddv;if(!den)return rootResult(a,p,n,false);p=check(p-2*v*dv/den,'halley');}throw new Error('unreachable');}
export function ridderRoot(x){let {a,lo,hi,tol,max,fl,fh}=bracket(x);if(!fl)return rootResult(a,lo,0,true);if(!fh)return rootResult(a,hi,0,true);let current=(lo+hi)/2;
 for(let n=1;n<=max;n++){const m=(lo+hi)/2,fm=evalP(a,m),rad=fm*fm-fl*fh;if(rad<0)throw new RangeError('invalid Ridder radicand');if(rad===0)return rootResult(a,m,n,Math.abs(fm)<=tol);const z=check(m+(m-lo)*(fl>=fh?1:-1)*fm/Math.sqrt(rad),'ridder'),fz=evalP(a,z);current=z;
 if(stop(fz,hi-lo,tol))return rootResult(a,z,n,true);
 if((fm<0)!==(fz<0)){lo=m;fl=fm;hi=z;fh=fz;}else if((fl<0)!==(fz<0)){hi=z;fh=fz;}else{lo=z;fl=fz;}if(lo>hi){[lo,hi]=[hi,lo];[fl,fh]=[fh,fl];}}
 return rootResult(a,current,max,false);}
export function scanRootBrackets(x){const a=rootBasic(x,['lower','upper','steps']),lo=finite(x.lower,'lower',-100,100),hi=finite(x.upper,'upper',-100,100),n=integer(x.steps,'steps',1,1024);if(lo>=hi)throw new RangeError('lower < upper required');const exact=[],intervals=[];let prev=lo,fp=evalP(a,lo);if(fp===0)exact.push(lo);for(let i=1;i<=n;i++){const t=lo+(hi-lo)*i/n,ft=evalP(a,t);if(ft===0)exact.push(t);else if((fp<0)!==(ft<0)&&fp!==0)intervals.push([prev,t]);prev=t;fp=ft;}return out({exact,brackets:intervals});}
function diff(x,fields){const a=rootBasic(x,fields),at=finite(x.at,'at',-100,100),h=finite(x.h,'h',1e-7,1);return {a,at,h,f:t=>evalP(a,t)};}
export function forwardDerivative(x){const {at,h,f}=diff(x,['at','h']);return out({estimate:check((f(at+h)-f(at))/h,'derivative')});}
export function centralDerivative(x){const {at,h,f}=diff(x,['at','h']);return out({estimate:check((f(at+h)-f(at-h))/(2*h),'derivative')});}
export function fivePointDerivative(x){const {at,h,f}=diff(x,['at','h']);return out({estimate:check((f(at-2*h)-8*f(at-h)+8*f(at+h)-f(at+2*h))/(12*h),'derivative')});}
export function secondCentralDerivative(x){const {at,h,f}=diff(x,['at','h']);return out({estimate:check((f(at+h)-2*f(at)+f(at-h))/(h*h),'second derivative')});}
export function richardsonDerivative(x){const {at,h,f}=diff(x,['at','h']),d=k=>(f(at+k)-f(at-k))/(2*k);return out({estimate:check((4*d(h/2)-d(h))/3,'richardson derivative')});}
function interval(x,mode='steps'){const names=['coefficients','lower','upper',mode],a=rootBasic(x,names.slice(1)),lo=finite(x.lower,'lower',-100,100),hi=finite(x.upper,'upper',-100,100);if(lo>=hi)throw new RangeError('lower < upper required');return {a,lo,hi,n:integer(x[mode],mode,1,512),f:t=>evalP(a,t)};}
export function midpointIntegral(x){const {lo,hi,n,f}=interval(x),h=(hi-lo)/n;let sum=0;for(let i=0;i<n;i++)sum+=f(lo+(i+0.5)*h);return out({integral:check(h*sum,'midpoint integral')});}
export function trapezoidIntegral(x){const {lo,hi,n,f}=interval(x),h=(hi-lo)/n;let sum=(f(lo)+f(hi))/2;for(let i=1;i<n;i++)sum+=f(lo+i*h);return out({integral:check(h*sum,'trapezoid integral')});}
export function simpsonIntegral(x){const {lo,hi,n,f}=interval(x);if(n%2)throw new RangeError('Simpson requires an even number of subintervals');const h=(hi-lo)/n;let sum=f(lo)+f(hi);for(let i=1;i<n;i++)sum+=(i%2?4:2)*f(lo+i*h);return out({integral:check(h*sum/3,'simpson integral')});}
export function booleIntegral(x){const {lo,hi,n,f}=interval(x);if(n%4)throw new RangeError('Boole requires multiple of four subintervals');const h=(hi-lo)/n;let sum=0;for(let i=0;i<n;i+=4){const t=lo+i*h;sum+=7*f(t)+32*f(t+h)+12*f(t+2*h)+32*f(t+3*h)+7*f(t+4*h);}return out({integral:check(2*h*sum/45,'boole integral')});}
function gauss(x,order){const {lo,hi,n,f}=interval(x),half=(hi-lo)/(2*n),xs=order===2?[-1/Math.sqrt(3),1/Math.sqrt(3)]:[-Math.sqrt(3/5),0,Math.sqrt(3/5)],weights=order===2?[1,1]:[5/9,8/9,5/9];let sum=0;for(let i=0;i<n;i++){const mid=lo+(2*i+1)*half;for(let j=0;j<xs.length;j++)sum+=half*weights[j]*f(mid+half*xs[j]);}return out({integral:check(sum,'gauss integral')});}
export function gaussLegendreTwo(x){return gauss(x,2);}
export function gaussLegendreThree(x){return gauss(x,3);}
export function rombergIntegral(x){const {a,lo,hi,n:levels,f}=interval(x,'levels');void a;if(levels>9)throw new RangeError('Romberg at most 9 levels');const table=[];for(let k=0;k<levels;k++){const n=2**k,h=(hi-lo)/n;let sum=(f(lo)+f(hi))/2;for(let i=1;i<n;i++)sum+=f(lo+i*h);const row=[h*sum];for(let j=1;j<=k;j++)row[j]=row[j-1]+(row[j-1]-table[k-1][j-1])/(4**j-1);table.push(row);}return out({integral:check(table.at(-1).at(-1),'romberg integral'),levels:table});}
export function adaptiveSimpson(x){keys(x,['coefficients','lower','upper','tolerance','maxDepth']);const a=coefficients(x.coefficients),lo=finite(x.lower,'lower',-100,100),hi=finite(x.upper,'upper',-100,100),tol=finite(x.tolerance,'tolerance',1e-13,1),depth=integer(x.maxDepth,'maxDepth',1,18);if(lo>=hi)throw new RangeError('lower < upper required');const f=t=>evalP(a,t),S=(a,b,fa,fm,fb)=>(b-a)*(fa+4*fm+fb)/6;let evaluations=3;
 function integrate(a,b,fa,fm,fb,whole,eps,d){const m=(a+b)/2,l=(a+m)/2,r=(m+b)/2,fl=f(l),fr=f(r);evaluations+=2;const left=S(a,m,fa,fl,fm),right=S(m,b,fm,fr,fb),error=(left+right-whole)/15;
 if(d===0)return {value:left+right+error,converged:Math.abs(error)<=eps};if(Math.abs(error)<=eps)return {value:left+right+error,converged:true};const u=integrate(a,m,fa,fl,fm,left,eps/2,d-1),v=integrate(m,b,fm,fr,fb,right,eps/2,d-1);return {value:u.value+v.value,converged:u.converged&&v.converged};}
 const fa=f(lo),fb=f(hi),fm=f((lo+hi)/2),z=integrate(lo,hi,fa,fm,fb,S(lo,hi,fa,fm,fb),tol,depth);return out({integral:check(z.value,'adaptive integral'),converged:z.converged,evaluations});}
function ode(x){keys(x,['a','b','c','t0','y0','dt','steps']);const a=finite(x.a,'a',-20,20),b=finite(x.b,'b',-20,20),c=finite(x.c,'c',-20,20),t=finite(x.t0,'t0',-100,100),y=finite(x.y0,'y0',-100,100),h=finite(x.dt,'dt',0.00001,1),n=integer(x.steps,'steps',1,512);return {f:(t,y)=>check(a*y+b*t+c,'ODE derivative'),t,y,h,n};}
function march(x,step){let {f,t,y,h,n}=ode(x);const values=[y];for(let i=0;i<n;i++){y=check(step(f,t,y,h),'ODE solution');t+=h;values.push(y);}return out({times:Array.from({length:n+1},(_,i)=>x.t0+i*h),values});}
export function eulerOde(x){return march(x,(f,t,y,h)=>y+h*f(t,y));}
export function heunOde(x){return march(x,(f,t,y,h)=>{const k1=f(t,y),k2=f(t+h,y+h*k1);return y+h*(k1+k2)/2;});}
export function midpointOde(x){return march(x,(f,t,y,h)=>{const k1=f(t,y);return y+h*f(t+h/2,y+h*k1/2);});}
export function rk4Ode(x){return march(x,(f,t,y,h)=>{const k1=f(t,y),k2=f(t+h/2,y+h*k1/2),k3=f(t+h/2,y+h*k2/2),k4=f(t+h,y+h*k3);return y+h*(k1+2*k2+2*k3+k4)/6;});}
export function symplecticEulerOscillator(x){keys(x,['position','velocity','omegaSquared','dt','steps']);let q=finite(x.position,'position',-100,100),v=finite(x.velocity,'velocity',-100,100),k=finite(x.omegaSquared,'omegaSquared',0,1e4),h=finite(x.dt,'dt',0.00001,1),n=integer(x.steps,'steps',1,1024);const positions=[q],velocities=[v];for(let i=0;i<n;i++){v=check(v-h*k*q,'velocity');q=check(q+h*v,'position');positions.push(q);velocities.push(v);}return out({positions,velocities,energyDrift:check((v*v+k*q*q-(x.velocity*x.velocity+k*x.position*x.position))/2,'energy drift')});}
const poly=[-2,0,1],br={coefficients:poly,lower:0,upper:2,tolerance:1e-10,maxIterations:100},guess={coefficients:poly,x0:1.2,tolerance:1e-10,maxIterations:50};
const i={coefficients:[1,2,3,4,5],lower:0,upper:1,steps:8},d={coefficients:[1,2,3,4],at:0.5,h:0.001},o={a:-1,b:0.5,c:1,t0:0,y0:2,dt:0.05,steps:12};
const definitions=[
 ['BISECTION_ROOT','Validated opposite-sign root bisection with convergence status',bisection,br],
 ['FALSE_POSITION_ROOT','Bracketed regula falsi root iteration',regulaFalsi,br],
 ['SECANT_ROOT','Two-initial-guess secant method with stagnation detection',secantRoot,{...guess,x1:1.5}],
 ['NEWTON_ROOT','Analytic-derivative Newton root iteration',newtonRoot,guess],
 ['HALLEY_ROOT','Second-derivative Halley cubic root iteration',halleyRoot,guess],
 ['RIDDER_ROOT','Bracketed exponential interpolation Ridder root method',ridderRoot,br],
 ['ROOT_BRACKET_SCAN','Finite-grid isolation of sign-changing polynomial root intervals',scanRootBrackets,{coefficients:[-1,0,1],lower:-2,upper:2,steps:15}],
 ['DERIV_FORWARD','Finite-step forward numerical first derivative',forwardDerivative,d],
 ['DERIV_CENTRAL','Finite-step symmetric numerical first derivative',centralDerivative,d],
 ['DERIV_FIVE_POINT','Fourth-order five-point numerical first derivative',fivePointDerivative,d],
 ['DERIV_SECOND_CENTRAL','Central numerical second derivative',secondCentralDerivative,d],
 ['DERIV_RICHARDSON','Richardson extrapolation of central first derivative',richardsonDerivative,d],
 ['QUAD_MIDPOINT','Composite midpoint integration for bounded polynomials',midpointIntegral,i],
 ['QUAD_TRAPEZOID','Composite trapezoidal numerical integration',trapezoidIntegral,i],
 ['QUAD_SIMPSON','Composite Simpson one-third numerical integration',simpsonIntegral,i],
 ['QUAD_BOOLE','Composite five-node Boole numerical quadrature',booleIntegral,i],
 ['QUAD_GAUSS_2','Composite two-point Gauss-Legendre numerical quadrature',gaussLegendreTwo,i],
 ['QUAD_GAUSS_3','Composite three-point Gauss-Legendre numerical quadrature',gaussLegendreThree,i],
 ['QUAD_ROMBERG','Richardson-extrapolated Romberg quadrature table',rombergIntegral,{coefficients:i.coefficients,lower:0,upper:1,levels:5}],
 ['QUAD_ADAPTIVE_SIMPSON','Adaptive Simpson error-estimated bounded quadrature',adaptiveSimpson,{coefficients:i.coefficients,lower:0,upper:1,tolerance:1e-10,maxDepth:12}],
 ['ODE_EULER','Scalar nonautonomous linear ODE forward Euler trajectory',eulerOde,o],
 ['ODE_HEUN','Scalar nonautonomous linear ODE explicit trapezoid trajectory',heunOde,o],
 ['ODE_MIDPOINT','Scalar nonautonomous linear ODE explicit midpoint trajectory',midpointOde,o],
 ['ODE_RK4','Scalar nonautonomous linear ODE classical four-stage Runge-Kutta trajectory',rk4Ode,o],
 ['OSCILLATOR_SYMPLECTIC_EULER','Velocity-first symplectic Euler harmonic-oscillator trajectory',symplecticEulerOscillator,{position:1,velocity:0,omegaSquared:4,dt:0.05,steps:20}],
];
export const NUMERICAL_METHODS_500=tuple(definitions,'CONTROL','CONTROL_DYNAMICS');
