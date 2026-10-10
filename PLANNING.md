# 麦麦点单决策台（mcd-order-lab）开发工作项目规划

> 赛事：1024程序员节 · 麦当劳程序员创意开发大赛
> 主办：金拱门（中国）有限公司 ｜ 官方合作伙伴：腾讯 WorkBuddy
> 官方规则源：`https://github.com/M-China-Official/mcd-developer-innovation-challenge`
> 规划版本：v1 ｜ 制定日期：2026-10-09

---

## 一、项目定位

### 1.1 一句话定义

**麦麦点单决策台** —— 基于麦当劳 MCP 实时数据的多目标点单决策工具：输入「预算 / 人数 / 热量上限 / 口味偏好」，自动组合套餐、叠加优惠券、比对营养，输出可直接下单的方案。

### 1.2 为什么是这个方向

| 判据 | 分析 |
|---|---|
| 榜单空缺 | 现有进榜项目集中在省钱、营养、团餐、派对；「多目标决策 + 可视化」尚未出现 |
| 排名机制 | 排名 **100% 由 GitHub Star 数决定**，评价主体是开发者，不是算法评委 |
| 差异化 | 上榜项目基本是纯 Markdown Skill。**能真正跑起来、有界面的工具，Star 吸引力显著更高** |
| 能力匹配 | 项目负责人为职业设计师，视觉呈现与交互完成度是可控优势 |
| 合规 | 真实调用 `https://mcp.mcd.cn`，满足规则「参赛项目须真实使用麦当劳 MCP 能力」 |

### 1.3 目标用户

- 想控制预算又不想凑单算半天的普通消费者
- 控卡/健身人群（热量与蛋白质双目标）
- 需要给多人（同事、家庭）一次性点餐的人
- 开发者群体本身（决定是否 Star）

---

## 二、技术方案

### 2.1 架构

```
浏览器 (public/)
   │  HTTP
   ▼
Node 本地服务 (src/server.js)          ← Token 只在服务端，绝不暴露给浏览器
   │  MCP Streamable HTTP / JSON-RPC 2.0
   ▼
麦当劳 MCP Server  https://mcp.mcd.cn
```

### 2.2 关键决策

| 决策项 | 选择 | 理由 |
|---|---|---|
| 第三方依赖 | **零依赖**，全部用 Node 内置模块 | 评审者 clone 后无需 `npm install`，降低体验门槛 |
| 前端框架 | 原生 HTML/CSS/JS | 同上；且便于直接以静态页分发 |
| 图表 | 内联 SVG 手绘 | 不引 CDN（国内可用性 + 离线可跑），体积可控 |
| Token 处理 | 仅服务端读取环境变量 `MCD_MCP_TOKEN` | 满足「配置文件仅使用环境变量占位符」的信息安全声明 |
| 下单动作 | 默认只生成方案，**不自动下单** | 避免误操作真实订单；下单需用户二次确认 |

### 2.3 计划调用的 MCP Tools（33 个中的 10 个）

| Tool | 用途 |
|---|---|
| `now-time-info` | 校准当前时间，判断早餐/正餐/夜宵时段 |
| `query-nearby-stores` / `delivery-query-stores` | 定位门店 |
| `query-meals` | 拉取当前门店可售菜单 |
| `query-meal-detail` | 套餐组成与可替换项 |
| `list-nutrition-foods` | 营养数据（能量/蛋白质/脂肪/碳水/钠） |
| `query-store-coupons` / `available-coupons` | 可用优惠券 |
| `calculate-price` | 精确算价（金额/配送费/优惠/应付） |
| `create-order` | 生成下单链接（需用户确认） |

---

## 三、里程碑与排期

赛事窗口：**2026-10-09 10:30 → 2026-10-25 23:59**（定榜 10-26 00:00），共 16 天。

| 阶段 | 日期 | 交付物 | 完成标准 |
|---|---|:---|:---|
| **M0 立项** | 10-09 | PLANNING.md、项目骨架、必需文档 | ✅ 规则研读完毕，目录与必需文件就位 |
| **M1 打通** | 10-10 ~ 10-11 | `src/mcp-client.js` | ✅ **已于 10-09 提前完成**：Token 到位，线上 35 个工具，全链路跑通，适配层已按真实结构重写 |
| **M2 引擎** | 10-12 ~ 10-14 | `src/planner.js` | ✅ 输入约束可产出 3~5 个候选组合，算价与营养可回溯校验 |
| **M3 界面** | 10-14 ~ 10-16 | `public/*` | ✅ 端到端可跑，可视化卡片/图表渲染正确 |
| **M4 交付** | 10-16 ~ 10-18 | README、MCP_INTEGRATION、截图、WorkBuddy Skill | ✅ 仓库 Public，报名 Issue 提交并收到成功通知 |
| **M5 运营** | 10-18 ~ 10-25 | 推广、反馈修复、`workbuddy.md` | ✅ 进入 RANKING.md 前 100 |
| **定榜** | 10-26 00:00 | — | 最终排名锁定 |

### 关键路径

```
MCP Token（外部依赖，需本人手机号申请）
   └─> M1 真实调用验证
         └─> M2 数据结构修正 + 引擎
               └─> M3 UI
                     └─> M4 报名
```

**最大风险在 M1**：MCP Token 未到位则后续全部阻塞。这是唯一不可由我方内部推进的依赖。

---

## 四、任务分解（WBS）

### M0 立项（10-09）
- [x] 研读官方 README.md 与 activityGuidelines.md
- [x] 分析 RANKING.md 榜单，确认差异化方向
- [x] 建立工作目录与任务清单
- [ ] 产出 PLANNING.md

### M1 MCP 打通（10-10 ~ 10-11）— **已于 10-09 提前完成**
- [x] 实现 Streamable HTTP JSON-RPC 客户端（`initialize` → `tools/list` → `tools/call`）
- [x] 处理 `Authorization: Bearer`、401/429 错误码
- [x] 实现 600 次/分钟限流的客户端节流（令牌桶）
- [x] 用真实 Token 跑通全部计划 Tool，落盘真实响应样例到 `examples/`
- [x] 按真实结构重写 `src/adapter.js`（菜单 join、营养表格解析、金额单位分、`productCode` 字段校验）

### M2 决策引擎（10-12 ~ 10-14）
- [ ] 约束建模：预算上限、人数、总热量上限、人均热量、忌口标签
- [ ] 组合搜索：枚举套餐/单品组合，剪枝到 top-N
- [ ] 优惠券叠加计算（以 `calculate-price` 结果为准，不自造价格逻辑）
- [ ] 打分函数：价格 / 热量达标度 / 蛋白质 / 丰盛度，加权排序
- [ ] 输出结构化方案对象（含每个决策的可解释字段）

### M3 可视化 UI（10-14 ~ 10-16）
- [ ] 参数输入区（门店、预算、人数、热量、偏好）
- [ ] 方案对比卡片 × 3~5
- [ ] 价格瀑布图（原价 → 各优惠 → 应付）
- [ ] 营养环形图（能量/蛋白/脂肪/碳水占比 vs 目标）
- [ ] 决策解释面板（为什么推荐这个）
- [ ] 下单确认二次弹窗

### M4 交付与报名（10-16 ~ 10-18）
- [ ] README.md（含截图、安装、快速开始）
- [ ] CONTEST_DECLARATION.md（**官方原文，一字不改**）
- [ ] MCP_INTEGRATION.md（Tool 清单、调用流程图、业务价值）
- [ ] mcp-config.example.json（仅环境变量占位符）
- [ ] workbuddy.md（WorkBuddy 对话上下文，用于 3000 积分专项奖励）
- [ ] SKILL.md（WorkBuddy Skill 版本）
- [ ] 建 Public 仓库、推代码、发报名 Issue

### M5 运营（10-18 ~ 10-25）
- [ ] 小红书 / 开发者社区投放（账号：艺次方^）
- [ ] 根据 Issue 与反馈迭代
- [ ] 每日跟踪 RANKING.md

---

## 五、验收标准

| 类别 | 标准 |
|---|---|
| 合规 | 5 个必需文件齐全且命名正确；CONTEST_DECLARATION.md 与官方原文逐字一致；配置仅环境变量占位符 |
| 功能 | 真实调用 MCP，非 mock；算价与 MCP `calculate-price` 结果一致 |
| 可运行 | `git clone` → 配 Token → `node src/server.js` → 浏览器可用，全程零 `npm install` |
| 文档 | README 3 分钟内可读懂并完成首次运行 |
| 差异化 | 首屏截图能一眼看出与其他参赛项目的区别 |

---

## 六、风险登记

| 风险 | 等级 | 应对 |
|---|---|---|
| ~~MCP Token 申请延迟~~ | ~~高~~ | ✅ 已解除：10-09 拿到 Token 并完成全链路校准 |
| GitHub PAT 未提供 | **高** | 当前唯一阻塞项；仓库创建与报名 Issue 均依赖它 |
| 真实返回结构与文档不一致 | 中 | M1 落盘真实样例，M2 以真实数据为准重构 |
| 自动下单造成真实交易 | 高 | 默认不调用 `create-order`，需显式二次确认 |
| Token 泄露 | 高 | `.gitignore` 排除 `.env`；提交前全局扫描真实 Token 字符串 |
| 内容合规（规则明令禁止比价/贬损品牌） | 中 | 文案只做「同品牌内方案对比」，不与其他品牌比较 |
| Star 数不足 | 中 | 预留 7 天运营窗口，多社区投放 |

---

## 七、待办（需用户执行）

| # | 事项 | 说明 | 状态 |
|:--:|---|---|:--:|
| 1 | 申请麦当劳 MCP Token | https://open.mcd.cn/mcp → 登录（手机号）→ 控制台 → 激活 → 同意协议 → 复制 | ✅ 已完成（10-09） |
| 2 | 提供 GitHub PAT | classic token + `public_repo`（fine-grained 不支持向非成员公开仓库贡献，无法发报名 Issue） | ✅ 已完成（10-10） |

---

## 八、报名进度（2026-10-10）

| 项 | 状态 |
|---|---|
| GitHub 账号 | `liuqingping01` |
| 仓库 | https://github.com/liuqingping01/mcd-order-lab （Public，21 个文件） |
| 必需文件核验 | README.md / CONTEST_DECLARATION.md / MCP_INTEGRATION.md / mcp-config.example.json / workbuddy.md —— 5/5 齐备 |
| 敏感文件扫描 | `.env`、`examples/*.real.json` 均未入库 ✅ |
| 报名 Issue | https://github.com/M-China/mcd-developer-innovation-challenge/issues/200 |
| 官方核验回复 | ⏳ 等待中（官方称报名成功会在 Issue 下自动回复） |

**注意**：`git push` 在受限环境中会被中断，改用 GitHub Git Data API
（blobs → tree → commit → update-ref）完成推送，产生单个规范 commit。
