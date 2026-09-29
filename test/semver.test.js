/**
 * lib/semver.js 的单元测试。
 *
 * 逻辑：版本比较是「要不要更新」这条判断的唯一依据，判错的后果是把已是最新的
 * 安装反复重装，或者明明有新版却提示已最新。因此这里把正式版、预发布版、
 * 非法输入三类边界都钉住。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compareVersions, isNewer, parseVersion } from '../lib/semver.js';

describe('parseVersion', () => {
  it('解析正式版并给出空的预发布段', () => {
    assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] });
  });

  it('接受前导 v', () => {
    assert.equal(parseVersion('v0.1.7')?.patch, 7);
  });

  it('拆出预发布标识', () => {
    assert.deepEqual(parseVersion('0.2.0-rc.2')?.prerelease, ['rc', '2']);
  });

  it('忽略构建元数据', () => {
    assert.deepEqual(parseVersion('1.0.0-rc.1+build.9')?.prerelease, ['rc', '1']);
  });

  it('非字符串与畸形字符串都返回 undefined', () => {
    for (const value of [undefined, null, 12, '', 'abc', '1.2', '1.2.3.4', {}]) {
      assert.equal(parseVersion(value), undefined, `应判为无法解析：${String(value)}`);
    }
  });
});

describe('compareVersions', () => {
  it('按主次补排序', () => {
    assert.equal(compareVersions('1.2.3', '1.2.4'), -1);
    assert.equal(compareVersions('1.3.0', '1.2.9'), 1);
    assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  });

  it('正式版高于同号预发布版', () => {
    assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
    assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
  });

  it('数字标识按数值而不是字典序比较', () => {
    // 字典序会认为 "10" < "9"，这是 semver 里最容易踩的坑。
    assert.equal(compareVersions('1.0.0-rc.10', '1.0.0-rc.9'), 1);
  });

  it('数字标识优先级低于字母标识', () => {
    assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1);
  });

  it('预发布段数少的优先级低', () => {
    assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  });

  it('任一侧无法解析时返回 undefined，而不是 0', () => {
    // 返回 0 会让「读不懂」伪装成「已是最新」，必须区分开。
    assert.equal(compareVersions('1.0.0', 'not-a-version'), undefined);
    assert.equal(compareVersions(undefined, undefined), undefined);
  });
});

describe('isNewer', () => {
  it('只在候选严格更大时为 true', () => {
    assert.equal(isNewer('0.2.0-rc.2', '0.1.7-rc.2'), true);
    assert.equal(isNewer('0.1.7-rc.2', '0.1.7-rc.2'), false);
    assert.equal(isNewer('0.1.6', '0.1.7-rc.2'), false);
  });

  it('当前版本是更新的预发布版时不再提示更新', () => {
    // 本机跑 rc 版、仓库 latest 还是旧稳定版，不应把人降级。
    assert.equal(isNewer('0.1.6', '0.2.0-rc.1'), false);
  });

  it('无法解析时返回 false', () => {
    assert.equal(isNewer('9.9.9', undefined), false);
  });
});
