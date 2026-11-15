# 补货小管家 · 多端（Android / iOS）设计

- 日期：2026-09-25
- 状态：**待确认**（本文档是提案，尚未开始实施）
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

推荐：**手机号 + 验证码**（用户在小程序或 App 里各自输入一次手机号验证，两边 `identityKey` 相同即视为同一人）。

- 短信服务用腾讯云短信（个人可开通），注意需要**签名与模板审核**。
- 备选降级：先用「邮箱 + 密码」把链路跑通，之后再换短信 —— 接口形状一样，切换成本低。

### 5.3 数据迁移

| 集合 | 变更 | 迁移动作 |
| --- | --- | --- |
| `members` | `openid` → `identityKey`（形如 `wechat:oXXX` / `phone:+8613800138000`），唯一索引改建在 `identityKey` 上 | 存量数据脚本：`identityKey = "wechat:" + openid` |
| `families` | 新增 `calendarToken`（若将来做 ICS）、`ownerUserId` | 可空，无需回填 |
| 其余集合 | 不变 | — |

迁移必须**可回滚**：先双写 `openid` 与 `identityKey`，观察一个版本后再删 `openid`。

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
| **1. 抽包** | `_shared/core.js` → `packages/refillpal-core/src/algorithms/`；`viewmodel/format/constants/undo` → `src/view/`；`sync-shared.js` 改为「把包产物拷进 cloudfunctions 与 miniprogram」 | `npm test` 仍 219 全绿；`npm run check` 通过；小程序与云函数行为零变化 |
| **2. 契约显式化** | `src/contract/` 定义每个 action 的入参出参形状；把现有「mock 与云函数结构一致」的测试升级为「三端一致」 | 新增契约测试；任何一端返回值结构漂移都会失败 |
| **3. 身份与 HTTP** | `openid` → `identityKey`；`members` 双写迁移；新增 HTTP 入口；手机号验证码登录 | 小程序端行为不变；HTTP 入口与小程序入口对同一 action 返回相同结构；越权测试两套都过 |
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

## 11. 待确认的决策点

写文档时有意留了四个需要需求方拍板的点：

1. **是否接受 `packages/refillpal-core` 不引入构建步骤**（JS + JSDoc，无编译期类型检查）？
2. **是否同意暂不移动 `miniprogram/`**（等 App 跑通后再统一目录）？
3. **身份方案选「手机号 + 验证码」还是先「邮箱 + 密码」**？前者体验好但要配短信签名与模板审核。
4. **是否接受"小程序与 App 各维护一套 UI"**？如果不能接受，§3.3 建议改选 Taro，且要接受小程序 UI 重写一次。
