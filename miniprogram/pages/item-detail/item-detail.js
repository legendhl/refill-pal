/**
 * 物品详情：库存 / 预测 / 消耗速度来源 + 时间轴 + 三个动作（记账、盘点、用完）。
 *
 * 「盘点」是这个产品里最有价值的输入：它能让估算法排除「囤货」干扰，
 * 所以这里给它和「用完了」同等显眼的位置，而不是藏在二级菜单里。
 */

const api = require('../../utils/api');
const vm = require('../../utils/viewmodel');
const format = require('../../utils/format');

Page({
  data: {
    loading: true,
    id: '',
    card: null,
    detail: null,
    timeline: [],
    unit: '',
    name: '',
    status: 'active',
    remindDays: 3
  },

  onLoad(query) {
    this.setData({ id: query.id || '' });
  },

  onShow() {
    if (this.data.id) return this.load();
    return undefined;
  },

  async load() {
    const res = await api.call('item', 'detail', { itemId: this.data.id });
    if (!res.ok) {
      this.setData({ loading: false });
      api.showError(new Error(res.message));
      if (res.code === 'ITEM_NOT_FOUND') setTimeout(() => wx.navigateBack(), 1200);
      return;
    }
    const view = res.data.item;
    if (!view) {
      this.setData({ loading: false });
      api.showError(new Error('找不到这个物品'));
      return;
    }
    const card = vm.cardOf(view);
    this.setData({
      loading: false,
      view,
      card,
      unit: view.unit || '',
      name: view.name,
      status: view.status,
      remindDays: res.data.remindDays,
      basisText: vm.basisText(view),
      rateText: vm.rateText(view),
      confidence: vm.confidenceText(view),
      stockText: vm.stockText(view),
      remainingText: vm.remainingText(view),
      emptyAtText: vm.emptyAtText(view),
      timeline: vm.toTimeline(res.data.events, view),
      historyCount: res.data.events.length
    });
    wx.setNavigationBarTitle({ title: view.name });
  },

  // ------------------------------------------------------------ 记一笔

  buy() {
    wx.showModal({
      title: `买了几个${this.data.unit || ''}？`,
      editable: true,
      placeholderText: '例如 2',
      success: async (res) => {
        if (!res.confirm) return;
        const qty = Number(res.content);
        if (!Number.isFinite(qty) || qty <= 0) {
          wx.showToast({ title: '数量要大于 0', icon: 'none' });
          return;
        }
        const saved = await api.call('purchase', 'add', { entries: [{ itemId: this.data.id, qty }] });
        if (!saved.ok) {
          api.showError(new Error(saved.message));
          return;
        }
        wx.showToast({ title: '已记上', icon: 'success' });
        this.offerAmount(saved.data.created[0]);
        this.load();
      }
    });
  },

  /** 记完顺手问一句金额：不想记就点取消，不阻塞流程 */
  offerAmount(eventId) {
    wx.showModal({
      title: '要记金额吗？',
      content: '记了金额，统计页才能告诉你每月花多少。',
      confirmText: '记一下',
      cancelText: '不用了',
      success: (res) => {
        if (!res.confirm) return;
        wx.showModal({
          title: '花了多少钱？',
          editable: true,
          placeholderText: '单位：元，例如 39.9',
          success: async (r2) => {
            if (!r2.confirm) return;
            const amount = Number(r2.content);
            if (!Number.isFinite(amount) || amount < 0) {
              wx.showToast({ title: '金额要填数字', icon: 'none' });
              return;
            }
            const saved = await api.call('purchase', 'update', { eventId, patch: { amount } });
            if (!saved.ok) api.showError(new Error(saved.message));
            else wx.showToast({ title: '已记上金额', icon: 'success' });
            this.load();
          }
        });
      }
    });
  },

  // ------------------------------------------------------------ 盘点 / 用完

  stocktake() {
    const current = this.data.view && this.data.view.stock;
    wx.showModal({
      title: '现在还剩多少？',
      editable: true,
      placeholderText: `估算还剩 ${format.formatQty(current || 0)}，改成实际数字`,
      success: async (res) => {
        if (!res.confirm) return;
        const remaining = Number(res.content);
        if (!Number.isFinite(remaining) || remaining < 0) {
          wx.showToast({ title: '请填一个数字', icon: 'none' });
          return;
        }
        await this.submitStocktake(remaining, false);
      }
    });
  },

  async submitStocktake(remaining, force) {
    const res = await api.call('item', 'stocktake', {
      itemId: this.data.id,
      remaining,
      force
    });
    if (!res.ok) {
      api.showError(new Error(res.message));
      return;
    }
    if (res.data.confirmNeeded) {
      wx.showModal({
        title: '确认一下',
        content: res.data.message,
        confirmText: '没填错',
        success: async (r) => {
          if (r.confirm) await this.submitStocktake(remaining, true);
        }
      });
      return;
    }
    wx.showToast({ title: '已校准', icon: 'success' });
    this.load();
  },

  usedUp() {
    wx.showModal({
      title: '确认用完了？',
      content: '记下这一刻，它能用来算出更准的消耗速度。',
      success: async (res) => {
        if (!res.confirm) return;
        const saved = await api.call('item', 'usedUp', { itemId: this.data.id });
        if (!saved.ok) {
          api.showError(new Error(saved.message));
          return;
        }
        wx.showToast({ title: '记下了', icon: 'success' });
        this.load();
      }
    });
  },

  // ------------------------------------------------------------ 更多操作

  more() {
    const isArchived = this.data.status === 'archived';
    const items = ['编辑物品', isArchived ? '恢复到提醒列表' : '归档（不再提醒）', '删除物品及全部记录'];
    wx.showActionSheet({
      itemList: items,
      success: async (res) => {
        if (res.tapIndex === 0) {
          wx.navigateTo({ url: `/pages/item-edit/item-edit?id=${this.data.id}` });
        } else if (res.tapIndex === 1) {
          const action = isArchived ? 'restore' : 'archive';
          const saved = await api.call('item', action, { itemId: this.data.id });
          if (!saved.ok) api.showError(new Error(saved.message));
          else wx.showToast({ title: isArchived ? '已恢复' : '已归档', icon: 'none' });
          this.load();
        } else if (res.tapIndex === 2) {
          this.confirmRemove();
        }
      }
    });
  },

  confirmRemove() {
    wx.showModal({
      title: `删除「${this.data.name}」？`,
      content: '这个物品的购买记录会一起删掉，统计里也会消失。删了就找不回来了。',
      confirmText: '删除',
      confirmColor: '#E5484D',
      success: async (res) => {
        if (!res.confirm) return;
        const saved = await api.call('item', 'remove', { itemId: this.data.id });
        if (!saved.ok) {
          api.showError(new Error(saved.message));
          return;
        }
        wx.showToast({ title: '已删除', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 600);
      }
    });
  },

  editEvent(e) {
    const id = e.currentTarget.dataset.id;
    wx.showActionSheet({
      itemList: ['修改数量', '修改金额', '删除这条记录'],
      success: async (res) => {
        if (res.tapIndex === 2) {
          const saved = await api.call('purchase', 'remove', { eventIds: [id] });
          if (!saved.ok) api.showError(new Error(saved.message));
          else wx.showToast({ title: '已删除', icon: 'none' });
          this.load();
          return;
        }
        const isQty = res.tapIndex === 0;
        wx.showModal({
          title: isQty ? '改成几？' : '金额改成多少？',
          editable: true,
          placeholderText: isQty ? `单位：${this.data.unit}` : '单位：元',
          success: async (r) => {
            if (!r.confirm) return;
            const value = Number(r.content);
            if (!Number.isFinite(value) || value < 0) {
              wx.showToast({ title: '请填一个数字', icon: 'none' });
              return;
            }
            const patch = isQty ? { qty: value } : { amount: value };
            const saved = await api.call('purchase', 'update', { eventId: id, patch });
            if (!saved.ok) api.showError(new Error(saved.message));
            else wx.showToast({ title: '已修改', icon: 'success' });
            this.load();
          }
        });
      }
    });
  },

  goEdit() {
    wx.navigateTo({ url: `/pages/item-edit/item-edit?id=${this.data.id}` });
  }
});
