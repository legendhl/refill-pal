'use strict';

const React = require('react');
const { View, Text, TextInput, StyleSheet } = require('react-native');

const { Screen, Card, Button, Muted, Banner, Title } = require('../ui/components');
const { colors, spacing } = require('../ui/theme');

/** 还没加入任何家庭时的引导：创建 or 用邀请码加入 */
function OnboardingScreen({ state, onCreate, onJoin }) {
  const [mode, setMode] = React.useState('create');
  const [familyName, setFamilyName] = React.useState('我家');
  const [inviteCode, setInviteCode] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (mode === 'create') await onCreate(familyName.trim() || '我家');
      else await onJoin(inviteCode.trim().toUpperCase());
    } catch (e) {
      setError(e.message || '操作失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <View style={styles.hero}>
        <Text style={styles.emoji}>🏠</Text>
        <Title size={26}>先建一个「家」</Title>
        <Muted style={styles.heroSub}>
          家里人共享同一份数据：谁买了、买了多少，都记在同一本账上，提醒也只提醒一次。
        </Muted>
      </View>

      <Card>
        <View style={styles.tabs}>
          {['create', 'join'].map((m) => (
            <Text
              key={m}
              onPress={() => {
                setMode(m);
                setError('');
              }}
              style={[styles.tab, mode === m && styles.tabActive]}
            >
              {m === 'create' ? '创建家庭' : '加入家庭'}
            </Text>
          ))}
        </View>

        {mode === 'create' ? (
          <>
            <Text style={styles.label}>家庭名</Text>
            <TextInput
              style={styles.input}
              value={familyName}
              onChangeText={setFamilyName}
              maxLength={16}
              placeholder="我家"
              placeholderTextColor={colors.muted}
            />
          </>
        ) : (
          <>
            <Text style={styles.label}>邀请码</Text>
            <TextInput
              style={[styles.input, styles.code]}
              value={inviteCode}
              onChangeText={setInviteCode}
              autoCapitalize="characters"
              maxLength={12}
              placeholder="家人给你的 6 位码"
              placeholderTextColor={colors.muted}
            />
          </>
        )}

        {error ? (
          <View style={{ marginTop: spacing.md }}>
            <Banner tone="error">{error}</Banner>
          </View>
        ) : null}

        <View style={{ marginTop: spacing.md }}>
          <Button title={busy ? '处理中…' : mode === 'create' ? '建好，开始用' : '加入'} onPress={submit} disabled={busy} />
        </View>
      </Card>

      {state && state.user ? <Muted style={styles.foot}>当前账号：{state.user.email}</Muted> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', paddingVertical: spacing.xl },
  emoji: { fontSize: 52, marginBottom: spacing.md },
  heroSub: { textAlign: 'center', marginTop: spacing.sm, lineHeight: 20 },
  tabs: { flexDirection: 'row', backgroundColor: colors.primarySoft, borderRadius: 999, padding: 4, marginBottom: spacing.lg },
  tab: { flex: 1, textAlign: 'center', paddingVertical: 8, borderRadius: 999, color: colors.muted, fontSize: 15 },
  tabActive: { backgroundColor: colors.card, color: colors.primary, fontWeight: '600' },
  label: { fontSize: 13, color: colors.muted, marginTop: spacing.sm, marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.ink
  },
  code: { letterSpacing: 2 },
  foot: { textAlign: 'center', marginTop: spacing.lg }
});

module.exports = { OnboardingScreen };
