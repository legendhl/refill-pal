'use strict';

const React = require('react');
const { View, Text, StyleSheet, Pressable, StatusBar, Platform, SafeAreaView, ActivityIndicator } = require('react-native');

const { createClient } = require('./src/api/client');
const { createStore } = require('./src/state/store');
const { secureTokenStore } = require('./src/state/token-store');
const { useStore } = require('./src/state/useStore');
const { API_BASE_URL } = require('./src/config');
const { ensurePermission, syncReminders } = require('./src/notifications/reminders');
const { colors, spacing } = require('./src/ui/theme');

const { AuthScreen } = require('./src/screens/AuthScreen');
const { OnboardingScreen } = require('./src/screens/OnboardingScreen');
const { HomeScreen } = require('./src/screens/HomeScreen');
const { ItemsScreen } = require('./src/screens/ItemsScreen');
const { ItemDetailScreen } = require('./src/screens/ItemDetailScreen');
const { StatsScreen } = require('./src/screens/StatsScreen');
const { MeScreen } = require('./src/screens/MeScreen');

const TABS = [
  { key: 'home', label: '待补货', emoji: '🧺' },
  { key: 'items', label: '物品', emoji: '📦' },
  { key: 'stats', label: '统计', emoji: '📊' },
  { key: 'me', label: '我的', emoji: '👤' }
];

const client = createClient({ baseUrl: API_BASE_URL, tokenStore: secureTokenStore });
const store = createStore({ client });

function TabBar({ active, onChange }) {
  return (
    <View style={styles.tabBar}>
      {TABS.map((tab) => {
        const isActive = tab.key === active;
        return (
          <Pressable key={tab.key} style={styles.tabItem} onPress={() => onChange(tab.key)}>
            <Text style={styles.tabEmoji}>{tab.emoji}</Text>
            <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Splash() {
  return (
    <View style={styles.center}>
      <ActivityIndicator color={colors.primary} size="large" />
      <Text style={styles.splashText}>补货小管家</Text>
    </View>
  );
}

function App() {
  const state = useStore(store);
  const [tab, setTab] = React.useState('home');
  const [detailId, setDetailId] = React.useState(null);
  const [permissionAsked, setPermissionAsked] = React.useState(false);

  React.useEffect(() => {
    store.bootstrap();
  }, []);

  // 每次排程变化就整批替换系统通知（先取消再排，避免旧提醒残留）
  React.useEffect(() => {
    let cancelled = false;
    async function apply() {
      if (state.status !== 'ready' || !state.family) return;
      try {
        if (!permissionAsked) {
          setPermissionAsked(true);
          const status = await ensurePermission();
          if (cancelled || status !== 'granted') return;
        }
        await syncReminders(state.schedule);
      } catch (e) {
        // 排程失败不该影响主流程（例如模拟器不支持通知）
      }
    }
    apply();
    return () => {
      cancelled = true;
    };
  }, [state.schedule, state.status, state.family, permissionAsked]);

  if (state.status === 'idle' || (state.status === 'loading' && !state.user)) return <Splash />;

  if (state.status === 'anon') {
    return (
      <SafeAreaView style={styles.root}>
        <StatusBar barStyle="dark-content" />
        <AuthScreen state={state} onLogin={(e, p) => store.login(e, p)} onRegister={(e, p, n) => store.register(e, p, n)} />
      </SafeAreaView>
    );
  }

  if (state.status === 'error') {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{state.error || '加载失败'}</Text>
        <Pressable onPress={() => store.bootstrap()} style={styles.retry}>
          <Text style={styles.retryText}>重试</Text>
        </Pressable>
      </View>
    );
  }

  if (state.status === 'ready' && !state.family) {
    return (
      <SafeAreaView style={styles.root}>
        <StatusBar barStyle="dark-content" />
        <OnboardingScreen
          state={state}
          onCreate={(name) => store.createFamily(name)}
          onJoin={(code) => store.joinFamily(code)}
        />
      </SafeAreaView>
    );
  }

  const content = detailId ? (
    <ItemDetailScreen
      itemId={detailId}
      client={client}
      onBack={() => setDetailId(null)}
      onChanged={() => store.refreshAll()}
    />
  ) : tab === 'home' ? (
    <HomeScreen
      state={state}
      onRefresh={() => store.refreshAll()}
      onPullRefresh={() => store.refreshAll()}
      onQuickAdd={(id, qty) => store.quickAdd(id, qty)}
      onRemoveEvent={(ids) => store.removePurchase(ids)}
      onOpenItem={(view) => setDetailId(view._id || view.id)}
    />
  ) : tab === 'items' ? (
    <ItemsScreen
      state={state}
      onOpenItem={(view) => setDetailId(view._id || view.id)}
      onCreateItem={(payload) => store.createItem(payload)}
      onRefresh={() => store.refreshAll()}
    />
  ) : tab === 'stats' ? (
    <StatsScreen client={client} />
  ) : (
    <MeScreen
      state={state}
      onLogout={() => store.logout()}
      onOpenFamily={() => setTab('me')}
      onReschedule={async () => {
        const status = await ensurePermission();
        if (status !== 'granted') return 0;
        return syncReminders(state.schedule);
      }}
    />
  );

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="dark-content" />
      <View style={{ flex: 1 }}>{content}</View>
      {detailId ? null : <TabBar active={tab} onChange={setTab} />}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  splashText: { marginTop: spacing.md, color: colors.muted, fontSize: 15 },
  errorText: { color: colors.danger, fontSize: 15, marginBottom: spacing.md },
  retry: { paddingHorizontal: spacing.xl, paddingVertical: spacing.sm, backgroundColor: colors.primarySoft, borderRadius: 999 },
  retryText: { color: colors.primary, fontWeight: '600' },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    backgroundColor: colors.card,
    paddingBottom: Platform.OS === 'ios' ? 18 : 6,
    paddingTop: 6
  },
  tabItem: { flex: 1, alignItems: 'center' },
  tabEmoji: { fontSize: 18 },
  tabLabel: { fontSize: 11, color: colors.muted, marginTop: 2 },
  tabLabelActive: { color: colors.primary, fontWeight: '600' }
});

module.exports = App;
module.exports.default = App;
