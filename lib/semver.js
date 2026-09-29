/**
 * 版本号解析与 semver 优先级比较。
 *
 * 用途：把 registry 返回的版本号和本机安装的版本号放在同一把尺子上量，
 * 决定「是否真的更新了」。这里刻意不引入 semver 依赖——插件在 Harness
 * 进程内以裸 ESM 加载，多一个运行时依赖就多一处解析失败的可能。
 *
 * 逻辑要点：
 *   - 只接受 `主.次.补[-预发布][+构建元数据]`，允许前导 `v`；无法解析时返回
 *     undefined，由调用方区分「不是版本号」和「版本号相等」两种情形。
 *   - 预发布比较遵循 semver 规则：纯数字段按数值比，字母数字段按字典序比，
 *     数字段优先级低于字母段，段数少的优先级低。
 *
 * @module @local/dsh-update-center/lib/semver
 */

/**
 * 解析一个版本字符串。
 * @param {unknown} value 待解析的值；非字符串直接判为无法解析。
 * @returns {{major: number, minor: number, patch: number, prerelease: string[]}|undefined}
 *   解析结果；无法解析时返回 undefined。
 */
export function parseVersion(value) {
  if (typeof value !== 'string') return undefined;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    // 无预发布段时用空数组表示「正式版」，空数组在下面天然比较为最高优先级。
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  };
}

/**
 * 按 semver 优先级比较两个版本。
 * @param {unknown} left 左值。
 * @param {unknown} right 右值。
 * @returns {-1|0|1|undefined} left&lt;right 为 -1，相等为 0，left&gt;right 为 1；
 *   任一侧不是合法版本号时返回 undefined，以免把「读不懂」误判成「已是最新」。
 */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === undefined || b === undefined) return undefined;

  // 主、次、补三段直接按数值比。
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }

  // 正式版 > 预发布版；两边都是正式版则相等。
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  // 逐段比较预发布标识；段数少的更小。
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
      continue;
    }
    // 一边是数字、一边是字母时，数字段优先级更低（semver 规定）。
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * 判断候选版本是否严格新于当前版本。
 * @param {unknown} candidate 候选版本（registry 上的）。
 * @param {unknown} current 当前版本（本机安装的）。
 * @returns {boolean} 只有两边都能解析且候选更大时才为 true。
 */
export function isNewer(candidate, current) {
  return compareVersions(candidate, current) === 1;
}
