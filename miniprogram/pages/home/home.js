/**
 * 待补货（首页）。打开就是答案：哪些该买了。
 *
 * 关键设计：
 *   - 「记一笔」是使用频率最高的动作，做成右下角常驻按钮 + 半屏宫格，点一下即 +1
 *   - 记完给 5 秒撤销窗口，并在同一条上提供「补金额」，不让表单拖慢主流程
 *   - 没网时展示上次缓存的数据并明确标注「离线」，不假装是最新的
 */

const app = getApp();
const api = require('../../utils/api');
const vm = require('../../utils/viewmodel');
const cache = require('../../utils/cache');
const format = require('../../utils/format');
const config = require('../../config');
const { createUndoQueue } = require('../../utils/undo');

const HOME_CACHE_KEY = 'home';

Page({
  data: {
    loading: true,
    offline: false,
    noFamily: false,
    headline: { title: '', subtitle: '' },
    summary: null,
    refill: [],
    ok: [],
    emptyRefill: null,
    hasItems: false,

    // 记一笔
    sheetVisible: false,
    quickItems: [],
    quickLoading: false,
    keyword: '',
    searchResults: [],

    // 撤销条
    undo: null,

    // 订阅额度
    showQuotaTip: false,
    quota: 0
  },

  onLoad() {
    this.undoQueue = createUndoQueue({
      windowMs: config.UNDO_WINDOW,
      onExpire: () => this.setData({ undo: null })
    });
    this.pendingReload = null;
    this.lastAdded = null;
  },

  onUnload() {
    this.undoQueue.clear();
    if (this.pendingReload) clearTimeout(this.pendingReload);
  },

  onShow() {
    return this.load();
  },

  onPullDownRefresh() {
    this.load({ silent: true }).then(() => wx.stopPullDownRefresh());
  },

  // ------------------------------------------------------------ 加载

  async load(options = {}) {
    if (!options.silent) this.setData({ loading: true });
    const res = await api.call('dashboard', 'home');

    if (!res.ok) {
      const cached = cache.get(HOME_CACHE_KEY);
      if (cached) {
        this.applyHome(cached, { offline: true });
      } else {
        this.setData({ loading: false, offline: true });
        api.showError(new Error(res.message));
      }
      return;
    }

    const data = res.data;
    if (data.needOnboarding) {
      this.setData({ loading: false, noFamily: true, offline: false });
      return;
    }

    cache.set(HOME_CACHE_KEY, data, config.CACHE_TTL);
    this.applyHome(data, { offline: false });
  },

  applyHome(data, flags = {}) {
    const summary = data.summary
      ? Object.assign({}, data.summary, {
          monthTotalText: format.formatMoney(data.summary.monthTotal)
        })
      : null;

    const quota = (data.me && data.me.subQuota && data.me.subQuota.remaining) || 0;
    const pushOn = !data.family || !data.family.settings || data.family.settings.pushEnabled !== false;

    this.setData({
      loading: false,
      offline: Boolean(flags.offline),
      noFamily: false,
      headline: vm.headline(data.summary ? data.summary.refillCount : 0, data.summary ? data.summary.overdueCount : 0),
      summary,
      refill: vm.toCards(data.refill),
      ok: vm.toCards(data.ok),
      hasItems: Boolean(data.summary && data.summary.itemCount),
      emptyRefill: vm.emptyRefillText(data.summary ? data.summary.itemCount : 0),
      quota,
      showQuotaTip: pushOn && quota < config.LOW_QUOTA_THRESHOLD,
      remindDays: data.remindDays
    });
  },

  // ------------------------------------------------------------ 记一笔

  async openSheet() {
    this.setData({ sheetVisible: true, quickLoading: true, keyword: '', searchResults: [] });
    const res = await api.call('purchase', 'frequent', { limit: 24 });
    if (!res.ok) {
      this.setData({ quickLoading: false });
      api.showError(new Error(res.message));
      return;
    }
    this.setData({
      quickLoading: false,
      quickItems: res.data.items.map(vm.toQuickItem)
    });
  },

  closeSheet() {
    this.setData({ sheetVisible: false, keyword: '', searchResults: [] });
    this.scheduleReload();
  },

  async onSearch(e) {
    const keyword = e.detail.value;
    this.setData({ keyword });
    if (!keyword.trim()) {
      this.setData({ searchResults: [] });
      return;
    }
    // 搜索在本地做：宫格里的物品本来就全在手上，没必要每敲一个字就请求一次
    await this.ensureSearchPool();
    this.setData({ searchResults: vm.filterByName(this.allItemsForSearch, keyword).map(vm.toQuickItem) });
  },

  async ensureSearchPool() {
    if (this.allItemsForSearch) return;
    const res = await api.call('item', 'list');
    this.allItemsForSearch = res.ok ? res.data.items : [];
  },

  currentList() {
    return this.data.keyword.trim() ? this.data.searchResults : this.data.quickItems;
  },

  async quickAdd(e) {
    const id = e.currentTarget.dataset.id;
    await this.addOne(id, 1);
  },

  async quickAddLong(e) {
    const id = e.currentTarget.dataset.id;
    const card = this.currentList().find((c) => c.id === id);
    if (!card) return;
    wx.showModal({
      title: card.name,
      editable: true,
      placeholderText: `买了几${card.unit || '个'}？`,
      success: async (res) => {
        if (!res.confirm) return;
        const qty = Number(res.content);
        if (!Number.isFinite(qty) || qty <= 0) {
          wx.showToast({ title: '数量要大于 0', icon: 'none' });
          return;
        }
        await this.addOne(id, qty);
      }
    });
  },

  async addOne(itemId, qty) {
    const res = await api.call('purchase', 'add', {
      entries: [{ itemId, qty }]
    });
    if (!res.ok) {
      api.showError(new Error(res.message));
      return;
    }

    const eventId = res.data.created[0];
    const view = res.data.items[0];
    const card = this.currentList().find((c) => c.id === itemId);
    const label = `${(card && card.name) || (view && view.name) || '物品'} ×${format.formatQty(qty)}`;

    // 立即更新宫格里的库存，让「点一下就记上了」有即时反馈
    this.mergeQuickItem(view);
    this.undoQueue.push(eventId, { label, itemId });
    this.setData({ undo: { id: eventId, label, itemId } });
    wx.vibrateShort({ type: 'light', fail: () => {} });

    this.scheduleReload();
  },

  mergeQuickItem(view) {
    if (!view) return;
    const card = vm.toQuickItem(view);
    const patch = {};
    ['quickItems', 'searchResults'].forEach((key) => {
      const list = this.data[key];
      if (!list || !list.length) return;
      const idx = list.findIndex((c) => c.id === card.id);
      if (idx < 0) return;
      const next = list.slice();
      next[idx] = Object.assign({}, next[idx], card);
      patch[key] = next;
    });
    if (Object.keys(patch).length) this.setData(patch);
  },

  /** 连续点几下时不要每下都重拉首页，攒 500ms 再拉 */
  scheduleReload() {
    if (this.pendingReload) clearTimeout(this.pendingReload);
    this.pendingReload = setTimeout(() => {
      this.pendingReload = null;
      this.load({ silent: true });
    }, 500);
  },

  // ------------------------------------------------------------ 撤销与补金额

  async undoAdd() {
    const undo = this.data.undo;
    if (!undo) return;
    const entry = this.undoQueue.undo(undo.id);
    this.setData({ undo: null });
    if (!entry) return;

    const res = await api.call('purchase', 'remove', { eventIds: [undo.id] });
    if (!res.ok) {
      api.showError(new Error(res.message));
    } else {
      // 撤销后要顺手把宫格里的库存改回来，否则宫格会停留在「记完」的状态
      (res.data.items || []).forEach((view) => this.mergeQuickItem(view));
      wx.showToast({ title: '已撤销', icon: 'none' });
    }
    this.load({ silent: true });
  },

  /** 补金额：金额是唯一会拖慢「记一笔」的字段，所以放到事后补 */
  async fillAmount() {
    const undo = this.data.undo;
    if (!undo) return;
    wx.showModal({
      title: '花了多少钱？',
      editable: true,
      placeholderText: '例如 39.9（单位：元）',
      success: async (res) => {
        if (!res.confirm) return;
        const amount = Number(res.content);
        if (!Number.isFinite(amount) || amount < 0) {
          wx.showToast({ title: '金额要填数字', icon: 'none' });
          return;
        }
        const saved = await api.call('purchase', 'update', {
          eventId: undo.id,
          patch: { amount }
        });
        if (!saved.ok) {
          api.showError(new Error(saved.message));
          return;
        }
        wx.showToast({ title: '已记上金额', icon: 'success' });
        this.undoQueue.undo(undo.id);
        this.setData({ undo: null });
        this.load({ silent: true });
      }
    });
  },

  // ------------------------------------------------------------ 订阅提醒

  async requestSubscribe() {
    const templateId = config.SUBSCRIBE_TEMPLATE_ID;
    const notConfigured = !templateId || templateId.indexOf('YOUR') === 0;

    if (api.isMock()) {
      // 演示模式下没有真实模板，这里走一遍流程让你看到界面反应
      await api.call('family', 'subscribe', { count: config.SUBSCRIBE_BATCH });
      wx.showToast({ title: `已续订 ${config.SUBSCRIBE_BATCH} 次（演示）`, icon: 'none' });
      this.load({ silent: true });
      return;
    }

    if (notConfigured) {
      wx.showModal({
        title: '还没配置提醒模板',
        content: '需要在微信公众平台申请订阅消息模板，并把模板 ID 填到 miniprogram/config.js。详见 docs/deploy.md。',
        showCancel: false
      });
      return;
    }

    wx.requestSubscribeMessage({
      tmplIds: [templateId],
      success: async (res) => {
        if (res[templateId] === 'accept') {
          await api.call('family', 'subscribe', { count: 1 });
          wx.showToast({ title: '已续订 1 次提醒', icon: 'none' });
          this.load({ silent: true });
        } else {
          wx.showToast({ title: '没订阅就不会收到提醒哦', icon: 'none' });
        }
      },
      fail: () => {
        wx.showToast({ title: '订阅失败，稍后再试', icon: 'none' });
      }
    });
  },

  // ------------------------------------------------------------ 跳转

  openItem(e) {
    wx.navigateTo({ url: `/pages/item-detail/item-detail?id=${e.detail.id}` });
  },

  goOnboarding() {
    wx.navigateTo({ url: '/pages/onboarding/onboarding' });
  },

  goItems() {
    wx.switchTab({ url: '/pages/items/items' });
  },

  goSettings() {
    wx.navigateTo({ url: '/pages/settings/settings' });
  },

  onShareAppMessage() {
    const names = this.data.refill.map((c) => c.name).slice(0, 5).join('、');
    return {
      title: names ? `家里该补货了：${names}` : '补货小管家：家里日用品什么时候该买',
      path: '/pages/home/home'
    };
  }
});
