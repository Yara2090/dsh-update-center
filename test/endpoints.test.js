/**
 * 前后端接口一致性检查。
 *
 * 逻辑：这个插件的前端（client.js）和后端（lib/center.js）是两个独立的单文件，
 * 两边靠**字符串**约定接口名。这种约定出错的方式很难受：不会有任何报错，只会在
 * 运行时静默 404，用户看到的就是「点了没反应」——恰恰是本插件 README 里反复在防的
 * 那类现象。所以这里把约定变成断言，改错一边就红。
 *
 * 学自同类插件的做法（dsh-whale-widget 的 tools/ci-audit.mjs 第 ② 项，它给的理由
 * 是「前端与后端是两个各 1.5 万行的单文件，各改一半就会在运行时静默 404」）。
 *
 * 三条不变量：
 *   1. 前端会调的每个动作，后端都认；
 *   2. 后端认的每个动作，前端都在用（否则就是一条没人走的路 —— 1.6.0 删掉的那个
 *      「重启」路由正是这种残留，当年谁都没发现）；
 *   3. 两边的路由前缀是同一个字符串。
 *
 * 另外，抽取结果本身也要断言非空：一个什么都抽不到、于是永远通过的检查，
 * 比没有检查更糟（同类插件管这叫「门禁腐烂」，专门写了个 selftest 去防）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

/**
 * 后端有意保留、但前端当前不直接调用的路由。
 * 往这里加东西必须写明理由，否则第 2 条不变量就白设了。
 */
const BACKEND_ONLY = new Set([
  '', // GET /dsh-update-center/：与 GET /state 等价的别名，前端只用 state。
]);

const clientSource = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const centerSource = readFileSync(path.join(ROOT, 'lib', 'center.js'), 'utf8');

/** 按正则抽出第一捕获组的所有值。 */
function collect(source, pattern) {
  const found = new Set();
  for (const match of source.matchAll(pattern)) found.add(match[1]);
  return found;
}

const frontendActions = new Set([
  ...collect(clientSource, /request\('([a-z][a-z-]*)'/g),
  ...collect(clientSource, /\bpost\('([a-z][a-z-]*)'/g),
  ...collect(clientSource, /controlButton\('([a-z][a-z-]*)'/g),
]);

// (?<![\w.]) 是为了避开 `last.action === 'stop'` 这种同名字段，它不是一条路由。
const backendActions = collect(centerSource, /(?<![\w.])action === '([a-z-]*)'/g);

const clientPrefix = /const ENDPOINT = '([^']+)'/.exec(clientSource)?.[1];
const backendPrefix = /export const ROUTE_PREFIX = '([^']+)'/.exec(centerSource)?.[1];

describe('前后端接口一致性', () => {
  it('抽取本身是有效的（否则这个检查会永远通过）', () => {
    assert.ok(frontendActions.size >= 5, `前端动作只抽到 ${frontendActions.size} 个：${[...frontendActions]}`);
    assert.ok(backendActions.size >= 5, `后端动作只抽到 ${backendActions.size} 个：${[...backendActions]}`);
    assert.equal(typeof clientPrefix, 'string', '没能在 client.js 里找到 ENDPOINT');
    assert.equal(typeof backendPrefix, 'string', '没能在 lib/center.js 里找到 ROUTE_PREFIX');
  });

  it('前端会调的每个动作，后端都认', () => {
    const missing = [...frontendActions].filter((action) => !backendActions.has(action)).sort();
    assert.deepEqual(missing, [], `前端调了但后端不认：${missing.join('、')} —— 运行时只会静默 404`);
  });

  it('后端认的每个动作，前端都在用（没有没人走的路）', () => {
    const orphan = [...backendActions]
      .filter((action) => !frontendActions.has(action) && !BACKEND_ONLY.has(action))
      .sort();
    assert.deepEqual(orphan, [], `后端有路由但前端从不调用：${orphan.join('、')} —— 半撤的残留就是这样来的`);
  });

  it('两边的路由前缀是同一个字符串', () => {
    assert.equal(clientPrefix, backendPrefix,
      `client.js 的 ENDPOINT (${String(clientPrefix)}) 与 lib/center.js 的 ROUTE_PREFIX (${String(backendPrefix)}) 不一致`);
  });
});
