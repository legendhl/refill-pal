'use strict';

/** 通用 UI 组件（RN 版）。风格与小程序端一致：暖橙、大圆角、卡片化。 */

const React = require('react');
const { View, Text, Pressable, StyleSheet, ActivityIndicator, ScrollView } = require('react-native');
const { colors, spacing, radius, levelOf } = require('./theme');

function Screen({ children, scroll = true, style }) {
  const inner = <View style={[styles.screenInner, style]}>{children}</View>;
  if (!scroll) return <View style={styles.screen}>{inner}</View>;
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
      {inner}
    </ScrollView>
  );
}

function Card({ children, style }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

function Title({ children, size = 22 }) {
  return <Text style={[styles.title, { fontSize: size }]}>{children}</Text>;
}

function Muted({ children, style }) {
  return <Text style={[styles.muted, style]}>{children}</Text>;
}

function Body({ children, style }) {
  return <Text style={[styles.body, style]}>{children}</Text>;
}

function Button({ title, onPress, variant = 'primary', disabled, style }) {
  const isPrimary = variant === 'primary';
  const isGhost = variant === 'ghost';
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => [
        styles.button,
        isPrimary && styles.buttonPrimary,
        isGhost && styles.buttonGhost,
        !isPrimary && !isGhost && styles.buttonPlain,
        disabled && styles.buttonDisabled,
        pressed && !disabled && styles.buttonPressed,
        style
      ]}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
    >
      <Text
        style={[
          styles.buttonText,
          isPrimary && styles.buttonTextPrimary,
          (isGhost || (!isPrimary && !isGhost)) && styles.buttonTextDark,
          disabled && styles.buttonTextDisabled
        ]}
      >
        {title}
      </Text>
    </Pressable>
  );
}

/** 一行「名称 + 右侧值」，用于设置类界面 */
function Row({ label, value, onPress, danger }) {
  const content = (
    <>
      <Text style={[styles.rowLabel, danger && { color: colors.danger }]}>{label}</Text>
      {value === undefined ? null : <Text style={styles.rowValue}>{value}</Text>}
    </>
  );
  if (!onPress) return <View style={styles.row}>{content}</View>;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
      {content}
    </Pressable>
  );
}

function Badge({ level, label }) {
  const style = levelOf(level);
  return (
    <View style={[styles.badge, { backgroundColor: style.bg }]}>
      <Text style={[styles.badgeText, { color: style.color }]}>{label || style.label}</Text>
    </View>
  );
}

function Empty({ emoji, title, desc, action }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyEmoji}>{emoji || '📦'}</Text>
      {title ? <Text style={styles.emptyTitle}>{title}</Text> : null}
      {desc ? <Text style={styles.emptyDesc}>{desc}</Text> : null}
      {action ? <View style={{ marginTop: spacing.lg }}>{action}</View> : null}
    </View>
  );
}

function Loading({ text = '加载中…' }) {
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={colors.primary} />
      <Text style={styles.loadingText}>{text}</Text>
    </View>
  );
}

function Banner({ children, tone = 'warn' }) {
  return (
    <View style={[styles.banner, tone === 'error' && styles.bannerError]}>
      <Text style={[styles.bannerText, tone === 'error' && { color: '#B3282D' }]}>{children}</Text>
    </View>
  );
}

function Divider() {
  return <View style={styles.divider} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  scrollContent: { paddingBottom: spacing.xxl },
  screenInner: { padding: spacing.lg },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
    shadowColor: '#B48264',
    shadowOpacity: 0.08,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2
  },
  title: { color: colors.ink, fontWeight: '700' },
  body: { color: colors.inkSoft, fontSize: 15, lineHeight: 22 },
  muted: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  button: {
    minHeight: 48,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    marginVertical: spacing.xs
  },
  buttonPrimary: { backgroundColor: colors.primary },
  buttonGhost: { backgroundColor: colors.primarySoft },
  buttonPlain: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  buttonDisabled: { backgroundColor: '#EFE7E1' },
  buttonPressed: { opacity: 0.85 },
  buttonText: { fontSize: 16, fontWeight: '600' },
  buttonTextPrimary: { color: '#FFFFFF' },
  buttonTextDark: { color: colors.inkSoft },
  buttonTextDisabled: { color: '#B0A099' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line
  },
  rowPressed: { backgroundColor: '#FFFBF8' },
  rowLabel: { fontSize: 16, color: colors.ink },
  rowValue: { fontSize: 14, color: colors.muted },
  badge: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: radius.pill },
  badgeText: { fontSize: 12, fontWeight: '600' },
  empty: { alignItems: 'center', paddingVertical: spacing.xxl, paddingHorizontal: spacing.lg },
  emptyEmoji: { fontSize: 44, marginBottom: spacing.md },
  emptyTitle: { fontSize: 17, fontWeight: '600', color: colors.inkSoft, marginBottom: spacing.sm },
  emptyDesc: { fontSize: 14, color: colors.muted, textAlign: 'center', lineHeight: 21 },
  loading: { alignItems: 'center', paddingVertical: spacing.xxl },
  loadingText: { marginTop: spacing.md, color: colors.muted, fontSize: 14 },
  banner: {
    backgroundColor: '#FFF4E5',
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md
  },
  bannerError: { backgroundColor: '#FFECEE' },
  bannerText: { color: '#8A6A2F', fontSize: 13, lineHeight: 20 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginVertical: spacing.md }
});

module.exports = { Screen, Card, Title, Muted, Body, Button, Row, Badge, Empty, Loading, Banner, Divider };
