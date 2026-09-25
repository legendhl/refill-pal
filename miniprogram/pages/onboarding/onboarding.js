/** 首次使用：创建一个家，或者用邀请码加入家人的家 */

const app = getApp();
const api = require('../../utils/api');

Page({
  data: {
    mode: 'create', // create | join
    familyName: '我家',
    nickName: '我',
    inviteCode: '',
    saving: false,
    error: '',
    isMock: false
  },

  onLoad(query) {
    this.setData({ isMock: api.isMock() });
    if (query && query.inviteCode) {
      this.setData({ mode: 'join', inviteCode: String(query.inviteCode).toUpperCase() });
    }
  },

  switchMode(e) {
    this.setData({ mode: e.currentTarget.dataset.mode, error: '' });
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [field]: e.detail.value, error: '' });
  },

  async submit() {
    if (this.data.saving) return;
    const nickName = String(this.data.nickName || '').trim();
    if (!nickName) {
      this.setData({ error: '先给自己起个昵称，家人才知道是谁记的' });
      return;
    }

    const payload = { nickName };
    if (this.data.mode === 'create') {
      payload.name = String(this.data.familyName || '').trim() || '我家';
    } else {
      const code = String(this.data.inviteCode || '').trim().toUpperCase();
      if (!code) {
        this.setData({ error: '请输入家人给你的邀请码' });
        return;
      }
      payload.inviteCode = code;
    }

    this.setData({ saving: true, error: '' });
    const res = await api.call('family', this.data.mode, payload);
    this.setData({ saving: false });

    if (!res.ok) {
      this.setData({ error: res.message || '操作失败' });
      return;
    }

    await app.refreshProfile();
    wx.showToast({ title: this.data.mode === 'create' ? '家建好了' : '已加入', icon: 'success' });

    // 站内还有其他页面时返回，否则回到首页
    const pages = getCurrentPages();
    setTimeout(() => {
      if (pages.length > 1) wx.navigateBack();
      else wx.switchTab({ url: '/pages/home/home' });
    }, 600);
  },

  async useDemo() {
    // 演示模式下邀请码是固定的，方便快速看到「加入」流程
    this.setData({ mode: 'join', inviteCode: 'PAL123', nickName: '我' });
    await this.submit();
  }
});
