const number = new Intl.NumberFormat('zh-TW');
const symbols = ['✦', '♪', '♡', '▥', '☆', '◎'];

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function decorative(tag, text, className) {
  const node = element(tag, text, className);
  node.setAttribute('aria-hidden', 'true');
  return node;
}

function metric(label, value, className) {
  const stat = element('div', undefined, 'achievement-metric' + (className ? ' ' + className : ''));
  const amount = element('dd', value);
  stat.append(element('dt', label), amount);
  return { stat, amount };
}

function trophy() {
  const art = decorative('div', undefined, 'achievement-art');
  const plate = element('div', undefined, 'achievement-plate');
  plate.append(element('span', '✦'), element('span', 'VOTEPROOF'));
  art.append(plate);
  return art;
}

export function campaignCollection(container, ranking) {
  let owner = null;
  let active = false;
  let controller;

  async function enter(isActive, session) {
    const member = session.member;
    const memberId = member?.member_id ?? null;
    if (active === isActive && owner === memberId) return;
    active = isActive;
    owner = memberId;
    controller?.abort();
    if (!active) {
      container.replaceChildren();
      return;
    }

    if (!member) {
      const login = element('a', '登入會員', 'btn btn-soft');
      login.href = '#login';
      const empty = element('div', undefined, 'achievement-empty');
      empty.append(element('p', '登入後即可查看你的活動成績和印章。'), login);
      container.replaceChildren(empty);
      return;
    }

    controller = new AbortController();
    const { signal } = controller;
    const status = element('p', '正在載入活動成果…', 'achievement-empty');
    status.setAttribute('role', 'status');
    container.replaceChildren(status);
    try {
      const { campaigns } = await session.campaignResults(signal);
      if (signal.aborted || session.member?.member_id !== memberId) return;
      if (!campaigns.length) {
        status.textContent = '目前沒有已結束且有公開排行榜的活動。';
        return;
      }
      render(campaigns, member, signal);
    } catch {
      if (signal.aborted) return;
      status.textContent = '活動成果暫時無法載入。';
      const retry = element('button', '重新載入', 'btn btn-soft');
      retry.type = 'button';
      retry.addEventListener('click', () => { active = false; void enter(true, session); });
      status.after(retry);
    }
  }

  function render(campaigns, member, signal) {
    const hero = element('article', undefined, 'achievement-hero');
    const banner = element('div', undefined, 'achievement-banner');
    const name = element('h2');
    const category = element('span', undefined, 'achievement-category');
    banner.append(name, category, trophy());

    const profile = element('div', undefined, 'achievement-profile');
    const who = element('div', undefined, 'achievement-who');
    const person = element('div');
    person.append(element('strong', member.nickname), element('small', '本次活動成績'));
    who.append(decorative('span', Array.from(member.nickname ?? '')[0] ?? '•', 'achievement-avatar'), person);
    const stats = element('dl', undefined, 'achievement-metrics');
    const rank = metric('名次', '—', 'achievement-rank');
    const points = metric('點數', '—');
    const proofs = metric('證明數', '—');
    stats.append(rank.stat, points.stat, proofs.stat);
    profile.append(who, stats);
    hero.append(banner, profile);

    const heading = element('div', undefined, 'achievement-subhead');
    heading.append(element('h2', '我的活動成果集章'), element('p', '每枚印章代表一個有計分投稿的已結束活動。'));
    const collection = element('section', undefined, 'achievement-collection');
    const summary = element('header', undefined, 'achievement-collection-head');
    const count = element('p', '已收集 ');
    count.append(element('strong', number.format(campaigns.filter(c => c.proof_count > 0).length)), document.createTextNode(' / ' + number.format(campaigns.length)));
    summary.append(element('h3', '應援成果卡'), count);
    const grid = element('ul', undefined, 'achievement-grid');
    const buttons = campaigns.map((campaign, i) => {
      const earned = campaign.proof_count > 0;
      const entry = element('li');
      const button = element('button', undefined, 'achievement-stamp ' + (earned ? 'is-earned' : 'is-locked'));
      button.type = 'button';
      button.classList.add('achievement-tone-' + (i % 4));
      const stamp = decorative('span', undefined, 'achievement-medal');
      stamp.append(element('span', earned ? symbols[i % symbols.length] : '', 'achievement-medal-symbol'));
      if (earned) stamp.append(element('span', '✓', 'achievement-check'));
      button.append(stamp, element('strong', campaign.name), element('small', earned ? number.format(campaign.points) + ' 點 · ' + number.format(campaign.proof_count) + ' 張' : '未解鎖'));
      button.addEventListener('click', () => void select(i));
      entry.append(button);
      grid.append(entry);
      return button;
    });
    collection.append(summary, grid);
    container.replaceChildren(hero, heading, collection);

    let selection = 0;
    async function select(index) {
      selection = index;
      const campaign = campaigns[index];
      buttons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === index)));
      name.textContent = campaign.name;
      category.textContent = campaign.category === 'Solo' ? 'Solo 應援活動' : '團體應援活動';
      points.amount.textContent = number.format(campaign.points);
      proofs.amount.textContent = number.format(campaign.proof_count);
      rank.amount.textContent = '—';
      if (campaign.points <= 0) return;
      try {
        const data = await ranking.get(campaign.leaderboard_id);
        if (signal.aborted || selection !== index) return;
        const board = data.leaderboards?.find(b => b.leaderboard_id === campaign.leaderboard_id);
        const mine = board?.rankings?.find(r => r.member_id === member.member_id);
        if (Number.isSafeInteger(mine?.rank) && mine.rank > 0 && mine.points === campaign.points && mine.proof_count === campaign.proof_count)
          rank.amount.textContent = '#' + number.format(mine.rank);
      } catch { /* Published rank is optional if the board cannot be read. */ }
    }
    void select(Math.max(0, campaigns.findIndex(c => c.proof_count > 0)));
  }

  return enter;
}
