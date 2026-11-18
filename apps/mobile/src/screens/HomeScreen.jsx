'use strict';

const React = require('react');
const { View, Text, StyleSheet, Pressable, RefreshControl, ScrollView } = require('react-native');

const { Card, Title, Muted, Badge, Empty, Banner } = require('../ui/components');
const { colors, spacing, levelOf } = require('../ui/theme');
const { view: vm, format } = require('../core');

const UNDO_MS = 5000;

function ItemRow({ view, onAdd, onOpen }) {
  const style = levelOf(view.level);
  return (
    <Pressable onPress={() => onOpen(view)} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
      <View style={[styles.rowBar, { backgroundColor: style.color }]} />
      <View style={styles.rowMain}>
        <View style={styles.rowTop}>
          <Text style={styles.rowName} numberOfLines={1}>
            {view.name}
          </Text>
          <Badge level={view.level} />
        </View>
        <Text style={[styles.rowRemaining, { color: style.color }]}>{vm.remainingText(view)}</Text>
        <Muted>
          {vm.stockText(view)} · {vm.rateText(view)}
        </Muted>
      </View>
      {onAdd ? (
        <Pressable onPress={() => onAdd(view)} style={styles.addButton} accessibilityLabel={`给${view.name}记一笔`}>
          <Text style={styles.addText}>＋1</Text>
        </Pressable>
      ) : null}
    </Pressable>
  );
}

function HomeScreen({ state, onRefresh, onQuickAdd, onRemoveEvent, onOpenItem, onPullRefresh }) {
  const [undo, setUndo] = React.useState(null);
  const [error, setError] = React.useState('');
  const timer = React.useRef(null);

  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const dashboard = state.dashboard;
  const refill = dashboard ? vm.toCards(dashboard.refill) : [];
  const ok = dashboard ? vm.toCards(dashboard.ok) : [];
  const summary = dashboard && dashboard.summary;

  async function add(view) {
    setError('');
    try {
      const res = await onQuickAdd(view._id, 1);
      const eventId = res && res.created && res.created[0];
      if (eventId) {
        setUndo({ eventId, label: `${view.name} ×1` });
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setUndo(null), UNDO_MS);
      }
    } catch (e) {
      setError(e.message || '记录失败');
    }
  }

  async function undoAdd() {
    const current = undo;
    setUndo(null);
    if (!current) return;
    try {
      await onRemoveEvent([current.eventId]);
    } catch (e) {
      setError(e.message || '撤销失败');
    }
  }

  if (state.status === 'loading') {
    return (
      <View style={styles.center}>
        <Muted>加载中…</Muted>
      </View>
    );
  }

  const headline = summary
    ? summary.refillCount > 0
      ? {
          title: `${summary.refillCount} 样该买了`,
          sub: summary.overdueCount > 0 ? `其中 ${summary.overdueCount} 样已经用完了` : '趁着还没用完，早点买'
        }
      : { title: '暂时不用买', sub: '家里的东西都还够用' }
    : { title: '还没有物品', sub: '去「物品」页把家里常用的东西加进来' };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={false} onRefresh={onPullRefresh || onRefresh} />}
      >
        {state.error ? <Banner tone="error">{state.error}</Banner> : null}
        {error ? <Banner tone="error">{error}</Banner> : null}

        <Card style={styles.hero}>
          <Title size={26}>{headline.title}</Title>
          <Text style={styles.heroSub}>{headline.sub}</Text>
          {summary ? (
            <Muted style={{ marginTop: spacing.sm }}>
              {summary.monthLabel}已花 {format.formatMoney(summary.monthTotal)} 元 · {summary.monthCount} 笔
            </Muted>
          ) : null}
        </Card>

        <Text style={styles.section}>
          该买了{state.remindDays ? `  ·  提前 ${state.remindDays} 天提醒` : ''}
        </Text>

        {refill.length ? (
          refill.map((view) => (
            <ItemRow key={view._id} view={view} onAdd={add} onOpen={onOpenItem} />
          ))
        ) : (
          <Empty
            emoji="✅"
            title={summary && summary.itemCount ? '眼下不用买' : '还没有物品'}
            desc={
              summary && summary.itemCount
                ? '记录得越多，它算得越准。东西用完了记得点一下「用完了」。'
                : '先去「物品」页添加一个，比如抽纸、洗手液。'
            }
          />
        )}

        {ok.length ? (
          <>
            <Text style={styles.section}>还够用</Text>
            {ok.map((view) => (
              <ItemRow key={view._id} view={view} onAdd={add} onOpen={onOpenItem} />
            ))}
          </>
        ) : null}

        <Muted style={styles.foot}>点一下「＋1」就记上；下滑可刷新。</Muted>
      </ScrollView>

      {undo ? (
        <View style={styles.undoBar}>
          <Text style={styles.undoText} numberOfLines={1}>
            已记：{undo.label}
          </Text>
          <Pressable onPress={undoAdd} hitSlop={12}>
            <Text style={styles.undoAction}>撤销</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: spacing.lg, paddingBottom: 100 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  hero: { backgroundColor: '#FFF6F0' },
  heroSub: { color: colors.inkSoft, fontSize: 15, marginTop: spacing.sm },
  section: { fontSize: 15, fontWeight: '600', color: colors.inkSoft, marginTop: spacing.lg, marginBottom: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: 16,
    marginBottom: spacing.sm,
    overflow: 'hidden',
    shadowColor: '#B48264',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2
  },
  rowPressed: { opacity: 0.9 },
  rowBar: { width: 5, alignSelf: 'stretch' },
  rowMain: { flex: 1, paddingVertical: spacing.md, paddingHorizontal: spacing.md },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowName: { fontSize: 17, fontWeight: '600', color: colors.ink, flex: 1, marginRight: spacing.sm },
  rowRemaining: { fontSize: 14, fontWeight: '600', marginTop: 2 },
  addButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md
  },
  addText: { color: colors.primary, fontWeight: '700', fontSize: 15 },
  foot: { textAlign: 'center', marginTop: spacing.xl },
  undoBar: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.lg,
    backgroundColor: colors.ink,
    borderRadius: 14,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  undoText: { color: '#FFFFFF', fontSize: 14, flex: 1, marginRight: spacing.md },
  undoAction: { color: '#FFB08A', fontSize: 15, fontWeight: '600' }
});

module.exports = { HomeScreen };
