/** 我的：家庭入口、提醒设置、数据导出、演示模式开关、关于 */

const app = getApp();
const api = require('../../utils/api');
const cache = require('../../utils/cache');
const config = require('../../config');

Page({
  data: {
    loading: true,
    hasFamily: false,
    familyName: '',
    nickName: '',
    roleText: '',
    memberCount: 0,
    quota: 0,
    remindDays: config.DEFAULT_REMIND_DAYS,
    pushTime: '09:00',
    pushEnabled: true,
    isMock: false,
    envConfigured: true,
    pushFeatureOn: config.PUSH_ENABLED,
    version: '1.0.0'
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
    const data = res.data;
    const family = data.family;
    const settings = (family && family.settings) || {};
    this.setData({
      loading: false,
      hasFamily: Boolean(family),
      familyName: family ? family.name : '',
      nickName: data.me ? data.me.nickName : '',
      roleText: data.me ? (data.me.role === 'owner' ? '创建者' : '成员') : '',
      memberCount: (data.members || []).length,
      quota: (data.me && data.me.subQuota && data.me.subQuota.remaining) || 0,
      remindDays: settings.remindDays === undefined ? config.DEFAULT_REMIND_DAYS : settings.remindDays,
      pushTime: settings.pushTime || '09:00',
      pushEnabled: settings.pushEnabled !== false,
      isMock: api.isMock(),
      envConfigured: config.ENV_ID.indexOf('YOUR') !== 0,
      pushFeatureOn: config.PUSH_ENABLED
    });
  },

  goFamily() {
    if (!this.data.hasFamily) {
      wx.navigateTo({ url: '/pages/onboarding/onboarding' });
      return;
    }
    wx.navigateTo({ url: '/pages/family/family' });
  },

  goSettings() {
    wx.navigateTo({ url: '/pages/settings/settings' });
  },

  async exportData() {
    const res = await api.call('family', 'exportData');
    if (!res.ok) {
      api.showError(new Error(res.message));
      return;
    }
    wx.setClipboardData({
      data: res.data.json,
      success: () => {
        wx.showModal({
          title: '已复制到剪贴板',
          content: `共 ${res.data.itemCount} 个物品、${res.data.eventCount} 条记录。可粘贴到备忘录或发给自己保存。`,
          showCancel: false
        });
      },
      fail: () => {
        wx.showToast({ title: '复制失败', icon: 'none' });
      }
    });
  },

  resetDemo() {
    wx.showModal({
      title: '重置演示数据？',
      content: '会把演示模式下的改动全部清掉，恢复成初始的示例数据。',
      success: async (res) => {
        if (!res.confirm) return;
        cache.clear();
        await api.call('mock', 'reset');
        wx.showToast({ title: '已重置', icon: 'success' });
        this.load();
      }
    });
  },

  clearCache() {
    cache.clear();
    wx.showToast({ title: '本地缓存已清空', icon: 'none' });
  },

  about() {
    wx.showModal({
      title: '补货小管家 RefillPal',
      content:
        '记一笔买了什么、还剩多少，它用你自己的消耗速度推算什么时候该补货，并在该买的时候提醒你。\n\n数据存在你自己的微信云开发环境里，只有家里人能看到。',
      showCancel: false
    });
  }
});
