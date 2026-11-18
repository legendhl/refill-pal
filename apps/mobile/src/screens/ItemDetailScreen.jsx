'use strict';

const React = require('react');
const { View, Text, StyleSheet, ScrollView, Alert } = require('react-native');

const { Card, Title, Muted, Badge, Button, Banner, Loading, Divider } = require('../ui/components');
const { NumberPrompt } = require('../ui/NumberPrompt');
const { colors, spacing, levelOf } = require('../ui/theme');
const { view: vm } = require('../core');

function ItemDetailScreen({ itemId, client, onBack, onChanged }) {
  const [detail, setDetail] = React.useState(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [prompt, setPrompt] = React.useState(null);

  const load = React.useCallback(async () => {
    try {
      const data = await client.call('item', 'detail', { itemId });
      setDetail(data);
      setError('');
    } catch (e) {
      setError(e.message || '加载失败');
    }
  }, [client, itemId]);

  React.useEffect(() => {
    load();
  }, [load]);

  async function run(action, payload, successMessage) {
    setBusy(true);
    setError('');
    try {
      const res = await client.call('item', action, payload);
      if (res && res.confirmNeeded) {
        Alert.alert('确认一下', res.message || '这个数字看起来不太对，确定没填错吗？', [
          { text: '取消', style: 'cancel' },
          {
            text: '没填错',
            onPress: async () => {
              await client.call('item', action, Object.assign({}, payload, { force: true }));
              await load();
              if (onChanged) await onChanged();
            }
          }
        ]);
      } else {
        await load();
        if (onChanged) await onChanged();
        if (successMessage) Alert.alert(successMessage);
      }
    } catch (e) {
      setError(e.message || '操作失败');
    } finally {
      setBusy(false);
    }
  }

  if (!detail) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        {error ? <Banner tone="error">{error}</Banner> : null}
        <Loading />
      </View>
    );
  }

  const view = detail.item;
  const style = levelOf(view.level);
  const timeline = vm.toTimeline(detail.events || [], view);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={styles.scroll}>
        {error ? <Banner tone="error">{error}</Banner> : null}

        <Card style={{ borderLeftWidth: 5, borderLeftColor: style.color }}>
          <View style={styles.headRow}>
            <Title size={24}>{view.name}</Title>
            <Badge level={view.level} />
          </View>
          <Text style={[styles.stock, { color: style.color }]}>{vm.stockText(view)}</Text>
          <Text style={styles.remaining}>{vm.remainingText(view)}</Text>

          <Divider />

          <View style={styles.facts}>
            <View style={styles.fact}>
              <Muted>消耗速度</Muted>
              <Text style={styles.factValue}>{vm.rateText(view)}</Text>
            </View>
            <View style={styles.fact}>
              <Muted>可信度</Muted>
              <Text style={styles.factValue}>{vm.confidenceText(view)}</Text>
            </View>
            <View style={styles.fact}>
              <Muted>提醒线</Muted>
              <Text style={styles.factValue}>剩 {detail.remindDays} 天</Text>
            </View>
          </View>

          <Text style={styles.basis}>{vm.basisText(view)}</Text>
          {view.specChanged ? <Text style={styles.warn}>换过规格，建议盘点一次让估算更准。</Text> : null}
        </Card>

        <View style={styles.actions}>
          <View style={styles.actionItem}>
            <Button
              title="记一笔"
              onPress={() =>
                setPrompt({
                  title: `买了几个${view.unit || ''}？`,
                  placeholder: '数量',
                  initialValue: '1',
                  onSubmit: async (value) => {
                    const qty = Number(value);
                    if (!Number.isFinite(qty) || qty <= 0) return;
                    setBusy(true);
                    try {
                      await client.call('purchase', 'add', { entries: [{ itemId, qty }] });
                      await load();
                      if (onChanged) await onChanged();
                    } catch (e) {
                      setError(e.message || '记录失败');
                    } finally {
                      setBusy(false);
                    }
                  }
                })
              }
            />
          </View>
          <View style={styles.actionItem}>
            <Button
              title="盘点"
              variant="ghost"
              onPress={() =>
                setPrompt({
                  title: '现在还剩多少？',
                  hint: `当前估算 ${vm.stockText(view)}，改成实际数字`,
                  placeholder: '剩余数量',
                  initialValue: '',
                  onSubmit: async (value) => {
                    const remaining = Number(value);
                    if (!Number.isFinite(remaining) || remaining < 0) return;
                    await run('stocktake', { itemId, remaining }, '已校准');
                  }
                })
              }
            />
          </View>
          <View style={styles.actionItem}>
            <Button
              title={view.stock <= 0 ? '已经用完了' : '用完了'}
              variant="plain"
              disabled={busy || view.stock <= 0}
              onPress={() =>
                Alert.alert('确认用完了？', '记下这一刻，它能用来算出更准的消耗速度。', [
                  { text: '取消', style: 'cancel' },
                  { text: '确认', onPress: () => run('usedUp', { itemId }, '记下了') }
                ])
              }
            />
          </View>
        </View>

        <Text style={styles.section}>历史记录</Text>
        {timeline.length ? (
          <Card style={{ paddingVertical: spacing.sm }}>
            {timeline.map((row, index) => (
              <View key={row.id} style={[styles.tlRow, index === timeline.length - 1 && { borderBottomWidth: 0 }]}>
                <View style={[styles.dot, { backgroundColor: row.isClose ? colors.danger : row.isPurchase ? colors.primary : colors.warn }]} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.tlTitle}>{row.title}</Text>
                  {row.subtitle ? <Muted>{row.subtitle}</Muted> : null}
                </View>
                <Muted>{row.dateText}</Muted>
              </View>
            ))}
          </Card>
        ) : (
          <Muted style={{ textAlign: 'center', marginVertical: spacing.lg }}>还没有记录</Muted>
        )}

        <Button title="返回" variant="plain" onPress={onBack} />
      </ScrollView>

      <NumberPrompt
        visible={Boolean(prompt)}
        title={prompt ? prompt.title : ''}
        hint={prompt ? prompt.hint : ''}
        placeholder={prompt ? prompt.placeholder : ''}
        initialValue={prompt ? prompt.initialValue : ''}
        onCancel={() => setPrompt(null)}
        onSubmit={(value) => {
          const current = prompt;
          setPrompt(null);
          if (current) current.onSubmit(value);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: spacing.lg, paddingBottom: 80 },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stock: { fontSize: 26, fontWeight: '700', marginTop: spacing.md },
  remaining: { fontSize: 15, color: colors.inkSoft, marginTop: 2 },
  facts: { flexDirection: 'row', marginBottom: spacing.md },
  fact: { flex: 1 },
  factValue: { fontSize: 14, fontWeight: '600', color: colors.ink, marginTop: 2 },
  basis: { fontSize: 13, color: colors.muted, lineHeight: 20, backgroundColor: '#FBF6F2', borderRadius: 10, padding: spacing.md },
  warn: { fontSize: 13, color: '#8A6A2F', backgroundColor: '#FFF8E1', borderRadius: 10, padding: spacing.md, marginTop: spacing.sm },
  actions: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.lg },
  actionItem: { flex: 1 },
  section: { fontSize: 15, fontWeight: '600', color: colors.inkSoft, marginTop: spacing.md, marginBottom: spacing.sm },
  tlRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: spacing.md },
  tlTitle: { fontSize: 15, color: colors.ink }
});

module.exports = { ItemDetailScreen };
