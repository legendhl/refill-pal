/** 提醒设置：提前几天、每天几点推、开不开，以及订阅额度 */

const api = require('../../utils/api');
const config = require('../../config');

Page({
  data: {
    loading: true,
    remindDays: config.DEFAULT_REMIND_DAYS,
    pushTime: '09:00',
    pushEnabled: true,
    quota: 0,
    lowQuota: false,
    saving: false,
    changed: false
  },

  onShow() {
    return this.load();
  },

  async load() {
    const res = await api.call('family', 'profile');
    if (!res.ok) {
      this.setData({ loading: false });
      api.showError(new Error(res.message));
      return;
    }
    const settings = (res.data.family && res.data.family.settings) || {};
    const quota = (res.data.me && res.data.me.subQuota && res.data.me.subQuota.remaining) || 0;
    this.setData({
      loading: false,
      remindDays: settings.remindDays === undefined ? config.DEFAULT_REMIND_DAYS : settings.remindDays,
      pushTime: settings.pushTime || '09:00',
      pushEnabled: settings.pushEnabled !== false,
      quota,
      lowQuota: quota < config.LOW_QUOTA_THRESHOLD
    });
  },

  changeDays(e) {
    const delta = Number(e.currentTarget.dataset.delta);
    const next = Math.min(30, Math.max(0, this.data.remindDays + delta));
    this.setData({ remindDays: next, changed: true });
  },

  onTimeChange(e) {
    this.setData({ pushTime: e.detail.value, changed: true });
  },

  onSwitch(e) {
    this.setData({ pushEnabled: e.detail.value, changed: true });
  },

  async save() {
    if (this.data.saving) return;
    this.setData({ saving: true });
    const res = await api.call('family', 'updateSettings', {
      remindDays: this.data.remindDays,
      pushTime: this.data.pushTime,
      pushEnabled: this.data.pushEnabled
    });
    this.setData({ saving: false });
    if (!res.ok) {
      api.showError(new Error(res.message));
      return;
    }
    this.setData({ changed: false });
    wx.showToast({ title: '已保存', icon: 'success' });
  },

  async renew() {
    const templateId = config.SUBSCRIBE_TEMPLATE_ID;

    if (api.isMock()) {
      await api.call('family', 'subscribe', { count: config.SUBSCRIBE_BATCH });
      wx.showToast({ title: `已续订 ${config.SUBSCRIBE_BATCH} 次（演示）`, icon: 'none' });
      this.load();
      return;
    }

    if (!templateId || templateId.indexOf('YOUR') === 0) {
      wx.showModal({
        title: '还没配置提醒模板',
        content: '请先在微信公众平台申请订阅消息模板，把模板 ID 填到 miniprogram/config.js。详见 docs/deploy.md。',
        showCancel: false
      });
      return;
    }

    wx.requestSubscribeMessage({
      tmplIds: [templateId],
      success: async (res) => {
        if (res[templateId] === 'accept') {
          await api.call('family', 'subscribe', { count: 1 });
          wx.showToast({ title: '已续订 1 次', icon: 'none' });
        } else {
          wx.showToast({ title: '没有订阅成功', icon: 'none' });
        }
        this.load();
      },
      fail: () => wx.showToast({ title: '订阅失败', icon: 'none' })
    });
  }
});
