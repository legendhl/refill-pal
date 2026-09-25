'use strict';

/**
 * 云函数入口。业务逻辑全部在 app.js（纯逻辑、可单测、可注入伪数据库），
 * 这里只负责把 wx-server-sdk 的运行时依赖注入进去。
 */

const cloud = require('wx-server-sdk');
const kit = require('./shared/kit');
const { handlers } = require('./app');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const handle = kit.createHandler(handlers, {
  db,
  _: db.command,
  getOpenId: async () => {
    const ctx = cloud.getWXContext() || {};
    return ctx.OPENID || null;
  }
});

exports.main = async (event) => handle(event);
