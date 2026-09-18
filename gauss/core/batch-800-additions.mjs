// Offline GAUSS 601–800. NOT incorporated into the Nexus registry or production.
import {FINITE_SET_700} from './layers/batch-800-sets.mjs';
import {ROOTED_TREES_700} from './layers/batch-800-trees.mjs';
import {INTERVALS_700} from './layers/batch-800-intervals.mjs';
import {FINITE_POLYNOMIALS_700} from './layers/batch-800-finite-polynomials.mjs';
import {BINARY_GRID_800} from './layers/batch-800-grids.mjs';
import {BITWORDS_800} from './layers/batch-800-bitwords.mjs';
import {FINITE_FUNCTIONS_800} from './layers/batch-800-functions.mjs';
import {URN_PROBABILITY_800} from './layers/batch-800-urns.mjs';
const all=[FINITE_SET_700,ROOTED_TREES_700,INTERVALS_700,FINITE_POLYNOMIALS_700,BINARY_GRID_800,BITWORDS_800,FINITE_FUNCTIONS_800,URN_PROBABILITY_800];
if(all.some(a=>a.length!==25))throw new Error('every domain must supply exactly 25 executable definitions');
export const BATCH_700_ADDITIONS=Object.freeze(all.slice(0,4).flat());
export const BATCH_800_ADDITIONS=Object.freeze(all.slice(4).flat());
export const NEW_200_ADDITIONS=Object.freeze([...BATCH_700_ADDITIONS,...BATCH_800_ADDITIONS]);
if(NEW_200_ADDITIONS.length!==200||new Set(NEW_200_ADDITIONS.map(x=>x.id)).size!==200||new Set(NEW_200_ADDITIONS.map(x=>x.execute)).size!==200)throw new Error('offline batch must contain 200 unique executable operators');
