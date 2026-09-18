import {EXACT_COMBINATORICS} from './layers/exact-enumerative-combinatorics.mjs';
import {EXACT_NUMBER_THEORY} from './layers/exact-enumerative-number-theory.mjs';
import {EXACT_STRING_EXTENSIONS} from './layers/exact-string-extensions.mjs';
import {EXACT_FINITE_PROBABILITY} from './layers/exact-finite-probability.mjs';
import {unicodeSuffixArray,unicodeAdjacentLcp,unicodeKmpOccurrences} from './layers/exact-string-algorithms.mjs';

const unicode = [
 {id:'GAUSS.CS.UNICODE_SUFFIX_ARRAY.226',domain:'COMPUTER_SCIENCE',description:'Unicode scalar suffix-array order by rank doubling',execute:unicodeSuffixArray,input:{text:'banana'}},
 {id:'GAUSS.CS.UNICODE_ADJACENT_LCP.227',domain:'COMPUTER_SCIENCE',description:'Unicode adjacent suffix longest common prefixes by Kasai',execute:unicodeAdjacentLcp,input:{text:'banana'}},
 {id:'GAUSS.CS.UNICODE_KMP_OCCURRENCES.228',domain:'COMPUTER_SCIENCE',description:'Overlapping Unicode substring matches by KMP automaton',execute:unicodeKmpOccurrences,input:{text:'banana',pattern:'ana'}},
];
export const BATCH_300_ADDITIONS=Object.freeze([
 ...EXACT_COMBINATORICS,...EXACT_NUMBER_THEORY,...EXACT_STRING_EXTENSIONS,...EXACT_FINITE_PROBABILITY,...unicode,
].map(({id,domain,description,execute,input})=>Object.freeze({id,domain,description,execute,input:Object.freeze(input)})));
if(BATCH_300_ADDITIONS.length!==100 || new Set(BATCH_300_ADDITIONS.map(x=>x.id)).size!==100 || new Set(BATCH_300_ADDITIONS.map(x=>x.execute)).size!==100)throw new Error('GAUSS new batch must have exactly 100 unique executable definitions');
