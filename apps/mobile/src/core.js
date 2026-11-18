'use strict';

/**
 * 共享核心的单一出口。
 *
 * 现在用相对路径指向 monorepo 里的 packages/refillpal-core（Metro 通过
 * metro.config.js 的 watchFolders 能解析到）。将来如果改成 npm workspace
 * 包名引用，只需要改这一个文件。
 */

module.exports = require('../../../packages/refillpal-core/src/index');
