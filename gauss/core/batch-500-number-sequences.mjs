// GAUSS 201–500 working batch. Exact bounded integer-sequence operators.
// Deliberately not wired into the registry until the complete 300-operator batch is ready for one-shot certification.
function integer(value,name,min,max){if(!Number.isSafeInteger(value)||value<min||value>max)throw new RangeError(`${name} must be a safe integer in [${min},${max}]`);return value;}
function decimal(n){return n.toString();}
function choose(n,k){if(k<0||k>n)return 0n;k=Math.min(k,n-k);let r=1n;for(let i=1;i<=k;i++)r=r*BigInt(n-k+i)/BigInt(i);return r;}
export function lucasNumber({n}){integer(n,'n',0,1000);let a=2n,b=1n;for(let i=0;i<n;i++)[a,b]=[b,a+b];return{n,value:decimal(a)};}
export function pellNumber({n}){integer(n,'n',0,1000);let a=0n,b=1n;for(let i=0;i<n;i++)[a,b]=[b,2n*b+a];return{n,value:decimal(a)};}
export function pellLucasNumber({n}){integer(n,'n',0,1000);let a=2n,b=2n;for(let i=0;i<n;i++)[a,b]=[b,2n*b+a];return{n,value:decimal(a)};}
export function jacobsthalNumber({n}){integer(n,'n',0,1000);let a=0n,b=1n;for(let i=0;i<n;i++)[a,b]=[b,b+2n*a];return{n,value:decimal(a)};}
export function jacobsthalLucasNumber({n}){integer(n,'n',0,1000);let a=2n,b=1n;for(let i=0;i<n;i++)[a,b]=[b,b+2n*a];return{n,value:decimal(a)};}
export function tribonacciNumber({n}){integer(n,'n',0,500);let a=0n,b=0n,c=1n;if(n<2)return{n,value:'0'};for(let i=2;i<n;i++)[a,b,c]=[b,c,a+b+c];return{n,value:decimal(c)};}
export function tetranacciNumber({n}){integer(n,'n',0,350);const v=[0n,0n,0n,1n];if(n<4)return{n,value:decimal(v[n])};for(let i=4;i<=n;i++)v.push(v[i-1]+v[i-2]+v[i-3]+v[i-4]);return{n,value:decimal(v[n])};}
export function catalanNumber({n}){integer(n,'n',0,500);let c=1n;for(let k=0;k<n;k++)c=c*2n*BigInt(2*k+1)/BigInt(k+2);return{n,value:decimal(c)};}
export function motzkinNumber({n}){integer(n,'n',0,300);if(n===0)return{n,value:'1'};let a=1n,b=1n;for(let k=1;k<n;k++){const next=((2n*BigInt(k)+3n)*b+3n*BigInt(k)*a)/BigInt(k+3);a=b;b=next;}return{n,value:decimal(b)};}
export function derangementNumber({n}){integer(n,'n',0,1000);if(n===0)return{n,value:'1'};let a=1n,b=0n;for(let k=2;k<=n;k++){const c=BigInt(k-1)*(a+b);a=b;b=c;}return{n,value:decimal(b)};}
export function bellNumber({n}){integer(n,'n',0,150);let row=[1n];for(let i=1;i<=n;i++){const next=[row[row.length-1]];for(let j=1;j<=i;j++)next[j]=next[j-1]+row[j-1];row=next;}return{n,value:decimal(row[0])};}
export function orderedBellNumber({n}){integer(n,'n',0,100);const dp=Array(n+1).fill(0n);dp[0]=1n;for(let i=1;i<=n;i++)for(let k=1;k<=i;k++)dp[i]+=choose(i,k)*dp[i-k];return{n,value:decimal(dp[n])};}
export function partitionIntoDistinctParts({n}){integer(n,'n',0,500);const dp=Array(n+1).fill(0n);dp[0]=1n;for(let part=1;part<=n;part++)for(let s=n;s>=part;s--)dp[s]+=dp[s-part];return{n,value:decimal(dp[n])};}
export function partitionIntoOddParts({n}){integer(n,'n',0,500);const dp=Array(n+1).fill(0n);dp[0]=1n;for(let part=1;part<=n;part+=2)for(let s=part;s<=n;s++)dp[s]+=dp[s-part];return{n,value:decimal(dp[n])};}
export function stirlingSecondKind({n,k}){integer(n,'n',0,300);integer(k,'k',0,n);const dp=Array(k+1).fill(0n);dp[0]=1n;for(let i=1;i<=n;i++)for(let j=Math.min(i,k);j>=1;j--)dp[j]=dp[j-1]+BigInt(j)*dp[j];return{n,k,value:decimal(dp[k])};}
export function stirlingFirstKindUnsigned({n,k}){integer(n,'n',0,300);integer(k,'k',0,n);const dp=Array(k+1).fill(0n);dp[0]=1n;for(let i=1;i<=n;i++){for(let j=Math.min(i,k);j>=1;j--)dp[j]=dp[j-1]+BigInt(i-1)*dp[j];dp[0]=0n;}return{n,k,value:decimal(dp[k])};}
export function eulerianNumber({n,k}){integer(n,'n',0,300);integer(k,'k',0,Math.max(0,n-1));if(n===0)return{n,k,value:'1'};let dp=Array(n).fill(0n);dp[0]=1n;for(let i=2;i<=n;i++){const next=Array(n).fill(0n);for(let j=0;j<i;j++)next[j]=BigInt(j+1)*(dp[j]??0n)+BigInt(i-j)*(j?dp[j-1]:0n);dp=next;}return{n,k,value:decimal(dp[k])};}
export function derangementInclusionExclusion({n}){integer(n,'n',0,200);let sum=0n;for(let k=0;k<=n;k++){let term=1n;for(let i=k+1;i<=n;i++)term*=BigInt(i);sum+=(k%2?-term:term);}return{n,value:decimal(sum)};}
export function centralBinomialCoefficient({n}){integer(n,'n',0,500);return{n,value:decimal(choose(2*n,n))};}
export function narayanaNumber({n,k}){integer(n,'n',1,500);integer(k,'k',1,n);return{n,k,value:decimal(choose(n,k)*choose(n,k-1)/BigInt(n))};}
export const BATCH_500_NUMBER_SEQUENCE_OPERATORS=Object.freeze([
['GAUSS.MATH.LUCAS_NUMBER.201',lucasNumber],['GAUSS.MATH.PELL_NUMBER.202',pellNumber],['GAUSS.MATH.PELL_LUCAS_NUMBER.203',pellLucasNumber],['GAUSS.MATH.JACOBSTHAL_NUMBER.204',jacobsthalNumber],['GAUSS.MATH.JACOBSTHAL_LUCAS_NUMBER.205',jacobsthalLucasNumber],['GAUSS.MATH.TRIBONACCI_NUMBER.206',tribonacciNumber],['GAUSS.MATH.TETRANACCI_NUMBER.207',tetranacciNumber],['GAUSS.MATH.CATALAN_NUMBER.208',catalanNumber],['GAUSS.MATH.MOTZKIN_NUMBER.209',motzkinNumber],['GAUSS.MATH.DERANGEMENT_NUMBER.210',derangementNumber],['GAUSS.MATH.BELL_NUMBER.211',bellNumber],['GAUSS.MATH.ORDERED_BELL_NUMBER.212',orderedBellNumber],['GAUSS.MATH.PARTITION_DISTINCT.213',partitionIntoDistinctParts],['GAUSS.MATH.PARTITION_ODD.214',partitionIntoOddParts],['GAUSS.MATH.STIRLING_SECOND.215',stirlingSecondKind],['GAUSS.MATH.STIRLING_FIRST_UNSIGNED.216',stirlingFirstKindUnsigned],['GAUSS.MATH.EULERIAN_NUMBER.217',eulerianNumber],['GAUSS.MATH.DERANGEMENT_IE.218',derangementInclusionExclusion],['GAUSS.MATH.CENTRAL_BINOMIAL.219',centralBinomialCoefficient],['GAUSS.MATH.NARAYANA_NUMBER.220',narayanaNumber]
].map(([id,execute])=>Object.freeze({id,domain:'MATHEMATICS',execute})));
