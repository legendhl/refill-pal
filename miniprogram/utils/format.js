/** 纯格式化与日期工具。全部为纯函数，无副作用、不依赖 wx API（便于单测）。 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

function toDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string') {
    // iOS 不支持 '2026-09-25 10:00:00'，统一换成 ISO 风格
    return new Date(value.replace(/-/g, '/').replace('T', ' ').replace(/\.\d+Z?$/, ''));
  }
  return new Date(NaN);
}

/** 当天零点 */
function startOfDay(value) {
  const d = toDate(value);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** 日期差（天），b - a，按自然日计算 */
function daysBetween(a, b) {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / MS_PER_DAY);
}

function addDays(value, n) {
  const d = startOfDay(value);
  d.setDate(d.getDate() + n);
  return d;
}

function formatDate(value, sep = '-') {
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return '';
  return [d.getFullYear(), pad2(d.getMonth() + 1), pad2(d.getDate())].join(sep);
}

function formatDateTime(value) {
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${formatDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatMonth(value) {
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/** 金额显示：保留两位，去掉无意义的 .00 */
function formatMoney(n) {
  const num = Number(n) || 0;
  if (Number.isInteger(num)) return `${num}`;
  return num.toFixed(2).replace(/0$/, '');
}

/** 数量显示：1.5 提、2 包 */
function formatQty(n) {
  const num = Number(n) || 0;
  if (Number.isInteger(num)) return `${num}`;
  return num.toFixed(1).replace(/\.0$/, '');
}

/**
 * 剩余天数 → 人话。
 * days 可以为小数；null 表示还无法估算。
 */
function remainingDaysText(days) {
  if (days === null || days === undefined || Number.isNaN(Number(days))) return '还不够数据估算';
  const d = Number(days);
  if (d <= 0) {
    const overdue = Math.max(1, Math.abs(Math.floor(d)));
    return `已用完约 ${overdue} 天`;
  }
  if (d < 1) return '今天大概就用完了';
  if (d < 1.5) return '明天大概用完';
  const whole = Math.floor(d);
  if (whole <= 7) return `预计 ${whole} 天后用完`;
  if (whole <= 30) return `预计 ${Math.round(whole / 7)} 周后用完`;
  return `预计 ${Math.round(whole / 30)} 个月后用完`;
}

/** 用于「该买了」卡片的一句短语，短到能塞进卡片 */
function shortRemainingText(days) {
  if (days === null || days === undefined || Number.isNaN(Number(days))) return '待估算';
  const d = Number(days);
  if (d <= 0) return '已用完';
  if (d < 1) return '今天';
  if (d < 1.5) return '明天';
  if (d < 30) return `${Math.floor(d)} 天后`;
  return `${Math.round(d / 30)} 个月后`;
}

module.exports = {
  MS_PER_DAY,
  pad2,
  toDate,
  startOfDay,
  daysBetween,
  addDays,
  formatDate,
  formatDateTime,
  formatMonth,
  formatMoney,
  formatQty,
  remainingDaysText,
  shortRemainingText
};
