'use strict';

/** 一个最小的数字输入弹窗（RN 没有跨平台的 Alert.prompt） */

const React = require('react');
const { Modal, View, Text, TextInput, StyleSheet, Pressable } = require('react-native');

const { colors, spacing } = require('./theme');

function NumberPrompt({ visible, title, hint, placeholder, initialValue, onCancel, onSubmit }) {
  const [value, setValue] = React.useState('');

  React.useEffect(() => {
    if (visible) setValue(initialValue === undefined || initialValue === null ? '' : String(initialValue));
  }, [visible, initialValue]);

  return (
    <Modal visible={Boolean(visible)} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>{title}</Text>
          {hint ? <Text style={styles.hint}>{hint}</Text> : null}
          <TextInput
            style={styles.input}
            value={value}
            onChangeText={setValue}
            keyboardType="decimal-pad"
            placeholder={placeholder}
            placeholderTextColor={colors.muted}
            autoFocus
          />
          <View style={styles.actions}>
            <Pressable onPress={onCancel} style={styles.action}>
              <Text style={styles.cancel}>取消</Text>
            </Pressable>
            <Pressable onPress={() => onSubmit(value)} style={styles.action}>
              <Text style={styles.confirm}>确定</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(47,39,35,0.4)', justifyContent: 'center', paddingHorizontal: spacing.xl },
  sheet: { backgroundColor: colors.card, borderRadius: 18, padding: spacing.lg },
  title: { fontSize: 17, fontWeight: '700', color: colors.ink },
  hint: { fontSize: 13, color: colors.muted, marginTop: 4 },
  input: {
    marginTop: spacing.md,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: 17,
    color: colors.ink
  },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: spacing.lg },
  action: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  cancel: { fontSize: 16, color: colors.muted },
  confirm: { fontSize: 16, color: colors.primary, fontWeight: '700' }
});

module.exports = { NumberPrompt };
