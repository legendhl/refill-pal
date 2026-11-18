/* 自动生成，请勿直接修改。
 * 源文件：packages/refillpal-core/src/view/constants.js
 * 由 npm run sync 同步；要改请改源文件后重新同步。
 */
/** 全局常量：分类、单位、渠道、紧急度分级 */

const CATEGORIES = [
  '纸品',
  '清洁',
  '洗护',
  '厨房',
  '母婴',
  '宠物',
  '药品',
  '其他'
];

const UNITS = ['包', '提', '卷', '瓶', '袋', '盒', '个', '桶', '支', '斤'];

const CHANNELS = ['超市', '京东', '淘宝', '拼多多', '美团', '小店', '其他'];

/** 紧急度分级 → 视觉样式。level 由云端 core.predict 计算 */
const LEVELS = {
  overdue: { label: '已用完', color: '#E5484D', bg: '#FFECEE' },
  urgent: { label: '马上要买', color: '#FF7A45', bg: '#FFF0E8' },
  warn: { label: '快用完了', color: '#D9A400', bg: '#FFF8E1' },
  ok: { label: '还够用', color: '#2E9E63', bg: '#EAF7F0' }
};

/** 置信度文案，index 为闭合周期数 */
function confidenceLabel(closedCycles) {
  const n = Number(closedCycles) || 0;
  if (n <= 0) return '估算中';
  if (n < 3) return '粗略估计';
  return '较准';
}

module.exports = {
  CATEGORIES,
  UNITS,
  CHANNELS,
  LEVELS,
  confidenceLabel
};
