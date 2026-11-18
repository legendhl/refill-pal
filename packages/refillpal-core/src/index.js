'use strict';

/**
 * 包入口：只导出「客户端也能用」的东西（算法 / 视图模型 / 契约）。
 *
 * 服务端专用的 kit 与 handlers 不从这里导出 —— 否则 App 打包时会把
 * 数据库与鉴权代码一起打进包里。
 *   服务端：require('@refillpal/core/src/server/kit')
 *   handlers：require('@refillpal/core/src/server/handlers/family')
 */

module.exports = {
  core: require('./algorithms/core'),
  view: require('./view/viewmodel'),
  format: require('./view/format'),
  constants: require('./view/constants'),
  undo: require('./view/undo'),
  contract: require('./contract')
};
