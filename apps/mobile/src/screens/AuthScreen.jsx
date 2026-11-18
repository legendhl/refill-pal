'use strict';

const React = require('react');
const { View, Text, TextInput, StyleSheet, KeyboardAvoidingView, Platform } = require('react-native');

const { Screen, Card, Button, Muted, Banner, Title } = require('../ui/components');
const { colors, spacing } = require('../ui/theme');

function AuthScreen({ state, onLogin, onRegister }) {
  const [mode, setMode] = React.useState('login');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [nickName, setNickName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  const isRegister = mode === 'register';

  async function submit() {
    if (busy) return;
    setError('');
    const mail = email.trim();
    if (!mail || !password) {
      setError('邮箱和密码都要填');
      return;
    }
    setBusy(true);
    try {
      if (isRegister) await onRegister(mail, password, nickName.trim() || undefined);
      else await onLogin(mail, password);
    } catch (e) {
      setError(e.message || '登录失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen>
        <View style={styles.hero}>
          <Text style={styles.emoji}>🧺</Text>
          <Title size={28}>补货小管家</Title>
          <Muted style={styles.heroSub}>记一笔买了什么，它学会你的消耗速度，在快用完时提醒你。</Muted>
        </View>

        <Card>
          <View style={styles.tabs}>
            {['login', 'register'].map((m) => (
              <Text
                key={m}
                onPress={() => {
                  setMode(m);
                  setError('');
                }}
                style={[styles.tab, mode === m && styles.tabActive]}
              >
                {m === 'login' ? '登录' : '注册'}
              </Text>
            ))}
          </View>

          <Text style={styles.label}>邮箱</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            placeholder="you@example.com"
            placeholderTextColor={colors.muted}
          />

          <Text style={styles.label}>密码</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder={isRegister ? '至少 8 位' : '密码'}
            placeholderTextColor={colors.muted}
          />

          {isRegister ? (
            <>
              <Text style={styles.label}>昵称（可选）</Text>
              <TextInput
                style={styles.input}
                value={nickName}
                onChangeText={setNickName}
                placeholder="家人怎么称呼你"
                placeholderTextColor={colors.muted}
                maxLength={20}
              />
            </>
          ) : null}

          {error ? (
            <View style={{ marginTop: spacing.md }}>
              <Banner tone="error">{error}</Banner>
            </View>
          ) : null}

          <View style={{ marginTop: spacing.md }}>
            <Button title={busy ? '请稍候…' : isRegister ? '注册并登录' : '登录'} onPress={submit} disabled={busy} />
          </View>
        </Card>

        {state && state.error ? <Muted>{state.error}</Muted> : null}
        <Muted style={styles.foot}>数据存在你自己的服务器上，只有家庭里的成员能看到。</Muted>
      </Screen>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', paddingVertical: spacing.xl },
  emoji: { fontSize: 52, marginBottom: spacing.md },
  heroSub: { textAlign: 'center', marginTop: spacing.sm, lineHeight: 20 },
  tabs: { flexDirection: 'row', backgroundColor: colors.primarySoft, borderRadius: 999, padding: 4, marginBottom: spacing.lg },
  tab: { flex: 1, textAlign: 'center', paddingVertical: 8, borderRadius: 999, color: colors.muted, fontSize: 15 },
  tabActive: { backgroundColor: colors.card, color: colors.primary, fontWeight: '600' },
  label: { fontSize: 13, color: colors.muted, marginTop: spacing.md, marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.ink
  },
  foot: { textAlign: 'center', marginTop: spacing.lg }
});

module.exports = { AuthScreen };
