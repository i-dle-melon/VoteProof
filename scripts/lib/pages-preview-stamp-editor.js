import { stampIcons, stampColors, stampMedal } from './campaign-collection.js';
import { taipeiInput, utcFromTaipei } from './admin-api.js';
import { stampPhase } from './preview-stamps.js';

const phaseLabels = { open: '已開放', scheduled: '即將開放', ended: '已結束', draft: '草稿', hidden: '已隱藏' };
const publication = [['draft', '草稿'], ['published', '公開'], ['hidden', '隱藏']];
const dateControl = value => taipeiInput(value).slice(0, 16);
const dateLabel = value => dateControl(value).replace('T', ' ');

function node(tag, text = '', className) {
  const el = document.createElement(tag);
  el.textContent = text;
  if (className) el.className = className;
  return el;
}

function action(label, callback, className = 'btn btn-white') {
  const button = node('button', label, className);
  button.type = 'button';
  button.addEventListener('click', callback);
  return button;
}

function field(container, name, label, type, value, limits = {}) {
  const wrapper = node('label', label, 'field');
  const control = node(type === 'select' || type === 'textarea' ? type : 'input');
  const { choices, ...properties } = limits;
  if (choices) for (const [key, title] of choices) control.append(new Option(title, key));
  else if (type !== 'textarea') control.type = type;
  Object.assign(control, { name, value, ...properties });
  wrapper.append(control);
  container.append(wrapper);
  return control;
}

export async function renderStampEditor({ container, request, mutate, run, isCurrent }) {
  const { stamps, campaigns } = await request('activity-stamps');
  if (!isCurrent()) return;

  const header = node('header', '', 'stamp-editor-heading');
  const heading = node('div');
  heading.append(node('h2', '活動集章設定'), node('p', '選擇一個投票活動，設定會員取得印章的條件。', 'tiny'));
  const memberLink = node('a', '查看會員中心', 'btn btn-white');
  memberLink.href = '#member';
  header.append(heading, memberLink);

  const totals = node('dl', '', 'stamp-editor-totals');
  const workspace = node('div', '', 'stamp-workspace');
  const browse = node('section', '', 'card form-card');
  const listHeader = node('div', '', 'stamp-editor-heading');
  const add = action('新增活動集章', () => open(), 'btn btn-primary');
  listHeader.append(node('h3', '集章清單'), add);
  const list = node('div', '', 'stamp-admin-list');
  browse.append(listHeader, list);
  const editor = node('section', '', 'card form-card stamp-editor-card');
  const feedback = node('p', '');
  feedback.setAttribute('role', 'status');
  workspace.append(editor, browse);
  container.append(header, totals, feedback, workspace);

  function renderList(selected) {
    const phases = stamps.map(stamp => stampPhase(stamp));
    const groups = [
      ['已開放', phases.filter(phase => phase === 'open').length],
      ['即將開放', phases.filter(phase => phase === 'scheduled').length],
      ['已結束', phases.filter(phase => phase === 'ended').length],
      ['草稿／隱藏', phases.filter(phase => phase === 'draft' || phase === 'hidden').length],
    ];
    totals.replaceChildren(...groups.map(([label, count]) => {
      const item = node('div', '', 'card');
      item.append(node('dt', label), node('dd', String(count)));
      return item;
    }));
    list.replaceChildren(...[...stamps].sort((a,b) => a.sort_order - b.sort_order).map(stamp => {
      const row = action('', () => open(stamp), 'stamp-admin-row');
      row.setAttribute('aria-pressed', String(stamp.stamp_id === selected));
      const detail = node('span', '', 'stamp-admin-detail');
      detail.append(node('strong', stamp.name), node('small', `${phaseLabels[stampPhase(stamp)]} · ${stamp.min_proofs} 次／${stamp.min_days} 天`));
      row.append(stampMedal({ ...stamp, earned: true }), detail, node('span', '編輯', 'stamp-row-action'));
      return row;
    }));
  }

  function open(existing = null) {
    feedback.textContent = '';
    renderList(existing?.stamp_id);
    const form = node('form', '', 'stamp-editor');
    form.dataset.previewStampEditor = '';
    form.append(node('h3', existing ? '編輯活動集章' : '新增活動集章'));
    const defaults = campaigns.find(c => c.campaign_id === existing?.campaign_id) ?? campaigns[0];
    if (!defaults) {
      editor.replaceChildren(node('p', '目前沒有可選擇的活動。'));
      return;
    }
    function group(title) {
      const section = node('fieldset', '', 'stamp-fields');
      section.append(node('legend', title));
      form.append(section);
      return section;
    }
    const general = group('基本設定');
    const linked = field(general, 'campaign_id', '對應投票活動', 'select', defaults.campaign_id, {
      choices: campaigns.map(c => [c.campaign_id, c.name]), required: true,
    });
    const name = field(general, 'name', '集章名稱', 'text', existing?.name ?? '', { required: true, maxLength: 60 });
    const description = field(general, 'description', '集章說明（選填）', 'textarea', existing?.description ?? '', { maxLength: 160, rows: 2 });
    description.closest('label').classList.add('stamp-full-field');

    const conditions = group('取得門檻');
    const intRange = (min, max) => ({ required: true, min, max, step: 1 });
    const proofs = field(conditions, 'min_proofs', '活動內有效投稿次數', 'number', existing?.min_proofs ?? 1, intRange(1, 10000));
    const days = field(conditions, 'min_days', '活動內不同投稿天數', 'number', existing?.min_days ?? 1, intRange(1, 3650));
    const opens = field(conditions, 'opens_at', '開始時間（台灣）', 'datetime-local', dateControl(existing?.opens_at ?? defaults.start_at), { required: true });
    const closes = field(conditions, 'closes_at', '結束時間（台灣）', 'datetime-local', dateControl(existing?.closes_at ?? defaults.end_at), { required: true });
    conditions.append(node('p', '兩項門檻都要達成，投稿天數以台灣日期計算。', 'tiny stamp-full-field'));

    const appearance = group('外觀與公開');
    const icon = field(appearance, 'icon', '印章圖案', 'select', existing?.icon ?? 'spark', { choices: stampIcons.map(([key,glyph,label]) => [key, key === 'mama' ? label : glyph + ' ' + label]) });
    const color = field(appearance, 'color', '印章背景色', 'select', existing?.color ?? 'purple', { choices: stampColors });
    const status = field(appearance, 'status', '顯示狀態', 'select', existing?.status ?? 'draft', { choices: publication });
    const order = field(appearance, 'sort_order', '顯示順序（數字越小越前）', 'number', existing?.sort_order ?? 100, intRange(0, 9999));

    const sample = node('aside', '', 'achievements stamp-form-preview');
    const paint = () => {
      const unlocked = node('div', '', 'is-earned');
      const locked = node('div', '', 'is-locked');
      const art = { icon: icon.value, color: color.value };
      unlocked.append(stampMedal({ ...art, earned: true }), node('small', '已取得'));
      locked.append(stampMedal({ ...art, earned: false }), node('small', '未解鎖'));
      const visual = node('div', '', 'stamp-form-art');
      visual.append(unlocked, locked);
      const summary = node('div');
      const title = name.value.trim() || '集章名稱';
      summary.append(node('h4', title), node('p', `投稿 ${proofs.value || '—'} 次 · ${days.value || '—'} 天`));
      if (opens.value && closes.value) summary.append(node('small', `${opens.value.replace('T', ' ')} 至 ${closes.value.replace('T', ' ')}（台灣）`));
      if (description.value.trim()) summary.append(node('p', description.value.trim()));
      sample.replaceChildren(visual, summary);
    };
    form.addEventListener('input', paint);
    form.addEventListener('change', paint);
    linked.addEventListener('change', () => {
      if (existing) return;
      const campaign = campaigns.find(c => c.campaign_id === linked.value);
      opens.value = dateControl(campaign.start_at);
      closes.value = dateControl(campaign.end_at);
    });
    paint();
    const previewHeading = node('h4', '即時外觀預覽', 'stamp-preview-title');
    const message = node('p', '', 'error');
    message.setAttribute('role', 'alert');
    const submit = node('button', '儲存集章設定', 'btn btn-primary');
    submit.type = 'submit';
    form.append(previewHeading, sample, message, submit);
    editor.replaceChildren(form);

    form.addEventListener('submit', event => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      message.textContent = '';
      let opens_at, closes_at;
      try { opens_at = utcFromTaipei(opens.value); closes_at = utcFromTaipei(closes.value); } catch {}
      if (!opens_at || !closes_at || opens_at >= closes_at) {
        message.textContent = '請確認時間格式，結束時間必須晚於開始時間。';
        return;
      }
      if (!name.value.trim()) {
        message.textContent = '請輸入集章名稱。';
        return;
      }
      const input = {
        campaign_id: linked.value, name: name.value.trim(), description: description.value.trim(),
        min_proofs: proofs.valueAsNumber, min_days: days.valueAsNumber, opens_at, closes_at,
        icon: icon.value, color: color.value, status: status.value, sort_order: order.valueAsNumber,
        ...(existing ? { expected_version: existing.version } : {}),
      };
      void run(async current => {
        const path = existing ? 'activity-stamps/' + existing.stamp_id + '/update' : 'activity-stamps';
        const { stamp } = await mutate(path, input);
        if (!current()) return;
        if (existing) stamps.splice(stamps.findIndex(row => row.stamp_id === stamp.stamp_id), 1, stamp);
        else stamps.push(stamp);
        open(stamp);
        feedback.textContent = '已儲存預覽設定。可前往會員中心查看。';
      });
    });
  }

  open();
}
