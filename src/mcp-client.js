/**
 * 麦当劳 MCP Streamable HTTP 客户端
 *
 * 零第三方依赖，仅使用 Node 内置 fetch。
 * 协议：MCP Streamable HTTP transport，JSON-RPC 2.0。
 * 服务端地址：https://mcp.mcd.cn
 *
 * 限流说明：官方限制每个 Token 每分钟最多 600 次请求，超出返回 429。
 * 本客户端内置令牌桶节流，默认保守设置为 300 次/分钟。
 */

const DEFAULT_URL = 'https://mcp.mcd.cn';
const PROTOCOL_VERSION = '2025-06-18';

export class McpError extends Error {
  constructor(code, message, data) {
    super(`MCP error ${code}: ${message}`);
    this.name = 'McpError';
    this.code = code;
    this.data = data;
  }
}

/** 简易令牌桶，用于客户端侧节流，避免触发服务端 429。 */
class TokenBucket {
  constructor(capacityPerMinute) {
    this.capacity = capacityPerMinute;
    this.tokens = capacityPerMinute;
    this.refillPerMs = capacityPerMinute / 60_000;
    this.last = Date.now();
  }

  async take() {
    const now = Date.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + (now - this.last) * this.refillPerMs
    );
    this.last = now;
    if (this.tokens < 1) {
      const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs);
      await new Promise((r) => setTimeout(r, waitMs));
      return this.take();
    }
    this.tokens -= 1;
  }
}

/**
 * 解析响应体。MCP Streamable HTTP 允许服务端返回：
 *   1) application/json           —— 单个 JSON-RPC 响应对象
 *   2) text/event-stream          —— SSE 流，每行形如 `data: {...}`
 * 两种情况都要支持，否则在部分工具上会静默失败。
 */
async function parseResponse(response) {
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('text/event-stream')) {
    const text = await response.text();
    const events = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        events.push(JSON.parse(payload));
      } catch {
        /* 忽略非 JSON 心跳行 */
      }
    }
    // 取最后一个携带 result / error 的消息
    return events.reverse().find((e) => 'result' in e || 'error' in e) ?? null;
  }

  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export class McdMcpClient {
  /**
   * @param {object} opts
   * @param {string} opts.token  麦当劳 MCP Token（Bearer），从环境变量读取，切勿硬编码
   * @param {string} [opts.url]
   * @param {number} [opts.ratePerMinute]
   */
  constructor({ token, url = DEFAULT_URL, ratePerMinute = 300 }) {
    if (!token) {
      throw new Error('缺少 MCP Token：请设置环境变量 MCD_MCP_TOKEN');
    }
    this.url = url;
    this.token = token;
    this.sessionId = null;
    this.bucket = new TokenBucket(ratePerMinute);
    this.requestId = 0;
    this.serverInfo = null;
    this.#loadEnv();
  }

  /** 若未显式传入 token，则回退读取 .env（不依赖 dotenv，自行解析）。 */
  #loadEnv() {
    // token 由调用方注入或 server.js 从 process.env 读取，此处仅做占位，
    // 保持客户端对环境无副作用。
  }

  #headers() {
    const h = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${this.token}`,
    };
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    return h;
  }

  async #send(method, params, { notify = false } = {}) {
    await this.bucket.take();
    const payload = { jsonrpc: '2.0', method };
    if (!notify) payload.id = ++this.requestId;
    if (params !== undefined) payload.params = params;

    const res = await fetch(this.url, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify(payload),
    });

    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    if (res.status === 401) {
      throw new McpError(401, 'Token 无效、已过期或未提供（401）');
    }
    if (res.status === 429) {
      throw new McpError(429, '触发限流，超过 600 次/分钟，请降低调用频率');
    }
    if (!res.ok) {
      throw new McpError(res.status, `HTTP ${res.status} ${res.statusText}`);
    }

    const msg = await parseResponse(res);
    if (notify || !msg) return null;
    if (msg.error) {
      throw new McpError(msg.error.code, msg.error.message, msg.error.data);
    }
    return msg.result;
  }

  /** MCP 握手：initialize + notifications/initialized */
  async initialize() {
    const result = await this.#send('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'mcd-order-lab', version: '1.0.0' },
    });
    this.serverInfo = result ?? null;
    await this.#send('notifications/initialized', undefined, { notify: true });
    return result;
  }

  /** 拉取服务端工具清单（用于校验文档与线上能力是否一致） */
  async listTools() {
    const result = await this.#send('tools/list', {});
    return result?.tools ?? [];
  }

  /**
   * 调用工具。
   * @param {string} name  工具名，如 'query-meals'
   * @param {object} args  工具入参
   * @returns {Promise<{content: Array, structuredContent: any, isError: boolean}>}
   */
  async callTool(name, args = {}) {
    const result = await this.#send('tools/call', { name, arguments: args });
    if (!result) throw new McpError(-32000, `工具 ${name} 返回空结果`);
    return {
      content: result.content ?? [],
      structuredContent: result.structuredContent ?? null,
      isError: Boolean(result.isError),
    };
  }

  /**
   * 调用工具并把文本内容解析为 JSON。
   * MCP 工具普遍把业务数据放在 content[0].text（JSON 字符串），
   * 这里统一解析，调用方不必关心传输细节。
   */
  async callToolJson(name, args = {}) {
    const { content, structuredContent, isError } = await this.callTool(name, args);
    if (structuredContent) return structuredContent;
    const text = (content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('');
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return { _rawText: text };
    }
  }
}
