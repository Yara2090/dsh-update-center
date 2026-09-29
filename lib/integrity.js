/**
 * 插件自检与修复：回答「这个插件现在还能不能正常工作」。
 *
 * 用途：插件由「插件目录里的文件」「profile 里的注册与链接」「运行环境的配置」
 * 三部分组成，任何一处缺了，表现都是「页面不见了」或「点了没反应」，用户很难
 * 从现象反推原因。这里把三部分逐项查一遍，并把其中能安全修的那些修掉。
 *
 * 逻辑要点：
 *   - 检查项只读磁盘，不改任何东西；修复项单独实现，且每一项都先备份再写。
 *   - 修复只做「把缺的补回去」，绝不删除或重写用户已有的其它内容；因此反复点
 *     一键修复是安全的（幂等）。
 *   - 判定依据尽量来自磁盘事实（文件是否存在、链接指向哪里、清单里写了什么），
 *     而不是插件自己的记忆，否则插件被搬走后就查不出问题了。
 *   - 检查与修复都不联网，也不需要 Harness 在运行。
 *
 * @module @local/dsh-update-center/lib/integrity
 */
import { constants, existsSync } from 'node:fs';
import { access, lstat, mkdir, open, readFile, readdir, realpath, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { locateInstallation, PACKAGE_NAME } from './installation.js';

/** 本模块所在目录。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 插件根目录：lib/ 的上一级。 */
export const PLUGIN_ROOT = path.resolve(HERE, '..');

/** 清单损坏时用的兜底包名；正常情况下一律以清单里的 name 为准。 */
export const FALLBACK_PLUGIN_NAME = '@local/dsh-update-center';

/** 无论清单怎么写都必须存在的文件。 */
const CORE_FILES = [
  'package.json',
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'locale/zh.json',
  'locale/en.json',
];

/** 宿主半边的入口；相对导入扫描从这里出发。 */
const HOST_ENTRIES = ['index.js'];

/** 浏览器半边必须出现这个标记，否则是被截断或写坏的文件。 */
const CLIENT_MARKER = '__ModuleLoader__';

/** 相对导入扫描的深度上限，防止异常目录结构下无限递归。 */
const MAX_IMPORT_DEPTH = 6;

/** Node 内置模块集合（含和不含 `node:` 前缀两种写法）。 */
const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

/** 取一个未知抛出物的可读信息。 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 把路径统一成可比较的形式：Windows 上大小写不敏感，分隔符统一成 `/`。 */
export function normalizePath(value) {
  const text = String(value).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? text.toLowerCase() : text;
}

/**
 * 推导 DSH 主目录。
 * @param {NodeJS.ProcessEnv} [env] 环境变量。
 * @returns {string} `<DSH_HOME>` 的绝对路径。
 */
export function resolveHomeDir(env = process.env) {
  const explicit = env.DSH_HOME;
  if (typeof explicit === 'string' && explicit !== '') return explicit;
  return path.join(homedir(), '.dsh');
}

/**
 * 推导当前 profile 目录（只看环境变量）。
 *
 * 逻辑：优先用 `DSH_PROFILE_DIR`，其次用 `<DSH_HOME>/profiles/<DSH_PROFILE>`。
 * 注意这两个变量是 Harness 注入给**工具子进程**的，宿主进程自己往往一个都没有，
 * 所以真正的判定要靠 discoverProfileDir 从磁盘反推。
 * @param {NodeJS.ProcessEnv} [env] 环境变量。
 * @returns {string|undefined} profile 目录；无法判定时为 undefined。
 */
export function resolveProfileDir(env = process.env) {
  const explicit = env.DSH_PROFILE_DIR;
  if (typeof explicit === 'string' && explicit !== '') return explicit;
  const profile = env.DSH_PROFILE;
  if (typeof profile !== 'string' || profile === '') return undefined;
  return path.join(resolveHomeDir(env), 'profiles', profile);
}

/**
 * 从磁盘反推当前 profile 目录。
 *
 * 逻辑：插件是被 profile 以链接的形式装进来的，因此最硬的证据是「谁的
 * `node_modules/<包名>` 指到了本插件目录」。环境变量只作为并列时的优先项，
 * 而清单里的依赖声明与 bundle 条目作为次一级证据——链接被删掉时仍能认出
 * 这是哪个 profile，从而让「缺链接」变成可修复项。
 *
 * 证据不足时返回 undefined：宁可不判定，也不猜——猜错会让修复写进别人的 profile。
 * @param {object} [options] 选项。
 * @param {NodeJS.ProcessEnv} [options.env] 环境变量。
 * @param {string} options.pluginName 插件包名。
 * @param {string} options.pluginRoot 插件目录。
 * @returns {Promise<string|undefined>} 最可能的 profile 目录。
 */
export async function discoverProfileDir(options = {}) {
  const env = options.env ?? process.env;
  const pluginName = options.pluginName;
  const pluginRoot = options.pluginRoot;
  const home = resolveHomeDir(env);
  const candidates = [];
  const declared = resolveProfileDir(env);
  if (declared !== undefined) candidates.push(declared);
  try {
    const entries = await readdir(path.join(home, 'profiles'), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(home, 'profiles', entry.name);
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }
  } catch {
    /* 没有 profiles 目录时就只靠声明 */
  }

  let best;
  let bestScore = 0;
  for (const candidate of candidates) {
    let score = 0;
    const resolved = await realpath(path.join(candidate, 'node_modules', pluginName)).catch(() => undefined);
    if (resolved !== undefined && normalizePath(resolved) === normalizePath(pluginRoot)) {
      score = 3;
    } else {
      const manifest = await readJson(path.join(candidate, 'package.json'));
      if (manifest.error === undefined) {
        const value = manifest.value;
        const dependency = value?.dependencies?.[pluginName];
        if (typeof dependency === 'string' && normalizePath(dependency).includes(normalizePath(pluginRoot))) {
          score = 2;
        } else if (Array.isArray(value?.dsh?.profile?.bundles) && value.dsh.profile.bundles.includes(pluginName)) {
          score = 1;
        }
      }
    }
    // 严格大于：并列时保留更靠前的候选（声明优先于目录枚举顺序）。
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/** 去掉注释，避免注释里的 `from 'xxx'` 被当成导入语句。 */
export function stripComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * 抽出源码里的 import/export 目标。
 * @param {string} source 源码。
 * @returns {string[]} 去重后的模块名。
 */
export function extractImportSpecifiers(source) {
  const cleaned = stripComments(source);
  const pattern = /(?:^|[\s;}])(?:import|export)\b[^;'"\n]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g;
  const found = new Set();
  let match = pattern.exec(cleaned);
  while (match !== null) {
    const specifier = match[1] ?? match[2];
    if (typeof specifier === 'string' && specifier !== '') found.add(specifier);
    match = pattern.exec(cleaned);
  }
  return [...found];
}

/** 判断一个模块名是不是相对路径。 */
export function isRelativeSpecifier(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

/**
 * 从清单里收集所有指向本地文件的路径。
 *
 * 逻辑：`exports`、`icon`、`dsh.bundle.patch` 里任何一条写错都会让 Harness
 * 装不上或页面加载不了，所以直接遍历清单取值，而不是维护一份会过期的固定列表。
 * @param {object} manifest package.json 解析结果。
 * @returns {string[]} 相对插件根目录的路径（已剔除通配符）。
 */
export function manifestFilePaths(manifest) {
  const found = new Set();
  const walk = (node) => {
    if (typeof node === 'string') {
      // 只认像文件路径的字符串：`web`、`./lib/*` 这类平台名或通配符一律跳过。
      if (!node.includes('*') && (node.startsWith('./') || node.startsWith('../'))) {
        found.add(node.replace(/^\.\//, ''));
      }
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const value of Object.values(node)) walk(value);
    }
  };
  walk(manifest?.exports);
  walk(manifest?.icon);
  walk(manifest?.dsh?.bundle?.patch);
  return [...found];
}

/**
 * 读取并解析一个 JSON 文件。
 * @param {string} target 文件路径。
 * @returns {Promise<{value?: any, error?: string}>} 解析结果或错误信息。
 */
async function readJson(target) {
  try {
    const text = await readFile(target, 'utf8');
    return { value: JSON.parse(text) };
  } catch (error) {
    return { error: messageOf(error) };
  }
}

/**
 * 顺着相对导入把宿主半边用到的文件走一遍。
 * @param {string} root 插件根目录。
 * @returns {Promise<{missing: string[], external: string[], visited: string[]}>} 走查结果。
 */
async function walkModuleGraph(root) {
  const missing = [];
  const external = new Set();
  const visited = new Set();
  const queue = HOST_ENTRIES.map((entry) => ({ file: entry, depth: 0 }));
  while (queue.length > 0) {
    const { file, depth } = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const absolute = path.join(root, file);
    let source;
    try {
      source = await readFile(absolute, 'utf8');
    } catch {
      missing.push(file);
      continue;
    }
    for (const specifier of extractImportSpecifiers(source)) {
      if (isRelativeSpecifier(specifier)) {
        const resolved = path
          .relative(root, path.resolve(path.dirname(absolute), specifier))
          .replace(/\\/g, '/');
        if (!existsSync(path.join(root, resolved))) missing.push(resolved);
        else if (depth < MAX_IMPORT_DEPTH) queue.push({ file: resolved, depth: depth + 1 });
        continue;
      }
      if (!BUILTINS.has(specifier)) external.add(specifier);
    }
  }
  return { missing: [...new Set(missing)], external: [...external], visited: [...visited] };
}

/** 备份一个文件（同名 `.bak`，覆盖上一次备份）。 */
async function backupFile(target) {
  const backup = `${target}.bak`;
  try {
    await writeFile(backup, await readFile(target), 'utf8');
    return backup;
  } catch {
    return undefined; // 原文件不存在或不可读时没有可备份的内容
  }
}

/** 删除一个链接（符号链接或 Windows 目录联接），绝不触碰链接指向的真实目录。 */
async function removeLink(target) {
  try {
    await unlink(target);
    return;
  } catch (error) {
    if (error?.code === 'EISDIR' || error?.code === 'EPERM') {
      // Windows 的目录联接必须先走 unlink 失败这条分支：fs.rm 会直接抛 EISDIR，
      // 只有 rmdir 会摘掉联接本身，且不会碰到联接指向的目录内容。
      await rmdir(target);
      return;
    }
    throw error;
  }
}

/**
 * 判断一个已存在的路径是不是「链接」而不是真实目录。
 *
 * 逻辑：Windows 的目录联接（junction）在 Node 的 lstat 下 isSymbolicLink() 为 false、
 * isDirectory() 为 true，和真实目录几乎无法区分；pnpm 与手工修复都可能产出这种形态。
 * 因此以 realpath 为准：路径解析后与自己不同，就说明它是一个指向别处的链接。
 * @param {string} target 待判断的路径。
 * @param {import('node:fs').Stats} info 该路径的 lstat 结果。
 * @returns {Promise<boolean>} 是否为链接。
 */
async function looksLikeLink(target, info) {
  if (info.isSymbolicLink()) return true;
  const resolved = await realpath(target).catch(() => undefined);
  if (resolved === undefined) return false;
  return normalizePath(resolved) !== normalizePath(target);
}

/**
 * 逐项检查插件完整性。
 *
 * @param {object} [options] 选项。
 * @param {string} [options.pluginRoot] 插件根目录，默认取本模块所在位置。
 * @param {NodeJS.ProcessEnv} [options.env] 环境变量，默认 `process.env`。
 * @param {string} [options.statePath] 偏好文件路径。
 * @returns {Promise<object>} 检查报告。
 */
export async function checkIntegrity(options = {}) {
  const root = options.pluginRoot ?? PLUGIN_ROOT;
  const env = options.env ?? process.env;
  const home = resolveHomeDir(env);
  const statePath = options.statePath ?? path.join(home, 'dsh-update-center.json');
  const checks = [];

  /** 记录一项检查结果。 */
  const record = (id, status, detail, repairable = false) => {
    checks.push({ id, status, repairable: status !== 'ok' && repairable, detail });
  };

  // ── 1. 插件文件 ────────────────────────────────────────────────────────
  const manifestPath = path.join(root, 'package.json');
  const manifest = await readJson(manifestPath);
  const pluginName = typeof manifest.value?.name === 'string' && manifest.value.name !== ''
    ? manifest.value.name
    : FALLBACK_PLUGIN_NAME;
  // profile 目录靠磁盘证据反推：宿主进程里通常没有 DSH_PROFILE_DIR。
  const profileDir = await discoverProfileDir({ env, pluginName, pluginRoot: root });

  const required = new Set(CORE_FILES);
  for (const relative of manifestFilePaths(manifest.value)) required.add(relative);
  const missingFiles = [...required].filter((relative) => !existsSync(path.join(root, relative)));
  record(
    'plugin-files',
    missingFiles.length === 0 ? 'ok' : 'error',
    missingFiles.length === 0 ? root : `缺少：${missingFiles.join('、')}`,
  );

  // ── 2. 清单本身 ────────────────────────────────────────────────────────
  if (manifest.error !== undefined) {
    record('manifest', 'error', `package.json 无法解析：${manifest.error}`);
  } else {
    const problems = [];
    if (manifest.value?.name !== pluginName) problems.push('缺少 name');
    if (typeof manifest.value?.version !== 'string') problems.push('缺少 version');
    if (typeof manifest.value?.dsh?.bundle?.patch !== 'string') problems.push('缺少 dsh.bundle.patch');
    if (manifest.value?.dsh?.client === undefined) problems.push('缺少 dsh.client');
    record('manifest', problems.length === 0 ? 'ok' : 'error', problems.length === 0 ? pluginName : problems.join('、'));
  }

  // ── 3. 源码依赖 ────────────────────────────────────────────────────────
  const graph = await walkModuleGraph(root);
  if (graph.missing.length > 0) {
    record('module-graph', 'error', `导入的文件不存在：${graph.missing.join('、')}`);
  } else if (graph.external.length > 0) {
    // 宿主半边只该用 Node 内置模块；出现第三方包说明依赖没随插件一起交付。
    record('module-graph', 'warn', `依赖了未声明的外部包：${graph.external.join('、')}`);
  } else {
    record('module-graph', 'ok', `${graph.visited.length} 个宿主文件，全部可解析`);
  }

  // ── 4. 浏览器半边可用 ──────────────────────────────────────────────────
  const clientText = await readFile(path.join(root, 'client.js'), 'utf8').catch(() => undefined);
  if (clientText === undefined) {
    record('client-bundle', 'error', 'client.js 不可读');
  } else if (!clientText.includes(CLIENT_MARKER)) {
    record('client-bundle', 'error', `client.js 缺少 ${CLIENT_MARKER} 标记，页面会加载失败`);
  } else {
    record('client-bundle', 'ok', `${Math.round(clientText.length / 1024)} KB`);
  }

  // ── 5. profile 注册 ────────────────────────────────────────────────────
  if (profileDir === undefined) {
    record('profile-registration', 'warn', '无法确定 profile 目录（缺少 DSH_PROFILE_DIR / DSH_PROFILE）');
  } else {
    const profileManifestPath = path.join(profileDir, 'package.json');
    const profileManifest = await readJson(profileManifestPath);
    if (profileManifest.error !== undefined) {
      record('profile-registration', 'error', `读不到 ${profileManifestPath}：${profileManifest.error}`, true);
    } else {
      const problems = [];
      const declared = profileManifest.value?.dependencies?.[pluginName];
      if (typeof declared !== 'string') problems.push('清单依赖里没有这个插件');
      else if (!normalizePath(declared).includes(normalizePath(root))) {
        problems.push(`依赖指向别处（${declared}）`);
      }
      const bundles = profileManifest.value?.dsh?.profile?.bundles;
      if (!Array.isArray(bundles) || !bundles.includes(pluginName)) problems.push('bundle 列表里没有这个插件');
      record(
        'profile-registration',
        problems.length === 0 ? 'ok' : 'error',
        problems.length === 0 ? pluginName : problems.join('、'),
        true,
      );
    }
  }

  // ── 6. profile 依赖链接 ────────────────────────────────────────────────
  if (profileDir === undefined) {
    record('profile-link', 'warn', '无法确定 profile 目录');
  } else {
    const linkPath = path.join(profileDir, 'node_modules', pluginName);
    let info;
    try {
      info = await lstat(linkPath);
    } catch {
      info = undefined;
    }
    if (info === undefined) {
      record('profile-link', 'error', `缺少链接 ${linkPath}`, true);
    } else {
      const resolved = await realpath(linkPath).catch(() => undefined);
      const expected = await realpath(root).catch(() => root);
      const linked = await looksLikeLink(linkPath, info);
      if (linked) {
        if (resolved !== undefined && normalizePath(resolved) === normalizePath(expected)) {
          record('profile-link', 'ok', resolved);
        } else {
          // 只有链接才能安全地删掉重建。
          record('profile-link', 'error', `指向 ${String(resolved ?? linkPath)}，应为 ${expected}`, true);
        }
      } else {
        // 普通目录有两种可能：别人把插件拷贝进来一份，或者这个名字被别的东西占了。
        // 两者都不该自动删除，因此一律不可修复，只如实说明区别。
        const copied = await readJson(path.join(linkPath, 'package.json'));
        const isCopy = copied.value?.name === pluginName;
        record(
          'profile-link',
          isCopy ? 'warn' : 'error',
          isCopy
            ? `${linkPath} 是拷贝而不是链接，插件更新后不会同步`
            : `${linkPath} 是普通目录且不是本插件，需要你手工处理`,
        );
      }
    }
  }

  // ── 7. 偏好文件 ────────────────────────────────────────────────────────
  if (!existsSync(statePath)) {
    record('state-file', 'ok', '尚未写入（使用默认值）');
  } else {
    const parsed = await readJson(statePath);
    if (parsed.error !== undefined || parsed.value === null || typeof parsed.value !== 'object') {
      record('state-file', 'error', `偏好文件损坏：${parsed.error ?? '内容不是对象'}`, true);
    } else {
      record('state-file', 'ok', statePath);
    }
  }

  // ── 8. DSH 主目录可写 ─────────────────────────────────────────────────
  {
    const writableTarget = existsSync(statePath) ? statePath : undefined;
    try {
      await mkdir(home, { recursive: true });
      if (writableTarget !== undefined) {
        // 以读写方式打开但不写、不截断：内容与时间戳都不变，却能真实反映 ACL。
        // （Windows 上 access(W_OK) 只看只读属性，挡不住真正被拒的写入。）
        const handle = await open(writableTarget, 'r+');
        await handle.close();
      } else {
        await access(home, constants.W_OK);
      }
      record('home-writable', 'ok', home);
    } catch (error) {
      record('home-writable', 'error', `${home} 不可写：${messageOf(error)}`, true);
    }
  }

  // ── 9. Node 版本 ───────────────────────────────────────────────────────
  {
    const major = Number.parseInt(String(process.versions.node).split('.')[0], 10);
    record(
      'node-version',
      Number.isFinite(major) && major >= 20 ? 'ok' : 'error',
      `v${process.versions.node}${Number.isFinite(major) && major >= 20 ? '' : '（需要 v20 及以上）'}`,
    );
  }

  // ── 10. Harness 安装 ──────────────────────────────────────────────────
  {
    const installation = locateInstallation();
    record(
      'dsh-install',
      installation === undefined ? 'error' : 'ok',
      installation === undefined ? `定位不到全局安装的 ${PACKAGE_NAME}` : `${PACKAGE_NAME}@${installation.version}`,
    );
  }

  const errors = checks.filter((check) => check.status === 'error').length;
  const warnings = checks.filter((check) => check.status === 'warn').length;
  const repairable = checks.filter((check) => check.status !== 'ok' && check.repairable).length;
  return {
    ok: true,
    checkedAt: Date.now(),
    pluginRoot: root,
    pluginName,
    profileDir: profileDir ?? null,
    statePath,
    summary: { errors, warnings, repairable, total: checks.length },
    checks,
  };
}

/**
 * 修复可自动处理的问题。
 *
 * 逻辑：先查一遍，只对「确有问题且标记为可修复」的项动手；每项互相独立，
 * 一项失败不影响其它项。所有写操作都先备份，且只补充缺失内容。
 * @param {object} [options] 选项（同 checkIntegrity，额外支持 preferences）。
 * @returns {Promise<object>} 修复动作与修复后的新报告。
 */
export async function repairIntegrity(options = {}) {
  const before = await checkIntegrity(options);
  const root = before.pluginRoot;
  const env = options.env ?? process.env;
  const home = resolveHomeDir(env);
  const profileDir = before.profileDir ?? undefined;
  const pluginName = before.pluginName;
  const repaired = [];
  let restartRequired = false;

  const repair = async (id, action) => {
    try {
      const note = await action();
      repaired.push({ id, ok: true, note: note ?? '' });
    } catch (error) {
      repaired.push({ id, ok: false, error: messageOf(error) });
    }
  };

  const broken = before.checks.filter((check) => check.status !== 'ok' && check.repairable);

  if (broken.some((check) => check.id === 'profile-registration') && profileDir !== undefined) {
    await repair('profile-registration', async () => {
      const manifestPath = path.join(profileDir, 'package.json');
      const parsed = await readJson(manifestPath);
      if (parsed.error !== undefined) throw new Error(`无法读取 ${manifestPath}：${parsed.error}`);
      const manifest = parsed.value;
      if (manifest === null || typeof manifest !== 'object') throw new Error(`${manifestPath} 不是对象`);
      const backup = await backupFile(manifestPath);
      manifest.dependencies = { ...(manifest.dependencies ?? {}) };
      // 用正斜杠：pnpm 的 link: 说明符在 Windows 上也接受这种写法。
      manifest.dependencies[pluginName] = `link:${root.replace(/\\/g, '/')}`;
      manifest.dsh = { ...(manifest.dsh ?? {}) };
      manifest.dsh.profile = { ...(manifest.dsh.profile ?? {}) };
      const bundles = Array.isArray(manifest.dsh.profile.bundles) ? [...manifest.dsh.profile.bundles] : [];
      if (!bundles.includes(pluginName)) bundles.push(pluginName);
      manifest.dsh.profile.bundles = bundles;
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      restartRequired = true;
      return backup === undefined ? '已写入注册信息' : `已写入注册信息（备份 ${path.basename(backup)}）`;
    });
  }

  if (broken.some((check) => check.id === 'profile-link') && profileDir !== undefined) {
    await repair('profile-link', async () => {
      const linkPath = path.join(profileDir, 'node_modules', pluginName);
      await mkdir(path.dirname(linkPath), { recursive: true });
      let info;
      try {
        info = await lstat(linkPath);
      } catch {
        info = undefined;
      }
      if (info !== undefined) {
        if (!(await looksLikeLink(linkPath, info))) {
          throw new Error(`${linkPath} 已存在但不是链接，为避免误删真实目录，需要你手工处理`);
        }
        await removeLink(linkPath);
      }
      // 目录联接不需要管理员权限，这是 Windows 上重建 pnpm 链接最省事的办法。
      await symlink(root, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      restartRequired = true;
      return `已重建链接 → ${root}`;
    });
  }

  if (broken.some((check) => check.id === 'state-file')) {
    await repair('state-file', async () => {
      const statePath = options.statePath ?? path.join(home, 'dsh-update-center.json');
      const backup = await backupFile(statePath);
      await writeFile(statePath, `${JSON.stringify(options.preferences ?? {}, null, 2)}\n`, 'utf8');
      return backup === undefined ? '已重建偏好文件' : `已重建偏好文件（备份 ${path.basename(backup)}）`;
    });
  }

  if (broken.some((check) => check.id === 'home-writable')) {
    await repair('home-writable', async () => {
      await mkdir(home, { recursive: true });
      return `已创建 ${home}`;
    });
  }

  const after = await checkIntegrity(options);
  return {
    ok: true,
    repaired,
    repairedCount: repaired.filter((entry) => entry.ok).length,
    failedCount: repaired.filter((entry) => !entry.ok).length,
    restartRequired,
    report: after,
  };
}
