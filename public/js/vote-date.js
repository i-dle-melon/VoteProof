export function localCalendarDate(date = new Date()) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}
export function defaultVoteDate(today, min = '', max = '') {
  if (min && today < min) return min;
  if (max && today > max) return max;
  return today;
}
export function setDefaultVoteDate(input, { min = '', max = '' } = {}, edited = false, date = new Date()) {
  input.min = min; input.max = max;
  // Keep intentional user edits; reportValidity still enforces new bounds.
  if (!edited) input.value = defaultVoteDate(localCalendarDate(date), min, max);
}
