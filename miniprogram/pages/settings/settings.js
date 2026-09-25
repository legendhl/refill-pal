/** 提醒设置：提前几天、每天几点推、开不开，以及订阅额度 */

const api = require('../../utils/api');
const config = require('../../config');

/** 定时器整点唤醒，所以只开放整点选择，避免「设了 9:30 却永远收不到」 */
function hourOptions() {
  const out = [];
  for (let h = 6; h <= 23; h += 1) out.push(`${h < 10 ? '0' : ''}${h}:00`);
  return out;
}

Page({
  data: {
    loading: true,
    remindDays: config.DEFAULT_REMIND_DAYS,
    pushTime: '09:00',
    pushEnabled: true,
    hourOptions: hourOptions(),
    hourIndex: 3,
    quota: 0,
    lowQuota: false,
    saving: false,
    changed: false,
    /** 微信推送总开关（config.js 里的 PUSH_ENABLED） */
    pushFeatureOn: config.PUSH_ENABLED
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
    const pushTime = settings.pushTime || '09:00';
    const hourIndex = Math.max(0, this.data.hourOptions.indexOf(pushTime));
    this.setData({
      loading: false,
      remindDays: settings.remindDays === undefined ? config.DEFAULT_REMIND_DAYS : settings.remindDays,
      pushTime,
      hourIndex,
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
    const index = Number(e.detail.value);
    this.setData({ hourIndex: index, pushTime: this.data.hourOptions[index], changed: true });
  },

  /** 预览：不至于为了确认模板字段对不对，等到第二天早上 */
  async preview() {
    if (!this.data.pushFeatureOn) return;
    const res = await api.call('notify', 'preview');
    if (!res.ok) {
      api.showError(new Error(res.message));
      return;
    }
    const data = res.data;
    if (!data.hasContent) {
      wx.showModal({
        title: '今天不会推送',
        content: '眼下没有需要补货的东西，所以它不会打扰你 —— 这是设计如此。',
        showCancel: false
      });
      return;
    }
    const lines = Object.keys(data.payload || {}).map((key) => {
      const v = data.payload[key];
      const text = v && typeof v === 'object' && 'value' in v ? v.value : v;
      return `${key}：${text}`;
    });
    const notes = [
      `待补货 ${data.refillCount} 样 / 共 ${data.itemCount} 样物品`,
      `推送时间 ${data.pushTime}，额度 ${data.quota} 次`,
      data.templateConfigured ? '模板 ID 已记录' : '还没有模板 ID：需要先点一次「续订提醒次数」'
    ];
    wx.showModal({
      title: '提醒内容预览',
      content: `${lines.join('\n')}\n\n${notes.join('\n')}`,
      showCancel: false
    });
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
    if (!this.data.pushFeatureOn) return;
    const templateId = config.SUBSCRIBE_TEMPLATE_ID;

    if (api.isMock()) {
      await api.call('family', 'subscribe', { count: config.SUBSCRIBE_BATCH, templateId });
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
          // 模板 ID 要一起报上去，否则 notify 云函数无从发送
          await api.call('family', 'subscribe', { count: 1, templateId });
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
