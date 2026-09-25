Component({
  properties: {
    card: {
      type: Object,
      value: {}
    },
    /** compact：物品页里用的紧凑两行样式 */
    compact: {
      type: Boolean,
      value: false
    },
    showConfidence: {
      type: Boolean,
      value: false
    }
  },

  data: {
    confidenceText: ''
  },

  observers: {
    card(card) {
      this.setData({
        confidenceText: card && card.estimable ? card.confidence : ''
      });
    }
  },

  methods: {
    onTap() {
      this.triggerEvent('tap', { id: this.data.card.id, card: this.data.card });
    },
    onLongPress() {
      this.triggerEvent('longpress', { id: this.data.card.id, card: this.data.card });
    }
  }
});
