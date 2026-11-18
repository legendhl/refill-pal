'use strict';

const React = require('react');
const { View, Text, StyleSheet, ScrollView, Alert } = require('react-native');

const { Card, Muted, Button, Row, Divider, Banner } = require('../ui/components');
const { colors, spacing } = require('../ui/theme');
const { API_BASE_URL, NOTIFY_HOUR } = require('../config');

function MeScreen({ state, onLogout, onOpenFamily, onReschedule }) {
  const [notifyStatus, setNotifyStatus] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  async function testReminders() {
    setBusy(true);
    try {
      const count = await onReschedule();
      setNotifyStatus(`已排 ${count} 条本地提醒`);
      Alert.alert('已重新排程', `未来 30 天排了 ${count} 条提醒（每天 ${NOTIFY_HOUR}:00）。`);
    } catch (e) {
      setNotifyStatus(e.message || '排程失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={styles.scroll}>
      <Card style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{(state.user && state.user.nickName ? state.user.nickName : '我').slice(0, 1)}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.name}>{state.user ? state.user.nickName : ''}</Text>
          <Muted>{state.user ? state.user.email : ''}</Muted>
        </View>
      </Card>

      <Card>
        <Row label="家庭" value={state.family ? state.family.name : '未加入'} onPress={onOpenFamily} />
        <Row label="成员" value={`${(state.members || []).length} 人`} />
        <Row label="提前提醒" value={`${state.remindDays} 天`} />
        <Row label="提醒时刻" value={`${NOTIFY_HOUR}:00（本地时间）`} />
        <Row label="待发射提醒" value={`${(state.schedule || []).length} 条`} />
      </Card>

      <Card>
        <Button title={busy ? '排程中…' : '重新排提醒'} variant="ghost" onPress={testReminders} disabled={busy} />
        {notifyStatus ? <Muted style={{ marginTop: spacing.sm }}>{notifyStatus}</Muted> : null}
        <Muted style={{ marginTop: spacing.sm }}>
          提醒是本地通知：不需要联网，也不依赖推送服务。每次打开 App 会重排未来 30 天。
        </Muted>
      </Card>

      <Card>
        <Row label="服务器" value={API_BASE_URL} />
        <Divider />
        <Muted>数据保存在你自己的服务器上，只有家庭成员能看到。</Muted>
      </Card>

      <Button title="退出登录" variant="plain" onPress={onLogout} />
      <Banner>
        本地通知需要通知权限。如果收不到提醒，去系统设置 → 通知 → 补货小管家 里打开。
      </Banner>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: spacing.lg, paddingBottom: 80 },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md
  },
  avatarText: { color: '#FFFFFF', fontSize: 22, fontWeight: '700' },
  name: { fontSize: 17, fontWeight: '600', color: colors.ink }
});

module.exports = { MeScreen };
