/**
 * lib/integrity.js 的自检与修复测试。
 *
 * 逻辑：自检的价值全在「判得准、修得安全」两件事上，因此这里造一套完整的
 * 假插件目录 + 假 profile，然后一处一处地破坏，验证：
 *   1. 缺文件、缺注册、链接指错、偏好损坏分别被哪一个检查项抓到；
 *   2. 哪些项被标成可自动修复，哪些必须人工处理；
 *   3. 一键修复只补缺失、会留备份、并且是幂等的。
 * 夹具全在临时目录里，测试绝不触碰真实的 ~/.dsh。
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  checkIntegrity,
  discoverProfileDir,
  extractImportSpecifiers,
  manifestFilePaths,
  normalizePath,
  repairIntegrity,
  resolveProfileDir,
  resolveHomeDir,
  stripComments,
} from '../lib/integrity.js';

/** 夹具里的插件包名，与真实清单保持一致。 */
const PLUGIN_NAME = '@local/dsh-update-center';

/** 本次测试创建过的所有夹具根目录，结束时统一清理。 */
const created = [];

/**
 * 造一套「完好的插件目录 + 完好的 profile」。
 * @returns {object} 夹具各路径与选项。
 */
function makeWorkspace() {
  const base = mkdtempSync(path.join(tmpdir(), 'dsh-uc-integrity-'));
  created.push(base);
  const root = path.join(base, 'dsh-update-center');
  const home = path.join(base, 'home');
  const profileDir = path.join(home, 'profiles', 'web');
  mkdirSync(path.join(root, 'lib'), { recursive: true });
  mkdirSync(path.join(root, 'locale'), { recursive: true });
  mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true });

  const manifest = {
    name: PLUGIN_NAME,
    version: '1.2.0',
    type: 'module',
    icon: './icon.svg',
    exports: {
      '.': './index.js',
      './client': './client.js',
      './package.json': './package.json',
      './locale/*.json': './locale/*.json',
    },
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      client: { platform: 'web' },
    },
  };
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(path.join(root, 'index.js'), "import { createUpdateCenter } from './lib/center.js';\nexport const inject = ['webServer'];\n");
  writeFileSync(
    path.join(root, 'lib', 'center.js'),
    "import { isNewer } from './semver.js';\nimport { locateInstallation } from './installation.js';\nexport const both = [isNewer, locateInstallation];\n",
  );
  writeFileSync(path.join(root, 'lib', 'semver.js'), 'export function isNewer() { return false; }\n');
  writeFileSync(path.join(root, 'lib', 'installation.js'), 'export function locateInstallation() { return undefined; }\n');
  writeFileSync(path.join(root, 'client.js'), "window.__ModuleLoader__.load({ id: 'x', factory() { return {}; } });\n");
  writeFileSync(path.join(root, 'cordis.patch.yml'), '- insert:\n    - id: dsh-update-center\n');
  writeFileSync(path.join(root, 'icon.svg'), '<svg/>');
  writeFileSync(path.join(root, 'locale', 'zh.json'), '{"meta":{"title":"x"}}');
  writeFileSync(path.join(root, 'locale', 'en.json'), '{"meta":{"title":"x"}}');

  const profileManifest = {
    name: 'dsh-profile-web',
    dependencies: { [PLUGIN_NAME]: `link:${root.replace(/\\/g, '/')}` },
    dsh: { profile: { bundles: [PLUGIN_NAME] } },
  };
  writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(profileManifest, null, 2));

  const statePath = path.join(home, 'dsh-update-center.json');
  const env = { DSH_HOME: home, DSH_PROFILE: 'web', DSH_PROFILE_DIR: profileDir };
  const linkPath = path.join(profileDir, 'node_modules', PLUGIN_NAME);
  // 夹具默认是「健康」状态：链接已存在且指向插件目录。
  // Windows 上建真实符号链接需要开发者模式，因此统一用目录联接。
  mkdirSync(path.dirname(linkPath), { recursive: true });
  symlinkSync(root, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  return { base, root, home, profileDir, statePath, env, linkPath, options: { pluginRoot: root, env, statePath } };
}

/**
 * 删掉一个链接（夹具清理用）。
 *
 * 逻辑：目录联接在 unlink 下会失败，退回 rmdir；两种都只删链接本身。
 * @param {string} target 链接路径。
 */
function removeLinkForTest(target) {
  try {
    unlinkSync(target);
  } catch {
    rmdirSync(target);
  }
}

/**
 * 造一条「中间层是链接」的别名路径，用来让同一个目录拥有第二种写法。
 *
 * 逻辑：`realpath` 会把整条路径规范化——Windows 上包括 8.3 短名与大小写，任何平台
 * 都包括路径中间的链接。因此「同一个目录，两种写法」是真实存在的：GitHub 的
 * Windows runner 上临时目录就带 8.3 短名，那里的 `realpath(p) !== p` 对**普通目录**
 * 也成立。这个 helper 让这种情形在任何机器上都能被确定地复现。
 * @param {string} target 要别名到的真实目录（绝对路径）。
 * @returns {string} 指向它的别名路径。
 */
function makeAliasPath(target) {
  const outer = mkdtempSync(path.join(tmpdir(), 'dsh-uc-alias-'));
  created.push(outer);
  const alias = path.join(outer, 'alias');
  symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  return alias;
}

/** 按 id 取一条检查结果。 */
const find = (report, id) => report.checks.find((check) => check.id === id);

/** 重写 profile 清单。 */
function writeProfileManifest(profileDir, manifest) {
  writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2));
}

/** 读取 profile 清单。 */
function readProfileManifest(profileDir) {
  return JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
}

after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

describe('自检用到的纯函数', () => {
  it('stripComments 去掉块注释与行注释', () => {
    const source = "/* from './a.js' */\nimport x from './b.js'; // from './c.js'\nconst url = 'https://example.com/x';\n";
    const cleaned = stripComments(source);
    assert.equal(cleaned.includes("'./a.js'"), false);
    assert.equal(cleaned.includes("'./c.js'"), false);
    // URL 里的双斜杠不能被当成注释起点。
    assert.ok(cleaned.includes('https://example.com/x'));
  });

  it('extractImportSpecifiers 只认真正的导入语句', () => {
    const source = [
      "// 注释里的 from './ghost.js' 不算",
      "import { a } from './lib/a.js';",
      "export * from '../shared/b.js';",
      "import 'node:fs';",
      "const text = 'import from nowhere';",
    ].join('\n');
    assert.deepEqual(extractImportSpecifiers(source).sort(), ['../shared/b.js', './lib/a.js', 'node:fs']);
  });

  it('manifestFilePaths 收集相对路径并剔除通配符', () => {
    const paths = manifestFilePaths({
      icon: './icon.svg',
      exports: { '.': './index.js', './locale/*.json': './locale/*.json', './web': './client.js' },
      dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
    });
    // 返回值统一去掉开头的 './'，调用方直接和插件根目录拼接。
    assert.deepEqual(paths.sort(), ['client.js', 'cordis.patch.yml', 'icon.svg', 'index.js'].sort());
    // 平台名与通配符都不该混进来。
    assert.equal(paths.includes('web'), false);
    assert.equal(paths.some((item) => item.includes('*')), false);
  });

  it('resolveProfileDir 依次回退到注入目录、HOME/profile、未知', () => {
    assert.equal(resolveProfileDir({ DSH_PROFILE_DIR: '/p', DSH_HOME: '/h', DSH_PROFILE: 'web' }), '/p');
    assert.equal(resolveProfileDir({ DSH_HOME: '/h', DSH_PROFILE: 'web' }), path.join('/h', 'profiles', 'web'));
    assert.equal(resolveProfileDir({ DSH_HOME: '/h' }), undefined);
    assert.equal(resolveHomeDir({ DSH_HOME: '/h' }), '/h');
  });

  it('normalizePath 抹平分隔符与大小写差异', () => {
    const normalized = normalizePath('C:\\Users\\A\\dsh\\');
    assert.equal(normalized.includes('\\'), false);
    assert.equal(normalized.endsWith('/'), false);
    if (process.platform === 'win32') assert.equal(normalized, normalized.toLowerCase());
  });
});

describe('discoverProfileDir', () => {
  it('宿主进程里没有 profile 环境变量时，靠链接反推出来', async () => {
    // 这是生产环境的真实情况：DSH_PROFILE_DIR / DSH_PROFILE 是注入给工具子进程的，
    // 宿主进程自己一个都没有，因此判定必须落到磁盘证据上。
    const { root, home, profileDir } = makeWorkspace();
    const found = await discoverProfileDir({
      env: { DSH_HOME: home },
      pluginName: PLUGIN_NAME,
      pluginRoot: root,
    });
    assert.equal(found, profileDir);
  });

  it('链接被删掉后，仍能从清单里的 bundle 条目认出是哪个 profile', async () => {
    // 认不出 profile 的话，「缺链接」就没法一键修复——这正是它存在的意义。
    const { root, home, profileDir, linkPath } = makeWorkspace();
    removeLinkForTest(linkPath);
    const found = await discoverProfileDir({
      env: { DSH_HOME: home },
      pluginName: PLUGIN_NAME,
      pluginRoot: root,
    });
    assert.equal(found, profileDir);
  });

  it('插件目录的写法不是规范形式时，仍能靠磁盘上的链接认出 profile', async () => {
    // 磁盘上的链接是最硬的一份证据（score 3）。此前这里拿 realpath 的结果直接和传进来的
    // pluginRoot 比字符串，pluginRoot 只要写法不规范（Windows 上：8.3 短名、大小写；
    // 任何平台：路径中间有链接），这一分就永远拿不到，只能退回清单去猜——而清单恰恰是
    // 坏掉时才需要自检的那部分。GitHub 的 Windows runner 上临时目录带 8.3 短名，
    // 这条用例就是那次真实变红的原因。
    const { base, root, home, profileDir } = makeWorkspace();
    const alias = makeAliasPath(base);
    // 同一个目录，只是换一种写法：alias/dsh-update-center 就是 root。
    const aliasedRoot = path.join(alias, 'dsh-update-center');
    assert.equal(realpathSync.native(aliasedRoot), realpathSync.native(root));
    assert.notEqual(aliasedRoot, root);

    // 清单里不留任何线索：这一分只能来自磁盘上的链接。
    writeProfileManifest(profileDir, { name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } } });

    const found = await discoverProfileDir({
      env: { DSH_HOME: home },
      pluginName: PLUGIN_NAME,
      pluginRoot: aliasedRoot,
    });
    assert.equal(found, profileDir);
  });

  it('无关的 profile 不会被选中', async () => {    const { root, home, profileDir } = makeWorkspace();
    const other = path.join(home, 'profiles', 'other');
    mkdirSync(other, { recursive: true });
    writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: 'other-profile' }));
    const found = await discoverProfileDir({
      env: { DSH_HOME: home },
      pluginName: PLUGIN_NAME,
      pluginRoot: root,
    });
    assert.equal(found, profileDir);
    assert.notEqual(found, other);
  });

  it('一点证据都没有时返回 undefined，绝不乱猜', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'dsh-uc-noprofile-'));
    created.push(home);
    mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true });
    const found = await discoverProfileDir({
      env: { DSH_HOME: home },
      pluginName: PLUGIN_NAME,
      pluginRoot: path.join(home, 'elsewhere'),
    });
    assert.equal(found, undefined);
  });
});

describe('checkIntegrity', () => {
  it('完好的夹具除环境项外全部通过', async () => {
    const { options } = makeWorkspace();
    const report = await checkIntegrity(options);
    for (const id of [
      'plugin-files',
      'manifest',
      'module-graph',
      'client-bundle',
      'profile-registration',
      'profile-link',
      'state-file',
      'home-writable',
      'node-version',
    ]) {
      assert.equal(find(report, id)?.status, 'ok', `${id} 应为 ok：${JSON.stringify(find(report, id))}`);
    }
    assert.equal(report.summary.repairable, 0);
  });

  it('缺源码文件时由 module-graph 抓到，且不可自动修复', async () => {
    const { options, root } = makeWorkspace();
    rmSync(path.join(root, 'lib', 'semver.js'));
    const report = await checkIntegrity(options);
    const check = find(report, 'module-graph');
    assert.equal(check.status, 'error');
    assert.match(check.detail, /semver\.js/);
    assert.equal(check.repairable, false);
    // 这类缺失只能重新克隆仓库，页面不该给一个修不好的按钮。
    assert.equal(report.summary.repairable, 0);
  });

  it('浏览器半边被截断时由 client-bundle 抓到', async () => {
    const { options, root } = makeWorkspace();
    writeFileSync(path.join(root, 'client.js'), 'window.oops = 1;\n');
    const report = await checkIntegrity(options);
    assert.equal(find(report, 'client-bundle').status, 'error');
  });

  it('profile 注册缺失或指向别处都被标成可修复', async () => {
    const { options, profileDir } = makeWorkspace();
    writeProfileManifest(profileDir, { name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } } });
    const report = await checkIntegrity(options);
    const check = find(report, 'profile-registration');
    assert.equal(check.status, 'error');
    assert.equal(check.repairable, true);
  });

  it('依赖指向别处时也算注册错误', async () => {
    const { options, profileDir } = makeWorkspace();
    writeProfileManifest(profileDir, {
      name: 'p',
      dependencies: { [PLUGIN_NAME]: 'link:C:/somewhere/else' },
      dsh: { profile: { bundles: [PLUGIN_NAME] } },
    });
    const report = await checkIntegrity(options);
    const check = find(report, 'profile-registration');
    assert.equal(check.status, 'error');
    assert.equal(check.repairable, true);
  });

  it('链接缺失时标成可修复', async () => {
    const { options, linkPath } = makeWorkspace();
    removeLinkForTest(linkPath);
    const report = await checkIntegrity(options);
    assert.equal(find(report, 'profile-link').status, 'error');
    assert.equal(find(report, 'profile-link').repairable, true);
  });

  it('链接指向别处时标成可修复', async () => {
    const { options, linkPath, base } = makeWorkspace();
    const elsewhere = path.join(base, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    removeLinkForTest(linkPath);
    symlinkSync(elsewhere, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    const report = await checkIntegrity(options);
    const check = find(report, 'profile-link');
    assert.equal(check.status, 'error');
    assert.equal(check.repairable, true);
  });

  it('链接位置是无关的普通目录时报错，且不自动删除', async () => {
    const { options, linkPath } = makeWorkspace();
    removeLinkForTest(linkPath);
    mkdirSync(linkPath, { recursive: true });
    const report = await checkIntegrity(options);
    const check = find(report, 'profile-link');
    assert.equal(check.status, 'error');
    assert.equal(check.repairable, false);
    assert.match(check.detail, /不是本插件/);
  });

  it('链接位置是拷贝进来的一份插件时只警告', async () => {
    const { options, linkPath, root } = makeWorkspace();
    removeLinkForTest(linkPath);
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(
      path.join(linkPath, 'package.json'),
      readFileSync(path.join(root, 'package.json'), 'utf8'),
    );
    const report = await checkIntegrity(options);
    const check = find(report, 'profile-link');
    assert.equal(check.status, 'warn');
    assert.equal(check.repairable, false);
    assert.match(check.detail, /拷贝/);
  });

  it('路径写法不是规范形式时，普通目录不会被误判成链接，更不会被修复删掉', async () => {
    // 这是本次变红暴露出的真问题，也是这套用例最该守住的一条：
    // looksLikeLink 此前拿 realpath(target) 和 target 直接比字符串。realpath 会把
    // 整条路径规范化，所以只要**路径前缀**的写法不唯一（Windows 的 8.3 短名、大小写，
    // 或路径中间有链接），一个货真价实的普通目录就会被判成「链接」——而 repair 正是
    // 据此决定要不要删掉它（见 lib/integrity.js 的 profile-link 修复分支）。
    // 判错的后果是删掉用户的目录，因此这里既验判定，也真的跑一次修复看目录还在不在。
    const { options, linkPath, home } = makeWorkspace();
    removeLinkForTest(linkPath);
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(path.join(linkPath, 'keep.txt'), '必须留下');

    // 用别名写法去指同一个 profile，制造「前缀不规范」的情形。
    const alias = makeAliasPath(home);
    const aliasedEnv = { ...options.env, DSH_PROFILE_DIR: path.join(alias, 'profiles', 'web') };
    const aliased = { ...options, env: aliasedEnv };
    assert.notEqual(path.join(alias, 'profiles', 'web'), options.env.DSH_PROFILE_DIR);

    const report = await checkIntegrity(aliased);
    const check = find(report, 'profile-link');
    assert.equal(check.status, 'error');
    assert.equal(check.repairable, false, '普通目录被当成了可以删掉重建的链接');
    assert.match(check.detail, /不是本插件/);

    const result = await repairIntegrity(aliased);
    assert.equal(result.repairedCount, 0);
    assert.ok(existsSync(path.join(linkPath, 'keep.txt')), '修复把普通目录删掉了');
  });

  it('偏好文件损坏时标成可修复', async () => {    const { options, statePath, home } = makeWorkspace();
    mkdirSync(home, { recursive: true });
    writeFileSync(statePath, '{ 这不是 JSON');
    const report = await checkIntegrity(options);
    const check = find(report, 'state-file');
    assert.equal(check.status, 'error');
    assert.equal(check.repairable, true);
  });
});

describe('repairIntegrity', () => {
  it('把注册、链接与偏好文件一次修好，并留下备份', async () => {
    const { options, profileDir, statePath, home, root } = makeWorkspace();
    writeProfileManifest(profileDir, { name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } } });
    writeFileSync(statePath, 'broken');

    const result = await repairIntegrity({ ...options, preferences: { channel: 'latest' } });

    assert.equal(result.failedCount, 0, JSON.stringify(result.repaired));
    assert.ok(result.repairedCount >= 2);
    assert.equal(result.restartRequired, true);

    // 修完的自检必须干净（环境项除外）。
    assert.equal(find(result.report, 'profile-registration').status, 'ok');
    assert.equal(find(result.report, 'profile-link').status, 'ok');
    assert.equal(find(result.report, 'state-file').status, 'ok');
    assert.equal(find(result.report, 'state-file').status, 'ok');

    const manifest = readProfileManifest(profileDir);
    assert.equal(manifest.dependencies[PLUGIN_NAME], `link:${root.replace(/\\/g, '/')}`);
    assert.deepEqual(manifest.dsh.profile.bundles, [PLUGIN_NAME]);
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).channel, 'latest');

    // 备份是「先备份再写」的证据：原内容必须能在 .bak 里找到。
    assert.equal(readFileSync(`${statePath}.bak`, 'utf8'), 'broken');
    assert.ok(existsSync(path.join(profileDir, 'package.json.bak')));
  });

  it('保留清单里原有的其它内容', async () => {
    const { options, profileDir } = makeWorkspace();
    writeProfileManifest(profileDir, {
      name: 'p',
      dependencies: { 'some-other-plugin': '^1.0.0' },
      dsh: { profile: { bundles: ['other'], patchReload: 'live' } },
    });
    await repairIntegrity(options);
    const manifest = readProfileManifest(profileDir);
    assert.equal(manifest.dependencies['some-other-plugin'], '^1.0.0');
    assert.equal(manifest.dsh.profile.patchReload, 'live');
    assert.deepEqual(manifest.dsh.profile.bundles, ['other', PLUGIN_NAME]);
  });

  it('幂等：再修一次不再产生动作', async () => {
    const { options, profileDir } = makeWorkspace();
    writeProfileManifest(profileDir, { name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } } });
    const first = await repairIntegrity(options);
    assert.ok(first.repairedCount > 0);
    const second = await repairIntegrity(options);
    assert.equal(second.repairedCount, 0);
    assert.equal(second.failedCount, 0);
    assert.equal(second.restartRequired, false);
  });

  it('重建链接不会删掉旧链接指向的真实目录', async () => {
    // 这是修复里唯一有破坏潜力的动作：必须证明它删的是链接，不是链接后面的东西。
    const { options, linkPath, base, root } = makeWorkspace();
    const elsewhere = path.join(base, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(path.join(elsewhere, 'keep.txt'), 'precious');
    removeLinkForTest(linkPath);
    symlinkSync(elsewhere, linkPath, process.platform === 'win32' ? 'junction' : 'dir');

    const result = await repairIntegrity(options);

    assert.equal(result.failedCount, 0, JSON.stringify(result.repaired));
    assert.equal(readFileSync(path.join(elsewhere, 'keep.txt'), 'utf8'), 'precious');
    // realpathSync（JS 版）不解析 Windows 目录联接，必须用 .native 才能看到真实指向。
    assert.equal(realpathSync.native(linkPath), realpathSync.native(root));
  });

  it('遇到真实目录时不硬来，如实报失败', async () => {
    const { options, linkPath } = makeWorkspace();
    removeLinkForTest(linkPath);
    mkdirSync(linkPath, { recursive: true });
    // 普通目录不是「可修复」项，因此这里既不该有动作，也不该动那个目录。
    const result = await repairIntegrity(options);
    assert.equal(result.failedCount, 0);
    assert.equal(result.repairedCount, 0);
    assert.ok(existsSync(linkPath));
  });
});
