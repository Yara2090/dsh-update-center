/**
 * 文档与实际的一致性检查。
 *
 * 逻辑：README 里的三样东西最容易悄悄过期，而它们过期了不会报错，只会让人
 * 读到假信息——这一轮里「用例数」就手工改过四次（84 → 87 → 89 → 91 → 95）：
 *   1. 目录里的锚点：重排章节后，目录可能指向一个不存在的标题；
 *   2. 「目录结构」那棵树：新增文件后可能忘了往上加，或反之；
 *   3. 文中的用例数：加了用例却忘了改数字。
 *
 * 这三条都能纯靠读文件判定，所以做成用例，改错一边就红。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const lines = readme.split('\n');

/** 按 GitHub 的规则从标题算出锚点：去掉标点、空格转连字符、转小写。 */
function githubAnchor(heading) {
  return heading.trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s+/g, '-');
}

const headings = lines.map((l) => /^##\s+(.+?)\s*$/.exec(l)?.[1]).filter(Boolean);
const toc = lines.map((l) => /^\s*-\s*\[([^\]]+)\]\(#([^)]+)\)\s*$/.exec(l))
  .filter(Boolean)
  .map((m) => ({ text: m[1], anchor: m[2] }));

describe('README 与实际的一致性', () => {
  it('目录里每条锚点都能跳到真实标题，且文案一致', () => {
    const byAnchor = new Map(headings.map((h) => [githubAnchor(h), h]));
    for (const item of toc) {
      const heading = byAnchor.get(item.anchor);
      assert.equal(heading, item.text,
        `目录项「${item.text}」(#${item.anchor}) 找不到对应标题（或有同名不同文案的标题）`);
    }
  });

  it('每个章节（除目录自身）都写进了目录，且顺序一致', () => {
    // 「目录」这一节当然不会把自己列进去，这是唯一允许的例外。
    const expected = headings.filter((h) => h !== '目录').map(githubAnchor);
    assert.deepEqual(toc.map((t) => t.anchor), expected,
      '目录顺序与章节顺序不一致，或漏了某一节');
  });

  it('「目录结构」树里列的文件都真实存在', () => {
    const start = lines.findIndex((l) => l.trim() === '## 目录结构');
    const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
    const tree = lines.slice(start, end).join('\n').replace(/[│├└─]/g, ' ');
    const names = [...tree.matchAll(/([A-Za-z0-9_.-]+\.(?:json|yml|png|svg|md|js))/g)].map((m) => m[1]);
    const missing = [...new Set(names)].filter((n) => ![
      n, `lib/${n}`, `test/${n}`, `locale/${n}`, `docs/${n}`, `.github/workflows/${n}`, `.github/${n}`,
    ].some((c) => existsSync(path.join(ROOT, c))));
    assert.deepEqual(missing, [], `树里提到但实际不存在：${missing.join(', ')}`);
  });

  it('反过来：实际有的源码与测试文件，树里都列了', () => {
    const start = lines.findIndex((l) => l.trim() === '## 目录结构');
    const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
    const tree = lines.slice(start, end).join('\n');
    const actual = [
      ...readdirSync(path.join(ROOT, 'lib')).map((f) => `lib/${f}`),
      ...readdirSync(path.join(ROOT, 'test')).map((f) => `test/${f}`),
    ];
    const unlisted = actual.filter((f) => tree.replace(/[│├└─]/g, ' ').split(/\s+/).includes(path.basename(f)) === false);
    assert.deepEqual(unlisted, [], `实际存在但树里没列：${unlisted.join(', ')}`);
  });

  it('文中写的用例数与实际数量一致', () => {
    let actual = 0;
    for (const file of readdirSync(path.join(ROOT, 'test'))) {
      const source = readFileSync(path.join(ROOT, 'test', file), 'utf8');
      for (const line of source.split('\n')) if (/^\s*it\(/.test(line)) actual += 1;
    }
    const claimed = Number(/(\d+)\s*个用例/.exec(readme)?.[1]);
    assert.equal(claimed, actual,
      `README 写「${claimed} 个用例」，实际有 ${actual} 个（加/删用例后记得改 README）`);
  });
});
