/**
 * 更新面板的 Host 内核：状态、路由与自动检测/自动安装。
 *
 * 用途：把「我现在是什么版本」「仓库上是什么版本」「怎么换掉」三件事收在
 * 一个对象里，并通过一条只对本机回环开放的 HTTP 前缀暴露给浏览器半边。
 * Client 侧因此不需要任何 Harness Client 包，只需要 fetch。
 *
 * 逻辑分层：
 *   - 状态（state）是唯一的真相来源，路由只读写它；
 *   - 偏好（通道/自动检测/自动安装/频率）落盘到 <DSH_HOME>/dsh-update-center.json，
 *     运行期数据（输出、错误）只留在内存；
 *   - 检查与安装都是「同时只允许一个」，避免并发 npm 进程互相踩文件。
 *
 * @module @local/dsh-update-center/lib/center
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { buildInstallCommand, detectPackageManager, locateInstallation, PACKAGE_NAME } from './installation.js';
import { checkIntegrity, repairIntegrity } from './integrity.js';
import { resolveLifecycle, scheduleStop } from './lifecycle.js';
import { contentV2Dir, countFetchLines, directoryBytes, isStalled, resolveNpmCacheRoot } from './progress.js';
import { isNewer, parseVersion } from './semver.js';

/** 本插件占用的绝对路由前缀；Client 侧必须与此保持一致。 */
export const ROUTE_PREFIX = '/dsh-update-center';

/** 允许选择的发布通道；同时充当注册表 dist-tag 白名单。 */
export const CHANNELS = ['latest', 'next'];

/** 未配置或配置不可用时的注册表地址。 */
const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

/** 一次注册表读取的超时时间。 */
const CHECK_TIMEOUT_MS = 20_000;
/** 安装日志在内存中保留的最大行数，超出丢弃最早的行。 */
const MAX_LOG_LINES = 400;
/** 单个请求体的字节上限，防止异常请求把内存吃满。 */
const MAX_BODY_BYTES = 64 * 1024;
/** 自动检测的巡检间隔：每次只判断「该不该查」，不直接发网络请求。 */
const AUTO_CHECK_TICK_MS = 5 * 60 * 1000;
/** 首次自动检测的延迟，避免和 Harness 启动抢网络与 CPU。 */
const AUTO_CHECK_DELAY_MS = 4_000;
/** 默认的检测频率（小时）。 */
const DEFAULT_INTERVAL_HOURS = 6;
/** 安装进度的心跳间隔：只刷新已用时长与静默判定，不发任何请求。 */
const PROGRESS_TICK_MS = 1_000;
/** 采样下载缓存体积的最小间隔；递归量目录有成本，不能跟着心跳每秒跑。 */
const CACHE_SAMPLE_MS = 3_000;

/** 取一个未知抛出物的可读信息。 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 判断请求是否来自本机回环地址。
 *
 * 逻辑：这条路由能改写全局 npm 安装，因此必须拒绝对外暴露的部署。
 * 只认显式的回环地址——空 remoteAddress 也判为拒绝，宁可失败也不放行。
 * @param {import('node:http').IncomingMessage} req 请求对象。
 * @returns {boolean} 是否来自回环。
 */
export function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress ?? '';
  return address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.');
}

/**
 * 读取并解析 JSON 请求体。
 * @param {import('node:http').IncomingMessage} req 请求对象。
 * @returns {Promise<object|undefined>} 解析出的对象；空体返回 {}，非法体返回 undefined。
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // 超限即断开，避免继续为一个异常请求分配内存。
        settle(undefined);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') {
        settle({});
        return;
      }
      try {
        const value = JSON.parse(text);
        // 只接受普通对象：数组和 null 都不是本 API 的入参形状。
        settle(value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined);
      } catch {
        settle(undefined);
      }
    });
    req.on('error', () => settle(undefined));
  });
}

/**
 * 以 JSON 响应一个请求。
 * @param {import('node:http').ServerResponse} res 响应对象。
 * @param {number} status HTTP 状态码。
 * @param {object} value 要序列化的结果。
 */
function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    // 状态随时会变，任何缓存都会让页面显示过期版本。
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * 从环境推导偏好文件路径。
 * @returns {string} <DSH_HOME>/dsh-update-center.json 的绝对路径。
 */
function resolveStatePath() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : path.join(homedir(), '.dsh');
  return path.join(home, 'dsh-update-center.json');
}

/** 把任意输入规整成配置对象。 */
function normalizeConfig(config) {
  return config !== null && typeof config === 'object' ? config : {};
}

/**
 * 校验注册表地址。
 *
 * 逻辑：这个字符串最终会以 `--registry=<地址>` 的形式进入安装命令行，而 Windows 上的
 * 安装命令经由 shell 执行（原因见 runUpdate），所以它同样不能是任意字符串。这里只
 * 接受能被 URL 解析、且协议为 http/https 的地址；其余一律退回官方源——**退回比透传安全**，
 * 而且一个连 URL 都算不上的地址本来也读不出任何版本信息。
 * @param {unknown} value 配置里的 registry 字段。
 * @returns {string} 可用的注册表地址。
 */
function resolveRegistry(value) {
  if (typeof value !== 'string' || value.trim() === '') return DEFAULT_REGISTRY;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return value;
  } catch {
    /* 不是合法 URL，按不可用处理 */
  }
  return DEFAULT_REGISTRY;
}

/** 把小时数规整成合法正数，否则取默认值。 */
function normalizeHours(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 建立更新面板实例。
 * @param {object} [config] 补丁行里的 config；字段全部可选。
 * @returns {{state: object, handle: Function, mount: Function, dispose: Function}} 面板实例。
 */
export function createUpdateCenter(config) {
  const settings = normalizeConfig(config);
  const statePath = resolveStatePath();

  /**
   * 运行期状态。路由把整个对象序列化给页面，因此这里的字段就是对外契约。
   */
  const state = {
    packageName: PACKAGE_NAME,
    channel: CHANNELS.includes(settings.channel) ? settings.channel : 'latest',
    registry: resolveRegistry(settings.registry),
    // 自动检测默认开启：它只读网络，不改变本机任何东西。
    autoCheck: settings.autoCheck !== false,
    // 自动安装默认关闭：它会替换正在运行的全局包，必须由用户显式承担。
    autoInstall: settings.autoInstall === true,
    checkIntervalHours: normalizeHours(settings.checkIntervalHours, DEFAULT_INTERVAL_HOURS),
    // 磁盘上的版本（安装成功后会被刷新）。
    currentVersion: undefined,
    // 用 null 而不是 undefined：这几个「无错误」槽位要稳定出现在 JSON 里，
    // 页面才能用 `!= null` 一次判定，而不是区分「字段不存在」和「字段为空」。
    currentVersionError: null,
    // 本进程启动时加载的版本，用来区分「已装到磁盘」和「正在运行」。
    runningVersion: undefined,
    latestVersion: undefined,
    updateAvailable: false,
    checking: false,
    checkedAt: undefined,
    checkError: null,
    updating: false,
    updateTarget: undefined,
    updateManager: undefined,
    updateOutput: [],
    updateResult: null,
    installCommand: undefined,
    restartRequired: false,
    // 停止的能力与脚本路径；在 mount 时按本机实际情况填好。
    lifecycle: undefined,
    // 最近一次停止动作的结果（子进程是否真的起来了）。
    lifecycleLast: undefined,
    // ── 安装进度 ──────────────────────────────────────────────────────────
    // 这几项存在的唯一理由：npm 在管道里完全静默，页面需要别的东西证明
    // 「进程还在干活」。时间永远在走，字节只在真的下载时增长，输出行数
    // 只在真的拿到应答时增加——三者一起才够判断。
    updateStartedAt: undefined,
    updateFinishedAt: undefined,
    updateElapsedMs: 0,
    updateLastOutputAt: undefined,
    updateLastGrowthAt: undefined,
    updateFetchCount: 0,
    updatePackageCount: 0,
    updateCacheBytes: undefined,
    updateCacheRate: undefined,
    updateSilentMs: 0,
    updateStalled: false,
  };

  /** 正在运行的安装子进程；dispose 时要把它一起收掉。 */
  let installer = null;
  /** 已经自动装过的目标版本，防止一次检测反复触发安装。 */
  let lastAutoInstallTarget;
  /** 进度心跳定时器；只在安装期间存在。 */
  let progressTimer = null;
  /** 上一次缓存采样，用来算下载速率。 */
  let cacheSample = { at: 0, bytes: undefined };

  /**
   * 重新读取安装清单。
   * 逻辑：安装成功后磁盘上的版本会变，所以每次读写前都重新定位一次，
   * 而不是缓存启动时的结果。
   */
  function refreshCurrentVersion() {
    const installation = locateInstallation();
    if (installation === undefined) {
      state.currentVersionError = `无法从当前进程定位 ${PACKAGE_NAME} 的安装位置`;
      return;
    }
    state.currentVersion = installation.version;
    state.currentVersionError = null;
    // 只记录第一次读到的版本，作为「本进程正在跑什么」的基准。
    if (state.runningVersion === undefined) state.runningVersion = installation.version;
  }

  /** 载入落盘的偏好；文件缺失或损坏都只是回退到 config 默认值。 */
  function loadPreferences() {
    if (!existsSync(statePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
      if (parsed === null || typeof parsed !== 'object') return;
      if (CHANNELS.includes(parsed.channel)) state.channel = parsed.channel;
      if (typeof parsed.autoCheck === 'boolean') state.autoCheck = parsed.autoCheck;
      if (typeof parsed.autoInstall === 'boolean') state.autoInstall = parsed.autoInstall;
      if (Number.isFinite(parsed.checkIntervalHours) && parsed.checkIntervalHours > 0) {
        state.checkIntervalHours = parsed.checkIntervalHours;
      }
      // 上次检测时间跨重启保留，避免每次启动都立刻打一次注册表。
      if (Number.isFinite(parsed.checkedAt)) state.checkedAt = parsed.checkedAt;
      if (typeof parsed.latestVersion === 'string') state.latestVersion = parsed.latestVersion;
      if (parsed.lastLifecycle !== null && typeof parsed.lastLifecycle === 'object') {
        state.lifecycleLast = parsed.lastLifecycle;
      }
    } catch {
      /* 偏好文件损坏时静默回退，不影响面板可用性 */
    }
  }

  /** 需要落盘的用户偏好；安装与偏好修复共用同一份形状。 */
  function preferencePayload() {
    return {
      channel: state.channel,
      autoCheck: state.autoCheck,
      autoInstall: state.autoInstall,
      checkIntervalHours: state.checkIntervalHours,
      checkedAt: state.checkedAt,
      latestVersion: state.latestVersion,
      // 上一次停止的结果也落盘：动作会把本进程换掉，只有写进文件才能在新进程里
      // 回答「我刚刚点的那个按钮到底生效没有」。
      lastLifecycle: state.lifecycleLast,
    };
  }

  /** 持久化用户偏好；写失败不抛出，因为面板本身仍然可用。 */
  async function savePreferences() {
    const payload = JSON.stringify(preferencePayload(), null, 2);
    try {
      await writeFile(statePath, payload, 'utf8');
    } catch {
      /* 只读的 HOME 属正常部署，落盘失败不应让页面报错 */
    }
  }

  /**
   * 把注册表返回的 dist-tags 折算成「是否有更新」。
   *
   * 逻辑：注册表是**外部输入**，而这里读到的版本号稍后会被拼进安装命令行。因此
   * 「读不懂」必须当场拒绝，而不是先存下来、等安装那一步再说——这与本插件一贯的
   * 「不把读不懂当成已是最新」是同一条规矩，只是后果更重：一个不是版本号的字符串
   * 一旦活到 runUpdate，就进了命令行参数。
   * @param {Record<string, string>|undefined} tags 注册表的 dist-tags。
   */
  function applyDistTags(tags) {
    const target = typeof tags?.[state.channel] === 'string' ? tags[state.channel] : tags?.latest;
    if (typeof target !== 'string') throw new Error(`注册表没有返回 "${state.channel}" 标签`);
    if (parseVersion(target) === undefined) {
      throw new Error(`注册表返回的 "${state.channel}" 标签不是合法版本号："${target}"`);
    }
    state.latestVersion = target;
    // 当前版本未知时不判断更新，避免把「读不懂」说成「已是最新」。
    state.updateAvailable = state.currentVersion === undefined
      ? false
      : isNewer(target, state.currentVersion);
  }

  /** 向注册表查询所选通道发布的版本。 */
  async function runCheck() {
    // 并发检查会互相覆盖状态，直接忽略后到的请求。
    if (state.checking || state.updating) return;
    state.checking = true;
    state.checkError = null;
    try {
      refreshCurrentVersion();
      const url = `${state.registry.replace(/\/+$/, '')}/${PACKAGE_NAME.replace('/', '%2F')}`;
      const response = await fetch(url, {
        // 带上这个 Accept 头可以让注册表返回精简版 metadata，体积小很多。
        headers: { accept: 'application/vnd.npm.install-v1+json' },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`注册表返回 HTTP ${response.status}`);
      const body = await response.json();
      applyDistTags(body?.['dist-tags']);
      state.checkedAt = Date.now();
      await savePreferences();
    } catch (error) {
      state.checkError = messageOf(error);
    } finally {
      state.checking = false;
    }
    maybeAutoInstall();
  }

  /**
   * 自动安装的闸门。
   * 逻辑：只在「用户开了自动安装 + 确实有新版 + 这个版本还没自动装过」时才动手；
   * lastAutoInstallTarget 保证一次检测只会触发一次安装，失败后也不会重试风暴。
   */
  function maybeAutoInstall() {
    if (!state.autoInstall || state.updating || state.checkError != null) return;
    if (!state.updateAvailable || typeof state.latestVersion !== 'string') return;
    if (state.latestVersion === lastAutoInstallTarget) return;
    lastAutoInstallTarget = state.latestVersion;
    runUpdate(state.latestVersion);
  }

  /** 按频率判断是否该发起一次自动检测。 */
  function maybeAutoCheck() {
    if (!state.autoCheck || state.checking || state.updating) return;
    const interval = state.checkIntervalHours * 60 * 60 * 1000;
    if (state.checkedAt !== undefined && Date.now() - state.checkedAt < interval) return;
    void runCheck();
  }

  /** 追加安装输出，并保留尾部若干行。 */
  function appendOutput(text) {
    const lines = String(text).split(/\r?\n/).filter((line) => line.trim() !== '');
    if (lines.length === 0) return;
    state.updateOutput = [...state.updateOutput, ...lines].slice(-MAX_LOG_LINES);
    // 有任何一行输出就是一次活动，静默判定据此复位。
    state.updateLastOutputAt = Date.now();
    const counted = countFetchLines(lines.join('\n'));
    if (counted.fetches > 0) state.updateFetchCount += counted.fetches;
    if (counted.packages > 0) state.updatePackageCount += counted.packages;
  }

  /**
   * 采样 npm 下载缓存的体积，并据此更新速率。
   *
   * 逻辑：这是「静默下载」期间唯一还会增长的信号，所以它必须便宜且容错：
   * 量不到就保持上一次的值，绝不因为缓存目录不认识而把进度清零。
   * @param {boolean} [force] 忽略采样间隔（安装结束时收尾用）。
   */
  async function sampleDownloadCache(force = false) {
    // pnpm 的缓存布局不同，宁可不显示字节数，也不显示一个错的数字。
    if (state.updateManager !== 'npm') return;
    const now = Date.now();
    if (!force && now - cacheSample.at < CACHE_SAMPLE_MS) return;
    const previous = cacheSample;
    const bytes = await directoryBytes(contentV2Dir(resolveNpmCacheRoot()));
    cacheSample = { at: now, bytes: bytes ?? previous.bytes };
    if (bytes === undefined) return;
    state.updateCacheBytes = bytes;
    if (previous.bytes !== undefined && bytes > previous.bytes && previous.at > 0) {
      const seconds = Math.max(1, (now - previous.at) / 1000);
      state.updateCacheRate = Math.round((bytes - previous.bytes) / seconds);
      state.updateLastGrowthAt = now;
    }
  }

  /** 推进一次进度心跳：刷新已用时长、静默标记，并顺带采样缓存体积。 */
  function tickProgress() {
    const now = Date.now();
    if (state.updateStartedAt !== undefined) {
      state.updateElapsedMs = (state.updateFinishedAt ?? now) - state.updateStartedAt;
    }
    // 活动时间取「输出」和「字节增长」的较大者：两者的静默原因不同，
    // 任一在动就说明安装还在推进。
    const lastActivity = Math.max(
      state.updateLastOutputAt ?? 0,
      state.updateLastGrowthAt ?? 0,
      state.updateStartedAt ?? 0,
    );
    state.updateStalled = state.updating === true && isStalled(now, lastActivity);
    state.updateSilentMs = now - lastActivity;
    void sampleDownloadCache();
  }

  /** 启动进度心跳。 */
  function startProgress() {
    stopProgress();
    progressTimer = setInterval(tickProgress, PROGRESS_TICK_MS);
    // unref：心跳绝不能成为进程退不出去的原因。
    progressTimer.unref?.();
  }

  /** 停掉进度心跳。 */
  function stopProgress() {
    if (progressTimer === null) return;
    clearInterval(progressTimer);
    progressTimer = null;
  }

  /** 收尾：冻结计时、清掉静默标记，并做最后一次缓存采样。 */
  function finishProgress() {
    stopProgress();
    // error 与 close 会先后到达，第二次收尾不应把已冻结的耗时再往后推。
    if (state.updateFinishedAt === undefined) state.updateFinishedAt = Date.now();
    if (state.updateStartedAt !== undefined) {
      state.updateElapsedMs = state.updateFinishedAt - state.updateStartedAt;
    }
    state.updateStalled = false;
    void sampleDownloadCache(true);
  }

  /**
   * 把目标版本装进同一个全局前缀，并把过程输出到 state 供页面轮询。
   *
   * 这里是**唯一的安装出口**，所以版本号在这里做最后一道校验：下面 spawn 用的是
   * `shell: true`（原因见该处注释），参数不会再被转义，一个不是版本号的字符串若能
   * 走到那里就等于一条命令注入。applyDistTags 已经挡过一次，但安全闸不能只建在
   * 调用方——所以这里再挡一次，并且这一层才是真正贴着危险动作的那层。
   * @param {string} version 目标版本号。
   * @returns {boolean} 是否真的启动了安装器。
   */
  function runUpdate(version) {
    if (state.updating) return false;
    if (parseVersion(version) === undefined) {
      const error = `拒绝安装：${String(version)} 不是合法的版本号`;
      state.updateOutput = [error];
      state.updateResult = { ok: false, error };
      state.updateTarget = undefined;
      state.updateManager = undefined;
      return false;
    }
    const installation = locateInstallation();
    const manager = installation === undefined ? 'npm' : detectPackageManager(installation.dir);
    const { command, args, display } = buildInstallCommand(manager, version, state.registry);

    state.updating = true;
    state.updateTarget = version;
    state.updateManager = manager;
    state.updateOutput = [];
    state.updateResult = null;
    state.installCommand = display;
    state.checkError = null;
    // 进度字段整体复位：上一次安装的字节数或耗时留在页面上会直接骗人。
    state.updateStartedAt = Date.now();
    state.updateFinishedAt = undefined;
    state.updateElapsedMs = 0;
    state.updateLastOutputAt = undefined;
    state.updateLastGrowthAt = undefined;
    state.updateFetchCount = 0;
    state.updatePackageCount = 0;
    state.updateCacheBytes = undefined;
    state.updateCacheRate = undefined;
    state.updateStalled = false;
    cacheSample = { at: 0, bytes: undefined };
    appendOutput(`$ ${display}`);

    let child;
    try {
      child = spawn(command, args, {
        // Windows 上 npm/pnpm 是 .cmd 包装脚本，必须经由 shell 才能找到。
        // shell: true 的代价是参数不再被转义，所以 args 里**不允许**出现未经校验的
        // 外部输入：spec 的版本号在函数入口已按 semver 校验，registry 在
        // resolveRegistry 里已限定为 http/https 的合法 URL。
        shell: process.platform === 'win32',
        windowsHide: true,
        env: process.env,
      });
    } catch (error) {
      state.updating = false;
      state.updateResult = { ok: false, error: messageOf(error) };
      finishProgress();
      return false;
    }
    installer = child;
    // 心跳先于输出到达：慢的第一秒里页面就已经有东西在动了。
    startProgress();

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', appendOutput);
    child.stderr?.on('data', appendOutput);

    child.on('error', (error) => {
      installer = null;
      state.updating = false;
      state.updateResult = { ok: false, error: messageOf(error) };
      appendOutput(`安装器启动失败：${messageOf(error)}`);
      finishProgress();
    });

    child.on('close', (code) => {
      installer = null;
      state.updating = false;
      // error 先到时会写好原因，close 不能用一个光秃秃的退出码把它盖掉。
      if (state.updateResult === null) state.updateResult = { ok: code === 0, exitCode: code };
      // 安装成功与否都以磁盘上的实际版本为准，而不是以退出码为准。
      const before = state.currentVersion;
      refreshCurrentVersion();
      state.updateAvailable = state.currentVersion === undefined
        ? false
        : isNewer(state.latestVersion, state.currentVersion);
      if (code === 0 && state.currentVersion !== before) state.restartRequired = true;
      appendOutput(code === 0
        ? `已安装 ${PACKAGE_NAME}@${version}；重启 Harness 后生效`
        : `安装器退出码 ${code}`);
      finishProgress();
    });

    return true;
  }

  /**
   * 处理一次请求。
   * @param {import('node:http').IncomingMessage} req 请求对象。
   * @param {import('node:http').ServerResponse} res 响应对象。
   */
  async function handle(req, res) {
    // 第一道闸：非回环一律拒绝，且不泄露任何状态。
    if (!isLoopbackRequest(req)) {
      sendJson(res, 403, { ok: false, error: '更新面板只对本机回环地址开放' });
      return;
    }

    const url = new URL(typeof req.url === 'string' && req.url !== '' ? req.url : '/', 'http://127.0.0.1');
    const action = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '');
    const method = req.method ?? 'GET';
    /** 拼出完整的对外状态快照。 */
    const snapshot = () => ({ ok: true, ...state, channels: CHANNELS, statePath });

    if (method === 'GET' && (action === '' || action === 'state')) {
      sendJson(res, 200, snapshot());
      return;
    }
    if (method === 'GET' && action === 'integrity') {
      // 只读自检：查文件、依赖链接与运行环境，不改动磁盘上的任何东西。
      sendJson(res, 200, await checkIntegrity({ statePath }));
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { ok: false, error: `不支持的方法 ${method}` });
      return;
    }

    const body = await readJsonBody(req);
    if (body === undefined) {
      sendJson(res, 400, { ok: false, error: '请求体必须是合法的 JSON 对象' });
      return;
    }

    if (action === 'check') {
      if (CHANNELS.includes(body.channel)) state.channel = body.channel;
      // 等检查结束再回包，页面因此在一次往返后就能看到最新结论。
      await runCheck();
      sendJson(res, 200, snapshot());
      return;
    }

    if (action === 'settings') {
      if (typeof body.autoCheck === 'boolean') state.autoCheck = body.autoCheck;
      if (typeof body.autoInstall === 'boolean') state.autoInstall = body.autoInstall;
      if (CHANNELS.includes(body.channel)) state.channel = body.channel;
      if (Number.isFinite(body.checkIntervalHours) && body.checkIntervalHours > 0) {
        state.checkIntervalHours = body.checkIntervalHours;
      }
      await savePreferences();
      // 刚打开自动检测时立刻补一次，否则用户要等满一个周期才看到结果。
      if (state.autoCheck) maybeAutoCheck();
      sendJson(res, 200, snapshot());
      return;
    }

    if (action === 'update') {
      if (CHANNELS.includes(body.channel) && body.channel !== state.channel) {
        state.channel = body.channel;
        await runCheck();
      }
      if (state.updating) {
        sendJson(res, 409, { ok: false, error: '已有安装任务在进行中', ...state });
        return;
      }
      if (typeof state.latestVersion !== 'string') {
        sendJson(res, 409, { ok: false, error: '尚未检测到可用版本，请先检测', ...state });
        return;
      }
      // 立即返回，页面改由轮询 /state 观察进度。
      // 版本号校验就在 runUpdate 入口，因此这里以它的返回值决定回包状态码，
      // 而不是在这个调用方再抄一份判定。
      if (!runUpdate(state.latestVersion)) {
        sendJson(res, 409, { ok: false, error: state.updateResult?.error ?? '已有安装任务在进行中', ...state });
        return;
      }
      sendJson(res, 200, snapshot());
      return;
    }

    if (action === 'stop') {
      // 安装中途停止会把 npm 一起带走，装出来的树可能不完整。
      if (state.updating) {
        sendJson(res, 409, { ok: false, error: '有安装任务在进行中，请等它结束', ...state });
        return;
      }
      const capability = state.lifecycle ?? resolveLifecycle();
      try {
        // 动作延后一两秒执行：本进程正是要被停掉的那个，得先把回包发完。
        const plan = scheduleStop({
          capability,
          // 子进程是否真的起来了只有事件知道。记进状态并落盘，失败了页面能看见，
          // 而不是像「点了没反应」那样无从查起。
          onEvent: (event) => {
            state.lifecycleLast = { at: Date.now(), ...event };
            void savePreferences();
          },
        });
        // 安排成功才记「已受理」，并立刻落盘——稍后本进程就要被停掉，事后再写就晚了。
        // onEvent 若来得及发生，会把这条覆盖成最终结果。
        state.lifecycleLast = { at: Date.now(), ok: undefined };
        await savePreferences();
        sendJson(res, 200, { ...snapshot(), ...plan });
      } catch (error) {
        // 脚本缺失之类的问题在这一步抛出来，不写任何记录。
        sendJson(res, 409, { ok: false, error: messageOf(error), ...state });
      }
      return;
    }

    if (action === 'repair') {
      // 修复会写 profile 清单/链接与偏好文件，因此只做「把缺的补回去」，
      // 且每一项都先备份；修完把重新自检的结果一并返回。
      const result = await repairIntegrity({ statePath, preferences: preferencePayload() });
      sendJson(res, 200, result);
      return;
    }

    sendJson(res, 404, { ok: false, error: `未知操作 "${action}"` });
  }

  /**
   * 安装路由与定时巡检。
   * @param {{webServer: {register: Function}, effect: Function}} ctx Host 插件上下文。
   * @returns {() => void} 释放路由、定时器与子进程的清理函数。
   */
  function mount(ctx) {
    loadPreferences();
    refreshCurrentVersion();
    // 本机是否有启动器/停止脚本，决定了「运行控制」卡片能不能点。
    state.lifecycle = resolveLifecycle();

    const removeRoute = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req, res) => {
        // handle 内部已把业务错误转成状态码，这里只兜底未预期的异常。
        void handle(req, res).catch((error) => {
          if (res.headersSent) {
            res.destroy();
            return;
          }
          sendJson(res, 500, { ok: false, error: messageOf(error) });
        });
      },
    });

    // unref 让这两个定时器不阻止进程退出。
    const tick = setInterval(maybeAutoCheck, AUTO_CHECK_TICK_MS);
    tick.unref?.();
    const kickoff = setTimeout(maybeAutoCheck, AUTO_CHECK_DELAY_MS);
    kickoff.unref?.();
    // 巡检本身也要在卸载时停掉，否则插件禁用后仍会发网络请求。
    return () => {
      removeRoute();
      clearInterval(tick);
      clearTimeout(kickoff);
      dispose();
    };
  }

  /** 结束仍在运行的安装子进程；插件被卸载时不留孤儿进程。 */
  function dispose() {
    stopProgress();
    if (installer === null) return;
    const child = installer;
    installer = null;
    state.updating = false;
    try {
      child.kill();
    } catch {
      /* 进程可能已经退出，忽略 */
    }
  }

  return { state, handle, mount, dispose };
}
