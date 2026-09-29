/**
 * 「更新与版本」设置页的 Host 半边。
 *
 * 这里只做一件事：把 Host 内核挂到 Cordis 生命周期上。真正的状态机、路由和
 * 安装逻辑在 lib/center.js，纯函数在 lib/semver.js 与 lib/installation.js，
 * 这样内核可以在 node --test 里直接实例化，不需要启动 Harness。
 *
 * 可配置字段（写在 profile 的 cordis.patch.yml 覆盖行里，全部可选）：
 *   channel            'latest' | 'next'   默认 latest
 *   registry           注册表地址          默认 https://registry.npmjs.org/
 *   autoCheck          是否自动检测        默认 true
 *   autoInstall        是否自动安装        默认 false（会替换全局包，需显式开启）
 *   checkIntervalHours 检测频率（小时）    默认 6
 *
 * @module @local/dsh-update-center
 */
import { createUpdateCenter } from './lib/center.js';

/**
 * 必需服务：没有 webServer 就不该激活，否则路由无处注册。
 * 写成 inject 而不是在 apply 里抛错，是为了让本插件在非 Web 部署里安静地不生效。
 */
export const inject = ['webServer'];

/**
 * 挂载更新面板。
 * @param {object} ctx Host 插件上下文。
 * @param {object} [config] 补丁行里的 config，见文件头注释。
 */
export function apply(ctx, config) {
  const center = createUpdateCenter(config, {
    /**
     * 拼出「带本进程登录令牌的地址」。
     *
     * 逻辑：停止/重启会换掉进程，旧页面手里的登录凭证随之失效，于是永远停在
     * 「重新连接中」。真正的解法不是让用户去找新标签页，而是把新进程的登录地址
     * 告诉旧页面，让它自己恢复。这个地址由 `connection` 服务签发——正是启动时
     * 打印 `dsh web: http://…?token=…` 用的那一个。
     *
     * `connection` 不是本插件的必需依赖（没有它本插件照常工作），所以这里按
     * 可选服务取，取不到就返回 undefined，页面退回「手动重新打开」的提示。
     * @returns {string|undefined} 带令牌的地址。
     */
    loginUrl: () => {
      try {
        const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined;
        const port = typeof ctx.get === 'function' ? ctx.get('webServer')?.port : undefined;
        if (typeof port !== 'number') return undefined;
        if (connection === undefined || typeof connection.authenticatedUrl !== 'function') return undefined;
        return connection.authenticatedUrl(`http://127.0.0.1:${String(port)}`);
      } catch {
        return undefined;
      }
    },
  });
  // 用 ctx.effect 拥有路由与定时器：插件卸载或被补丁屏蔽时自动回收。
  ctx.effect(() => center.mount(ctx), 'dsh-update-center: 路由与自动检测');
}
