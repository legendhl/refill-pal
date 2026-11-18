'use strict';

/** 设计 token：与小程序端保持同一套颜色/间距，避免两端观感分裂 */

const colors = {
  primary: '#FF7A45',
  primarySoft: '#FFF0E8',
  bg: '#FFF8F3',
  card: '#FFFFFF',
  ink: '#2F2723',
  inkSoft: '#6B5B52',
  muted: '#9A8C84',
  line: '#F2EAE4',
  danger: '#E5484D',
  warn: '#D9A400',
  ok: '#2E9E63',
  urgent: '#FF7A45',
  overdue: '#E5484D'
};

const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
const radius = { sm: 8, md: 14, lg: 20, pill: 999 };

const levelColors = {
  overdue: { color: colors.overdue, bg: '#FFECEE', label: '已用完' },
  urgent: { color: colors.urgent, bg: '#FFF0E8', label: '马上要买' },
  warn: { color: colors.warn, bg: '#FFF8E1', label: '快用完了' },
  ok: { color: colors.ok, bg: '#EAF7F0', label: '还够用' }
};

function levelOf(level) {
  return levelColors[level] || levelColors.ok;
}

module.exports = { colors, spacing, radius, levelOf, levelColors };
