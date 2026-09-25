/** 家庭与成员：邀请码、成员管理、退出/解散 */

const app = getApp();
const api = require('../../utils/api');

Page({
  data: {
    loading: true,
    family: null,
    members: [],
    myId: '',
    isOwner: false,
    inviteCode: ''
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
    if (!data.family) {
      this.setData({ loading: false, family: null, members: [] });
      return;
    }
    this.setData({
      loading: false,
      family: data.family,
      members: data.members,
      myId: data.me ? data.me._id : '',
      isOwner: Boolean(data.me && data.me.role === 'owner'),
      inviteCode: data.family.inviteCode
    });
  },

  copyCode() {
    wx.setClipboardData({
      data: this.data.inviteCode,
      success: () => wx.showToast({ title: '邀请码已复制', icon: 'none' })
    });
  },

  rename() {
    wx.showModal({
      title: '家庭名',
      editable: true,
      placeholderText: this.data.family.name,
      success: async (res) => {
        if (!res.confirm || !res.content) return;
        const saved = await api.call('family', 'rename', { name: res.content });
        if (!saved.ok) api.showError(new Error(saved.message));
        this.load();
      }
    });
  },

  rotate() {
    wx.showModal({
      title: '换一个邀请码？',
      content: '旧的邀请码立即失效，已经加入的成员不受影响。',
      success: async (res) => {
        if (!res.confirm) return;
        const saved = await api.call('family', 'rotateInvite');
        if (!saved.ok) api.showError(new Error(saved.message));
        this.load();
      }
    });
  },

  removeMember(e) {
    const id = e.currentTarget.dataset.id;
    const member = this.data.members.find((m) => m._id === id);
    if (!member) return;
    wx.showModal({
      title: `把「${member.nickName}」移出家庭？`,
      content: '他会看不到家里的记录，之前记的东西会保留。',
      confirmColor: '#E5484D',
      success: async (res) => {
        if (!res.confirm) return;
        const saved = await api.call('family', 'removeMember', { memberId: id });
        if (!saved.ok) api.showError(new Error(saved.message));
        this.load();
      }
    });
  },

  leave() {
    wx.showModal({
      title: '退出家庭？',
      content: '记录会保留在家里，凭邀请码可以重新加入。',
      success: async (res) => {
        if (!res.confirm) return;
        const saved = await api.call('family', 'leave');
        if (!saved.ok) {
          api.showError(new Error(saved.message));
          return;
        }
        await app.refreshProfile();
        wx.showToast({ title: '已退出', icon: 'none' });
        setTimeout(() => wx.switchTab({ url: '/pages/home/home' }), 600);
      }
    });
  },

  destroy() {
    wx.showModal({
      title: '彻底删除家庭和全部数据？',
      content: '所有物品、购买记录都会永久删除，无法恢复。只有你一个人在家时才能这么做。',
      confirmText: '永久删除',
      confirmColor: '#E5484D',
      success: async (res) => {
        if (!res.confirm) return;
        const saved = await api.call('family', 'destroy');
        if (!saved.ok) {
          api.showError(new Error(saved.message));
          return;
        }
        await app.refreshProfile();
        wx.showToast({ title: '已删除', icon: 'none' });
        setTimeout(() => wx.switchTab({ url: '/pages/home/home' }), 600);
      }
    });
  },

  onShareAppMessage() {
    return {
      title: `来「${this.data.family ? this.data.family.name : '我家'}」一起管日用品，邀请码 ${this.data.inviteCode}`,
      path: '/pages/onboarding/onboarding?inviteCode=' + this.data.inviteCode
    };
  }
});
