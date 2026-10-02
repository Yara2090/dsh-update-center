/**
 * lib/lifecycle.js 的停止计划测试。
 *
 * 逻辑：这个动作会在服务自己身上动刀，一旦参数拼错，结果不是「没反应」就是
 * 「服务没停掉」。因此这里不碰真实进程，只钉死「该调哪个脚本、带什么参数」：
 *   1. 能力判定只认磁盘上真实存在的停止脚本；
 *   2. 停止只调停止脚本，且沿用启动器写下的端口；
 *   3. 缺脚本时必须抛错，而不是糊一个空命令出去；
 *   4. 安排动作时先写回包再执行——用假 spawn 验证参数形状。
 *
 * 重启的用例在 1.6.0 随功能一起删掉了。它们是这套测试里最值得记住的一课：
 * 当年那批用例**全部用假 spawn 打桩**，只验证了「命令拼得对不对」，于是那条
 * 路径从没被真跑过一次——接口还活着，实际却拉不起服务。现在只剩停止，而它
 * 有一条真的拉起 PowerShell 的冒烟测试兜底（见文件末尾）。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  STOP_SCRIPT,
  planStop,
  readRunState,
  resolveLifecycle,
  scheduleStop,
} from '../lib/lifecycle.js';

/** 本次测试创建的临时目录，结束时统一清理。 */
const created = [];

/** 造一个假的 DSH 主目录，并按需放上停止脚本。 */
function makeHome({ stopper = true, runState } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-uc-lifecycle-'));
  created.push(home);
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
  it('停止脚本存在时可停', () => {
    const home = makeHome();
    const capability = resolveLifecycle({ DSH_HOME: home });
    assert.equal(capability.home, home);
    assert.equal(capability.canStop, true);
    assert.equal(capability.stopper, path.join(home, STOP_SCRIPT));
    // 界面只读这两个字段；能力对象里不该再留着已经删掉的重启字段。
    assert.deepEqual(Object.keys(capability).sort(), ['canStop', 'home', 'stopper']);
  });

  it('缺脚本时不可用，而不是假装可用', () => {
    const home = makeHome({ stopper: false });
    assert.equal(resolveLifecycle({ DSH_HOME: home }).canStop, false);
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

describe('planStop', () => {
  it('只调停止脚本，并带上端口', () => {
    const home = makeHome();
    const plan = planStop(resolveLifecycle({ DSH_HOME: home }), { port: 3080 });
    assert.equal(plan.script, path.join(home, STOP_SCRIPT));
    assert.ok(plan.args.includes('-File'));
    assert.deepEqual(plan.args.slice(-2), ['-Port', '3080']);
    // 重启专用参数不该再出现在任何地方。
    assert.equal(plan.args.includes('-ForceRestart'), false);
    assert.equal(plan.args.includes('-Workspace'), false);
  });

  it('读不到运行状态时不硬塞端口参数', () => {
    const home = makeHome();
    const plan = planStop(resolveLifecycle({ DSH_HOME: home }), undefined);
    assert.equal(plan.args.includes('-Port'), false);
  });

  it('脚本不存在时抛错，绝不糊一个空命令', () => {
    const capability = resolveLifecycle({ DSH_HOME: makeHome({ stopper: false }) });
    assert.throws(() => planStop(capability), /找不到停止脚本/);
  });
});

describe('scheduleStop', () => {
  it('把动作交给一个延后执行的子进程', async () => {
    const home = makeHome({ runState: { port: 3080 } });
    const calls = [];
    const result = scheduleStop({
      env: { DSH_HOME: home },
      delayMs: 1,
      spawn: (target, args, options) => {
        calls.push({ target, args, options });
        return { unref() {} };
      },
    });
    assert.equal(result.scheduled, true);
    assert.equal(result.script, path.join(home, STOP_SCRIPT));
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
    assert.deepEqual(calls[0].args.slice(-2), ['-Port', '3080']);
  });

  it('子进程启动失败时如实上报，而不是静默失败', async () => {
    const home = makeHome();
    const events = [];
    scheduleStop({
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
    scheduleStop({
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
    // 这条用例是 1.3.1 那次故障的直接产物：只断言「spawn 被调用了」并不够，
    // 因为 detached 的写法会让 PowerShell 起得来、退得掉、却什么都不执行。
    // 它是这套测试里唯一真的拉起一个进程的用例，别删。
    const home = makeHome();
    const marker = path.join(home, 'marker.txt');
    const script = path.join(home, 'probe.ps1');
    writeFileSync(script, `Set-Content -LiteralPath "${marker}" -Value ok -Encoding UTF8\n`);
    scheduleStop({
      env: { DSH_HOME: home },
      delayMs: 1,
      capability: { home, stopper: script, canStop: true },
    });
    const deadline = Date.now() + 10_000;
    while (!existsSync(marker) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(existsSync(marker), 'PowerShell 没有真正执行脚本（典型症状：detached 导致静默退出）');
  });

  it('缺脚本时立刻抛错，不安排任何东西', () => {
    const home = makeHome({ stopper: false });
    assert.throws(() => scheduleStop({ env: { DSH_HOME: home }, delayMs: 1 }), /找不到停止脚本/);
  });
});
