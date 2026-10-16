// Public endpoints supply eligible boards. Explicit flags also protect fixture
// and older clients from accidentally exposing a hidden/archived result.
export function bestPublicRank(boards, memberId) {
  const ranks = (boards ?? []).filter(b => b.is_public !== false && b.is_public !== 0 && (!b.status || b.status === 'active'))
    .flatMap(b => b.rankings ?? []).filter(r => memberId && r.member_id === memberId)
    .map(r => r.rank).filter(rank => Number.isSafeInteger(rank) && rank > 0);
  return ranks.reduce((best,rank) => best === null || rank < best ? rank : best, null);
}
export function boardCategory(board) {
  if (board.type === 'campaign') return board.is_current_comeback === true || board.is_current_comeback === 1 ? 'comeback' : 'named:' + board.leaderboard_id;
  if (board.type === 'custom') return 'custom:' + board.leaderboard_id;
  return board.vote_type === '團體' ? 'group' : board.vote_type === 'Solo' ? 'solo' : 'history';
}
