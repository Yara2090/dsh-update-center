/**
 * lib/center.js 的路由与状态测试。
 *
 * 逻辑：更新面板只有一个对外契约——那几条 HTTP 路由。因此这里不启动 Harness，
 * 而是直接实例化内核并把它当成普通 node:http 处理器来打，覆盖：
 *   1. 正常读取状态；
 *   2. 偏好的写入与落盘；
 *   3. 注册表正常 / 缺标签 / 报错三条分支（用本地假注册表，测试不依赖外网）；
 *   4. 方法、请求体、未知操作、非回环来源等拒绝分支。
 * 安装动作本身不会真跑 npm：只在「尚未检测到版本」这条前置校验上验证它被拒绝。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

  it('缺启动器脚本时拒绝停止与重启，并说明缺了什么', async () => {
    // 测试环境的 DSH_HOME 是临时目录，里面没有启动器脚本，因此这里走拒绝分支：
    // 既验证了判定，也保证用例绝不会真的去停掉谁的服务。
    const stop = await invoke(center, { method: 'POST', url: `${ROUTE_PREFIX}/stop`, body: '{}' });
    assert.equal(stop.status, 409);
    assert.equal(stop.body.ok, false);
    assert.match(String(stop.body.error), /停止脚本/);

    const restart = await invoke(center, { method: 'POST', url: `${ROUTE_PREFIX}/restart`, body: '{}' });
    assert.equal(restart.status, 409);
    assert.equal(restart.body.ok, false);
    assert.match(String(restart.body.error), /启动器脚本/);
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
});
