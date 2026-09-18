// Offline GAUSS 801–1000. This package does not mutate Nexus main or its registry.
import {RATIONAL_SERIES_900} from './layers/batch-1000-series.mjs';
import {PARTITIONS_900} from './layers/batch-1000-partitions.mjs';
import {BOOLEAN_FUNCTIONS_900} from './layers/batch-1000-boolean.mjs';
import {FINITE_RELATIONS_900} from './layers/batch-1000-relations.mjs';
import {WEIGHTED_TREES_1000} from './layers/batch-1000-weighted-trees.mjs';
import {MODULAR_MATRICES_1000} from './layers/batch-1000-modular-matrices.mjs';
import {EXACT_MARKOV_1000} from './layers/batch-1000-markov.mjs';
import {PREFIX_CODES_1000} from './layers/batch-1000-prefix-codes.mjs';
const domains=[RATIONAL_SERIES_900,PARTITIONS_900,BOOLEAN_FUNCTIONS_900,FINITE_RELATIONS_900,WEIGHTED_TREES_1000,MODULAR_MATRICES_1000,EXACT_MARKOV_1000,PREFIX_CODES_1000];
if(domains.some(d=>d.length!==25))throw new Error('expected eight families of 25 implemented operators');
export const BATCH_900_ADDITIONS=Object.freeze(domains.slice(0,4).flat());
export const BATCH_1000_ADDITIONS=Object.freeze(domains.slice(4).flat());
export const NEW_200_ADDITIONS=Object.freeze([...BATCH_900_ADDITIONS,...BATCH_1000_ADDITIONS]);
if(NEW_200_ADDITIONS.length!==200||new Set(NEW_200_ADDITIONS.map(x=>x.id)).size!==200||new Set(NEW_200_ADDITIONS.map(x=>x.execute)).size!==200)throw new Error('invalid offline batch 801–1000 uniqueness');
