# 🍔 麦麦点单决策台 `mcd-order-lab`

> 基于**麦当劳 MCP 实时数据**的多目标点单决策工具。
> 输入「预算 / 人数 / 热量上限 / 口味偏好」，自动组合套餐、比对营养、校正价格，输出可直接下单的方案。
>
> 1024程序员节 · 麦当劳程序员创意开发大赛 参赛作品

---

## 为什么做这个

点麦当劳时真正麻烦的不是"选什么"，而是三件事同时算：**花多少钱、吃进多少热量、几个人怎么搭配**。
麦当劳 MCP 已经把菜单、营养、优惠券、算价都开放出来了，但这些数据是分散的——本项目把它们编排成一条完整决策链路。

**与其他参赛项目的区别**：榜单上多数作品是 Markdown 形态的 Skill 定义，本项目是一个**能真正跑起来的可视化应用**——有界面、有图表、有真实的端到端调用。

---

## 特性

- **多目标决策**：预算、人数、人均热量上限、人均蛋白质下限、忌口、偏好，同时求解
- **价格以官方为准**：本地只做组合搜索与排序，**最终金额一律取自 MCP `calculate-price`**，不自造价格规则
- **可视化对比**：预算消耗条、人均营养环形图、逐项拆解与决策理由
- **零依赖**：只用 Node 内置模块，`git clone` 后直接 `node src/server.js`，**不需要 `npm install`**
- **安全默认**：Token 只存在于服务端，浏览器永远拿不到；**默认不下单**，需显式二次确认
- **诚实降级**：任何一步 MCP 调用失败都会在页面上明确提示，不静默返回看似正常的结果
- **已用真实 Token 完成线上校准**：对接中踩到的 5 个真实坑点全部记录并防御，见 [`MCP_INTEGRATION.md`](./MCP_INTEGRATION.md)

---

## 实跑验证（2026-10-09，真实 Token）

门店：麦当劳杭州黄龙万科中心餐厅（storeCode `3330254`） · 菜单 128 项 · 营养 160 条

输入「2 人 · 预算 ¥80 · 人均热量 ≤ 900 kcal · 蛋白质 ≥ 20g」，输出：

| 方案 | 组合 | 本地估算 | 官方算价 | 人均热量 | 人均蛋白质 |
|---|---|---:|---:|---:|---:|
| 1 | 双层深海鳕鱼堡 ×2 + 圆筒冰淇淋 ×2 | ¥58.00 | **¥58.00** | 578 kcal | 30 g |
| 2 | 双层深海鳕鱼堡 ×2 + 新地 ×2 | ¥72.00 | **¥72.00** | 767 kcal | 33 g |
| 3 | 巨无霸 ×2 + 圆筒冰淇淋 ×2 | ¥61.00 | **¥61.00** | 606 kcal | 29 g |
| 4 | 双层吉士汉堡 ×2 + 圆筒冰淇淋 ×2 | ¥56.00 | **¥56.00** | 522 kcal | 29 g |
| 5 | 芝士安格斯厚牛堡 ×2 + 韩式烟熏芝士风味酱 ×2 | ¥69.00 | **¥69.00** | 696 kcal | 32 g |

**本地估算与官方 `calculate-price` 结果 5/5 完全一致。** 界面仍以官方算价为准显示。

---

## 快速开始

### 1. 申请 MCP Token

访问 [https://open.mcd.cn/mcp](https://open.mcd.cn/mcp) → 右上角【登录】（手机号验证）→ 【控制台】→ 【激活】→ 同意协议 → 复制 Token。

### 2. 配置

```bash
git clone https://github.com/liuqingping01/mcd-order-lab.git
cd mcd-order-lab
cp .env.example .env
# 编辑 .env，填入 MCD_MCP_TOKEN=<你的 Token>
```

### 3. 运行

```bash
node src/server.js
# 打开 http://localhost:5173
```

要求：Node.js ≥ 18（用到内置 `fetch`）。

---

## 使用示例

| 输入 | 输出 |
|---|---|
| 2 人 · 预算 ¥80 · 人均热量 ≤ 800 千卡 · 忌口：辣 | 3~5 个方案，每个含：组合清单、总价、人均热量与蛋白质、预算消耗条、营养环形图、决策理由 |

界面参数说明：

| 参数 | 说明 |
|---|---|
| 城市 / 位置关键词 | 对应 `query-nearby-stores` 的 `city` 与 `keyword`，两者在该接口中均必填 |
| 人数 | 决定每项的份数与人均指标 |
| 总预算（元） | 超过预算的组合会被剪枝 |
| 人均热量上限 | 千卡，`0` 表示不限 |
| 人均蛋白质下限 | 克，`0` 表示不限 |
| 忌口 / 偏好关键词 | 逗号分隔，按餐品名称与标签匹配 |

---

## 目录结构

```
mcd-order-lab/
├── README.md                  # 本文件
├── CONTEST_DECLARATION.md      # 参赛声明（官方原文，不可修改）
├── MCP_INTEGRATION.md          # MCP 集成说明：Tool 清单、调用流程、业务价值
├── PLANNING.md                 # 开发工作项目规划
├── mcp-config.example.json     # MCP 配置示例（仅环境变量占位符）
├── workbuddy.md                # WorkBuddy 开发上下文
├── SKILL.md                    # WorkBuddy Skill 版本定义
├── src/
│   ├── server.js               # HTTP 服务 + MCP 编排
│   ├── mcp-client.js           # MCP Streamable HTTP 客户端（零依赖）
│   ├── planner.js              # 多目标组合搜索与打分
│   ├── adapter.js              # 返回结构归一化
│   └── env.js                  # 极简 .env 加载
├── public/                     # 前端（原生 HTML/CSS/JS）
│   ├── index.html
│   ├── style.css
│   └── app.js
└── scripts/
    └── probe.js                # 真实结构探测（校准 adapter 用）
```

---

## 使用的 MCP Tools

`now-time-info` · `query-nearby-stores` · `query-meals` · `list-nutrition-foods` · `query-store-coupons` · `calculate-price` · `create-order`（需二次确认）

完整说明见 [`MCP_INTEGRATION.md`](./MCP_INTEGRATION.md)。

---

## 校准真实数据结构（开发者）

MCP 各 Tool 的返回字段以线上实际响应为准。拿到 Token 后运行：

```bash
node scripts/probe.js
```

会输出 `examples/tools.json`（线上工具定义）与 `examples/<tool>.real.json`（真实响应样例，已 gitignore），据此修正 `src/adapter.js` 即可，算法层与前端无需改动。

---

## 开发规划

见 [`PLANNING.md`](./PLANNING.md)：里程碑、WBS、验收标准、风险登记。

---

## 声明

本作品为参赛项目，由参赛者独立开发，**非麦当劳官方产品**。
项目输出仅供参考，不构成医疗、营养或其他专业建议；餐品信息、价格及供应状态以麦当劳官方渠道的实时结果为准。

## 许可

代码部分采用 [MIT](./LICENSE) 许可。麦当劳相关商标、餐品数据与 MCP 服务归权利方所有。
