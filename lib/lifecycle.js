/**
 * 服务的停止与重启：把桌面快捷方式干的事搬进设置页。
 *
 * 用途：用户很自然会以为「关掉网页 = 停掉 Harness」，实际不是——关浏览器只是
 * 断开连接，服务仍在后台跑；而更新插件或改配置之后又必须重启才生效。这里让
 * 面板直接提供这两个动作。
 *
 * 逻辑要点：
 *   - **不自己实现杀进程与拉起**，而是调用用户机器上已有的启动器脚本
 *     （`launch-deepseek-harness.ps1` / `stop-deepseek-harness.ps1`）。那套脚本
 *     知道怎么认端口、怎么清状态文件、怎么带令牌打开浏览器；复用它意味着行为
 *     与桌面快捷方式完全一致，也不会出现两套停止逻辑互相打架。
 *   - 动作**延后执行**：本进程就是要被停掉的那个，必须先让 HTTP 回包发出去。
 *   - 子进程 `detached` + `stdio: 'ignore'`：它必须活过本进程的死亡。
 *
 * @module @local/dsh-update-center/lib/lifecycle
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { resolveHomeDir } from './integrity.js';

/** 取一个未知抛出物的可读信息。 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 启动器脚本名（由安装器放在 DSH 主目录下）。 */
export const LAUNCH_SCRIPT = 'launch-deepseek-harness.ps1';
/** 停止脚本名。 */
export const STOP_SCRIPT = 'stop-deepseek-harness.ps1';
/** 动作延后执行的毫秒数：够把 HTTP 回包发完，又短到用户感觉不到等待。 */
export const LIFECYCLE_DELAY_MS = 1_500;

/**
 * 判断这台机器上能不能停止/重启服务。
 * @param {NodeJS.ProcessEnv} [env] 环境变量。
 * @returns {{home: string, launcher: string, stopper: string, canRestart: boolean, canStop: boolean}} 能力与脚本路径。
 */
export function resolveLifecycle(env = process.env) {
  const home = resolveHomeDir(env);
  const launcher = path.join(home, LAUNCH_SCRIPT);
  const stopper = path.join(home, STOP_SCRIPT);
  return {
    home,
    launcher,
    stopper,
    canRestart: existsSync(launcher),
    canStop: existsSync(stopper),
  };
}

/**
 * 读启动器写下的运行状态。
 *
 * 逻辑：重启要沿用同一个端口与工作区，否则新进程可能跑到别的端口上，
 * 用户会以为「重启把服务弄丢了」。读不到就退回脚本默认值。
 * @param {NodeJS.ProcessEnv} [env] 环境变量。
 * @returns {object|undefined} `run/web-server.json` 的内容。
 */
export function readRunState(env = process.env) {
  const statePath = path.join(resolveHomeDir(env), 'run', 'web-server.json');
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 把一次动作折算成要执行的命令行（纯函数，便于测试）。
 * @param {'stop'|'restart'} action 动作。
 * @param {object} capability resolveLifecycle 的结果。
 * @param {object|undefined} runState 运行状态。
 * @returns {{action: string, script: string, target: string, args: string[]}} 命令计划。
 */
export function planLifecycle(action, capability, runState) {
  if (action !== 'stop' && action !== 'restart') throw new Error(`未知的生命周期动作 "${action}"`);
  if (action === 'stop' && capability?.canStop !== true) {
    throw new Error(`找不到停止脚本 ${capability?.stopper ?? '(未知路径)'}`);
  }
  if (action === 'restart' && capability?.canRestart !== true) {
    throw new Error(`找不到启动器脚本 ${capability?.launcher ?? '(未知路径)'}`);
  }
  const script = action === 'stop' ? capability.stopper : capability.launcher;
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script];
  if (action === 'restart') args.push('-ForceRestart');
  if (Number.isFinite(runState?.port)) args.push('-Port', String(runState.port));
  if (action === 'restart' && typeof runState?.workspace === 'string' && runState.workspace !== '') {
    args.push('-Workspace', runState.workspace);
  }
  return {
    action,
    script,
    target: process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
    args,
  };
}

/**
 * 安排一次停止或重启。
 * @param {'stop'|'restart'} action 动作。
 * @param {object} [options] 选项（env / delayMs / spawn / capability，测试用）。
 * @returns {object} 已安排的动作描述，可直接回给页面。
 */
export function scheduleLifecycle(action, options = {}) {
  const env = options.env ?? process.env;
  const delayMs = options.delayMs ?? LIFECYCLE_DELAY_MS;
  const spawnFn = options.spawn ?? spawn;
  const capability = options.capability ?? resolveLifecycle(env);
  const plan = planLifecycle(action, capability, readRunState(env));
  const report = typeof options.onEvent === 'function' ? options.onEvent : () => {};
  const timer = setTimeout(() => {
    try {
      const child = spawnFn(plan.target, plan.args, {
        // Windows 上绝不能用 detached：它会带来 DETACHED_PROCESS（新进程没有控制台），
        // 而 Windows PowerShell 在这种状态下会**以退出码 0 静默退出、一行脚本都不执行**
        // （实测：detached 的四个变体全部没跑起来，去掉 detached 立刻正常）。
        // 这里本来也不需要它——Windows 不会因父进程退出而杀掉子进程，
        // 启动器脚本自己就是这么把服务留在后台的。
        detached: process.platform !== 'win32',
        stdio: 'ignore',
        windowsHide: true,
      });
      // 没有 error 监听时，子进程启动失败会以未捕获异常的形式把宿主进程带崩。
      child.on?.('error', (error) => report({ ok: false, error: messageOf(error) }));
      child.on?.('spawn', () => report({ ok: true, pid: child.pid }));
      child.unref?.();
    } catch (error) {
      report({ ok: false, error: messageOf(error) });
    }
  }, delayMs);
  // 不让这个定时器成为进程退不出去的理由。
  timer.unref?.();
  return {
    scheduled: true,
    action: plan.action,
    delayMs,
    script: plan.script,
    command: `${plan.target} ${plan.args.join(' ')}`,
  };
}
