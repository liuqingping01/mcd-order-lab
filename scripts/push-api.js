/**
 * 通过 GitHub API 推送到远端
 * ============================================================
 * 用途：在 `git push` 不可用的受限环境（如沙箱、无 SSH/凭据助手的容器）
 *       下完成推送。零第三方依赖，只用 Node 内置模块。
 *
 * 原理：Git Data API —— blobs → tree → commit → update-ref
 *       等价于一次 git commit + push，产生单个规范 commit。
 *
 * 用法：
 *   export GITHUB_TOKEN=<your classic token with public_repo>
 *   export GITHUB_REPO=owner/repo          # 可选，默认读取 origin
 *   export GITHUB_REF=heads/main           # 可选，默认 heads/main
 *   node scripts/push-api.js "commit message"
 *
 * 说明：出于安全，本脚本**不派生 git 进程**（部分受限环境会返回 EBUSY），
 *       改为直接解析 .git/config 与 .gitignore，
 *       因此 .gitignore 规则依然生效，.env 等敏感文件不会被带上去。
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { projectRoot } from '../src/env.js';

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error('缺少 GITHUB_TOKEN 环境变量');
  process.exit(1);
}

const repo = process.env.GITHUB_REPO ?? detectRepo();
const refPath = process.env.GITHUB_REF ?? 'heads/main';
const message = process.argv[2] ?? 'chore: update via GitHub API';

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'push-api.js',
  'X-GitHub-Api-Version': '2022-11-28',
};

async function api(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

/** 从 .git/config 的 remote.origin.url 推断 owner/repo（不调用 git 二进制） */
function detectRepo() {
  const cfgPath = join(projectRoot, '.git', 'config');
  if (existsSync(cfgPath)) {
    const m = readFileSync(cfgPath, 'utf8').match(/url\s*=\s*(\S+)/);
    if (m) {
      const r = m[1].match(/github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?\/?$/);
      if (r) return `${r[1]}/${r[2]}`;
    }
  }
  console.error('无法推断仓库，请设置 GITHUB_REPO=owner/repo');
  process.exit(1);
}

/**
 * 轻量 .gitignore 匹配。支持：空行 / # 注释 / 目录前缀 / 通配符 / ! 取反。
 * 按「最后一条匹配规则生效」处理，与 git 行为一致。
 */
function loadIgnorePatterns() {
  const file = join(projectRoot, '.gitignore');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function patternToRegExp(pattern) {
  let src = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  src = src.replace(/\*/g, '[^/]*');
  src = src.replace(/\?/g, '[^/]');
  // `foo/` 只匹配目录；此处目录通过前缀判断，统一转成「自身或子路径」
  return new RegExp(`(^|/)${src}(/|$)`);
}

function isIgnored(relPath, patterns) {
  let ignored = false;
  for (const p of patterns) {
    const negate = p.startsWith('!');
    const body = negate ? p.slice(1) : p;
    // 目录规则 `node_modules/` 需同时匹配其内部文件
    const candidates = [relPath];
    const isDirRule = body.endsWith('/');
    for (const c of candidates) {
      if (!patternToRegExp(body.replace(/\/$/, '')).test(c)) continue;
      if (isDirRule) {
        ignored = !negate;
        continue;
      }
      ignored = !negate;
    }
  }
  return ignored;
}

/** 递归收集待推送文件（跳过 .git） */
function collectFiles(dir, base, patterns, out) {
  for (const entry of readdirSync(dir)) {
    if (entry === '.git') continue;
    const abs = join(dir, entry);
    const rel = relative(base, abs).split(sep).join('/');
    const ignored = isIgnored(rel, patterns) || isIgnored(`${rel}/`, patterns);
    const info = statSync(abs);
    if (info.isDirectory()) {
      if (ignored) continue;
      collectFiles(abs, base, patterns, out);
    } else {
      if (ignored) continue;
      out.push(rel);
    }
  }
  return out;
}

const ignorePatterns = loadIgnorePatterns();
const files = collectFiles(projectRoot, projectRoot, ignorePatterns, []);

console.log(`仓库 ${repo} · 待提交文件 ${files.length} 个`);

const tree = [];
for (const file of files) {
  const content = readFileSync(file).toString('base64');
  const blob = await api('POST', `/repos/${repo}/git/blobs`, { content, encoding: 'base64' });
  tree.push({ path: file, mode: '100644', type: 'blob', sha: blob.sha });
}

const { sha: treeSha } = await api('POST', `/repos/${repo}/git/trees`, { tree });
console.log('tree:', treeSha);

// 仓库可能尚无首次提交，此时 parent 不存在
let parents = [];
try {
  const ref = await api('GET', `/repos/${repo}/git/ref/${refPath}`);
  parents = [ref.object.sha];
} catch {
  console.log('远端尚无该分支，将创建首次提交');
}

const commit = await api('POST', `/repos/${repo}/git/commits`, {
  message,
  tree: treeSha,
  parents,
});
console.log('commit:', commit.sha);

await api('PATCH', `/repos/${repo}/git/refs/${refPath}`, { sha: commit.sha });
console.log(`已推送 refs/${refPath} → ${commit.sha}`);
