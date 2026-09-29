/**
 * 安装过程的进度信号：把「npm 到底还在不在干活」变成可展示的数字。
 *
 * 用途：`npm install --global` 的进度条只在 TTY 下画，输出被接到管道后一个字
 * 都不吐；调试日志也要等进程结束才落盘。于是「安装中」在页面上表现为一片安静，
 * 用户无法区分「正在下载」和「已经卡死」。
 *
 * 逻辑要点（每个信号都不完整，合起来才够判断）：
 *   - 时间：已用时长永远在走，是「进程还活着」的最弱但最可靠证据；
 *   - 输出：`--loglevel=http` 让每个完成的注册表请求打一行，于是能数出取了几个包；
 *   - 字节：直接量 npm 下载缓存的体积，这是唯一能在「静默下载大压缩包」期间
 *     仍然增长的信号，也是估算速率与剩余量的依据；
 *   - 静默：以上都不动超过阈值时，页面给一句温和的说明，而不是假装还在跑。
 *
 * 这里全部是纯函数或只读文件系统访问，便于 node --test 直接覆盖。
 *
 * @module @local/dsh-update-center/lib/progress
 */
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * 判定「长时间没有动静」的阈值。
 *
 * 逻辑：取 90 秒而不是更短，是因为 npm 在解包阶段会连续几分钟不输出任何东西，
 * 阈值太短会把正常安装报成可疑。
 */
export const STALL_MS = 90_000;

/**
 * npm 抓取日志行的形状：`npm http fetch GET 200 <url> 12ms (cache miss)`。
 *
 * 只匹配 fetch 行，这样 `npm warn`/`npm error` 之类的噪声不会被算成进度。
 */
const FETCH_LINE = /\bnpm http fetch\b/i;

/**
 * 推导 npm 的缓存根目录。
 *
 * 逻辑：优先尊重用户显式配置（npm 会把 `cache` 配置镜像成 `npm_config_cache`
 * 环境变量），其次按平台默认值猜，最后退到 HOME。猜错只会让字节数显示不出来，
 * 不会影响安装本身。
 * @param {NodeJS.ProcessEnv} [env] 环境变量。
 * @param {string} [platform] `process.platform` 的替身，便于测试。
 * @param {string} [home] 用户主目录。
 * @returns {string} 缓存根目录绝对路径。
 */
export function resolveNpmCacheRoot(env = process.env, platform = process.platform, home = homedir()) {
  const explicit = env.npm_config_cache;
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit;
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA;
    if (typeof local === 'string' && local.trim() !== '') return path.join(local, 'npm-cache');
  }
  return path.join(home, '.npm');
}

/**
 * 缓存根目录下真正存放压缩包的目录。
 *
 * 只量 content-v2 而不是整个 _cacache：index-v5 里的元数据体积小且与下载量无关，
 * 混进来只会让数字抖动。
 * @param {string} cacheRoot 缓存根目录。
 * @returns {string} `_cacache/content-v2` 的绝对路径。
 */
export function contentV2Dir(cacheRoot) {
  return path.join(cacheRoot, '_cacache', 'content-v2');
}

/** 递归累加目录下所有普通文件的大小，单个文件读取失败就跳过。 */
async function sumDirectory(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // 子目录在采样瞬间被 npm 改名/删除是正常的，当作 0 处理。
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await sumDirectory(full);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      total += (await stat(full)).size;
    } catch {
      /* 文件刚被移走，忽略 */
    }
  }
  return total;
}

/**
 * 量一个目录的总体积。
 * @param {string} target 目录路径。
 * @returns {Promise<number|undefined>} 字节数；目录不存在或不可读时为 undefined。
 */
export async function directoryBytes(target) {
  try {
    const info = await stat(target);
    if (!info.isDirectory()) return undefined;
  } catch {
    // 缓存目录还不存在（全新机器上的首次安装）——返回 undefined 让调用方显示「未知」，
    // 而不是显示一个会被误读成「还没开始下载」的 0。
    return undefined;
  }
  return sumDirectory(target);
}

/**
 * 数一段安装输出里完成了多少次抓取。
 *
 * 逻辑：区分「请求数」和「压缩包数」，因为前者包含注册表元数据，会远大于后者；
 * 页面上说的是「已取 N 个包」，用压缩包数才不会被误解成包的数量暴增。
 * @param {string} text 安装器输出（可含多行）。
 * @returns {{fetches: number, packages: number}} 抓取行数与其中的压缩包行数。
 */
export function countFetchLines(text) {
  let fetches = 0;
  let packages = 0;
  for (const line of String(text).split(/\r?\n/)) {
    if (!FETCH_LINE.test(line)) continue;
    fetches += 1;
    if (line.includes('.tgz')) packages += 1;
  }
  return { fetches, packages };
}

/**
 * 判断安装是否已经长时间没有任何动静。
 * @param {number} now 当前时间戳。
 * @param {number|undefined} lastActivityAt 最后一次观测到活动的时间戳。
 * @param {number} [thresholdMs] 静默阈值。
 * @returns {boolean} 是否已达静默阈值。
 */
export function isStalled(now, lastActivityAt, thresholdMs = STALL_MS) {
  if (!Number.isFinite(lastActivityAt)) return false;
  return now - lastActivityAt >= thresholdMs;
}
