# 补货小管家（RefillPal）实施计划

- 日期：2026-09-25
- 依据：`docs/plans/2026-09-25-refillpal-design.md`
- 目标：交付可导入微信开发者工具、填好环境 ID 即可运行的一期完整项目

---

## 0. 验证条件与策略（先说清楚能做到什么）

本机**未安装微信开发者工具**，因此验证分两层：

| 层 | 谁来做 | 手段 | 覆盖 |
| --- | --- | --- | --- |
| 自动验证 | 我，每个里程碑 | `node --test` 单测 + JSON 可解析性校验 + 文件结构校验 | 全部算法与数据整形逻辑、配置正确性 |
| 真机验证 | 你，在开发者工具 | `docs/deploy.md` 验收清单 | UI、交互、云函数联通、订阅消息到达 |

为了让第一层尽可能覆盖真实的 UI 逻辑，代码结构强制两条约束：

1. **所有视图形计算（排序、文案、颜色分级、分组、汇总）放进 `miniprogram/utils/viewmodel.js` 的纯函数**，Page 只做"取数据 → 调纯函数 → setData"。这样首页长什么样我可以离线断言。
2. **`utils/api.js` 提供与云函数同构的本地 Mock 适配器**（`config.js` 里 `USE_MOCK` 开关）。好处有两个：我没有云环境也能跑通页面逻辑；你开通云开发之前，在开发者工具里就能先点着看 UI。

---

## 1. 里程碑总览

| 里程碑 | 内容 | 依赖 | 可否自动验证 |
| --- | --- | --- | --- |
| M0 | 工程骨架与约定 | — | 是 |
| M1 | 核心算法 + 单测（最高风险，先做） | M0 | 是，完全覆盖 |
| M2 | 云端数据层：云函数 + Mock 适配器 | M1 | 是 |
| M3 | 前端主干：框架 + 待补货首页 + 记一笔 | M2 | 部分 |
| M4 | 前端其余页面：物品 / 详情 / 统计 / 我的 | M3 | 部分 |
| M5 | 提醒与分享：notify + 订阅额度 + 清单分享 | M4 | 是（推送判定逻辑） |
| M6 | 部署手册 + 验收清单 + 收尾 | M5 | 是（结构校验） |

顺序理由：M1 是唯一"错了就全盘重做"的部分，先写、先测；UI 可以改，算法不能返工。

---

## M0 · 工程骨架

**产出**

```
project.config.json         # appid 占位 "wxYOUR_APPID"
project.private.config.json # .gitignore
miniprogram/{app.js,app.json,app.wxss,config.js,sitemap.json}
miniprogram/utils/{api.js,format.js,cache.js,constants.js,viewmodel.js}
cloudfunctions/_shared/{core.js,package.json}
scripts/sync-shared.js
.gitignore
```

**关键约定**

- 云函数统一入参 `{ action, payload }`，出参 `{ ok, data }` / `{ ok: false, code, message }`。
- `config.js` 集中三处占位：`ENV_ID`、`SUBSCRIBE_TEMPLATE_ID`、`USE_MOCK = true`。
- `sync-shared.js` 把 `_shared/core.js` 复制到各云函数 `shared/core.js`（避开 npm `file:` 依赖的打包坑）。

**验收标准**

1. `node scripts/sync-shared.js` 退出码 0，且每个云函数目录下出现内容一致的 `shared/core.js`。
2. 所有 `.json` 文件 `JSON.parse` 通过（脚本 `scripts/check-json.js`）。
3. `app.json` 的 pages 列表与磁盘上实际目录逐一对应，无缺失无多余。

---

## M1 · 核心算法与单测（本项目的心脏）

**产出**：`cloudfunctions/_shared/core.js` + `cloudfunctions/_shared/__tests__/core.test.js`

**实现的纯函数**

| 函数 | 职责 |
| --- | --- |
| `estimateRate(events, item)` | 冷启动 / EWMA 骨架 / 盘点校准 三段融合，返回 `{ rate, confidence, sampleCount }` |
| `settleStock(item, now, rate)` | 锚点法结算当前库存 |
| `applyEvent(item, event, now)` | 写流水前结算 + 更新锚点，返回新 item（不落库，纯函数） |
| `predict(item, now)` | 返回 `{ stock, remainingDays, emptyAt, level }`，`level ∈ urgent/warn/ok` |
| `buildRefillList(items, now, remindDays)` | 待补货排序（逾期置顶 → 剩余天数升序） |
| `confidenceLabel(n)` | 「估算中 / 粗略估计 / 较准」文案 |
| `summarizeMonthly(events, month)` | 月度开支、分类占比、环比 |

**单测必须覆盖的边界**

- 冷启动：只有 `initEstimateDays`、无购买历史
- 单周期、多周期 EWMA；验证**近期样本权重更大**（构造新旧差异明显的序列，断言 rate 偏向新值）
- 异常值剔除：同一天两笔购买（间隔 0）、间隔 < 1 天
- 盘点闭合：两次盘点 + 期间购买；盘点后 rate 明显修正
- 锚点结算：跨月、rate 变更前后、库存不为负
- `remindDays` 边界：剩余天数恰好等于 3、恰好 2.9、库存 0、库存负向（逾期）
- 规格变更检测：中途 spec 变化时给出提示标记

**验收标准**

1. `node --test cloudfunctions/_shared/` 全绿。
2. 每个上表函数至少 1 个测试；边界清单每一项有对应用例（不允许只测 happy path）。
3. 断言的是**具体数值**（如 `assert.ok(Math.abs(rate - 0.5) < 1e-6)`），不是"结果不为空"这类空断言。

---

## M2 · 云端数据层

**产出**：云函数 `family / item / purchase / dashboard / stats` + `utils/api.js`（含 Mock 适配器）

**要点**

- 每个云函数第一步 `resolveFamily(openid)`：查 `members` 取 `familyId`，查不到返回 `NO_FAMILY`，前端据此跳引导页。
- 购买 / 盘点用**数据库事务**同时写 `events` 与更新 `items`；并发增量用原子 `inc`。
- `dashboard` 一次聚合返回首页全部数据，避免小程序端多次请求。
- 云函数内调用 `_shared/core.js` 计算，**不在小程序端算库存**（防止客户端时间被篡改）。

**验收标准**

1. `node --test` 中新增"云函数处理函数"测试：把每个 `main` 的 `action` 分支抽成可注入假数据库的纯处理器（`handlers.js`），断言
   - 越权：openid 不属于 familyId → 返回 `FORBIDDEN`
   - 无家庭：返回 `NO_FAMILY`
   - 记一笔后 `items.anchorQty` 与 `events` 同时写入
   - 撤销后库存回到记之前
2. Mock 适配器与云函数**入参出参结构一致**，由同一份测试断言两边返回同样的形状。

---

## M3 · 前端主干：待补货首页 + 记一笔

**产出**：`pages/home/*`、`components/{item-card,quick-grid,subscribe-panel,empty-state}/*`

**要点**

- 首页三段：该买了（紧急度卡片）/ 还够用列表 / 右下「记一笔」。
- 记一笔：半屏宫格 → 点一下 +1 → 可选金额渠道 → Toast + 5 秒撤销队列。
- 离线：展示 `cache.js` 缓存的 dashboard，顶部标注「离线数据，可能不是最新」。
- 颜色分级、文案、排序全部来自 `viewmodel.js` 纯函数。

**验收标准**

1. `node --test` 覆盖 `viewmodel.js`：给定固定 items/now，断言首页卡片顺序、文案（「预计 2 天后用完」）、颜色分级完全符合预期字符串。
2. 撤销队列逻辑单测：5 秒内撤销 → 不落库；超时 → 落库。
3. 结构校验：`app.json` tabBar 四项与页面路径一致；所有 `.wxml` 引用的组件路径存在。
4. 你在开发者工具里（`USE_MOCK = true`）能完成：看到待补货列表 → 点记一笔 → 数量 +1 → 列表预算天数变化。

---

## M4 · 前端其余页面

**产出**：`pages/{items,item-detail,item-edit,stats,me,family,settings}/*`

**要点**

- 物品列表：分类分组 + 搜索 + 新建。
- 详情：库存 / 预计用完日 / 置信度 + 消耗曲线（原生 canvas 或轻量 svg 绘制）+ 历史时间轴 + 「盘点」「用完了」。
- 统计：月度开支、分类占比、消耗排行。
- 我的：成员与邀请码、提醒设置、分类管理、订阅额度、数据导出。
- 长辈友好：正文 ≥ 28rpx，主按钮 ≥ 88rpx。

**验收标准**

1. `viewmodel.js` 新增函数有单测：`groupByCategory`、`buildHistoryTimeline`、`buildMonthlyChart` 的数值与分组正确。
2. 结构校验：所有页面 JSON 存在、`usingComponents` 路径可达、无未定义组件。
3. 你在开发者工具里能走通：新建物品 → 记两笔 → 盘点 → 详情页看到预测变化。

---

## M5 · 提醒与分享

**产出**：`cloudfunctions/notify/*`（含 `config.json` 定时触发器）、订阅额度逻辑、清单分享

**要点**

- `notify`：查所有家庭 → 算待补货 → 生成一条汇总消息 → 逐成员发送 → 写 `pushLogs`（`familyId + date` 唯一索引保证幂等）。
- 错误码分类：额度耗尽跳过、`43101`（拒收）标记该成员停推、其他重试一次。
- 订阅额度：打开小程序时 `remaining < 3` 引导续订一次，授权 +1，发送成功 −1。
- 分享：待补货页生成清单海报 + `onShareAppMessage` 小程序卡片。

**验收标准**

1. `node --test` 覆盖 `buildPushPayload(family, refillList)`：给定待补货列表，断言汇总文案、物品条数截断（微信 thing 字段长度限制）、空列表不推送。
2. 幂等断言：同一天对同一家庭调用两次 `notify`，只产生一条 `pushLogs`、只发一次。
3. `notify/config.json` 的 cron 为合法 7 位格式，时区按 UTC+8 校验。
4. 部署手册给出申请 `templateId` 的具体步骤与字段映射（thing/time/number 各自的字符上限）。

---

## M6 · 部署手册与收尾

**产出**：`docs/deploy.md`、`README.md`、最终 `git commit`

**deploy.md 内容**

1. 注册小程序 → 拿 AppID → 填 `project.config.json`
2. 开发者工具开通云开发 → 拿环境 ID → 填 `miniprogram/config.js`
3. 创建 6 个集合 + 按设计文档 §2.3 建索引（给出可直接照抄的字段顺序表）
4. 申请订阅消息模板 → 填 `SUBSCRIBE_TEMPLATE_ID`
5. 右键上传 6 个云函数 → 确认 `notify` 定时触发器已生效
6. 把 `USE_MOCK` 改为 `false`
7. 真机验收清单（12 条，含越权、离线、额度耗尽、盘点异常）

**验收标准**

1. 按手册从零走一遍，每一步都有可判断成功的标志，不出现"自行体会"。
2. 全部 `node --test` 通过；`node scripts/check-json.js` 通过。
3. `git log` 呈现清晰的里程碑式提交历史。

---

## 2. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 估算算法在家里真实数据上不准 | 提醒失效，信任崩塌 | M1 先做且充分单测；UI 如实展示置信度；提供盘点作为校准手段 |
| 订阅消息额度耗尽导致漏推 | 核心功能失效 | 打开即续订、额度 < 3 提示、推送前检查额度 |
| 没有云环境导致 UI 无法预览 | 交付物无法验收 | `USE_MOCK` 本地模式，先看 UI 后接云 |
| 微信开发者工具上传 `file:` 依赖失败 | 云函数跑不起来 | 用 `sync-shared.js` 复制，绝不用 npm 本地依赖 |
| 家人共同编辑产生并发写 | 丢笔、库存错乱 | 事务 + 原子 `inc`；前端按钮 loading 锁 |

---

## 3. 明确不在本计划内

- 二期：账号体系、多家庭、上架审核材料、隐私协议
- 一句话自然语言录入、扫条码入库
- 长期订阅消息、服务号 / 短信 / 邮件
- 比价、存放位置、保质期管理
