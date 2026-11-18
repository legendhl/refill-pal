'use strict';

const React = require('react');
const { View, Text, StyleSheet, ScrollView, Pressable } = require('react-native');

const { Card, Title, Muted, Button, Loading, Banner, Divider } = require('../ui/components');
const { colors, spacing } = require('../ui/theme');
const { view: vm } = require('../core');

function monthKey(offset) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function StatsScreen({ client }) {
  const [offset, setOffset] = React.useState(0);
  const [stats, setStats] = React.useState(null);
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async (nextOffset) => {
    setLoading(true);
    try {
      const data = await client.call('stats', 'monthly', { month: monthKey(nextOffset) });
      setStats(data);
      setError('');
    } catch (e) {
      setError(e.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [client]);

  React.useEffect(() => {
    load(offset);
  }, [load, offset]);

  const view = stats ? vm.toStatsVm(stats) : null;

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={styles.scroll}>
      {error ? <Banner tone="error">{error}</Banner> : null}

      <Card style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Pressable onPress={() => setOffset((v) => v - 1)} hitSlop={12}>
          <Text style={styles.arrow}>‹</Text>
        </Pressable>
        <Text style={styles.month}>{view ? view.monthLabel : monthKey(offset)}</Text>
        <Pressable onPress={() => setOffset((v) => Math.min(0, v + 1))} hitSlop={12}>
          <Text style={[styles.arrow, offset >= 0 && { opacity: 0.25 }]}>›</Text>
        </Pressable>
      </Card>

      {loading || !view ? (
        <Loading />
      ) : (
        <>
          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
              <Text style={styles.total}>{view.totalText}</Text>
              <Text style={styles.unit}>元</Text>
            </View>
            <View style={styles.metaRow}>
              <Muted>
                {view.countText} · 日均 {view.dailyText}
              </Muted>
              <Text style={[styles.mom, { color: view.mom.color }]}>{view.mom.text}</Text>
            </View>
            {view.missingAmountCount ? (
              <Text style={styles.missing}>有 {view.missingAmountCount} 笔没记金额，没有算进合计</Text>
            ) : null}
          </Card>

          {view.hasBars ? (
            <Card>
              <Text style={styles.section}>花在哪</Text>
              {view.bars.map((bar) => (
                <View key={bar.key} style={styles.barRow}>
                  <Text style={styles.barKey}>{bar.key}</Text>
                  <View style={styles.track}>
                    <View style={[styles.fill, { width: `${Math.max(4, bar.percent)}%` }]} />
                  </View>
                  <Text style={styles.barValue}>{bar.amountText}</Text>
                </View>
              ))}
            </Card>
          ) : null}

          {view.trendBars.length ? (
            <Card>
              <Text style={styles.section}>最近半年</Text>
              <View style={styles.chart}>
                {view.trendBars.map((bar) => (
                  <View key={bar.key} style={styles.chartCol}>
                    <Text style={styles.chartValue}>{bar.totalText}</Text>
                    <View style={styles.chartBarWrap}>
                      <View
                        style={[
                          styles.chartBar,
                          { height: `${bar.heightPercent}%` },
                          bar.isCurrent && { backgroundColor: colors.primary }
                        ]}
                      />
                    </View>
                    <Muted>{bar.label}</Muted>
                  </View>
                ))}
              </View>
            </Card>
          ) : null}

          {view.predicted.length ? (
            <Card>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={styles.section}>照这样用，一个月要花</Text>
                <Text style={styles.predictedTotal}>约 {view.predictedTotalText} 元</Text>
              </View>
              <Divider />
              {view.predicted.map((row) => (
                <View key={row.itemId} style={styles.predRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.predName}>{row.name}</Text>
                    <Muted>{row.monthlyQtyText}</Muted>
                  </View>
                  <Text style={[styles.predCost, !row.hasCost && { color: colors.muted }]}>{row.monthlyCostText}</Text>
                </View>
              ))}
              {view.unestimableCount ? (
                <Muted style={{ marginTop: spacing.sm }}>
                  还有 {view.unestimableCount} 样物品数据不够，暂时算不进来。
                </Muted>
              ) : null}
            </Card>
          ) : null}

          {view.rank.length ? (
            <Card>
              <Text style={styles.section}>这个月买得最多的</Text>
              {view.rank.map((row, index) => (
                <View key={row.itemId} style={styles.rankRow}>
                  <Text style={styles.rankIndex}>{index + 1}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.predName}>{row.name}</Text>
                    <Muted>
                      {row.qtyText} · {row.countText}
                    </Muted>
                  </View>
                  <Text style={styles.predCost}>{row.amountText}</Text>
                </View>
              ))}
            </Card>
          ) : null}

          {!view.hasData ? (
            <Muted style={{ textAlign: 'center', marginTop: spacing.xl }}>这个月还没有记录</Muted>
          ) : null}

          <Button title="刷新" variant="plain" onPress={() => load(offset)} />
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: spacing.lg, paddingBottom: 80 },
  arrow: { fontSize: 26, color: colors.primary, paddingHorizontal: spacing.md },
  month: { fontSize: 16, fontWeight: '600', color: colors.ink },
  total: { fontSize: 40, fontWeight: '700', color: colors.ink },
  unit: { fontSize: 16, color: colors.inkSoft, marginLeft: 4 },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: spacing.sm },
  mom: { fontSize: 14, fontWeight: '600' },
  missing: { marginTop: spacing.md, fontSize: 12, color: '#8A6A2F', backgroundColor: '#FFF8E1', borderRadius: 8, padding: spacing.sm },
  section: { fontSize: 15, fontWeight: '600', color: colors.inkSoft, marginBottom: spacing.sm },
  barRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  barKey: { width: 64, fontSize: 13, color: colors.inkSoft },
  track: { flex: 1, height: 12, backgroundColor: '#F7EFE9', borderRadius: 6, overflow: 'hidden', marginHorizontal: spacing.sm },
  fill: { height: '100%', backgroundColor: colors.primary, borderRadius: 6 },
  barValue: { width: 80, textAlign: 'right', fontSize: 13, color: colors.ink },
  chart: { flexDirection: 'row', alignItems: 'flex-end', height: 160 },
  chartCol: { flex: 1, alignItems: 'center', height: '100%' },
  chartValue: { fontSize: 10, color: colors.muted, marginBottom: 4 },
  chartBarWrap: { flex: 1, width: '100%', justifyContent: 'flex-end', alignItems: 'center' },
  chartBar: { width: 18, backgroundColor: '#F0D9CB', borderRadius: 4, minHeight: 4 },
  predictedTotal: { fontSize: 15, fontWeight: '700', color: colors.primary },
  predRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm },
  predName: { fontSize: 15, color: colors.ink },
  predCost: { fontSize: 15, fontWeight: '600', color: colors.primary },
  rankRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm },
  rankIndex: { width: 24, color: colors.muted, fontWeight: '600' }
});

module.exports = { StatsScreen };
