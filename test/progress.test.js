/**
 * 进度信号与安装命令的单元测试。
 *
 * 逻辑：这些函数决定「页面说安装还在跑还是卡住了」，判错会让用户要么白等、
 * 要么把正常下载当成故障。因此逐条钉住它们的边界：缓存根目录的三级回退、
 * 只有 fetch 行算进度、目录量不到时返回 undefined（而不是会被误读的 0）、
 * 静默阈值恰好等于阈值时判为静默，以及安装命令必须带出让 npm 在管道里
 * 开口的参数。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildInstallCommand } from '../lib/installation.js';
import {
  STALL_MS,
  contentV2Dir,
  countFetchLines,
  directoryBytes,
  isStalled,
  resolveNpmCacheRoot,
} from '../lib/progress.js';

describe('resolveNpmCacheRoot', () => {
  it('尊重显式配置的 npm_config_cache', () => {
    const explicit = path.join(path.sep, 'custom-cache');
    assert.equal(resolveNpmCacheRoot({ npm_config_cache: explicit }, 'win32', 'C:\\home'), explicit);
  });

  it('空白配置视为未设置', () => {
    const local = path.join(path.sep, 'appdata');
    assert.equal(
      resolveNpmCacheRoot({ npm_config_cache: '   ', LOCALAPPDATA: local }, 'win32', 'C:\\home'),
      path.join(local, 'npm-cache'),
    );
  });

  it('Windows 上缺 LOCALAPPDATA 时回退到 HOME', () => {
    const home = path.join(path.sep, 'home');
    assert.equal(resolveNpmCacheRoot({}, 'win32', home), path.join(home, '.npm'));
  });

  it('非 Windows 平台用 ~/.npm', () => {
    const home = path.join(path.sep, 'home');
    assert.equal(resolveNpmCacheRoot({}, 'linux', home), path.join(home, '.npm'));
  });
});

describe('contentV2Dir', () => {
  it('只在缓存根下取真正存放压缩包的目录', () => {
    assert.equal(contentV2Dir('/root'), path.join('/root', '_cacache', 'content-v2'));
  });
});

describe('countFetchLines', () => {
  it('只数 npm http fetch 行，并单独数出压缩包', () => {
    const output = [
      '$ npm install --global --loglevel=http @deepseek-ai/dsh@0.2.0-rc.2',
      'npm http fetch GET 200 https://registry.npmjs.org/@deepseek-ai/dsh 42ms (cache miss)',
      'npm http fetch GET 200 https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.0-rc.2.tgz 512ms (cache miss)',
      'npm warn deprecated foo@1.0.0: use bar instead',
      'added 812 packages in 5m',
    ].join('\n');
    assert.deepEqual(countFetchLines(output), { fetches: 2, packages: 1 });
  });

  it('没有 fetch 行时归零', () => {
    assert.deepEqual(countFetchLines('npm error code EACCES\n'), { fetches: 0, packages: 0 });
    assert.deepEqual(countFetchLines(''), { fetches: 0, packages: 0 });
  });
});

describe('directoryBytes', () => {
  let root;

  before(() => {
    root = mkdtempSync(path.join(tmpdir(), 'dsh-update-center-bytes-'));
    mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    writeFileSync(path.join(root, 'one.bin'), Buffer.alloc(1000));
    writeFileSync(path.join(root, 'a', 'two.bin'), Buffer.alloc(24));
    writeFileSync(path.join(root, 'a', 'b', 'three.bin'), Buffer.alloc(6));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('递归累加所有普通文件', async () => {
    assert.equal(await directoryBytes(root), 1030);
  });

  it('目录不存在时返回 undefined，而不是 0', async () => {
    // 0 会被页面当成「一个字节都没下载」，把「缓存目录还没建立」误报成「没有进展」。
    assert.equal(await directoryBytes(path.join(root, 'nope')), undefined);
  });

  it('目标不是目录时也返回 undefined', async () => {
    assert.equal(await directoryBytes(path.join(root, 'one.bin')), undefined);
  });
});

describe('isStalled', () => {
  it('恰好到达阈值即判为静默', () => {
    assert.equal(isStalled(1_000, 400, 600), true);
  });

  it('未到阈值不算静默', () => {
    assert.equal(isStalled(1_000, 401, 600), false);
  });

  it('没有活动记录时不算静默', () => {
    assert.equal(isStalled(1_000, undefined), false);
  });

  it('默认阈值是 90 秒', () => {
    assert.equal(STALL_MS, 90_000);
    assert.equal(isStalled(STALL_MS, 0), true);
  });
});

describe('buildInstallCommand', () => {
  it('npm 命令带上让它在管道里输出的参数', () => {
    const { command, args, display } = buildInstallCommand('npm', '1.2.3');
    assert.equal(command, 'npm');
    assert.ok(args.includes('--loglevel=http'), '缺少 --loglevel=http 时安装期间将完全没有输出');
    assert.ok(args.includes('--no-audit'));
    assert.equal(args.at(-1), '@deepseek-ai/dsh@1.2.3');
    assert.match(display, /npm install --global/);
  });

  it('pnpm 用 append-only reporter 以便非 TTY 下仍有输出', () => {
    const { command, args } = buildInstallCommand('pnpm', '1.2.3');
    assert.equal(command, 'pnpm');
    assert.ok(args.includes('--reporter=append-only'));
    assert.equal(args.at(-1), '@deepseek-ai/dsh@1.2.3');
  });

  it('把注册表地址带进安装命令，避免检测与安装用不同的源', () => {
    const registry = 'https://registry.npmmirror.com/';
    const npm = buildInstallCommand('npm', '1.2.3', registry);
    assert.ok(npm.args.includes(`--registry=${registry}`));
    const pnpm = buildInstallCommand('pnpm', '1.2.3', registry);
    assert.ok(pnpm.args.includes(`--registry=${registry}`));
  });

  it('未配置注册表时不加 --registry，交给包管理器决定', () => {
    assert.equal(buildInstallCommand('npm', '1.2.3').args.some((a) => a.startsWith('--registry')), false);
    assert.equal(buildInstallCommand('npm', '1.2.3', '  ').args.some((a) => a.startsWith('--registry')), false);
  });
});
