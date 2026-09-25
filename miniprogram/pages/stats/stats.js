/**
 * 统计页：这个月花了多少、花在哪、这些东西一个月大概要花多少。
 *
 * 最后一项（预计月开销）是只有估算了消耗速度才给得出的数字，
 * 也是这个产品相对「记账本」的真正增量。
 */

const api = require('../../utils/api');
const vm = require('../../utils/viewmodel');

function monthOptions(now) {
  const out = [];
  for (let i = 0; i < 6; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({
      label: `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`,
      value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    });
  }
  return out;
}

Page({
  data: {
    loading: true,
    months: [],
    monthIndex: 0,
    view: null,
    showAllRank: false
  },

  onLoad() {
    this.setData({ months: monthOptions(new Date()) });
  },

  onShow() {
    return this.load();
  },

  async load() {
    const month = this.data.months[this.data.monthIndex];
    const res = await api.call('stats', 'monthly', { month: month ? month.value : undefined });
    if (!res.ok) {
      this.setData({ loading: false });
      api.showError(new Error(res.message));
      return;
    }
    this.setData({ loading: false, view: vm.toStatsVm(res.data) });
  },

  onMonthChange(e) {
    this.setData({ monthIndex: Number(e.detail.value), showAllRank: false }, () => this.load());
  },

  toggleRank() {
    this.setData({ showAllRank: !this.data.showAllRank });
  },

  goItem(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/item-detail/item-detail?id=${id}` });
  }
});
