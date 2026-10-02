/**
 * lib/center.js 的路由与状态测试。
 *
 * 逻辑：更新面板只有一个对外契约——那几条 HTTP 路由。因此这里不启动 Harness，
 * 而是直接实例化内核并把它当成普通 node:http 处理器来打，覆盖：
 *   1. 正常读取状态；
 *   2. 偏好的写入与落盘；
 *   3. 注册表正常 / 缺标签 / 返回非版本号 / 报错四条分支（用本地假注册表，测试不依赖外网）；
 *   4. 方法、请求体、未知操作、非回环来源等拒绝分支；
 *   5. 安装出口的版本号校验：非法版本号必须被拒绝，且绝不启动安装进程。
 * 安装动作本身不会真跑 npm：只在「尚未检测到版本」这条前置校验上验证它被拒绝。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createUpdateCenter, isLoopbackRequest, ROUTE_PREFIX } from '../lib/center.js';

/** 假注册表返回的稳定版本号；远高于任何真实安装版本。 */
const FAKE_LATEST = '9.9.9';

/**
 * 造一个假的 ServerResponse，只实现处理器用到的那几个方法。
 * @returns {{res: object, read: () => {status: number, body: object}}} 假响应与读取器。
 */
function fakeResponse() {
  const captured = { status: 0, body: undefined };
  const res = {
    headersSent: false,
    destroyed: false,
    writeHead(status) {
      captured.status = status;
      res.headersSent = true;
    },
    end(payload) {
      captured.body = JSON.parse(Buffer.from(payload).toString('utf8'));
    },
    destroy() {
      res.destroyed = true;
    },
  };
  return { res, read: () => captured };
}

/**
 * 用假 req/res 直接调用处理器，绕开真实 socket。
 * @param {object} center 内核实例。
 * @param {{url?: string, method?: string, address?: string, body?: string}} options 请求参数。
 * @returns {Promise<{status: number, body: object}>} 捕获到的响应。
 */
async function invoke(center, options = {}) {
  const { address = '127.0.0.1', method = 'GET', url = `${ROUTE_PREFIX}/state`, body } = options;
  const listeners = new Map();
  const req = {
    socket: { remoteAddress: address },
    method,
    url,
    on(event, handler) {
      listeners.set(event, handler);
      return req;
    },
    destroy() {},
  };
  const { res, read } = fakeResponse();
  const done = center.handle(req, res);
  // 有请求体时按 Node 的可读流时序把 data/end 推给处理器。
  if (body !== undefined) {
    listeners.get('data')?.(Buffer.from(body, 'utf8'));
    listeners.get('end')?.();
  }
  await done;
  return read();
}

/** 启动一个假注册表，按路径返回不同的应答。 */
async function startFakeRegistry() {
  const server = http.createServer((req, res) => {
    if (req.url.includes('missing-tags')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: 'stub' }));
      return;
    }
    if (req.url.includes('bogus-tag')) {
      // 注册表是外部输入：这里故意返回一个「不是版本号」的 dist-tag，模拟被投毒的
      // 源或写坏的镜像。它绝不能活着走到安装命令行。
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ 'dist-tags': { latest: '9.9.9; calc.exe', next: '9.9.9 && whoami' } }));
      return;
    }
    if (req.url.includes('boom')) {
      res.writeHead(500);
      res.end('nope');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ 'dist-tags': { latest: FAKE_LATEST, next: '10.0.0-alpha.1' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${String(server.address().port)}/` };
}

describe('更新面板路由', () => {
  let home;
  let registry;
  let center;
  let savedProfileDir;
  let savedProfile;

  before(async () => {
    // 把偏好文件重定向到临时目录，测试绝不碰用户真实的 ~/.dsh。
    home = mkdtempSync(path.join(tmpdir(), 'dsh-update-center-test-'));
    process.env.DSH_HOME = home;
    // 自检与「一键修复」会按 profile 目录去读写插件注册信息，测试里必须把它掐掉，
    // 否则跑一次用例就可能改到开发者自己正在用的 profile。
    savedProfileDir = process.env.DSH_PROFILE_DIR;
    savedProfile = process.env.DSH_PROFILE;
    delete process.env.DSH_PROFILE_DIR;
    delete process.env.DSH_PROFILE;
    registry = await startFakeRegistry();
    center = createUpdateCenter({ registry: registry.origin, checkIntervalHours: 1 });
  });

  after(async () => {
    center.dispose();
    await new Promise((resolve) => registry.server.close(resolve));
    delete process.env.DSH_HOME;
    if (savedProfileDir !== undefined) process.env.DSH_PROFILE_DIR = savedProfileDir;
    if (savedProfile !== undefined) process.env.DSH_PROFILE = savedProfile;
    rmSync(home, { recursive: true, force: true });
  });

  it('GET /state 返回完整快照', async () => {
    const { status, body } = await invoke(center);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.packageName, '@deepseek-ai/dsh');
    assert.equal(body.channel, 'latest');
    assert.deepEqual(body.channels, ['latest', 'next']);
    assert.equal(body.autoCheck, true);
    assert.equal(body.autoInstall, false);
    assert.equal(typeof body.statePath, 'string');
    // 进度字段必须稳定出现在快照里：页面在没有它们时会退回「一片安静」的老样子。
    assert.equal(body.updating, false);
    assert.equal(body.updateElapsedMs, 0);
    assert.equal(body.updateFetchCount, 0);
    assert.equal(body.updatePackageCount, 0);
    assert.equal(body.updateStalled, false);
  });

  it('POST /settings 写入偏好并落盘', async () => {
    const { status, body } = await invoke(center, {
      method: 'POST',
      url: `${ROUTE_PREFIX}/settings`,
      body: JSON.stringify({ autoCheck: false, channel: 'next', checkIntervalHours: 12 }),
    });
    assert.equal(status, 200);
    assert.equal(body.autoCheck, false);
    assert.equal(body.channel, 'next');
    assert.equal(body.checkIntervalHours, 12);

    const saved = JSON.parse(readFileSync(path.join(home, 'dsh-update-center.json'), 'utf8'));
    assert.equal(saved.channel, 'next');
    assert.equal(saved.autoCheck, false);
    assert.equal(saved.checkIntervalHours, 12);
  });

  it('POST /check 读注册表并记录最新版本', async () => {
    await invoke(center, {
      method: 'POST',
      url: `${ROUTE_PREFIX}/settings`,
      body: JSON.stringify({ channel: 'latest' }),
    });
    const { status, body } = await invoke(center, { method: 'POST', url: `${ROUTE_PREFIX}/check`, body: '{}' });
    assert.equal(status, 200);
    assert.equal(body.checkError, null);
    assert.equal(body.latestVersion, FAKE_LATEST);
    assert.equal(typeof body.checkedAt, 'number');
    // 定位到安装版本时，9.9.9 必然比任何真实版本新。
    if (body.currentVersion !== undefined && body.currentVersionError === undefined) {
      assert.equal(body.updateAvailable, true);
    }
  });

  it('注册表缺少所选标签时报错而不是当作已最新', async () => {
    const broken = createUpdateCenter({ registry: `${registry.origin}missing-tags/` });
    const { status, body } = await invoke(broken, { method: 'POST', url: `${ROUTE_PREFIX}/check`, body: '{}' });
    assert.equal(status, 200);
    assert.match(String(body.checkError), /标签/);
    assert.equal(body.updateAvailable, false);
  });

  it('注册表返回 5xx 时把状态码带进错误信息', async () => {
    const broken = createUpdateCenter({ registry: `${registry.origin}boom/` });
    const { body } = await invoke(broken, { method: 'POST', url: `${ROUTE_PREFIX}/check`, body: '{}' });
    assert.match(String(body.checkError), /500/);
  });

  it('注册表返回不是版本号的标签时当场拒绝，不记成可用版本', async () => {
    // 这条用例守的是「外部字符串不进命令行」：dist-tag 会被拼成
    // `npm install --global @deepseek-ai/dsh@<tag>`，而 Windows 上那条命令经由 shell 执行。
    const poisoned = createUpdateCenter({ registry: `${registry.origin}bogus-tag/` });
    const { status, body } = await invoke(poisoned, { method: 'POST', url: `${ROUTE_PREFIX}/check`, body: '{}' });
    assert.equal(status, 200);
    assert.match(String(body.checkError), /不是合法版本号/);
    assert.equal(body.latestVersion, undefined);
    assert.equal(body.updateAvailable, false);
    poisoned.dispose();
  });

  it('即便状态里被塞进非法版本号，/update 也拒绝且不启动安装器', async () => {
    // 上一道闸在读取注册表时；这一道在安装出口本身。安全闸不能只建在调用方，
    // 因此这里绕过 check 直接把非法版本号写进状态，验证出口自己会拦。
    const victim = createUpdateCenter({ registry: registry.origin });
    victim.state.latestVersion = '9.9.9; calc.exe';
    const { status, body } = await invoke(victim, { method: 'POST', url: `${ROUTE_PREFIX}/update`, body: '{}' });
    assert.equal(status, 409);
    assert.equal(body.ok, false);
    assert.match(String(body.updateResult.error), /不是合法的版本号/);
    // 关键：没有真的起任何安装进程。
    assert.equal(body.updating, false);
    assert.equal(body.updateTarget, undefined);
    victim.dispose();
  });

  it('非法注册表地址退回官方源，合法地址原样保留', async () => {
    // registry 同样会进命令行（--registry=<地址>），因此它也不能是任意字符串。
    assert.equal(createUpdateCenter({ registry: 'not a url' }).state.registry, 'https://registry.npmjs.org/');
    assert.equal(createUpdateCenter({ registry: 'file:///etc/passwd' }).state.registry, 'https://registry.npmjs.org/');
    assert.equal(createUpdateCenter({ registry: '' }).state.registry, 'https://registry.npmjs.org/');
    assert.equal(createUpdateCenter({}).state.registry, 'https://registry.npmjs.org/');
    assert.equal(
      createUpdateCenter({ registry: 'https://mirror.corp/npm/' }).state.registry,
      'https://mirror.corp/npm/',
    );
  });

  it('尚未检测到版本时拒绝安装', async () => {
    const fresh = createUpdateCenter({ registry: registry.origin });
    const { status, body } = await invoke(fresh, { method: 'POST', url: `${ROUTE_PREFIX}/update`, body: '{}' });
    assert.equal(status, 409);
    assert.equal(body.ok, false);
  });

  it('拒绝非回环来源', async () => {
    // 这条路由能改写全局安装包，必须只对本机开放。
    const { status, body } = await invoke(center, { address: '10.0.0.5' });
    assert.equal(status, 403);
    assert.equal(body.ok, false);
  });

  it('拒绝不支持的方法、非法请求体与未知操作', async () => {
    const method = await invoke(center, { method: 'DELETE' });
    assert.equal(method.status, 405);

    const badBody = await invoke(center, { method: 'POST', url: `${ROUTE_PREFIX}/check`, body: '{oops' });
    assert.equal(badBody.status, 400);

    const unknown = await invoke(center, { method: 'POST', url: `${ROUTE_PREFIX}/nope`, body: '{}' });
    assert.equal(unknown.status, 404);
    assert.match(String(unknown.body.error), /nope/);
  });

  it('GET /integrity 返回自检报告', async () => {
    const { status, body } = await invoke(center, { url: `${ROUTE_PREFIX}/integrity` });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(typeof body.checkedAt, 'number');
    assert.ok(Array.isArray(body.checks));
    // 至少要有文件检查；profile 相关项在缺 DSH_PROFILE_DIR 时是「无法判定」而不是失败。
    assert.ok(body.checks.some((check) => check.id === 'plugin-files'));
    assert.equal(typeof body.summary.repairable, 'number');
  });

  it('POST /repair 返回修复动作与修复后的报告', async () => {
    const { status, body } = await invoke(center, { method: 'POST', url: `${ROUTE_PREFIX}/repair`, body: '{}' });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.repaired));
    assert.equal(typeof body.repairedCount, 'number');
    assert.equal(typeof body.report.checkedAt, 'number');
    // 测试环境里没有 profile 目录，因此不该产生任何写动作。
    assert.equal(body.repairedCount, 0);
  });

  it('缺停止脚本时拒绝停止，并说明缺了什么', async () => {
    // 测试环境的 DSH_HOME 是临时目录，里面没有停止脚本，因此这里走拒绝分支：
    // 既验证了判定，也保证用例绝不会真的去停掉谁的服务。
    const stop = await invoke(center, { method: 'POST', url: `${ROUTE_PREFIX}/stop`, body: '{}' });
    assert.equal(stop.status, 409);
    assert.equal(stop.body.ok, false);
    assert.match(String(stop.body.error), /停止脚本/);
  });

  it('重启路由已经删掉，访问它只会得到 404', async () => {
    // 1.6.0 删掉了「重启」：界面按钮早在 1.5.0 就撤了，实现与这条路由却还留着，
    // 成了一条从没被真跑过、却能停掉服务的路径。这条用例守着它别再悄悄回来。
    const restart = await invoke(center, { method: 'POST', url: `${ROUTE_PREFIX}/restart`, body: '{}' });
    assert.equal(restart.status, 404);
    assert.equal(restart.body.ok, false);
    assert.match(String(restart.body.error), /restart/);
  });

  it('脚本齐全时排定停止动作', async () => {
    // 放一个假停止脚本：真被执行的会是它，因此这个用例不会碰真实服务。
    writeFileSync(path.join(home, 'stop-deepseek-harness.ps1'), '# fake stopper\n');
    const fresh = createUpdateCenter({ registry: registry.origin });
    const { status, body } = await invoke(fresh, { method: 'POST', url: `${ROUTE_PREFIX}/stop`, body: '{}' });
    assert.equal(status, 200);
    assert.equal(body.scheduled, true);
    assert.match(String(body.script), /stop-deepseek-harness\.ps1$/);
    // 计划里不该再有 action 字段（重启时代的产物）；能力对象的字段由
    // test/lifecycle.test.js 逐字钉住。
    assert.equal(body.action, undefined);
    fresh.dispose();
  });
});

describe('isLoopbackRequest', () => {
  it('只认显式回环地址', () => {
    assert.equal(isLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' } }), true);
    assert.equal(isLoopbackRequest({ socket: { remoteAddress: '127.8.9.10' } }), true);
    assert.equal(isLoopbackRequest({ socket: { remoteAddress: '::1' } }), true);
    assert.equal(isLoopbackRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true);
    assert.equal(isLoopbackRequest({ socket: { remoteAddress: '192.168.1.9' } }), false);
    // 空地址说明我们无法确认来源，按拒绝处理。
    assert.equal(isLoopbackRequest({ socket: {} }), false);
  });
});

describe('挂载与卸载', () => {
  let home;
  let previousHome;

  before(() => {
    previousHome = process.env.DSH_HOME;
    home = mkdtempSync(path.join(tmpdir(), 'dsh-update-center-mount-'));
    process.env.DSH_HOME = home;
  });

  after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('mount 注册一条前缀路由，dispose 后清理干净', () => {
    const routes = [];
    const ctx = {
      webServer: {
        register(route) {
          routes.push(route);
          return () => routes.pop();
        },
      },
    };
    const center = createUpdateCenter({ registry: 'http://127.0.0.1:1/' });
    const dispose = center.mount(ctx);
    assert.equal(routes.length, 1);
    assert.equal(routes[0].kind, 'prefix');
    assert.equal(routes[0].path, ROUTE_PREFIX);
    // 无子进程时 dispose 不应抛错，重复调用也应安全。
    assert.doesNotThrow(() => {
      dispose();
      center.dispose();
    });
    assert.equal(routes.length, 0);
  });

  it('只创建实例、不挂载时不写任何偏好文件', () => {
    createUpdateCenter({});
    assert.equal(existsSync(path.join(home, 'dsh-update-center.json')), false);
  });

  it('旧偏好文件里的「重启」记录不会被当成一次停止显示', () => {
    // 1.6.0 删掉了重启，但旧偏好文件里可能还躺着一条 action:"restart" 的记录：
    // 字段形状和停止一样（同样有 ok/pid），若照单全收，卡片会把一次重启说成一次
    // 停止——而界面上的名字已经写死成「停止 Harness」了。
    const statePath = path.join(home, 'dsh-update-center.json');
    writeFileSync(statePath, JSON.stringify({
      channel: 'latest',
      lastLifecycle: { action: 'restart', at: 1790927107921, ok: true, pid: 29728 },
    }));

    const center = createUpdateCenter({ registry: 'http://127.0.0.1:1/' });
    const dispose = center.mount({ webServer: { register: () => () => {} } });
    assert.equal(center.state.lifecycleLast, undefined);
    // 其余偏好仍要照常读进来，别把整份文件一起丢了。
    assert.equal(center.state.channel, 'latest');
    dispose();
  });

  it('旧偏好文件里留下的「停止」记录仍然会被读进来', () => {
    const statePath = path.join(home, 'dsh-update-center.json');
    writeFileSync(statePath, JSON.stringify({
      lastLifecycle: { action: 'stop', at: 1, ok: true, pid: 5 },
    }));
    const center = createUpdateCenter({ registry: 'http://127.0.0.1:1/' });
    const dispose = center.mount({ webServer: { register: () => () => {} } });
    assert.deepEqual(center.state.lifecycleLast, { action: 'stop', at: 1, ok: true, pid: 5 });
    dispose();
  });
});
