// Isolated Pages data. Saved settings live only until the preview is reloaded.
import { stampIcons, stampColors, stampPngSize, stampIconBlob, stampHexColor } from './campaign-collection.js';

const dayMs = 86400000;
const modes = ['draft', 'published', 'hidden'];
const options = ['campaign_id', 'name', 'description', 'min_proofs', 'min_days', 'opens_at', 'closes_at', 'icon', 'color', 'status', 'sort_order', 'custom_icon', 'custom_color'];

export async function prepareStampIcon(file) {
  if (file.size > 1024 * 1024) throw Error('圖案檔案不得超過 1 MB。');
  const size = stampPngSize(new Uint8Array(await file.slice(0, 33).arrayBuffer()));
  if (!size?.width || !size?.height) throw Error('請選擇透明背景的 PNG 圖片。');
  if (size.width > 1024 || size.height > 1024) throw Error('圖案長寬不得超過 1024 像素。');
  let bitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw Error('無法讀取這張 PNG，請選擇其他檔案。'); }
  try {
    const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let hasTransparency = false, hasArtwork = false;
    for (let i = 3; i < data.length; i += 4) {
      hasTransparency ||= data[i] < 255;
      hasArtwork ||= data[i] > 0;
      if (hasTransparency && hasArtwork) break;
    }
    if (!hasTransparency || !hasArtwork) throw Error('PNG 必須同時包含透明背景與可見的圖案。');
    return canvas.toDataURL('image/png').split(',')[1];
  } finally { bitmap.close(); }
}

export function stampPhase(stamp, now = Date.now()) {
  if (stamp.status !== 'published') return stamp.status;
  if (now < Date.parse(stamp.opens_at)) return 'scheduled';
  return now < Date.parse(stamp.closes_at) ? 'open' : 'ended';
}

export function createStampPreview(results, getOtherCampaigns) {
  const historic = results.map(result => ({ ...result, start_at: new Date(Date.parse(result.end_at) - 14 * dayMs).toISOString() }));
  const available = () => [...historic, ...getOtherCampaigns()].map(({ campaign_id, name, category, start_at, end_at }) => ({
    campaign_id, name, category, start_at, end_at,
  }));
  const now = Date.now();
  const rows = historic.map((result, i) => ({
    stamp_id: 'PREVIEW-STAMP-' + (i + 1), version: 0,
    campaign_id: result.campaign_id, name: result.name, description: '',
    min_proofs: i === 0 ? 20 : 1, min_days: i === 0 ? 3 : 1,
    opens_at: i === 0 ? result.start_at : new Date(now + (i === 9 ? -1 : i) * dayMs).toISOString(),
    closes_at: i === 0 ? result.end_at : new Date(now + (i + 7) * dayMs).toISOString(),
    icon: i === 0 ? 'mama' : stampIcons[i % 6][0], color: stampColors[i % 4][0],
    status: 'published', sort_order: (i + 1) * 10,
  }));
  const sort = (a, b) => a.sort_order - b.sort_order || a.stamp_id.localeCompare(b.stamp_id);

  function list() {
    return { stamps: [...rows].sort(sort), campaigns: available() };
  }

  function update(input, id = null) {
    const existing = id === null ? null : rows.find(row => row.stamp_id === id);
    if (id !== null && (!existing || input?.expected_version !== existing.version)) return ['STAMP_CONFLICT', 409];
    const integer = (n, low, high) => Number.isSafeInteger(n) && n >= low && n <= high;
    const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
    if (!input || Object.keys(input).some(key => !options.includes(key) && !(existing && key === 'expected_version')) ||
        !available().some(c => c.campaign_id === input.campaign_id) ||
        typeof input.name !== 'string' || !input.name.trim() || Array.from(input.name).length > 60 ||
        typeof input.description !== 'string' || Array.from(input.description).length > 160 ||
        !integer(input.min_proofs, 1, 10000) || !integer(input.min_days, 1, 3650) ||
        !integer(input.sort_order, 0, 9999) || !date(input.opens_at) || !date(input.closes_at) || input.opens_at >= input.closes_at ||
        (input.icon === 'custom' ? !stampIconBlob(input.custom_icon) : !stampIcons.some(([key]) => key === input.icon) || input.custom_icon != null) ||
        (input.color === 'custom' ? !stampHexColor(input.custom_color) : !stampColors.some(([key]) => key === input.color) || input.custom_color != null) ||
        !modes.includes(input.status))
      return ['INVALID_STAMP_SETTING', 400];
    const clean = Object.fromEntries(options.map(key => [key, input[key]]));
    clean.name = clean.name.trim();
    clean.description = clean.description.trim();
    if (clean.color === 'custom') clean.custom_color = stampHexColor(clean.custom_color);
    if (existing) {
      Object.assign(existing, { ...clean, version: existing.version + 1 });
      return [{ stamp: existing }, 200];
    }
    const stamp = { ...clean, stamp_id: 'PREVIEW-STAMP-' + crypto.randomUUID(), version: 0 };
    rows.push(stamp);
    return [{ stamp }, 200];
  }

  function remove(id, input) {
    const index = rows.findIndex(row => row.stamp_id === id);
    if (index < 0 || !input || Object.keys(input).length !== 1 || input.expected_version !== rows[index].version)
      return ['STAMP_CONFLICT', 409];
    rows.splice(index, 1);
    return [{ removed: true }, 200];
  }

  // The preview has fictional approvals spread over three distinct local
  // days. The interval is evaluated before both thresholds.
  function progress(stamp, result) {
    const total = result?.proof_count ?? 0;
    let proof_count = 0, proof_days = 0;
    const chunks = Math.min(total, 3);
    for (let i = 0; i < chunks; i++) {
      const occurred = new Date(Date.parse(result.end_at) - (i + 1) * dayMs).toISOString();
      if (occurred < stamp.opens_at || occurred >= stamp.closes_at || Date.parse(occurred) > Date.now()) continue;
      proof_count += Math.floor(total / chunks) + (i < total % chunks ? 1 : 0);
      proof_days++;
    }
    return { proof_count, proof_days, earned: proof_count >= stamp.min_proofs && proof_days >= stamp.min_days };
  }

  function memberResults() {
    const campaigns = new Map(available().map(row => [row.campaign_id, row]));
    return rows.filter(row => row.status === 'published').sort(sort).map(row => {
      const result = results.find(c => c.campaign_id === row.campaign_id);
      const campaign = campaigns.get(row.campaign_id);
      const { icon, color, description, min_proofs, min_days, custom_icon, custom_color } = row;
      return {
        campaign_id: row.campaign_id, name: row.name, category: campaign.category,
        leaderboard_id: result?.leaderboard_id ?? null, points: result?.points ?? 0, proof_count: result?.proof_count ?? 0,
        stamp: { icon, color, description, min_proofs, min_days, custom_icon, custom_color, ...progress(row, result) },
      };
    });
  }
  return { list, update, remove, memberResults };
}
