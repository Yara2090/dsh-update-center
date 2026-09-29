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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    assert.deepEqual(calls[0].options, { detached: true, stdio: 'ignore', windowsHide: true });
    assert.ok(calls[0].args.includes('-ForceRestart'));
    assert.equal(calls[0].args.at(-1), 'C:\\dsh');
  });

  it('缺脚本时立刻抛错，不安排任何东西', () => {
    const home = makeHome({ stopper: false });
    assert.throws(() => scheduleLifecycle('stop', { env: { DSH_HOME: home }, delayMs: 1 }), /找不到停止脚本/);
  });
});
