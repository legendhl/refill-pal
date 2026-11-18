'use strict';

const React = require('react');
const { View, Text, TextInput, StyleSheet, Pressable, ScrollView } = require('react-native');

const { Card, Muted, Badge, Button, Empty, Banner } = require('../ui/components');
const { colors, spacing, levelOf } = require('../ui/theme');
const { view: vm } = require('../core');

function ItemsScreen({ state, onOpenItem, onCreateItem, onRefresh }) {
  const [keyword, setKeyword] = React.useState('');
  const [adding, setAdding] = React.useState(false);
  const [form, setForm] = React.useState({ name: '', unit: '包', category: '其他', baseQty: '0', days: '' });
  const [error, setError] = React.useState('');

  const filtered = vm.filterByName(state.items || [], keyword);
  const groups = vm.groupByCategory(filtered);

  async function submitNew() {
    setError('');
    const name = form.name.trim();
    if (!name) {
      setError('给物品起个名字');
      return;
    }
    const days = Number(form.days);
    try {
      await onCreateItem({
        name,
        unit: form.unit.trim() || '个',
        category: form.category.trim() || '其他',
        baseQty: Number(form.baseQty) || 0,
        initEstimateDays: Number.isFinite(days) && days > 0 ? days : null
      });
      setAdding(false);
      setForm({ name: '', unit: '包', category: '其他', baseQty: '0', days: '' });
    } catch (e) {
      setError(e.message || '保存失败');
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {error ? <Banner tone="error">{error}</Banner> : null}

        <TextInput
          style={styles.search}
          value={keyword}
          onChangeText={setKeyword}
          placeholder="搜物品名 / 分类 / 品牌"
          placeholderTextColor={colors.muted}
        />

        <View style={styles.headerRow}>
          <Muted>{state.items.length} 样物品</Muted>
          <Pressable onPress={() => setAdding((v) => !v)}>
            <Text style={styles.link}>{adding ? '收起' : '＋ 新建物品'}</Text>
          </Pressable>
        </View>

        {adding ? (
          <Card>
            <Text style={styles.label}>名称</Text>
            <TextInput
              style={styles.input}
              value={form.name}
              onChangeText={(v) => setForm(Object.assign({}, form, { name: v }))}
              placeholder="例如 抽纸"
              placeholderTextColor={colors.muted}
              maxLength={20}
            />
            <View style={styles.twoCols}>
              <View style={styles.col}>
                <Text style={styles.label}>单位</Text>
                <TextInput
                  style={styles.input}
                  value={form.unit}
                  onChangeText={(v) => setForm(Object.assign({}, form, { unit: v }))}
                  placeholder="包"
                  placeholderTextColor={colors.muted}
                  maxLength={4}
                />
              </View>
              <View style={styles.col}>
                <Text style={styles.label}>分类</Text>
                <TextInput
                  style={styles.input}
                  value={form.category}
                  onChangeText={(v) => setForm(Object.assign({}, form, { category: v }))}
                  placeholder="其他"
                  placeholderTextColor={colors.muted}
                  maxLength={10}
                />
              </View>
            </View>
            <View style={styles.twoCols}>
              <View style={styles.col}>
                <Text style={styles.label}>现在还剩</Text>
                <TextInput
                  style={styles.input}
                  value={form.baseQty}
                  onChangeText={(v) => setForm(Object.assign({}, form, { baseQty: v }))}
                  keyboardType="decimal-pad"
                  placeholder="0"
                  placeholderTextColor={colors.muted}
                />
              </View>
              <View style={styles.col}>
                <Text style={styles.label}>大概能用（天）</Text>
                <TextInput
                  style={styles.input}
                  value={form.days}
                  onChangeText={(v) => setForm(Object.assign({}, form, { days: v }))}
                  keyboardType="number-pad"
                  placeholder="选填"
                  placeholderTextColor={colors.muted}
                />
              </View>
            </View>
            <Button title="保存" onPress={submitNew} style={{ marginTop: spacing.md }} />
            <Muted style={{ marginTop: spacing.sm }}>
              「大概能用多久」只是冷启动；记满两三次购买后，它会被真实消耗速度覆盖。
            </Muted>
          </Card>
        ) : null}

        {groups.length ? (
          groups.map((group) => (
            <View key={group.category}>
              <Text style={styles.section}>
                {group.category}  <Text style={styles.count}>{group.count}</Text>
              </Text>
              {group.items.map((view) => {
                const style = levelOf(view.level);
                return (
                  <Pressable
                    key={view.id}
                    onPress={() => onOpenItem(view)}
                    style={({ pressed }) => [styles.row, pressed && { opacity: 0.9 }]}
                  >
                    <View style={[styles.bar, { backgroundColor: style.color }]} />
                    <View style={styles.rowMain}>
                      <Text style={styles.name} numberOfLines={1}>
                        {view.name}
                      </Text>
                      <Text style={[styles.remaining, { color: style.color }]}>{view.remainingText}</Text>
                    </View>
                    <Badge level={view.level} />
                  </Pressable>
                );
              })}
            </View>
          ))
        ) : (
          <Empty
            emoji="🧺"
            title={keyword ? '没有匹配的物品' : '还没有物品'}
            desc={keyword ? '换个关键词试试' : '把家里常用的东西加进来，比如抽纸、洗手液、垃圾袋。'}
            action={keyword ? null : <Button title="添加第一个物品" onPress={() => setAdding(true)} />}
          />
        )}

        <Muted style={styles.foot} onPress={onRefresh}>
          下拉刷新不可用时可点这里重新加载
        </Muted>
      </ScrollView>

    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: spacing.lg, paddingBottom: 100 },
  search: {
    backgroundColor: colors.card,
    borderRadius: 999,
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.ink
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.md },
  link: { color: colors.primary, fontWeight: '600', fontSize: 14 },
  section: { fontSize: 15, fontWeight: '600', color: colors.inkSoft, marginTop: spacing.lg, marginBottom: spacing.sm },
  count: { color: colors.muted, fontWeight: '400' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: 14,
    marginBottom: spacing.sm,
    overflow: 'hidden',
    paddingRight: spacing.md
  },
  bar: { width: 5, alignSelf: 'stretch' },
  rowMain: { flex: 1, paddingVertical: spacing.md, paddingHorizontal: spacing.md },
  name: { fontSize: 16, fontWeight: '600', color: colors.ink },
  remaining: { fontSize: 13, fontWeight: '600', marginTop: 2 },
  label: { fontSize: 12, color: colors.muted, marginTop: spacing.sm, marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    fontSize: 15,
    color: colors.ink
  },
  twoCols: { flexDirection: 'row', gap: spacing.md },
  col: { flex: 1 },
  foot: { textAlign: 'center', marginTop: spacing.xl }
});

module.exports = { ItemsScreen };
