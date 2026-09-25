const config = require('./config');
const api = require('./utils/api');
const cache = require('./utils/cache');

App({
  globalData: {
    /** { family, me } 或 null */
    profile: null,
    /** 启动失败原因：NO_FAMILY / OFFLINE / 其他 */
    bootCode: null,
    /** 启动就绪的 Promise，页面 shouldWait 它 */
    ready: null,
    /** 打开小程序时是否已经引导过续订 */
    quotaChecked: false
  },

  onLaunch() {
    if (!config.USE_MOCK) {
      if (!wx.cloud) {
        console.error('[RefillPal] 当前基础库不支持云开发，请升级微信开发者工具基础库');
      } else {
        wx.cloud.init({ env: config.ENV_ID, traceUser: true });
      }
    }
    api.init({ useMock: config.USE_MOCK });
    this.globalData.profile = cache.get('profile');
    this.globalData.ready = this.bootstrap();
  },

  /** 拉取「我是谁、我在哪个家」 */
  bootstrap() {
    return api
      .call('family', 'profile')
      .then((res) => {
        if (res && res.ok) {
          this.globalData.profile = res.data;
          this.globalData.bootCode = null;
          cache.set('profile', res.data, config.CACHE_TTL);
          return res.data;
        }
        this.globalData.bootCode = (res && res.code) || 'UNKNOWN';
        return this.globalData.profile;
      })
      .catch(() => {
        this.globalData.bootCode = 'OFFLINE';
        return this.globalData.profile;
      });
  },

  /** 页面里 await app.ready() 拿家庭信息 */
  ready() {
    return this.globalData.ready || Promise.resolve(this.globalData.profile);
  },

  /** 家庭信息变化（新建家庭/加入家庭）后刷新全局 */
  refreshProfile() {
    this.globalData.ready = this.bootstrap();
    return this.globalData.ready;
  }
});
