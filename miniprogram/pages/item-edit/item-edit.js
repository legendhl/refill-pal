/** 新建 / 编辑物品。表单只问必要的信息，「大概能用多久」是让它开始工作的关键一项。 */

const api = require('../../utils/api');
const { CATEGORIES, UNITS } = require('../../utils/constants');

Page({
  data: {
    isCreate: true,
    id: '',
    categories: CATEGORIES,
    units: UNITS,
    categoryIndex: 0,
    unitIndex: 0,
    form: {
      name: '',
      brand: '',
      spec: '',
      baseQty: '',
      initEstimateDays: ''
    },
    saving: false,
    hint: ''
  },

  onLoad(query) {
    if (query && query.id) {
      this.setData({ isCreate: false, id: query.id });
      wx.setNavigationBarTitle({ title: '编辑物品' });
      this.loadItem();
    } else {
      wx.setNavigationBarTitle({ title: '添加物品' });
    }
  },

  async loadItem() {
    const res = await api.call('item', 'detail', { itemId: this.data.id });
    if (!res.ok) {
      api.showError(new Error(res.message));
      return;
    }
    const view = res.data.item;
    const category = view.category || '其他';
    const unit = view.unit || '个';
    this.setData({
      categoryIndex: Math.max(0, CATEGORIES.indexOf(category)),
      unitIndex: Math.max(0, UNITS.indexOf(unit)),
      form: {
        name: view.name || '',
        brand: view.brand || '',
        spec: view.spec || '',
        baseQty: String(view.baseQty || 0),
        initEstimateDays: view.initEstimateDays ? String(view.initEstimateDays) : ''
      },
      hint: this.hintFor(view.initEstimateDays)
    });
    wx.setNavigationBarTitle({ title: view.name });
  },

  hintFor(days) {
    if (!days) return '';
    return `按「${days} 天用完」估算，记录几次购买后它会自己修正。`;
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    const form = Object.assign({}, this.data.form, { [field]: e.detail.value });
    this.setData({ form });
    if (field === 'initEstimateDays') {
      const days = Number(e.detail.value);
      this.setData({ hint: Number.isFinite(days) && days > 0 ? this.hintFor(days) : '' });
    }
  },

  onCategoryChange(e) {
    this.setData({ categoryIndex: Number(e.detail.value) });
  },

  onUnitChange(e) {
    this.setData({ unitIndex: Number(e.detail.value) });
  },

  pickEstimate(e) {
    this.setData({
      'form.initEstimateDays': String(e.currentTarget.dataset.days),
      hint: this.hintFor(Number(e.currentTarget.dataset.days))
    });
  },

  async save() {
    if (this.data.saving) return;
    const form = this.data.form;
    const name = String(form.name || '').trim();
    if (!name) {
      wx.showToast({ title: '给物品起个名字', icon: 'none' });
      return;
    }

    const payload = {
      name,
      category: this.data.categories[this.data.categoryIndex],
      unit: this.data.units[this.data.unitIndex],
      brand: String(form.brand || '').trim() || null,
      spec: String(form.spec || '').trim() || null
    };

    const days = Number(form.initEstimateDays);
    if (form.initEstimateDays !== '' && (!Number.isFinite(days) || days <= 0)) {
      wx.showToast({ title: '「大概能用多久」要填天数', icon: 'none' });
      return;
    }
    payload.initEstimateDays = form.initEstimateDays === '' ? null : days;

    if (this.data.isCreate) {
      const qty = Number(form.baseQty);
      if (form.baseQty !== '' && (!Number.isFinite(qty) || qty < 0)) {
        wx.showToast({ title: '现有数量不能是负数', icon: 'none' });
        return;
      }
      payload.baseQty = form.baseQty === '' ? 0 : qty;
    }

    this.setData({ saving: true });
    const res = this.data.isCreate
      ? await api.call('item', 'create', payload)
      : await api.call('item', 'update', { itemId: this.data.id, patch: payload });
    this.setData({ saving: false });

    if (!res.ok) {
      api.showError(new Error(res.message));
      return;
    }

    wx.showToast({ title: this.data.isCreate ? '已添加' : '已保存', icon: 'success' });
    setTimeout(() => wx.navigateBack(), 500);
  },

  cancel() {
    wx.navigateBack();
  }
});
