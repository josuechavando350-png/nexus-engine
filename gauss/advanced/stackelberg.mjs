import { assertExactKeys } from '../core/common.mjs';
import { boundedInt, dense } from './scientific-linear.mjs';

function matrix(input, label) {
  const rows = dense(input, label, 2, 8);
  const width = dense(rows[0], `${label}[0]`, 2, 8).length;
  return rows.map((row, i) => {
    if (dense(row, `${label}[${i}]`, width, width).length !== width) throw new TypeError('invalid payoff matrix');
    return row.map((value, j) => boundedInt(value, `${label}[${i}][${j}]`));
  });
}
/** Pure leader commitment, follower pure best response with explicit optimistic/pessimistic tie semantics. */
export function solvePureStackelberg(input) {
  assertExactKeys(input, ['leaderPayoffs', 'followerPayoffs', 'tiePolicy'], 'Stackelberg input');
  if (!['OPTIMISTIC', 'PESSIMISTIC'].includes(input.tiePolicy)) throw new TypeError('unsupported follower tie policy');
  const leader = matrix(input.leaderPayoffs, 'leaderPayoffs');
  const follower = matrix(input.followerPayoffs, 'followerPayoffs');
  if (leader.length !== follower.length || leader[0].length !== follower[0].length) throw new TypeError('payoff shapes mismatch');
  const responses = leader.map((row, l) => {
    const best = Math.max(...follower[l]);
    const followers = follower[l].map((payoff, f) => payoff === best ? f : null).filter((f) => f !== null);
    const selectedFollower = followers.reduce((chosen, f) =>
      (input.tiePolicy === 'OPTIMISTIC' ? row[f] > row[chosen] : row[f] < row[chosen]) ? f : chosen, followers[0]);
    return { leaderAction: l, followerBestResponses: followers, selectedFollower,
      leaderPayoff: row[selectedFollower], followerPayoff: follower[l][selectedFollower] };
  });
  const chosen = responses.reduce((best, current) => current.leaderPayoff > best.leaderPayoff ? current : best, responses[0]);
  return { commitment: 'PURE_STRATEGY', tiePolicy: input.tiePolicy, responses, leaderAction: chosen.leaderAction,
    followerAction: chosen.selectedFollower, leaderValue: chosen.leaderPayoff, followerValue: chosen.followerPayoff,
    exhaustivePureCommitments: leader.length,
    note: 'Exact for pure leader commitments and the declared follower tie policy; mixed leader commitments are not optimized.' };
}
