/**
 * lib/lifecycle.js 的停止/重启计划测试。
 *
 * 逻辑：这两个动作会在服务自己身上动刀，一旦参数拼错，结果不是「没反应」就是
 * 「服务起不来了」。因此这里不碰真实进程，只钉死「该调哪个脚本、带什么参数」：
 *   1. 能力判定只认磁盘上真实存在的脚本；
 *   2. 重启必须带 -ForceRestart，并沿用当前端口与工作区，避免重启后跑到别处；
 *   3. 缺脚本时必须抛错，而不是糊一个空命令出去；
 *   4. 安排动作时先写回包再执行——用假 spawn 验证参数形状。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  LAUNCH_SCRIPT,
  STOP_SCRIPT,
  planLifecycle,
  readRunState,
  resolveLifecycle,
  scheduleLifecycle,
} from '../lib/lifecycle.js';

/** 本次测试创建的临时目录，结束时统一清理。 */
const created = [];

/** 造一个假的 DSH 主目录，并按需放上启动器/停止脚本。 */
function makeHome({ launcher = true, stopper = true, runState } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-uc-lifecycle-'));
  created.push(home);
  if (launcher) writeFileSync(path.join(home, LAUNCH_SCRIPT), '# fake launcher\n');
  if (stopper) writeFileSync(path.join(home, STOP_SCRIPT), '# fake stopper\n');
  if (runState !== undefined) {
    mkdirSync(path.join(home, 'run'), { recursive: true });
    writeFileSync(path.join(home, 'run', 'web-server.json'), JSON.stringify(runState));
  }
  return home;
}

after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

describe('resolveLifecycle', () => {
  it('脚本齐全时两个动作都可用', () => {
    const home = makeHome();
    const capability = resolveLifecycle({ DSH_HOME: home });
    assert.equal(capability.home, home);
    assert.equal(capability.canStop, true);
    assert.equal(capability.canRestart, true);
    assert.equal(capability.stopper, path.join(home, STOP_SCRIPT));
    assert.equal(capability.launcher, path.join(home, LAUNCH_SCRIPT));
  });

  it('缺脚本时对应动作不可用，而不是假装可用', () => {
    const home = makeHome({ launcher: false });
    const capability = resolveLifecycle({ DSH_HOME: home });
    assert.equal(capability.canRestart, false);
    assert.equal(capability.canStop, true);
  });
});

describe('readRunState', () => {
  it('读得到启动器写下的端口与工作区', () => {
    const home = makeHome({ runState: { port: 3099, workspace: 'C:\\work' } });
    assert.deepEqual(readRunState({ DSH_HOME: home }), { port: 3099, workspace: 'C:\\work' });
  });

  it('文件缺失或损坏时返回 undefined，而不是抛错', () => {
    const home = makeHome();
    assert.equal(readRunState({ DSH_HOME: home }), undefined);
    mkdirSync(path.join(home, 'run'), { recursive: true });
    writeFileSync(path.join(home, 'run', 'web-server.json'), '{ 坏掉的 JSON');
    assert.equal(readRunState({ DSH_HOME: home }), undefined);
  });
});

describe('planLifecycle', () => {
  it('停止：只调停止脚本，不带 -ForceRestart', () => {
    const home = makeHome();
    const plan = planLifecycle('stop', resolveLifecycle({ DSH_HOME: home }), { port: 3080 });
    assert.equal(plan.script, path.join(home, STOP_SCRIPT));
    assert.ok(plan.args.includes('-File'));
    assert.equal(plan.args.includes('-ForceRestart'), false);
    assert.deepEqual(plan.args.slice(-2), ['-Port', '3080']);
  });

  it('重启：带 -ForceRestart，并沿用端口与工作区', () => {
    const home = makeHome();
    const plan = planLifecycle('restart', resolveLifecycle({ DSH_HOME: home }), {
      port: 3080,
      workspace: 'C:\\dsh',
    });
    assert.equal(plan.script, path.join(home, LAUNCH_SCRIPT));
    assert.ok(plan.args.includes('-ForceRestart'));
    assert.deepEqual(plan.args.slice(-4), ['-Port', '3080', '-Workspace', 'C:\\dsh']);
  });

  it('读不到运行状态时不硬塞端口参数', () => {
    const home = makeHome();
    const plan = planLifecycle('restart', resolveLifecycle({ DSH_HOME: home }), undefined);
    assert.equal(plan.args.includes('-Port'), false);
    assert.equal(plan.args.includes('-Workspace'), false);
  });

  it('脚本不存在时抛错，绝不糊一个空命令', () => {
    const capability = resolveLifecycle({ DSH_HOME: makeHome({ launcher: false, stopper: false }) });
    assert.throws(() => planLifecycle('stop', capability), /找不到停止脚本/);
    assert.throws(() => planLifecycle('restart', capability), /找不到启动器脚本/);
    assert.throws(() => planLifecycle('reboot', capability), /未知的生命周期动作/);
  });
});

describe('scheduleLifecycle', () => {
  it('把动作交给一个脱离本进程的子进程', async () => {
    const home = makeHome({ runState: { port: 3080, workspace: 'C:\\dsh' } });
    const calls = [];
    const result = scheduleLifecycle('restart', {
      env: { DSH_HOME: home },
      delayMs: 1,
      spawn: (target, args, options) => {
        calls.push({ target, args, options });
        return { unref() {} };
      },
    });
    assert.equal(result.scheduled, true);
    assert.equal(result.action, 'restart');
    // 延后执行：此刻还没有真的 spawn。
    assert.equal(calls.length, 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls.length, 1);
    // Windows 上必须是 detached:false —— 见 lib/lifecycle.js 里那段注释：
    // DETACHED_PROCESS 会让 Windows PowerShell 以退出码 0 静默退出、脚本一行不跑。
    assert.deepEqual(calls[0].options, {
      detached: process.platform !== 'win32',
      stdio: 'ignore',
      windowsHide: true,
    });
    assert.ok(calls[0].args.includes('-ForceRestart'));
    assert.equal(calls[0].args.at(-1), 'C:\\dsh');
  });

  it('子进程启动失败时如实上报，而不是静默失败', async () => {
    const home = makeHome();
    const events = [];
    scheduleLifecycle('restart', {
      env: { DSH_HOME: home },
      delayMs: 1,
      spawn: () => ({
        pid: 0,
        unref() {},
        on(event, handler) {
          if (event === 'error') handler(new Error('boom'));
        },
      }),
      onEvent: (event) => events.push(event),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(events.length, 1);
    assert.equal(events[0].ok, false);
    assert.match(events[0].error, /boom/);
  });

  it('子进程成功拉起时上报 pid', async () => {
    const home = makeHome();
    const events = [];
    scheduleLifecycle('restart', {
      env: { DSH_HOME: home },
      delayMs: 1,
      spawn: () => ({
        pid: 4242,
        unref() {},
        on(event, handler) {
          if (event === 'spawn') handler();
        },
      }),
      onEvent: (event) => events.push(event),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(events, [{ ok: true, pid: 4242 }]);
  });

  it('真的能把 PowerShell 拉起来执行脚本（Windows 冒烟测试）', { skip: process.platform !== 'win32' }, async () => {
    // 这条用例是这次故障的直接产物：只断言「spawn 被调用了」并不够，
    // 因为 detached 的写法会让 PowerShell 起得来、退得掉、却什么都不执行。
    const home = makeHome();
    const marker = path.join(home, 'marker.txt');
    const script = path.join(home, 'probe.ps1');
    writeFileSync(script, `Set-Content -LiteralPath "${marker}" -Value ok -Encoding UTF8\n`);
    scheduleLifecycle('restart', {
      env: { DSH_HOME: home },
      delayMs: 1,
      capability: { home, launcher: script, stopper: script, canRestart: true, canStop: true },
    });
    const deadline = Date.now() + 10_000;
    while (!existsSync(marker) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(existsSync(marker), 'PowerShell 没有真正执行脚本（典型症状：detached 导致静默退出）');
  });

  it('缺脚本时立刻抛错，不安排任何东西', () => {
    const home = makeHome({ stopper: false });
    assert.throws(() => scheduleLifecycle('stop', { env: { DSH_HOME: home }, delayMs: 1 }), /找不到停止脚本/);
  });
});
