/** 物品页：按分类分组的全部物品，带搜索与新建入口 */

const api = require('../../utils/api');
const vm = require('../../utils/viewmodel');

Page({
  data: {
    loading: true,
    noFamily: false,
    keyword: '',
    groups: [],
    total: 0,
    empty: null
  },

  onShow() {
    return this.load();
  },

  async load() {
    const res = await api.call('item', 'list');
    if (!res.ok) {
      this.setData({ loading: false });
      api.showError(new Error(res.message));
      return;
    }
    this.views = res.data.items;
    this.setData({
      loading: false,
      noFamily: false,
      total: this.views.length,
      empty: {
        emoji: '🧺',
        title: '还没有物品',
        desc: '把家里常用的东西加进来，比如抽纸、洗手液、垃圾袋。\n加的时候填一句「大概能用多久」，它就能开始提醒你。',
        actionText: '添加第一个物品'
      }
    });
    this.applyFilter();
  },

  applyFilter() {
    const list = vm.filterByName(this.views, this.data.keyword);
    this.setData({ groups: vm.groupByCategory(list) });
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value });
    this.applyFilter();
  },

  openItem(e) {
    wx.navigateTo({ url: `/pages/item-detail/item-detail?id=${e.detail.id}` });
  },

  goCreate() {
    wx.navigateTo({ url: '/pages/item-edit/item-edit' });
  },

  goOnboarding() {
    wx.navigateTo({ url: '/pages/onboarding/onboarding' });
  }
});
