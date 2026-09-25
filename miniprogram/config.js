/**
 * 全局配置 —— 部署时只需要改这一个文件（外加 project.config.json 的 appid）。
 *
 * 部署三步：
 *   1. project.config.json 里的 "appid" 换成你自己的小程序 AppID
 *   2. 下面的 ENV_ID 换成云开发环境 ID（开发者工具 → 云开发 → 设置 → 环境 ID）
 *   3. 订阅消息模板申请通过后，把模板 ID 填到 SUBSCRIBE_TEMPLATE_ID
 *   4. 云函数全部上传成功后，把 USE_MOCK 改成 false
 */
module.exports = {
  /** 云开发环境 ID，形如 'refillpal-1a2b3c4d5e6f7g8h' */
  ENV_ID: 'YOUR-CLOUD-ENV-ID',

  /** 订阅消息模板 ID（每日补货汇总） */
  SUBSCRIBE_TEMPLATE_ID: 'YOUR-SUBSCRIBE-TEMPLATE-ID',

  /**
   * true  = 本地演示数据，不需要云开发就能在开发者工具里点着看
   * false = 走真实云函数
   */
  USE_MOCK: true,

  /** 默认提前几天提醒补货 */
  DEFAULT_REMIND_DAYS: 3,

  /** 订阅额度低于这个数就引导续订 */
  LOW_QUOTA_THRESHOLD: 3,

  /** 一次续订引导最多申请几条额度 */
  SUBSCRIBE_BATCH: 3,

  /** 首页数据的本地缓存有效期（毫秒） */
  CACHE_TTL: 12 * 60 * 60 * 1000,

  /** 云函数调用超时（毫秒） */
  CALL_TIMEOUT: 10000,

  /** 撤销窗口（毫秒） */
  UNDO_WINDOW: 5000
};
