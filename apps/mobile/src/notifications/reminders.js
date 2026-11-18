'use strict';

/**
 * expo-notifications 胶水层：只做「排程 → 系统通知」这一步转换。
 * 纯计算在 ./schedule.js，这样逻辑可测、胶水很薄。
 */

const Notifications = require('expo-notifications');

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false
  })
});

/** 请求通知权限；返回 'granted' | 'denied' | 'undetermined' */
async function ensurePermission() {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return 'granted';
  const asked = await Notifications.requestPermissionsAsync();
  return asked.granted ? 'granted' : asked.status || 'denied';
}

/**
 * 用新的排程整体替换系统里的待定通知。
 *
 * 先 cancelAll 再逐条排，是为了避免「预测变了、旧通知还留着」——
 * 这正是日历一次性导入方案做不到、而本地通知天然能做到的事。
 */
async function syncReminders(schedule) {
  await Notifications.cancelAllScheduledNotificationsAsync();

  let scheduled = 0;
  for (const item of schedule || []) {
    if (!item || !item.date) continue;
    if (item.date.getTime() <= Date.now()) continue;
    await Notifications.scheduleNotificationAsync({
      content: {
        title: item.title,
        body: item.body,
        data: { itemId: item.itemId }
      },
      trigger: { type: 'date', date: item.date }
    });
    scheduled += 1;
  }
  return scheduled;
}

async function pendingCount() {
  const list = await Notifications.getAllScheduledNotificationsAsync();
  return list.length;
}

module.exports = { ensurePermission, syncReminders, pendingCount };
