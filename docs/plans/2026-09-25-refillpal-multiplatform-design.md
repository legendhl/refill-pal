# 补货小管家 · 多端（Android / iOS）设计

- 日期：2026-09-25
- 状态：**已确认**（4 个决策点已定，见 §12；尚未开始实施）
- 前置文档：[一期设计](2026-09-25-refillpal-design.md)、[实施计划](2026-09-25-refillpal-implementation-plan.md)
- 范围：小程序保留，新增 Android + iOS 移动端；**不含** `.ics` 日历订阅、Web 版、远程推送

---

## 1. 背景与已确认的决策

### 1.1 为什么做移动端

按需求方确认，动机按优先级：

| 动机 | 说明 | 对本设计的影响 |
| --- | --- | --- |
| 推送/提醒不够用 | 订阅消息一次授权只能推一条，额度总要用完 | 移动端用**本地通知**，不用远程推送 |
| 小程序能力受限 | 不能在微信外使用、无法后台运行等 | 需要一个真正独立的 App 运行环境 |
| 数据与后续扩展 | 希望后端不被微信锁死，能接自己的服务器 | 后端要做 **HTTP 化 + 身份抽象** |

明确**不是**动机的：品牌独立、界面表现力。因此不追求"看起来像大厂 App"，优先复用与低成本。

### 1.2 已排除的方案

- **`.ics` 日历订阅**：需求方明确不在本方案内（推 1~2 天可做，但不是当前路线）。
- **远程推送**（APNs + 国内厂商通道）：需求方确认只要"到点提醒我"，不需要"家人操作后立刻推送"。国内 Android 无 GMS，远程推送要逐个接小米/华为/OPPO/vivo 通道或第三方服务，成本远高于收益。
- **Capacitor 等 WebView 套壳**：iOS 审核 4.2 条款（纯套壳可能被拒）且体验差。
- **原生 Swift + Kotlin**：两套代码，个人项目不现实。

---

## 2. 现状盘点：哪些是资产，哪些是负债

这一步决定"能复用多少"，是选型的事实依据。

### 2.1 可直接复用的（已验证）

| 资产 | 现状 | 复用方式 |
| --- | --- | --- |
| 算法层 | `cloudfunctions/_shared/core.js`，24KB，**零 `require`**，纯函数 | 三端直接 import，一行不改 |
| 视图模型层 | `miniprogram/utils/{viewmodel,format,constants,undo}.js`，**全部零 `wx.` 引用** | 直接搬到共享包 |
| 云函数 handlers | `family/item/purchase/dashboard/stats` 的 `app.js` 只依赖 `./shared/core` 与 `./shared/kit`，且 `db`/`now`/`openid` 全部注入 | 同一份 handler 挂两个入口 |
| 测试 | 219 个，其中 47 个是纯算法、36 个是云函数集成 | 跟着算法一起搬 |
| 数据模型 | 事件溯源（`baseAt/baseQty` + 流水重放），已证明能正确处理撤销/补录 | 不动 |
| 主包体积 | 171KB | 远低于限制 |

**关键结论**：客户端 8 个 utils 里有 5 个平台无关（`api`/`cache`/`mock` 除外）。也就是说"算法 + 视图模型"这两层可以整体搬走，剩下要重写的只有 UI 和平台适配。

### 2.2 必须改的（负债）

| 负债 | 具体表现 | 处理 |
| --- | --- | --- |
| 身份绑死 openid | 每个 handler 第一步都是 `kit.requireFamily(db, openid)`，靠 `members.where({openid})` 反查家庭 | 身份抽象成 `identityKey`（见 §5） |
| 数据表没有跨端标识 | `members.openid` 是唯一索引，语义专属于小程序 | 迁移到 `members.identityKey` |
| 单一入口 | `kit.createHandler` 只服务 `wx.cloud.callFunction` | 增加 HTTP 入口，二者共用 handler |
| UI 绑死 WXML | 9 个页面、2 个组件 | App 端重写（不可复用，见 §3） |

### 2.3 平台约束（会直接影响方案的硬事实）

这几条是本设计里最容易踩的，先列出来：

1. **`openid` 按 AppID 隔离**。同一个人在小程序里和在移动应用里拿到的 openid **不同**。跨端认同一人必须靠 `unionid`。
2. **`unionid` 需要微信开放平台**。小程序与"移动应用"要绑定到同一个开放平台账号，且创建移动应用需要开发者资质认证（企业主体 + 认证费）。**个人主体做不了 App 里的微信登录。**
3. **个人主体小程序不能用手机号快速验证组件**（`getPhoneNumber`）。所以两端都不能"一键取手机号"。
4. **国内 Android 没有 Google 服务**，FCM 不可用；远程推送必须接厂商通道。
5. **iOS 本地通知**有数量上限（待定通知最多 64 条），且需要用户授权通知权限。

→ 由此推出 §5 的身份方案和 §6 的通知方案。

---

## 3. 技术选型

### 3.1 对比

| 方案 | 一套代码 iOS+Android | 复用现有 JS | App 体验 | 迁移成本 | 备注 |
| --- | --- | --- | --- | --- | --- |
| **React Native + Expo** | ✅ | ✅ 直接 import | 原生渲染 | UI 重写 | **推荐** |
| Flutter | ✅ | ❌ 算法要翻译成 Dart | 很好 | UI + 算法双重重写 | 丢掉最值钱的资产 |
| Taro 3（React） | ✅ 且同时出小程序/H5 | ✅ | 中（RN 运行时） | 小程序 UI 也要重写 | 只在"必须只维护一套 UI"时选 |
| uni-app（Vue） | ✅ 且同时出小程序/H5 | ⚠️ 需改造 | 中下 | 中 | 国内生态好，App 端偏弱 |
| Capacitor 套壳 | ✅ | ✅ | 差 | 最低 | iOS 4.2 审核风险 |

### 3.2 推荐：React Native + Expo

理由（按权重）：

1. **算法一行不改**。`core.js` 是零依赖纯函数，RN 可以直接 import；Flutter 要把它翻译成 Dart，而这是全项目测试最密、返工风险最高的部分。
2. **UI 无论如何都要重写**。WXML 的卡片/宫格不可能变成原生组件，所以"选一个能复用 WXML 的方案"是伪需求。Taro 也只能让你重写一遍小程序 UI 再顺带出 App。
3. **Expo 把签名/打包/上架的成本降到最低**：EAS Build 云端打包，不必在本地配 Xcode/Android Studio；`expo-notifications` 一条命令就能排本地通知。

### 3.3 什么情况下改选 Taro

如果出现以下任一情况，应改用 Taro 3：

- 需求方改变主意，要求**长期只维护一套 UI**，小程序和 App 永远同步；
- 移动端只需要"能装、能用"，不追求原生体验；
- 愿意接受"小程序 UI 也重写一次"的一次性成本，换取之后不再维护两套界面。

这个决定建议留到 §7 第 4 步（真正开始写 App UI 时）再最终确认——前三步不受它影响。

---

## 4. 目标架构

### 4.1 仓库结构

```
refillPal/
├── packages/refillpal-core/          # 三端共用，零依赖、零 I/O
│   ├── src/algorithms/
│   │   ├── rate.js                   # 速率估算（EWMA + 离群截断 + 盘点校准）
│   │   ├── stock.js                  # 事件溯源重放 / 预测 / 待补货排序
│   │   ├── stats.js                  # 月度统计
│   │   └── reminder.js               # 未来 N 天该提醒什么（App 本地通知用）
│   ├── src/view/                     # ← miniprogram/utils/{viewmodel,format,constants,undo}
│   ├── src/contract/                 # 新增：action 名单 + 入参出参形状断言
│   ├── test/                         # ← test/core.test.js / viewmodel.test.js / format.test.js
│   └── index.js
├── apps/mobile/                      # 新增：RN + Expo
├── miniprogram/                      # 现有，只改 require 路径
├── cloudfunctions/                   # 现有 6 个 + 新增 http 入口
├── tools/                            # sync-shared / check-json / release-check / e2e-screenshots
└── docs/
```

### 4.2 三条依赖规则（由 `check` 脚本强制）

1. **单向依赖**：`contract` ← `algorithms` ← `view` ← UI。
   - `algorithms` 不许 require `view`
   - `view` 不许 require `wx` / `react-native` / 任何 I/O
2. **零 I/O**：不碰数据库、不发请求、不读系统时间（`now` 一律注入）。保证三端跑同一份测试得到同一结果。
3. **UI 不共享，样式下沉到 token**：小程序用 WXML，RN 用自身组件；共享止于 `view` 层的纯对象（`{name, stockText, color, badge}`），颜色/字号作为数据或 token 传递。

### 4.3 两个刻意的取舍

**取舍一：不引入构建步骤。** `packages/refillpal-core` 保持 CommonJS + JSDoc 类型注释，不装 TypeScript/Babel。

- 理由：小程序消费共享代码必须靠 `tools/sync-shared.js` **复制**（小程序不能 require 项目根之外的路径，云函数也不适合 `file:` 依赖）。一旦要求编译产物，同步链就多一环、多一处会坏的地方。
- 代价：共享包内不能写 TS 语法；类型靠 JSDoc + `checkJs`，IDE 补全可用，但没有编译期类型检查。

**取舍二：暂不把 `miniprogram/` 挪进 `apps/`。** 挪动要改 `project.config.json` 的 `miniprogramRoot` 与 50 多处测试/脚本路径，而需求方在开发者工具里还开着这个项目。等 App 跑通、路径稳定后再统一 `git mv`，风险更低。

---

## 5. 身份与后端

这是本设计里工作量最大、也最容易被低估的部分。

### 5.1 身份接缝：`createHandler` 的 `getOpenId`

现有代码已有一个天然的抽象点：

```js
// cloudfunctions/_shared/kit.js
function createHandler(handlers, deps) {
  const openid = await deps.getOpenId();        // ← 身份从这里进来
  const data = await fn({ openid, payload, db: deps.db, _: deps._, now });
}
```

**两个入口注入不同的 `getOpenId`，handler 一行不改**：

| 入口 | 注入的 `getOpenId` 实现 |
| --- | --- |
| `wx.cloud.callFunction`（小程序） | `cloud.getWXContext().OPENID` → `identityKey = "wechat:" + openid` |
| HTTP（App） | 校验 `Authorization: Bearer <token>` → 解析出 `userId` → `identityKey = "phone:" + phone` |

因此 handler 里的 `openid` 参数实际含义变成 "identityKey"。**建议改名**（`openid` → `identity`），否则半年后会有人以为它真的是 openid。

### 5.2 身份方案（受 §2.3 的约束）

| 方案 | 可用性 | 跨端打通 | 成本 | 结论 |
| --- | --- | --- | --- | --- |
| 微信登录（App 内） | ❌ 个人主体无法创建开放平台"移动应用" | 靠 unionid | — | 不可用 |
| 手机号快速验证组件 | ❌ 个人主体小程序不支持 | — | — | 不可用 |
| **手输手机号 + 短信验证码** | ✅ 两端都能做 | 天然打通（同一手机号 = 同一人） | 短信约 ¥0.04/条 | **推荐** |
| 邮箱 + 密码 | ✅ | 天然打通 | 0 | 备选（体验差） |

**已确认：邮箱 + 密码。**

- 两端都用邮箱注册登录，同一邮箱 = 同一人，不依赖 unionid、不需要任何资质、无短信费用。
- 代价是体验略差（手输邮箱、要记密码），但对 2~5 人的家庭场景可接受。
- **不做自助找回密码**：找回需要能发邮件（SMTP 或 Resend），先省掉这个外部依赖；忘记密码由家庭创建者在 App 里重置。

### 5.3 数据迁移

| 集合 | 变更 | 迁移动作 |
| --- | --- | --- |
| `members` | `openid` → `user_id`（外键指向 `users`）；唯一索引改到 `user_id` | 存量数据脚本：为每个 openid 建一条 `users` 记录 |
| `users` | **新表**：`id`、`email`（可空，唯一）、`password_hash`（可空）、`wechat_openid`（可空，唯一） | 从 `members.openid` 回填 |
| `families` | 新增 `calendarToken`（若将来做 ICS）、`ownerUserId` | 可空，无需回填 |
| 其余集合 | 不变 | — |

迁移必须**可回滚**：先双写 `openid` 与 `user_id`，观察一个版本后再删 `openid`。

为什么用 `users` 表而不是给 `members` 加一个字符串 `identityKey`：同一个用户可能同时有微信身份（小程序）和邮箱密码（App），而"他在这个家庭里是什么角色"是另一件事。把「身份」和「成员关系」拆开，绑定账号时才不需要搬家。

### 5.4 HTTP 入口

新增 `cloudfunctions/http/`（或独立的 `api` 云函数），职责只有三件：

1. 解析 `POST /api/{action}` 的 body → `{action, payload}`
2. 从 `Authorization` header 解析 `userId`
3. 调用与小程序**同一份** handler，返回 JSON

不新增业务逻辑。这样"同一份逻辑两套入口"是可测的：契约测试对两个入口各跑一遍，断言返回结构一致。

---

## 6. 提醒方案：本地通知

### 6.1 为什么够用

需求确认只要"到点提醒我"。而"哪天该买什么"在手机本地就能算出来（`packages/core` 的同一份算法）。因此：

- **不需要 APNs / FCM / 厂商通道**
- **不需要后端推送基础设施**
- iOS/Android 行为一致

### 6.2 调度策略

```
App 启动 / 数据变更
  → 拉取家庭数据（HTTP，失败则用本地缓存）
  → core.reminder.buildSchedule(views, { now, horizonDays: 30 })
  → cancelAllScheduledNotificationsAsync()
  → 逐条 scheduleNotificationAsync({ trigger: { type: 'date', date } })
```

- 每个"该买"物品一条通知：`{提醒日} 09:00`，正文 `还剩 0.1 瓶，预计今天用完`
- 提前量沿用家庭设置里的 `remindDays`
- **每次重排前先全部取消**：避免预测变化后旧通知残留（这正是 `.ics` 一次性导入方案的死结，本地通知没有这个问题）

### 6.3 边界与已知限制

| 限制 | 影响 | 处理 |
| --- | --- | --- |
| 必须打开过一次 App 才能排通知 | 新装后不打开 = 没有提醒 | 引导页明确提示"打开一次即可排好未来 30 天" |
| 30 天不打开 | 通知断档 | 每次打开重排；窗口取 30 天，兼顾 iOS 64 条上限 |
| iOS 通知权限被拒 | 收不到 | 设置页显示状态 + 一键跳系统设置 |
| Android 13+ 需 `POST_NOTIFICATIONS` | 同上 | Expo 配置里声明，运行时请求 |
| 时区/夏令时 | 偏移 | 用本地时间触发（`Calendar` trigger），不用 UTC 时间戳 |

### 6.4 与小程序版本的关系

小程序继续保留微信订阅消息（总开关 `PUSH_ENABLED`）。两者互不影响：小程序里被提醒过、App 里又收到本地通知，属于可接受的重复；如果嫌吵，在 App 里把 `remindDays` 调小即可。

---

## 7. 迁移顺序（每步都可验证，不推倒重来）

| 步骤 | 内容 | 验收标准（可执行） |
| --- | --- | --- |
| **1. 抽包 + 收口数据层** | `_shared/core.js` → `packages/refillpal-core/src/algorithms/`；`viewmodel/format/constants/undo` → `src/view/`；`sync-shared.js` 改为「把包产物拷进 cloudfunctions 与 miniprogram」；**`db` 访问收口到 `repository` 接口**（见 §11.5） | `npm test` 仍 219 全绿；`npm run check` 通过；小程序与云函数行为零变化；除 `repository/clouddb.js` 外，任何 handler 不再直接出现 `db.collection(` |
| **2. 契约显式化** | `src/contract/` 定义每个 action 的入参出参形状；把现有「mock 与云函数结构一致」的测试升级为「三端一致」 | 新增契约测试；任何一端返回值结构漂移都会失败 |
| **3. 身份与 HTTP** | 新建 `users` 表；`members.openid` → `members.user_id`；新增 HTTP 入口；邮箱 + 密码注册登录（scrypt + JWT） | 小程序端行为不变；HTTP 入口与小程序入口对同一 action 返回相同结构；越权测试两套都过 |
| **4. App** | 建 `apps/mobile`，先做只读（首页/物品/统计），再做记一笔 | 真机上能登录、能看到家庭数据、能收到本地通知 |

**关键：第 1、2 步不改变任何用户可见行为**，只是把代码挪到正确的位置。这两步做完，小程序的 219 个测试仍然全绿，就等于"地基已经能接任何端了"。

---

## 8. 测试策略

| 层 | 怎么测 | 覆盖 |
| --- | --- | --- |
| 算法（共享） | 现有 47 个测试跟着代码搬 | 速率估算、重放、预测、统计 |
| 提醒调度（共享） | 新增纯函数测试 | 未来 30 天该排哪些通知、边界（库存 0、无速率、时区） |
| 契约（共享） | 形状断言，三端各跑一遍 | action 名、入参出参字段 |
| 云函数 | 现有 36 个 + HTTP 入口的并行断言 | 归属安全、家庭共享、事件溯源 |
| App UI | 先手动验收；稳定后接 Detox（可选） | 登录、看到数据、收到通知 |

不引入的东西：E2E 全链路（参考现有做法，用注入式测试替身更划算）。

---

## 9. 成本与风险

| 项 | 估算 | 说明 |
| --- | --- | --- |
| 第 1~2 步（抽包 + 契约） | 2~3 天 | 工作量小但必须做，否则后面都是空中楼阁 |
| 第 3 步（身份 + HTTP） | 3~5 天 | 最大的一块；含数据迁移与双入口测试 |
| 第 4 步（App 首版） | 1~2 周 | 只读 + 记一笔 + 本地通知 |
| Apple 开发者账号 | **$99/年** | 上 App Store 必需 |
| 短信 | 约 ¥0.04/条 | 仅登录用 |
| 备案 / 类目 / 隐私 | 沿用小程序已有的 | 移动端另有 App Store 隐私问卷 |

**主要风险**：

1. **身份方案做歪**：`openid` 与 `identityKey` 混用是最可能的长期技术债。缓解：第 3 步一次性改干净，只保留一个字段名。
2. **双端 UI 长期维护**：两份界面各改各的。缓解：业务逻辑共享到 `packages/core`，UI 只做"看起来像"的薄层；如果这个成本不可接受，回到 §3.3 改选 Taro。
3. **个人主体无法做 App 微信登录**：已通过"手机号 + 验证码"绕开，但用户多一步输入。
4. **iOS 审核**：本地通知不涉及远程推送，审核风险低；但需要隐私清单与隐私政策链接。

---

## 10. 明确不做

- `.ics` 日历订阅（需求方已排除）
- 远程推送（APNs / FCM / 厂商通道）
- Web 版
- App 内的微信登录（个人主体资质限制）
- 实时协作（家人操作后 App 立刻收到）—— 打开 App 时拉取即可
- 双端 UI 组件库抽公共层（YAGNI，等真的维护不动再说）

---

## 11. 服务端部署与数据存储

需求方现有一台 **阿里云轻量应用服务器（Alibaba Cloud Linux，2 vCPU / 2 GiB / 40 GiB ESSD）**，已付费。这让"自建后端"从"每年多花 ¥840"变成"只用把已有的机器用起来"，选型因此改变。

### 11.1 一条硬约束：数据只能有一个源

小程序、App、未来的 Web 必须读写**同一份数据**。绝不能"小程序写云开发、App 写自己的库"——那样家庭共享立刻失效（这也是为什么下面的路线必须二选一，不能并存）。

### 11.2 两条路线

| | 路线 A：微信云开发 + HTTP 触发 | 路线 B：自建 Node + PostgreSQL |
| --- | --- | --- |
| 接口 | 给 5 个云函数各配 HTTP 触发路径 | Fastify 服务，`POST /api/{action}` |
| 数据 | 云开发数据库（MongoDB 兼容，**无公网连接串**） | 服务器上的 PostgreSQL |
| 小程序端 | **零改动**（继续 `wx.cloud.callFunction`） | 要改 `api.js` 为 `wx.request`，并配置 request 合法域名 |
| App 端 | 直接 HTTP | 直接 HTTP |
| 新增成本 | ¥0 | ¥0（服务器已有） |
| 锁定 | 绑小程序 AppID | 无 |
| 工作量 | 1 天 | 3~5 天（含数据迁移与部署） |

### 11.3 推荐：直接走 B

理由：

1. **服务器已经付过钱**，反对自建的最大理由（成本）消失。
2. 需求方明确把"数据与后续扩展"列为动机，路线 A 不解决锁定，只是把锁定往后推。
3. **备案本来就在关键路径上**（小程序也要备案），所以"需要域名 + 备案"不是新增成本。
4. 路线 A 之后仍要迁一次 B，等于把迁移风险做两遍。

**但保留一个安全阀**：先定契约（`/api/{action}` + JSON body），两条路对客户端完全一致。如果自建卡在域名或证书上，可以临时切回路线 A，App 不用改一行。

### 11.4 目标拓扑

```
   App (RN)              小程序
      │                    │
      │ HTTPS              │ HTTPS（wx.request，需配 request 合法域名）
      └────────┬───────────┘
               ▼
        Caddy :443  ← 自动申请/续期 Let's Encrypt 证书，反代到本机
               │ 127.0.0.1:3000
               ▼
        Node (Fastify)  ── repository 接口 ──▶  PostgreSQL 127.0.0.1:5432
               │
               └─ 静态文件/日志 → systemd journal
```

- 数据库**只监听 127.0.0.1**，永不暴露公网
- Caddy 负责 TLS 与 HTTP/2；比 nginx + certbot 少一半配置
- 不引入 Docker：2 GiB 内存上跑容器运行时 + 镜像的收益不抵开销（若将来要上云托管再容器化）

### 11.5 数据层收口：`repository` 接口

现在每个 handler 直接写 `db.collection('items').where(...).get()`，这是云数据库的形状。换成 PostgreSQL 就意味着改遍 5 个 `app.js`。所以在第 1 步就收口：

```js
// cloudfunctions/_shared/repository/index.js —— 只声明实际用到的方法
/**
 * @typedef {Object} Repository
 * @property {(name: string) => Collection} collection
 */

// Collection 需要实现（与现有 kit.js 的用法一一对应）：
//   where(cond) orderBy(field, dir) limit(n) skip(n)
//   .get() -> { data: Row[] }
//   .count() -> { total: number }
//   .add({ data }) -> { _id }
//   .update({ data }) -> { stats: { updated } }
//   .remove() -> { stats: { removed } }
//   command: { eq, neq, gt, gte, lt, lte, in, nin, inc }

// 三个实现，同一套接口：
//   clouddb.js   ← cloud.database()，现在生产用
//   postgres.js  ← 新，SQL 翻译（含 where 条件 → WHERE 子句）
//   fake-db.js   ← 已有，测试用（test-utils/fake-db.js）
```

**这不是过度设计**：`test-utils/fake-db.js` 已经是这个接口的第二个实现了，说明这层本来就存在，只是没被命名。命名之后，换数据库从"重写 5 个 handler"变成"新增一个 80 行的适配器"。

### 11.6 集合 → 表

| 云开发集合 | 表 | 说明 |
| --- | --- | --- |
| `families` | `families` | `settings` 用 `jsonb` |
| （新增） | `users` | 邮箱 + 密码 + 微信 openid |
| `members` | `members` | `openid` → `user_id` |
| `items` | `items` | `base_qty` 用 `numeric` |
| `events` | `events` | 索引：`(family_id, occurred_at desc)`、`(family_id, item_id, occurred_at)` |
| `pushLogs` | `push_logs` | 推送总开关关闭后可暂不迁 |

```sql
create table users (
  id            text primary key,
  email         text unique,              -- App 用户
  password_hash text,                     -- scrypt: 格式见 11.7
  wechat_openid text unique,              -- 小程序用户
  created_at    timestamptz not null default now(),
  check (email is not null or wechat_openid is not null)
);

create table members (
  id         text primary key,
  family_id  text not null references families(id) on delete cascade,
  user_id    text not null references users(id) on delete cascade,
  nick_name  text not null default '家人',
  role       text not null default 'member',   -- owner | member
  joined_at  timestamptz not null default now(),
  unique (family_id, user_id)
);

create table events (
  id          text primary key,
  family_id   text not null references families(id) on delete cascade,
  item_id     text not null references items(id) on delete cascade,
  type        text not null,                   -- purchase | stocktake | used_up
  qty         numeric not null default 0,
  amount      numeric,
  channel     text, brand text, spec text, note text,
  occurred_at timestamptz not null,
  created_by  text,
  created_at  timestamptz not null default now()
);
create index on events (family_id, occurred_at desc);
create index on events (family_id, item_id, occurred_at);
```

### 11.7 邮箱 + 密码的字段设计

- **哈希**：`scrypt`（Node 内置 `crypto.scryptSync`，零依赖）。存 `scrypt$N$r$p$salt$hash`（Base64），参数 `N=16384, r=8, p=1`，与常见库兼容。
- **绝不做**：明文、MD5、SHA1、可逆加密。
- **token**：登录成功签发 JWT（`HS256`，有效期 30 天），payload 只放 `sub: userId`。密钥放 systemd 环境变量文件（`/etc/refillpal/env`，权限 600），不进代码、不进 git。
- **登录接口**：`POST /api/auth/login`、`POST /api/auth/register` 不属于业务 handler，单独两条路由。
- **绑定**：小程序用户在「我的」页可补填邮箱 + 密码（给当前 `users` 行填 `email`/`password_hash`）；若该邮箱已属于另一个 `users` 行，**只提示不合并**（合并家庭超出范围）。

### 11.8 部署清单（针对 2C2G / Alibaba Cloud Linux）

Alibaba Cloud Linux 是 RHEL 系，用 `dnf`，不是 `apt`。

1. **加 2 GiB swap**（2 GiB 内存跑 Postgres + Node，不加 swap 容易被 OOM killer 干掉）
   ```bash
   fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
   echo '/swapfile none swap sw 0 0' >> /etc/fstab
   ```
2. **Node 20 LTS**：NodeSource 源或官方二进制解压到 `/opt/node`。
3. **PostgreSQL 16**：PGDG 源；`postgresql.conf` 按 2 GiB 调：`shared_buffers = 256MB`、`work_mem = 8MB`、`maintenance_work_mem = 64MB`、`max_connections = 30`。
4. **Caddy**：官方源；`Caddyfile` 只有四行：
   ```
   api.example.com {
     reverse_proxy 127.0.0.1:3000
   }
   ```
   证书自动申请、自动续期。
5. **systemd**：`refillpal-api.service`，`Restart=always`、`EnvironmentFile=/etc/refillpal/env`、`MemoryMax=512M`。
6. **阿里云安全组**：只放行 22/80/443；5432 与 3000 不对外。
7. **Node 内存上限**：`NODE_OPTIONS=--max-old-space-size=384`，防止把机器吃满。

### 11.9 备份

数据丢了就是一年的记录，**这一步不能省**：

```bash
# /etc/cron.d/refillpal-backup —— 每天 03:10
10 3 * * * postgres pg_dump -Fc refillpal > /var/backups/refillpal-$(date +\%F).dump
# 保留 30 天 + 每周同步到阿里云 OSS（ossutil）或下载到本地
```

恢复演练一次（`pg_restore` 到临时库）再算备份可用。

### 11.10 迁移步骤与回滚

| 步骤 | 动作 | 回滚方式 |
| --- | --- | --- |
| 1 | 云开发控制台导出全部 5 个集合为 JSON | 无副作用 |
| 2 | 写一次性导入脚本 `tools/import-clouddb.js`（可重复执行、幂等） | 清库重跑 |
| 3 | 小程序 `api.js` 切到 `wx.request`，两套后端并行验证 | 把 URL 切回 `wx.cloud.callFunction` |
| 4 | 观察 1 周，确认无数据差异后停用云函数 | 云函数保留 30 天不删 |

第 3 步要**并行验证**：同一份操作分别打两个后端，比对返回结构（复用第 2 步的契约测试）。

### 11.11 前置条件：域名与备案

**这是路线 B 唯一无法用代码加速的环节，也是当前的关键路径。** 需求方目前没有域名。

#### 两套备案，别搞混

| 备案类型 | 在哪提交 | 是否需要域名 | 阻塞什么 |
| --- | --- | --- | --- |
| **小程序备案** | 微信公众平台 | **不需要** | 小程序发布（不影响云开发、也不影响开发调试） |
| **域名 ICP 备案** | 阿里云 ICP 代备案系统 | 需要 | 小程序 `wx.request` 合法域名、App 的 HTTPS 接口、大陆服务器 80/443 |

也就是说：**现有小程序可以继续推进发布，不受域名阻塞**；域名备案只卡"自建后端"这一条线。

#### 域名 ICP 备案的实际门槛

来自[阿里云轻量应用服务器使用须知](https://help.aliyun.com/zh/simple-application-server/product-overview/usage-notes)：

- 大陆地域实例对外提供网站服务前**必须备案**；非大陆地域不需要
- 申请**备案服务号**要求实例购买时长 **≥ 3 个月**（含续费）；一个公网 IP 支持 5 个备案服务号
- **未备案域名不支持提前上线访问** —— 所以备案期间不要急着开 80/443
- 已有备案的域名接入阿里云，需在 30 天内完成接入手续

#### 步骤与时间

| 步骤 | 耗时 | 备注 |
| --- | --- | --- |
| 1. 注册域名 | 即时 | 选 `.com` 或 `.cn`；部分新后缀不在可备案列表里，别图便宜 |
| 2. 域名实名认证 | 1~3 个工作日 | 未实名无法提交备案 |
| 3. 申请备案服务号 | 即时 | 确认实例购买时长 ≥ 3 个月 |
| 4. 提交备案（主体 + 网站信息 + 人脸核验） | 半天 | 个人主体对**网站名称**有命名规范（避免"XX平台/XX服务"这类词），按系统提示填 |
| 5. 阿里云初审 | 1~2 个工作日 | 材料不合格会被打回 |
| 6. 管局审核 | 1~20 个工作日 | 各省不同，常见 5~15 |
| **合计** | **约 2~4 周** | 这是关键路径 |

#### 备案等待期可以并行做什么

备案不需要服务器、不需要域名，下面这些都能立刻开工：

| 时间 | 备案进度 | 并行推进 |
| --- | --- | --- |
| 今天 | 注册域名 | **第 1 步：抽包 + `repository` 收口**（纯本地，219 测试守着） |
| 第 1~3 天 | 实名 → 提交备案 | **第 2 步：契约显式化** |
| 第 1~3 周 | 管局审核中 | 写 Node/Fastify + PostgreSQL 服务；本地 + 局域网联调；**App 开发**（见下） |
| 备案通过 | — | 装 Caddy、解析域名、自动证书；小程序切 `wx.request`；App 切正式域名 |

#### 备案期间的联调与内测怎么办

| 场景 | 做法 | 是否需要域名 |
| --- | --- | --- |
| 日常开发 | App 指向电脑的 `http://192.168.x.x:3000`（同一局域网） | 不需要 |
| 家人内测（备案未下来） | 临时走**路线 A**：给云函数开 HTTP 触发，用腾讯的 `*.service.tcloudbase.com` 域名 | **不需要**（腾讯的域名） |
| 正式 | 自建 + 已备案域名 + Caddy | 需要 |

这正是 §11.3 里留的那个"安全阀"的用处：**契约不变，baseURL 可换**。备案没下来时 App 也能在家人手机上跑起来，不会干等两周。

## 12. 决策记录

### 12.1 已确认（2026-09-25）

| # | 决策 | 结论 |
| --- | --- | --- |
| 1 | `packages/refillpal-core` 是否引入构建步骤 | **不引入**，CommonJS + JSDoc |
| 2 | 是否暂不移动 `miniprogram/` | **同意**暂不移动，App 跑通后再统一 |
| 3 | 身份方案 | **邮箱 + 密码**（不做短信、不做 App 内微信登录、不做自助找回） |
| 4 | 是否接受两端各维护一套 UI | **接受**，选 RN + Expo（不迁 Taro） |
| 5 | 服务端部署 | **自建**：阿里云轻量（2C2G）+ Node/Fastify + PostgreSQL + Caddy |
| 6 | 提醒实现 | App 端**本地通知**，不做远程推送、不做 `.ics` |
| 7 | 域名 | **暂无**；先注册 + 备案（2~4 周），期间用局域网或路线 A 顶住 App 开发 |

### 12.2 仍需确认

1. ~~域名现状~~ **已确认：没有域名**。行动项：立即注册域名并提交 ICP 备案（约 2~4 周，是当前关键路径）。详见 §11.11。注意它**只阻塞自建后端**，不阻塞小程序发布（小程序备案是另一套流程，不需要域名）。
2. **数据库最终选型**：本文档按 PostgreSQL 写。如果更在意"零运维、备份就是拷文件"，也可以选 SQLite（WAL 模式，2 GiB 机器上更宽松），代价是将来上云托管/多实例会受限。
3. **小程序是否也切到自建后端**（路线 B 要求切换）。若不切，就必须走路线 A 的双后端并存——**不推荐**，会出现数据双源。


写文档时有意留了四个需要需求方拍板的点：

1. **是否接受 `packages/refillpal-core` 不引入构建步骤**（JS + JSDoc，无编译期类型检查）？
2. **是否同意暂不移动 `miniprogram/`**（等 App 跑通后再统一目录）？
3. **身份方案选「手机号 + 验证码」还是先「邮箱 + 密码」**？前者体验好但要配短信签名与模板审核。
4. **是否接受"小程序与 App 各维护一套 UI"**？如果不能接受，§3.3 建议改选 Taro，且要接受小程序 UI 重写一次。
