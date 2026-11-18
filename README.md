# 补货小管家 RefillPal

家里的日用品什么时候该买，它替你记着。

记一笔买了什么，它学会你的消耗速度，在快用完的时候提醒你。

一期有**三个端**，共用同一份算法：

| 端 | 技术 | 状态 |
| --- | --- | --- |
| 微信小程序 | 原生 + 微信云开发 | 已完成，可发布 |
| Android / iOS | React Native + Expo | 已完成代码，待真机验证 |
| 自建服务端 | Node（零依赖）+ SQLite | 已完成，可部署 |

---

## 它能做什么

- **3 秒记一笔**：打开就是「该买了」，点一下就记上。买完顺手记，不用填表。
- **自己学会消耗速度**：记两次购买它就知道了，记三次就准了。不靠你手填周期。
- **盘点校准**：说一句「其实还剩 3 包」，它立刻修正预测，并且这次的盘点会成为最准的估算依据。
- **该买的时候提醒**：App 用本地通知（不需要推送服务），小程序用订阅消息。
- **家人共享**：谁买了都记在同一本账上。邀请码一发就能加入。
- **算得清花了多少**：本月开支、花在哪、照这个用法一个月大概要花多少。

## 它和其他记账 App 的区别

记账 App 记录「已经花了多少」，它回答「还要花多少、什么时候花」。
后一个问题需要知道**你家的消耗速度**——所以它记的是「买了多少、用了多久」，而不是单纯的金额。

## 项目结构

```
refillPal/
├── packages/refillpal-core/      ★ 三端唯一源码（零依赖、零 I/O）
│   ├── src/algorithms/core.js    速率估算、事件溯源重放、预测、统计、推送文案
│   ├── src/view/                 视图模型：排序/文案/配色（小程序与 App 共用）
│   ├── src/contract/             action 唯一登记处 + 形状断言
│   ├── src/server/kit.js         服务端公共工具（归属校验、分页、输入校验、统一入口）
│   ├── src/server/handlers/      family / item / purchase / dashboard / stats
│   └── test/                     算法与视图模型测试
├── server/                       ★ 自建服务端（零运行时依赖）
│   ├── src/db/sqlite-repo.js     实现与云数据库同名的链式 API
│   ├── src/auth/                 scrypt 密码哈希 + 自签 JWT
│   ├── src/app.js                node:http 路由，身份注入 handler
│   ├── src/main.js               入口
│   └── scripts/backup.js         VACUUM INTO 备份（可恢复）
├── apps/mobile/                  ★ React Native + Expo
│   ├── App.jsx                   会话门 + 四个 Tab
│   ├── src/api/client.js         接口封装（与服务端同一套 {ok,data} 契约）
│   ├── src/state/store.js        会话 + 数据 + 提醒排程（不依赖 React，可测）
│   ├── src/notifications/        本地通知排程（纯逻辑 + expo 胶水）
│   └── src/screens/              登录/引导/待补货/物品/详情/统计/我的
├── miniprogram/                  微信小程序（页面与组件）
├── cloudfunctions/               微信云函数（app.js 转发到 packages 的 handler）
├── test/                         云函数集成、小程序页面、mock、notify 测试
├── test-utils/                   伪数据库、wx 桩、小程序运行时
├── scripts/                      sync-shared / check-json / release-check
└── docs/
    ├── deploy.md                 ★ 小程序部署手册
    ├── deploy-server.md          ★ 服务端部署手册（含备份与恢复）
    └── plans/                    设计与实施文档
```

## 开发命令

| 命令 | 作用 |
| --- | --- |
| `npm test` | 跑全部测试（288 个，跨三端） |
| `npm run check` | 结构校验：页面完整性、组件路径、JS 语法、JSX 语法、WXML 配对、生成物是否最新 |
| `npm run verify` | sync + check + test，提交前跑这个 |
| `npm run sync` | 把 `packages/refillpal-core/src` 同步到云函数与小程序（改了共享代码后必跑） |
| `npm run server` | 启动自建服务端（需要环境变量） |
| `npm run release-check` | 小程序发布前自检 |
| `node test-utils/e2e-screenshots.js` | 驱动开发者工具跑小程序模拟器并截图 |

## 三端怎么跑

### 微信小程序（演示模式，零配置）

用微信开发者工具「导入项目」选到本目录即可，`miniprogram/config.js` 的 `USE_MOCK` 默认 `true`。
接真实云端见 [docs/deploy.md](docs/deploy.md)。

### 自建服务端

```bash
PORT=3000 DB_FILE=./data/refillpal.db JWT_SECRET=$(openssl rand -hex 32) \
  node server/src/main.js

curl http://127.0.0.1:3000/api/health
```

零依赖，不需要 `npm install`。生产部署（systemd / Caddy / 备份 / 恢复）见
[docs/deploy-server.md](docs/deploy-server.md)。

### 移动端

```bash
cd apps/mobile
npm install                     # 首次
EXPO_PUBLIC_API_BASE_URL=http://192.168.1.10:3000 npx expo start
```

用 Expo Go 扫码即可在手机上跑。`EXPO_PUBLIC_API_BASE_URL` 指向服务端
（开发期用局域网 IP，正式用已备案的 HTTPS 域名）。

## 两个关键设计

### 1. 库存是「算」出来的，不是「存」出来的

`items` 只存一个不可变的初始基准（`baseAt` / `baseQty`），当前库存由全部流水**重放**得出
（`core.replayEvents`）。撤销、补录、改错、删除记录之后，库存永远和流水一致，
不存在「缓存与事实分叉」。这是实施过程中把原设计推翻重做的一次修正。

### 2. 身份是注入的，不是写死的

`kit.createHandler` 从 `deps.getOpenId()` 拿身份，于是同一份 handler 能挂到两个入口：

- 小程序：`cloud.getWXContext().OPENID` → `identityKey = 微信 openid`
- 自建服务端：JWT 解析出 `user:<id>` → `identityKey = "user:..."`

`familyId` 一律由 identity 反查，**从不读取客户端传来的 familyId**。
所以「家人共享」和「越权访问别人家数据」用同一套机制解决，两个入口都有越权测试。

## 测试

288 个测试，分五层：

| 位置 | 覆盖 |
| --- | --- |
| `packages/refillpal-core/test/core.test.js` | 算法：速率估算、离群截断、盘点校准、锚点结算、预测分级、统计 |
| `packages/refillpal-core/test/{viewmodel,format,undo,contract}.test.js` | 视图模型、格式化、撤销队列、契约一致性 |
| `server/test/` | Repository 语义、密码/JWT、端到端 HTTP、备份与恢复 |
| `test/cloud-functions.test.js` `test/notify.test.js` | 云函数：归属安全、家庭共享、推送幂等与额度 |
| `test/pages.test.js` | 小程序页面：WXML 绑定与字段必须存在 + 完整交互流程 |
| `apps/mobile/test/` | API 客户端、提醒排程、导航栈，以及「App → 服务端 → SQLite」整链集成 |

两处「把运行时搬进 Node」的做法值得说明：

- `test/pages.test.js` 注入 `wx`/`Page`/`getApp` 桩，真的执行小程序页面逻辑；
- `apps/mobile/test/store.test.js` 起一个真实的 HTTP 服务，移动端 store 直接打过去。

它们拦下过真 bug：归档物品详情误报「找不到物品」、撤销后宫格库存不同步、模板 ID 没上报导致推送发不出。

## 已知限制

- **小程序推送需要续订**：微信规定订阅消息「一次授权 = 一条」。App 端的本地通知没有这个限制。
- **App 提醒需要打开过一次**：本地通知要 App 至少启动一次才能排程，一次排未来 30 天。
- **盘点才能更准**：只靠购买间隔会被「囤货」干扰。所以详情页把「盘点」做成了和「用完了」同等显眼。
- **预估永远带不确定性**：界面如实显示「估算中 / 粗略估计 / 较准」，不假装精确。
