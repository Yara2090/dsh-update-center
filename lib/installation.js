/**
 * 定位本机安装的 DeepSeek Harness，并给出「怎么装新版本」。
 *
 * 用途：更新面板必须回答两个只有 Host 侧知道的问题——
 *   1. 我现在跑的是哪个版本、装在哪；
 *   2. 该用哪个包管理器把它换掉。
 *
 * 逻辑要点：
 *   - 启动器执行的是 `<prefix>/node_modules/@deepseek-ai/dsh/lib/bin.js`，
 *     所以从 process.argv[1] 向上找 package.json 最可靠；找不到时再退回到
 *     npm 全局前缀和常见的 pnpm 全局目录，最后才认输。
 *   - 包管理器探测只看「安装目录附近有没有 pnpm 的痕迹」，因为用 pnpm 装出来
 *     的目录被 npm 覆盖会留下一个坏掉的 node_modules；探测不到一律按 npm 处理。
 *
 * @module @local/dsh-update-center/lib/installation
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** 本面板更新的包名；同时用作 package.json 里的 name 校验值。 */
export const PACKAGE_NAME = '@deepseek-ai/dsh';

/**
 * 读取一个 package.json，仅当它确实是被更新包的清单时返回内容。
 * @param {string} manifestPath 候选清单路径。
 * @returns {{dir: string, version: string}|undefined} 包目录与版本。
 */
function readDshManifest(manifestPath) {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return undefined;
    // name 必须精确匹配：向上遍历时很容易撞到别的 package.json。
    if (parsed.name !== PACKAGE_NAME || typeof parsed.version !== 'string') return undefined;
    return { dir: path.dirname(manifestPath), version: parsed.version };
  } catch {
    // 文件不存在、无权限、JSON 损坏——都只是「这个候选不行」。
    return undefined;
  }
}

/**
 * 列出所有可能的定位起点（文件路径或清单路径）。
 * @returns {string[]} 起点列表，按可信度从高到低。
 */
function installationSeeds() {
  const seeds = [];
  // 最高可信度：本进程就是由那个 bin.js 启动的。
  if (typeof process.argv[1] === 'string' && process.argv[1] !== '') seeds.push(process.argv[1]);
  // 次选：Windows 上 npm 全局前缀的固定位置。
  const appData = process.env.APPDATA;
  if (typeof appData === 'string' && appData !== '') {
    seeds.push(path.join(appData, 'npm', 'node_modules', PACKAGE_NAME, 'package.json'));
  }
  // 兜底：把 HOME 当成 pnpm/npm 的全局前缀猜一次。
  seeds.push(path.join(homedir(), '.npm-global', 'lib', 'node_modules', PACKAGE_NAME, 'package.json'));
  return seeds;
}

/**
 * 定位本机安装的 @deepseek-ai/dsh。
 * @returns {{dir: string, version: string}|undefined} 安装目录与版本；定位失败时为 undefined。
 */
export function locateInstallation() {
  for (const seed of installationSeeds()) {
    let dir = path.resolve(seed);
    // 起点本身就是清单文件时先直接判定，然后再从它的目录向上走。
    if (dir.endsWith('.json')) {
      const direct = readDshManifest(dir);
      if (direct !== undefined) return direct;
      dir = path.dirname(dir);
    } else {
      dir = path.dirname(dir);
    }
    // 深度上限只是防止在极端路径下走太久；正常在第 1~2 层就命中。
    for (let depth = 0; depth < 8; depth += 1) {
      const manifest = readDshManifest(path.join(dir, 'package.json'));
      if (manifest !== undefined) return manifest;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

/** 判断目录下是否存在某个文件。 */
function hasFile(dir, name) {
  try {
    return existsSync(path.join(dir, name));
  } catch {
    return false;
  }
}

/**
 * 推断当初是用哪个包管理器装的这个包。
 * @param {string} installDir 已定位到的包目录。
 * @returns {'npm'|'pnpm'} 包管理器标识；无证据时按 npm 处理。
 */
export function detectPackageManager(installDir) {
  let dir = installDir;
  for (let depth = 0; depth < 4; depth += 1) {
    // pnpm 的全局目录会把真实文件放进 .pnpm/ 并用符号链接指出来。
    if (dir.includes(`${path.sep}.pnpm${path.sep}`)) return 'pnpm';
    if (hasFile(dir, 'pnpm-lock.yaml') || hasFile(dir, 'pnpm-workspace.yaml')) return 'pnpm';
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'npm';
}

/**
 * 生成安装某版本的完整命令。
 *
 * 逻辑：命令里必须带上「让它在管道里也能说话」的参数——npm 的进度条只在 TTY 下
 * 画，被父进程用管道接走后就彻底静默，用户看到的是一片死寂。`--loglevel=http`
 * 让每个注册表请求各打一行，面板因此能数出「已取几个包」；`--no-audit`/`--no-fund`
 * 去掉与升级无关的网络往返，既快也少噪声。pnpm 侧对应的是 append-only reporter。
 *
 * 另外必须显式带上注册表地址：面板的「检测」和「安装」若用了不同的源，会出现
 * 「检测到 X 有新版本、安装却从 Y 拉不到」这种自相矛盾的结果。镜像地址来自插件的
 * `registry` 配置（默认官方源），因此走内网镜像的用户装的时候也真的走镜像。
 * @param {'npm'|'pnpm'} manager 包管理器。
 * @param {string} version 目标版本号。
 * @param {string} [registry] 注册表地址；留空则用包管理器自己的默认值。
 * @returns {{command: string, args: string[], display: string}} spawn 参数与展示用命令行。
 */
export function buildInstallCommand(manager, version, registry) {
  const spec = `${PACKAGE_NAME}@${version}`;
  const source = typeof registry === 'string' && registry.trim() !== '' ? [`--registry=${registry}`] : [];
  if (manager === 'pnpm') {
    const args = ['add', '--global', '--reporter=append-only', ...source, spec];
    return { command: 'pnpm', args, display: `pnpm ${args.join(' ')}` };
  }
  const args = ['install', '--global', '--no-audit', '--no-fund', '--loglevel=http', ...source, spec];
  return { command: 'npm', args, display: `npm ${args.join(' ')}` };
}
