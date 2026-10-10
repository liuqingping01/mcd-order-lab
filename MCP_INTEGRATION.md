# MCP 集成说明

> 本文件说明本项目实际使用的麦当劳 MCP Server、Tool、调用流程与业务价值。
> **所有内容已于 2026-10-09 用真实 Token 完成线上校准**，标注 ⚠️ 处为与官方 README 文字描述不一致、以线上实际行为为准的要点。

## 1. 接入配置

| 项 | 值 |
|---|---|
| MCP Server | 麦当劳中国官方 MCP Server（线上 `serverInfo`: `mcd-mcp` v1.0.0） |
| 接入地址 | `https://mcp.mcd.cn` |
| 传输协议 | Streamable HTTP |
| 鉴权 | `Authorization: Bearer ${MCD_MCP_TOKEN}` |
| 限流 | 600 次/分钟（客户端侧保守设为 300 次/分钟，内置令牌桶） |
| 线上工具数 | **35 个**（官方 README 列表为 33 个，以线上 `tools/list` 为准） |

配置示例见 [`mcp-config.example.json`](./mcp-config.example.json)，**仅含环境变量占位符，不含任何真实凭据**。

### 关键业务参数（决定调用成败）

| 参数 | 取值 | 规则 |
|---|---|---|
| `beType` | 1=到店自取，2=麦乐送到家，5=得来速，6=企业团餐 | 必传 |
| `orderType` | 1=到店（含自取+得来速），2=外送（含麦乐送+团餐） | 与 beType 配对 |
| `beCode` | 与 storeCode 配对的业务编码 | **到店自取(beType=1)不传，传了会报错**；其余场景必传 |
| `storeCode` | 门店编码（纯数字） | 必填 |

本项目走**到店自取（beType=1 / orderType=1）**链路：无需用户配置配送地址，也不触碰地址簿，是隐私面最小、依赖最少的一条路径。

## 2. 实际使用的 Tools

| # | Tool | 作用 | 状态 |
|:--:|---|---|:--:|
| 1 | `now-time-info` | 校准服务端时间 | ✅ 已接通 |
| 2 | `query-nearby-stores` | 按城市+关键词查门店：`{beType, city, keyword, searchType}` | ✅ 已接通 |
| 3 | `query-meals` | 取门店实时菜单：`{storeCode, beType, orderType}` | ✅ 已接通 |
| 4 | `list-nutrition-foods` | 160 条餐品营养数据 | ✅ 已接通 |
| 5 | `query-store-coupons` | 门店可用优惠券 | ✅ 已接通（当前账号返回空） |
| 6 | `calculate-price` | **最终价格唯一准绳** | ✅ 已接通 |
| 7 | `create-order` | 下单（需显式二次确认） | 未启用（默认不下单） |

## 3. 调用流程

```mermaid
flowchart TD
    A[用户输入约束] --> B[now-time-info]
    B --> C[query-nearby-stores<br/>beType=1, city, keyword, searchType=2]
    C -->|storeCode| D[query-meals]
    D -->|categories + meals 字典| G
    B --> E[list-nutrition-foods]
    E -->|表格字符串| F[parseNutritionTable]
    F --> G{{本地组合搜索 planner.js}}
    C --> H[query-store-coupons]
    G --> I[Top-N 候选]
    I --> J[calculate-price<br/>逐个校正]
    J --> K[输出方案 + 可视化]
    K -->|默认| L[结束]
    K -->|用户显式确认| M[create-order]
```

## 4. ⚠️ 实测校准要点（与文档描述不一致处）

这几点是踩过的坑，也是本项目最有复用价值的部分：

### 4.1 `query-meals` 的名称和价格不在同一个地方

返回结构为：

```jsonc
{
  "categories": [ { "name": "鸡肉汉堡/卷", "meals": [ { "code": "1440", "tags": [...] } ] } ],
  "meals": { "1440": { "name": "麦辣鸡腿汉堡", "currentPrice": "22.5", "image": "..." } }
}
```

- `categories[].meals[]` **只有 code 和 tags，没有名称和价格**
- 名称与价格在 `data.meals` 这个 **code → 详情的字典**里
- 单看任一部分都不完整，必须 join。实现见 `src/adapter.js` 的 `normalizeMenu()`

### 4.2 `list-nutrition-foods` 返回的不是 JSON

`data` 是自定义表格字符串：

```
[160]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:
  猪柳麦满分,null,1288,308,16,16,24,781,213
```

首行声明条数与列名，其后按逗号分隔。热量字段名是 **`energyKcal`**（不是 `calories`）。解析见 `parseNutritionTable()`。

### 4.3 金额单位是「分」

`calculate-price` 返回 `price: 5100` 表示 **51.00 元**。必须除以 100。

### 4.4 字段名写错会静默返回 0（最危险的一条）

`calculate-price` 的 items 元素字段必须是 **`productCode`**。若误写为 `code`：

- 接口返回 `success: true`、`code: 200`
- 但 `price = 0`、`productList = []`

不报错、不抛异常，直接给出看似正常的 0 元。本项目在 `extractPrice()` 中**强制校验 `productList` 非空**，否则判定算价无效并在界面标注「未校验」，杜绝 0 元伪装成真实金额。

### 4.5 其他

- `query-nearby-stores` 的 `data` 是**数组**，不是 `{stores:[]}` 包装
- 到店自取场景 `beType=1` 时传 `beCode` 会报错 400
- `query-store-coupons` 实测返回空数组（当前账号/门店无可用券），UI 会明示「不含券后优惠」而非假装算了优惠

## 5. 调用链实现位置

| 环节 | 文件 |
|---|---|
| MCP 协议客户端（initialize / tools/list / tools/call） | `src/mcp-client.js` |
| 返回结构适配 + 表格解析 + 金额提取 | `src/adapter.js` |
| 组合搜索与多目标打分（按线上真实分类名分桶） | `src/planner.js` |
| 编排与 HTTP 服务 | `src/server.js` |
| 前端展示 | `public/app.js` |
| 线上结构探测 | `scripts/probe.js` |

## 6. 实跑验证结果（2026-10-09）

门店：麦当劳杭州黄龙万科中心餐厅（storeCode `3330254`）
菜单 128 项 · 营养 160 条 · 优惠券 0 张

| 方案 | 组合（2 人份） | 本地估算 | 官方算价 | 人均热量 | 人均蛋白质 |
|---|---|---:|---:|---:|---:|
| 1 | 双层深海鳕鱼堡 ×2 + 圆筒冰淇淋 ×2 | ¥58.00 | **¥58.00** | 578 kcal | 30 g |
| 2 | 双层深海鳕鱼堡 ×2 + 新地 ×2 | ¥72.00 | **¥72.00** | 767 kcal | 33 g |
| 3 | 巨无霸 ×2 + 圆筒冰淇淋 ×2 | ¥61.00 | **¥61.00** | 606 kcal | 29 g |
| 4 | 双层吉士汉堡 ×2 + 圆筒冰淇淋 ×2 | ¥56.00 | **¥56.00** | 522 kcal | 29 g |
| 5 | 芝士安格斯厚牛堡 ×2 + 韩式烟熏芝士风味酱 ×2 | ¥69.00 | **¥69.00** | 696 kcal | 32 g |

**本地估算与官方 `calculate-price` 结果 5/5 完全一致** —— 说明估算逻辑未偏离官方计价规则；即便如此，界面仍以官方算价为准显示。

## 7. 业务价值

1. **对用户**：把「凑满减 + 算热量 + 选搭配」的人工试错，压缩为一次输入、5 个可直接比对的方案。
2. **对麦当劳 MCP 生态**：验证了「菜单 + 营养 + 优惠券 + 算价」四类工具可被编排成完整决策链路，而非单点查询；并把上述 5 个真实对接坑点公开出来，降低后续开发者的接入成本。
3. **对开发者**：提供零第三方依赖接入 MCP Streamable HTTP 的最小实现（SSE 与 JSON 双响应解析、会话维持、限流节流），可直接复制复用。

## 8. 容错与降级

`src/server.js` 中每一步 MCP 调用都被 `step()` 包裹：单步失败不中断整体流程，而是写入 `warnings` 并在页面如实展示。**宁可明示数据缺失，也不静默返回看起来正常的错误结果。**
