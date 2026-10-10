# WorkBuddy 开发上下文

> 本文件记录本项目使用腾讯 WorkBuddy 开发的真实对话上下文，
> 用于核验「麦当劳程序员创意开发大赛 × WorkBuddy 联动奖励」资格。

## 基本信息

| 项 | 内容 |
|---|---|
| 项目名称 | 麦麦点单决策台（mcd-order-lab） |
| 开发工具 | 腾讯 WorkBuddy（Windows 客户端，Agent 模式） |
| 开发起始 | 2026-10-09 |
| 本地工作目录 | `D:\AIWork\mcd-order-lab` |
| 运行时 | Node.js v22.22.2（WorkBuddy 托管版本） |
| 涉及 Skill | agent-browser（尝试用于渲染型页面抓取，因本机安装损坏改用托管 Python 直接取源码） |

## 对话上下文（按时间序）

### 1. 需求提出

> 用户：我看到 workbuddy 联合麦当劳发起了开发大赛，你去了解大赛详情，报名参赛，创建一个项目，制定开发工作项目规划。

附链接：`https://builderx.csdn.net/activity-site/m-code/pages`

### 2. 赛事信息核实

- 活动落地页为纯图片 SPA，传统抓取取不到文字。WorkBuddy 用托管 Python 拉取原始 HTML，提取到：
  - 页面标题：1024程序员节 · 麦当劳程序员创意开发大赛
  - 报名入口跳转：`https://github.com/M-China-Official/mcd-developer-innovation-challenge`
  - 页面内同时存在跳转 WorkBuddy 官网的热区
- 进一步读取官方仓库的 `README.md`、`activityGuidelines.md`、`CONTEST_DECLARATION.md`、`RANKING.md`，确认：
  - 活动时间 2026-10-09 10:30 — 2026-10-25 23:59
  - 排名机制为 GitHub Star 数，前 100 名进榜
  - 必需交付文件及命名要求
  - WorkBuddy 身份为**官方合作伙伴**（非联合主办）
- 读取 `M-China/mcd-mcp-server` README，确认线上共 33 个 Tool

### 3. 方向与策略判断

- 读取 `RANKING.md`（10-09 18:00 更新）：12 个项目进榜，第 1 名 13 Star；已有方向集中在省钱、早餐、派对、团餐、营养、积分
- 判断：排名由 Star 决定，评价主体是开发者；上榜项目多为 Markdown Skill 形态
- 结论：以「可运行的可视化应用」形成差异化

### 4. 用户决策（AskUserQuestion 确认）

| 决策项 | 用户选择 |
|---|---|
| 项目方向 | 麦麦点单决策台（可视化 Web 应用） |
| GitHub 授权 | 用户提供 PAT，由 WorkBuddy 全程代办 |
| MCP Token | 用户自行前往 https://open.mcd.cn/mcp 申请（进行中） |

### 5. WorkBuddy 执行产出

| 产出 | 说明 |
|---|---|
| `PLANNING.md` | 里程碑、WBS、排期、验收标准、风险登记 |
| `CONTEST_DECLARATION.md` | 用脚本从官方仓库**直接下载**，保证与原文逐字一致（1522 字节，SHA-256 `cd28101bcb29cc8fb24b372fe91ce6b42c4a1487a54e01f7ade0c8c6a84241b7`） |
| `src/mcp-client.js` | 零依赖 MCP Streamable HTTP 客户端：initialize / tools/list / tools/call，支持 JSON 与 SSE 双响应解析、会话维持、令牌桶限流 |
| `src/adapter.js` | 返回结构归一化层，隔离线上字段与算法层 |
| `src/planner.js` | 多目标组合搜索：预算/热量/蛋白质/品类完整度加权打分，含剪枝与去重 |
| `src/server.js` | HTTP 服务 + MCP 编排，每步失败降级并写入 warnings |
| `public/*` | 原生 HTML/CSS/JS 界面，内联 SVG 绘制预算条与营养环形图 |
| `scripts/probe.js` | 真实结构探测脚本，用于校准 adapter |
| `README.md` / `MCP_INTEGRATION.md` / `SKILL.md` / `mcp-config.example.json` / `.env.example` / `.gitignore` / `LICENSE` | 交付文档与配置 |

### 6. 验证记录

```
node --check  → 6 个 JS 文件全部通过
启动服务      → /api/health 200 {"ok":true,"tokenConfigured":false,"node":"v22.22.2"}
              → / 200 3464 bytes · /style.css 200 7709 bytes · /app.js 200 11002 bytes
```

### 7. 真实调用校准（2026-10-09）

用户申请到 MCP Token 后，WorkBuddy 完成配置并跑通全链路：

```
→ initialize        OK   serverInfo: mcd-mcp v1.0.0
→ tools/list        OK   线上 35 个工具（官方 README 列 33 个）
→ now-time-info     OK
→ list-nutrition-foods OK 160 条
→ query-nearby-stores OK  麦当劳杭州黄龙万科中心餐厅（3330254）
→ query-meals       OK   128 项菜单
→ query-store-coupons OK  0 张（当前账号无可用券）
→ calculate-price   OK   与本地估算 5/5 一致
```

校准中发现线上结构与官方 README 描述存在 5 处不一致，WorkBuddy 据此重写了
`src/adapter.js` 并修正了全部调用参数，坑点已完整记录进 `MCP_INTEGRATION.md`：

1. `query-meals` 的菜单名称/价格在 `data.meals` 字典里，分类归属在 `data.categories`，必须 join
2. `list-nutrition-foods` 的 `data` 是自定义表格字符串，非 JSON；热量字段名为 `energyKcal`
3. `calculate-price` 金额单位是「分」
4. 其 items 字段误用 `code` 代替 `productCode` 时会**静默返回 0 元**（success=true），已加 `productList` 非空校验防御
5. 到店自取（beType=1）传 `beCode` 会报 400

## 当前状态（如实标注）

| 环节 | 状态 |
|---|---|
| 项目骨架、文档、算法、界面 | ✅ 已完成 |
| MCP 真实调用验证与适配层校准 | ✅ **已完成**（2026-10-09，真实 Token，全链路跑通） |
| GitHub 仓库创建与代码推送 | ✅ **已完成**（2026-10-10，Public 仓库，21 个文件） |
| 报名 Issue 提交 | ✅ **已提交** [#200](https://github.com/M-China/mcd-developer-innovation-challenge/issues/200) |
| 官方报名核验回复 | ⏳ 等待自动回复 |
