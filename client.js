/**
 * 「更新与版本」设置页的浏览器半边。
 *
 * 用途：在 Harness Web 的设置面板里注册一个 settings.section 页面，展示
 * 已安装版本与仓库上的版本，并允许用户检测和安装更新。
 *
 * 逻辑要点：
 *   - 这是 dsh.client 的构建产物格式（window.__ModuleLoader__.load），必须
 *     整份放在一个文件里；Node 侧的子模块拆分（lib/）不适用于浏览器半边。
 *   - 只从浏览器模块表取 react，不 import 任何 Harness Client 包：那些包会
 *     变，而这个页面崩溃会直接让 slot entry 变空。
 *   - 数据来自 Host 的 /dsh-update-center 路由，同源 fetch，不带任何凭据。
 *   - 检测/安装期间用 1s 轮询拉状态，其余时间完全不发请求。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-update-center',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 本插件拥有的词典命名空间；与 Host 无关，仅前端文案。 */
    const NS = 'dshUpdateCenter';
    /** Host 路由前缀，必须与 lib/center.js 的 ROUTE_PREFIX 一致。 */
    const ENDPOINT = '/dsh-update-center';
    /** 检测或安装进行中的轮询间隔。 */
    const POLL_MS = 1000;

    /**
     * 依次尝试的路由基址。
     *
     * 逻辑：Harness 里应用自己的浏览器路由是「相对于当前文档」的，所以先取
     * 文档所在目录；再退回根绝对路径。两者相同时会被去重，因此正常页面只会
     * 发一次请求。
     */
    const BASES = (() => {
      const candidates = [];
      try {
        candidates.push(new URL('dsh-update-center/', document.baseURI).pathname);
      } catch {
        /* 没有 document.baseURI 的环境直接落到绝对前缀 */
      }
      candidates.push(`${ENDPOINT}/`);
      return candidates.filter((value, index) => candidates.indexOf(value) === index);
    })();

    /**
     * 调用一个路由，直到某个基址返回 JSON。
     *
     * 逻辑：如果命中的是 SPA 兜底（返回 index.html），response.json() 会失败，
     * 于是换下一个基址重试；只有拿到 JSON 才当作真正的应答。
     * @param {string} pathname 前缀之下的路由名。
     * @param {object} [init] fetch 选项。
     * @returns {Promise<object>} 解码后的 JSON。
     */
    async function request(pathname, init) {
      let failure;
      for (const base of BASES) {
        try {
          const response = await fetch(`${base}${pathname}`, init);
          const body = await response.json().catch(() => null);
          if (body === null || typeof body !== 'object') {
            failure = new Error(`no update service answered at ${base}${pathname}`);
            continue;
          }
          if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${String(response.status)}`);
          return body;
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
        }
      }
      throw failure ?? new Error('the update service is unreachable');
    }

    /** 英文文案。 */
    const en = {
      nav: 'Updates & Version',
      title: 'Updates & Version',
      description: 'Check the registry for a newer DeepSeek Harness release and install it from here.',
      versionSection: 'Version',
      currentVersion: 'Installed',
      runningVersion: 'Running',
      latestVersion: 'Available',
      channel: 'Release channel',
      channelLatest: 'Stable',
      channelNext: 'Preview',
      checking: 'Checking…',
      unknown: 'Unknown',
      upToDate: 'You are running the latest release.',
      updateAvailable: 'A newer release is available.',
      notChecked: 'Not checked yet.',
      checkFailed: 'The registry could not be read',
      checkNow: 'Check now',
      updateNow: 'Install update',
      installing: 'Installing…',
      autoSection: 'Automatic detection',
      autoCheck: 'Check automatically',
      autoCheckHint: 'The Harness looks for a newer release in the background and reports it here.',
      interval: 'Check every',
      intervalHours: (hours) => `${hours} h`,
      intervalDay: '24 h',
      autoInstall: 'Install automatically',
      autoInstallHint: 'Install a detected release without asking.',
      autoInstallWarn: 'Risky: this replaces the global package. Turn it on only if an unattended install is acceptable; a restart is still required.',
      lastChecked: 'Last check',
      never: 'Never',
      integritySection: 'Integrity',
      integrityHint: 'Checks the files, links and settings this plugin needs, and fixes what can be fixed safely.',
      integrityOk: 'Everything checks out.',
      integrityIssues: (errors, repairable) => `${errors} problem${errors === 1 ? '' : 's'} found${repairable > 0 ? `, ${repairable} can be fixed automatically` : ''}.`,
      integrityUnavailable: 'The integrity check could not run',
      integrityCheck: 'Check integrity',
      integrityRepair: 'Fix automatically',
      integrityRepairing: 'Repairing…',
      integrityFixed: (count) => `Repaired ${count} item${count === 1 ? '' : 's'}.`,
      integrityFixFailed: 'Some repairs did not succeed',
      integrityNothingToFix: 'Nothing here can be repaired automatically — follow the details above.',
      integrityRestart: 'The plugin registration changed. Restart the Harness to apply it.',
      ck_plugin_files: 'Plugin files',
      ck_manifest: 'Manifest',
      ck_module_graph: 'Source dependencies',
      ck_client_bundle: 'Browser bundle',
      ck_profile_registration: 'Profile registration',
      ck_profile_link: 'Profile link',
      ck_state_file: 'Preferences file',
      ck_home_writable: 'Harness home writable',
      ck_node_version: 'Node version',
      ck_dsh_install: 'Harness installation',
      lifecycleSection: 'Service control',
      lifecycleHint: 'Closing the browser does NOT stop the Harness — it keeps running in the background. Use these buttons to actually stop or restart it.',
      lifecycleStop: 'Stop Harness',
      lifecycleRestart: 'Restart Harness',
      lifecycleConfirmStop: 'Click again to stop',
      lifecycleConfirmRestart: 'Click again to restart',
      lifecycleScheduledStop: (seconds) => `Scheduled: the service stops in about ${seconds} s and this page will disconnect.`,
      lifecycleScheduledRestart: (seconds) => `Scheduled: the service restarts in about ${seconds} s. A new tab opens automatically with a fresh sign-in link.`,
      lifecycleMissingStop: (target) => `Cannot stop from here: ${target} was not found.`,
      lifecycleMissingRestart: (target) => `Cannot restart from here: ${target} was not found.`,
      lifecycleFailed: 'The action could not be scheduled',
      lifecycleLastOk: (action) => `Last "${action}": the helper process started.`,
      lifecycleLastFailed: (error) => `The last action never ran: ${error}`,
      installSection: 'Install',
      installHint: 'The update is installed into the same global prefix. Restart the Harness afterwards to run the new version.',
      command: 'Command',
      log: 'Installer output',
      progress: 'Install progress',
      elapsed: 'Elapsed',
      downloaded: 'Downloaded',
      rateLabel: 'Rate',
      fetched: 'Fetched',
      packages: (count) => `${count} package${count === 1 ? '' : 's'}`,
      stalled: (seconds) => `No new output for ${seconds} s. npm prints nothing while it downloads or unpacks a large package, so this is expected — as long as no error shows up below, the install is still running.`,
      installingHint: 'Keep this plugin enabled while it installs: disabling or reloading it terminates the installer.',
      totalTime: 'Total time',
      restart: 'The new version is on disk. Restart the Harness to run it.',
      installed: 'Install finished.',
      installFailed: 'The installer did not finish successfully',
      unavailable: 'The update service is not reachable. It is served over loopback only, so a remote browser cannot use this page.',
      notLocated: 'The installed Harness package could not be located from the running process.',
    };

    /** 简体中文文案。 */
    const zh = {
      nav: '更新与版本',
      title: '更新与版本',
      description: '检查仓库中的 DeepSeek Harness 新版本，并在此直接安装。',
      versionSection: '版本信息',
      currentVersion: '已安装',
      runningVersion: '运行中',
      latestVersion: '最新版本',
      channel: '更新通道',
      channelLatest: '稳定版',
      channelNext: '预览版',
      checking: '检测中…',
      unknown: '未知',
      upToDate: '当前已是最新版本。',
      updateAvailable: '发现新版本，可以更新。',
      notChecked: '尚未检测。',
      checkFailed: '无法读取版本仓库',
      checkNow: '立即检查',
      updateNow: '立即更新',
      installing: '正在安装…',
      autoSection: '自动检测',
      autoCheck: '自动检测更新',
      autoCheckHint: 'Harness 会在后台检查新版本，并在这里提示。',
      interval: '检测频率',
      intervalHours: (hours) => `${hours} 小时`,
      intervalDay: '24 小时',
      autoInstall: '自动安装更新',
      autoInstallHint: '检测到新版本后直接安装，不再询问。',
      autoInstallWarn: '有风险：这会替换全局安装包。确认可以接受无人值守安装再开启；装完仍需要重启。',
      lastChecked: '上次检测',
      never: '从未',
      integritySection: '完整性检查',
      integrityHint: '检查本插件运行所需的文件、链接与配置是否齐全，能安全修的可以直接修好。',
      integrityOk: '一切正常。',
      integrityIssues: (errors, repairable) => `发现 ${errors} 项问题${repairable > 0 ? `，其中 ${repairable} 项可自动修复` : ''}。`,
      integrityUnavailable: '完整性检查未能执行',
      integrityCheck: '检查完整性',
      integrityRepair: '一键修复',
      integrityRepairing: '正在修复…',
      integrityFixed: (count) => `已修复 ${count} 项。`,
      integrityFixFailed: '有修复项没有成功',
      integrityNothingToFix: '这里没有可自动修复的问题，请按上面的说明手工处理。',
      integrityRestart: '插件注册信息有改动，重启 Harness 后生效。',
      ck_plugin_files: '插件文件',
      ck_manifest: '插件清单',
      ck_module_graph: '源码依赖',
      ck_client_bundle: '浏览器半边',
      ck_profile_registration: 'profile 注册',
      ck_profile_link: 'profile 链接',
      ck_state_file: '偏好文件',
      ck_home_writable: 'DSH 主目录可写',
      ck_node_version: 'Node 版本',
      ck_dsh_install: 'Harness 安装',
      lifecycleSection: '运行控制',
      lifecycleHint: '关闭浏览器并不会停止 Harness —— 它会在后台继续运行。要真正停止或重启，用下面的按钮。',
      lifecycleStop: '停止 Harness',
      lifecycleRestart: '重启 Harness',
      lifecycleConfirmStop: '再点一次即停止',
      lifecycleConfirmRestart: '再点一次即重启',
      lifecycleScheduledStop: (seconds) => `已安排：服务将在约 ${seconds} 秒后停止，本页面会断开连接。`,
      lifecycleScheduledRestart: (seconds) => `已安排：服务将在约 ${seconds} 秒后重启，并自动打开带新登录链接的标签页。`,
      lifecycleMissingStop: (target) => `无法从这里停止：找不到 ${target}。`,
      lifecycleMissingRestart: (target) => `无法从这里重启：找不到 ${target}。`,
      lifecycleFailed: '动作没有安排成功',
      lifecycleLastOk: (action) => `上次「${action}」：启动器子进程已成功拉起。`,
      lifecycleLastFailed: (error) => `上次动作根本没有跑起来：${error}`,
      installSection: '安装',
      installHint: '更新会安装到同一个全局目录；完成后需要重启 Harness 才能运行新版本。',
      command: '命令',
      log: '安装输出',
      progress: '安装进度',
      elapsed: '已用时',
      downloaded: '已下载',
      rateLabel: '速率',
      fetched: '已取',
      packages: (count) => `${count} 个包`,
      stalled: (seconds) => `已有 ${seconds} 秒没有新输出。npm 在下载大压缩包或解包阶段本来就不输出任何东西，这属于正常现象——只要下面没有出现报错，安装就还在继续。`,
      installingHint: '安装期间请让本插件保持启用：禁用或重载它会直接终止安装进程。',
      totalTime: '总耗时',
      restart: '新版本已写入磁盘，重启 Harness 后生效。',
      installed: '安装完成。',
      installFailed: '安装未能成功完成',
      unavailable: '无法访问更新服务。该服务只对本机回环地址开放，远程浏览器无法使用此页面。',
      notLocated: '未能从当前进程定位已安装的 Harness 包。',
    };

    /**
     * 页面样式。
     *
     * 逻辑：全部使用主题 token（--dsw-alias-*）而不是字面颜色，这样明暗主题
     * 切换、主题换肤都自动跟随；类名统一加 duc_ 前缀避免和宿主样式打架。
     * 作为 React 元素渲染，组件卸载时 style 标签一起消失，不留全局副作用。
     */
    const CSS = `
.duc_page{display:flex;flex-direction:column;gap:16px;padding-top:20px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.duc_head{display:flex;flex-direction:column;gap:4px}
.duc_title{font-size:16px;font-weight:500;line-height:24px}
.duc_desc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.duc_card{border:0.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);padding:4px 16px 12px;display:flex;flex-direction:column}
.duc_cardTitle{padding:12px 0 4px;font-weight:500}
.duc_row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:40px}
.duc_row+.duc_row{border-top:0.5px solid var(--dsw-alias-border-l1)}
.duc_rowLabel{flex:1;min-width:0}
.duc_rowValue{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.duc_rowStack{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}
.duc_hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.duc_status{display:flex;align-items:center;gap:6px;padding:8px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.duc_ok{color:var(--dsw-alias-state-success-primary)}
.duc_warn{color:var(--dsw-alias-state-warn-primary)}
.duc_error{color:var(--dsw-alias-state-error-primary)}
.duc_actions{display:flex;align-items:center;gap:8px;padding-top:12px;flex-wrap:wrap}
.duc_button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;border:none;border-radius:var(--dsw-radius-md);cursor:pointer;font-family:inherit;font-size:14px;line-height:22px;height:36px;padding:0 14px;color:var(--dsw-alias-label-primary);background:transparent}
.duc_button:disabled{cursor:not-allowed;opacity:0.4}
.duc_buttonPrimary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.duc_buttonPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.duc_buttonOutline{border:0.5px solid var(--dsw-alias-border-l3)}
.duc_buttonOutline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.duc_switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer}
.duc_switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}
.duc_switch:disabled{cursor:default;opacity:0.5}
.duc_thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);transition:transform 120ms ease}
.duc_switch[aria-checked="true"] .duc_thumb{transform:translateX(16px)}
.duc_segmented{display:inline-flex;gap:2px;padding:2px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2)}
.duc_segment{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:18px;height:24px;padding:0 10px;border-radius:var(--dsw-radius-sm);cursor:pointer}
.duc_segment:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.duc_segment:disabled{cursor:not-allowed;opacity:0.5}
.duc_segmentActive{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.duc_mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px}
.duc_progress{position:relative;height:4px;margin:12px 0 0;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.duc_progressBar{position:absolute;top:0;left:-35%;height:100%;width:35%;border-radius:999px;background:var(--dsw-alias-brand-primary);animation:duc_slide 1.4s ease-in-out infinite}
.duc_stats{display:flex;flex-wrap:wrap;gap:2px 16px;padding-top:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.duc_statsItem{white-space:nowrap}
.duc_statsValue{color:var(--dsw-alias-label-primary)}
.duc_checks{display:flex;flex-direction:column;padding-top:6px}
.duc_check{display:flex;align-items:baseline;gap:8px;padding:2px 0;font-size:12px;line-height:18px}
.duc_checkMark{flex:0 0 auto;width:12px;font-weight:600}
.duc_checkName{flex:0 0 auto;color:var(--dsw-alias-label-primary)}
.duc_checkDetail{flex:1;min-width:0;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;overflow-wrap:anywhere}
@keyframes duc_slide{0%{left:-35%}100%{left:100%}}
/* 前庭敏感的用户不该被迫盯着一条来回滑动的亮条：改成静态满宽提示。 */
@media (prefers-reduced-motion: reduce){.duc_progressBar{animation:none;left:0;width:100%;opacity:0.6}}
.duc_log{margin:8px 0 0;padding:8px 10px;max-height:200px;overflow:auto;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-all}
`;

    /**
     * 一行「标签 + 右侧内容」。标签下有说明时竖排。
     * @param {object} props label / hint / children。
     */
    function Row(props) {
      return h('div', { className: 'duc_row' }, [
        h('div', { className: props.hint === undefined ? 'duc_rowLabel' : 'duc_rowStack', key: 'label' }, [
          h('div', { key: 'main' }, props.label),
          props.hint === undefined ? null : h('div', { className: 'duc_hint', key: 'hint' }, props.hint),
        ]),
        h('div', { className: 'duc_rowValue', key: 'value' }, props.children),
      ]);
    }

    /**
     * 开关控件。
     * 视觉状态直接绑定 aria-checked，保证屏幕阅读器读到的和看到的一致。
     */
    function Switch(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': props.checked,
        'aria-label': props.label,
        className: 'duc_switch',
        disabled: props.disabled === true,
        onClick: () => props.onChange(!props.checked),
      }, h('span', { className: 'duc_thumb' }));
    }

    /** 分段选择器：用于通道与检测频率这类少量互斥选项。 */
    function Segmented(props) {
      return h('div', { className: 'duc_segmented', role: 'group', 'aria-label': props.label },
        props.options.map((option) => h('button', {
          key: option.value,
          type: 'button',
          className: option.value === props.value ? 'duc_segment duc_segmentActive' : 'duc_segment',
          'aria-pressed': option.value === props.value,
          disabled: props.disabled === true,
          onClick: () => props.onChange(option.value),
        }, option.label)));
    }

    /**
     * 读取 Host 状态，并给出页面需要的写入口。
     *
     * 逻辑：
     *   - 进入页面先拉一次状态；
     *   - 只有当「本地有待完成的操作」或「Host 正在检测/安装」时才开启 1s 轮询，
     *     空闲时完全静默，不给后端制造无用请求。
     */
    function useCenterState() {
      const [state, setState] = React.useState(null);
      const [failure, setFailure] = React.useState(null);
      const [pending, setPending] = React.useState(null);

      const load = React.useCallback(async () => {
        try {
          const body = await request('state', {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          });
          setState(body);
          setFailure(null);
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error));
        }
      }, []);

      React.useEffect(() => {
        void load();
      }, [load]);

      const busy = pending !== null || state?.checking === true || state?.updating === true;
      React.useEffect(() => {
        if (!busy) return undefined;
        const timer = setInterval(() => {
          void load();
        }, POLL_MS);
        return () => clearInterval(timer);
      }, [busy, load]);

      const post = React.useCallback(async (action, payload) => {
        setPending(action);
        try {
          const body = await request(action, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload ?? {}),
          });
          setState(body);
          setFailure(null);
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error));
        } finally {
          setPending(null);
          // 写完再拉一次，确保页面显示的是 Host 的真实状态而不是本地猜测。
          void load();
        }
      }, [load]);

      return { state, failure, busy, post };
    }

    /**
     * 读取自检报告，并给出重新检查与一键修复的入口。
     *
     * 逻辑：进页面就查一次（纯磁盘只读，代价很小）；修复是唯一会写磁盘的动作，
     * 因此只有用户点按钮才发生，修复后直接用返回的新报告替换旧结论。
     */
    function useIntegrity() {
      const [report, setReport] = React.useState(null);
      const [failure, setFailure] = React.useState(null);
      const [pending, setPending] = React.useState(null);
      const [outcome, setOutcome] = React.useState(null);

      const check = React.useCallback(async () => {
        setPending('check');
        try {
          const body = await request('integrity', {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          });
          setReport(body);
          setFailure(null);
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error));
        } finally {
          setPending(null);
        }
      }, []);

      const repair = React.useCallback(async () => {
        setPending('repair');
        try {
          const body = await request('repair', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          });
          setReport(body.report ?? null);
          setOutcome(body);
          setFailure(null);
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error));
        } finally {
          setPending(null);
        }
      }, []);

      React.useEffect(() => {
        void check();
      }, [check]);

      return { report, failure, pending, outcome, check, repair };
    }

    /**
     * 把检查项 id 映射成本地化名称；词典里没有这一项时退回 id 本身，
     * 这样 Host 新增检查项不会让页面出现空白。
     * @param {Function} t 翻译函数。
     * @param {string} id 检查项 id。
     * @returns {string} 展示名称。
     */
    function checkLabel(t, id) {
      const key = `ck_${String(id).replace(/-/g, '_')}`;
      const value = t(key);
      return typeof value === 'string' && value !== key ? value : String(id);
    }

    /**
     * 停止/重启 Harness 的入口。
     *
     * 逻辑：这两个动作会直接掐断当前页面（要停的就是这个服务），所以要点两次
     * 确认，并且只允许安排一次；安排成功后按钮就不再可用，免得用户反复点却
     * 看不到任何反应。
     */
    function useLifecycle() {
      const [armed, setArmed] = React.useState(null);
      const [pending, setPending] = React.useState(null);
      const [outcome, setOutcome] = React.useState(null);
      const [failure, setFailure] = React.useState(null);

      const arm = React.useCallback((action) => {
        setArmed((current) => (current === action ? null : action));
      }, []);

      const run = React.useCallback(async (action) => {
        setPending(action);
        try {
          const body = await request(action, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          });
          setOutcome({
            action,
            delayMs: Number.isFinite(body.delayMs) ? Number(body.delayMs) : 2000,
          });
          setFailure(null);
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error));
        } finally {
          setPending(null);
          setArmed(null);
        }
      }, []);

      return { armed, arm, pending, outcome, failure, run };
    }

    /**
     * 把时间戳渲染成本地可读文本；无时间戳时显示「从未」。
     * @param {number|undefined} value 毫秒时间戳。
     * @param {Function} t 翻译函数。
     * @returns {string} 展示文本。
     */
    function formatCheckedAt(value, t) {
      if (!Number.isFinite(value)) return t('never');
      try {
        return new Date(value).toLocaleString();
      } catch {
        return t('never');
      }
    }

    /**
     * 把毫秒渲染成 `分:秒`（超过一小时才补上小时段）。
     *
     * 逻辑：已用时长是安装期间唯一「永远在动」的数字，所以宁可粗糙也要一直刷新；
     * 用 tabular-nums 对齐后，秒数跳动不会带动整行抖动。
     * @param {number|undefined} ms 毫秒。
     * @returns {string} 展示文本；非法输入显示破折号。
     */
    function formatDuration(ms) {
      if (!Number.isFinite(ms) || ms < 0) return '—';
      const total = Math.floor(ms / 1000);
      const seconds = total % 60;
      const minutes = Math.floor(total / 60) % 60;
      const hours = Math.floor(total / 3600);
      const tail = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
      return hours > 0 ? `${hours}:${tail}` : `${minutes}:${String(seconds).padStart(2, '0')}`;
    }

    /**
     * 把字节数渲染成 MB / GB。
     * @param {number|undefined} bytes 字节数。
     * @returns {string|null} 展示文本；未知时为 null，调用方据此整项不显示。
     */
    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes < 0) return null;
      const mb = bytes / (1024 * 1024);
      return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
    }

    /**
     * 把字节/秒渲染成速率。
     * @param {number|undefined} bytesPerSecond 每秒字节数。
     * @returns {string|null} 展示文本；为 0 或未知时返回 null。
     */
    function formatRate(bytesPerSecond) {
      if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return null;
      return bytesPerSecond >= 1024 * 1024
        ? `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`
        : `${Math.max(1, Math.round(bytesPerSecond / 1024))} KB/s`;
    }

    /** 一个统计项：「标签 + 值」。 */
    function Stat(props) {
      return h('span', { className: 'duc_statsItem' }, `${props.label} `,
        h('span', { className: 'duc_statsValue' }, props.value));
    }

    /**
     * 「更新与版本」页面本体。
     * @param {object} props slot 注入的属性；t 来自注册时的 locale 命名空间。
     */
    function UpdateCenterPage(props) {
      // t 正常由 slot 的 locale 选项注入；兜底走英文词典，避免极端情况下整页崩溃。
      const t = typeof props.t === 'function' ? props.t : (key) => en[key] ?? key;
      const { state, failure, busy, post } = useCenterState();
      const integrity = useIntegrity();
      const lifecycle = useLifecycle();
      // 运行控制相关：能力来自 Host 对「本机有没有启动器/停止脚本」的探测。
      const lifecycleState = state?.lifecycle;
      const stopReady = lifecycleState?.canStop === true;
      const restartReady = lifecycleState?.canRestart === true;
      const controlBusy = lifecycle.pending !== null || lifecycle.outcome !== null;
      /** 生成一个「点两次确认」的按钮。 */
      const controlButton = (action, baseLabel, confirmLabel, ready, missingLabel) => h('button', {
        key: action,
        type: 'button',
        className: 'duc_button duc_buttonOutline',
        disabled: !ready || controlBusy,
        title: ready ? undefined : missingLabel,
        onClick: () => {
          if (lifecycle.armed !== action) {
            lifecycle.arm(action);
            return;
          }
          void lifecycle.run(action);
        },
      }, lifecycle.armed === action ? confirmLabel : baseLabel);

      const currentVersion = state?.currentVersion;
      const runningVersion = state?.runningVersion;
      const latest = state?.latestVersion ?? (state?.checking === true ? t('checking') : t('unknown'));
      const channel = state?.channel ?? 'latest';

      // 状态行文案：按「连接失败 > 检测失败 > 检测中 > 定位失败 > 版本未知 > 有更新 > 已最新」判定。
      // 顺序很重要：读不到当前版本时绝不能显示「已是最新」。
      let statusText = t('notChecked');
      let statusClass = 'duc_status';
      if (failure !== null) {
        statusText = `${t('unavailable')} (${failure})`;
        statusClass = 'duc_status duc_error';
      } else if (state?.checkError != null) {
        statusText = `${t('checkFailed')}：${String(state.checkError)}`;
        statusClass = 'duc_status duc_error';
      } else if (state?.checking === true) {
        statusText = t('checking');
      } else if (state?.currentVersionError != null) {
        statusText = t('notLocated');
        statusClass = 'duc_status duc_warn';
      } else if (currentVersion === undefined) {
        statusText = t('notChecked');
      } else if (state?.updateAvailable === true) {
        statusText = t('updateAvailable');
        statusClass = 'duc_status duc_warn';
      } else if (typeof state?.latestVersion === 'string') {
        statusText = t('upToDate');
        statusClass = 'duc_status duc_ok';
      }

      const header = h('div', { className: 'duc_head', key: 'head' }, [
        h('div', { className: 'duc_title', key: 'title' }, t('title')),
        h('div', { className: 'duc_desc', key: 'desc' }, t('description')),
      ]);

      const versionCard = h('div', { className: 'duc_card', key: 'version' }, [
        h('div', { className: 'duc_cardTitle', key: 'title' }, t('versionSection')),
        h(Row, { key: 'current', label: t('currentVersion') }, h('span', { className: 'duc_mono' }, String(currentVersion ?? t('unknown')))),
        // 更新安装完成后磁盘版本会变，而进程仍是旧代码，这一行把两者摊开说明。
        runningVersion !== undefined && currentVersion !== undefined && runningVersion !== currentVersion
          ? h(Row, { key: 'running', label: t('runningVersion') }, h('span', { className: 'duc_mono' }, String(runningVersion)))
          : null,
        h(Row, { key: 'latest', label: t('latestVersion') }, h('span', { className: 'duc_mono' }, String(latest))),
        h(Row, { key: 'channel', label: t('channel') }, h(Segmented, {
          label: t('channel'),
          value: channel,
          disabled: busy,
          options: [
            { value: 'latest', label: t('channelLatest') },
            { value: 'next', label: t('channelNext') },
          ],
          onChange: (value) => {
            void post('settings', { channel: value });
          },
        })),
        // aria-live：检测/安装结果异步到达，读屏用户需要被通知到。
        h('div', { className: statusClass, key: 'status', role: 'status', 'aria-live': 'polite' }, statusText),
        h(Row, { key: 'checkedAt', label: t('lastChecked') }, h('span', {}, formatCheckedAt(state?.checkedAt, t))),
        h('div', { className: 'duc_actions', key: 'actions' }, [
          h('button', {
            key: 'check',
            type: 'button',
            className: 'duc_button duc_buttonOutline',
            disabled: busy,
            onClick: () => {
              void post('check', { channel });
            },
          }, t('checkNow')),
          h('button', {
            key: 'update',
            type: 'button',
            className: 'duc_button duc_buttonPrimary',
            // 只有确知「有新版且当前不在忙」时才允许点，避免无意义的安装。
            disabled: busy || state?.updateAvailable !== true,
            onClick: () => {
              void post('update', { channel });
            },
          }, state?.updating === true ? t('installing') : t('updateNow')),
        ]),
      ]);

      const autoCard = h('div', { className: 'duc_card', key: 'auto' }, [
        h('div', { className: 'duc_cardTitle', key: 'title' }, t('autoSection')),
        h(Row, {
          key: 'toggle',
          label: t('autoCheck'),
          hint: t('autoCheckHint'),
        }, h(Switch, {
          label: t('autoCheck'),
          // 状态未到达前按默认值展示；Host 默认开启自动检测。
          checked: state?.autoCheck !== false,
          disabled: state === null,
          onChange: (value) => {
            void post('settings', { autoCheck: value });
          },
        })),
        h(Row, { key: 'interval', label: t('interval') }, h(Segmented, {
          label: t('interval'),
          value: String(state?.checkIntervalHours ?? 6),
          // 关掉自动检测后频率没有意义，一并禁用。
          disabled: state?.autoCheck === false,
          options: [
            { value: '1', label: t('intervalHours')(1) },
            { value: '6', label: t('intervalHours')(6) },
            { value: '12', label: t('intervalHours')(12) },
            { value: '24', label: t('intervalDay') },
          ],
          onChange: (value) => {
            void post('settings', { checkIntervalHours: Number(value) });
          },
        })),
        h(Row, {
          key: 'autoInstall',
          label: t('autoInstall'),
          hint: t('autoInstallHint'),
        }, h(Switch, {
          label: t('autoInstall'),
          checked: state?.autoInstall === true,
          // 自动安装依赖自动检测，检测关掉时这个开关没有意义。
          disabled: state === null || state.autoCheck === false,
          onChange: (value) => {
            void post('settings', { autoInstall: value });
          },
        })),
        state?.autoInstall === true
          ? h('div', { className: 'duc_status duc_warn', key: 'warn' }, t('autoInstallWarn'))
          : null,
      ]);

      // 安装进度：npm 在管道里完全静默，所以页面得自己造出「还在动」的证据——
      // 时间是心跳，字节只在真的下载时增长，两者都比一句「正在安装…」诚实。
      const progressStats = [];
      if (state?.updating === true) {
        progressStats.push(h(Stat, {
          key: 'elapsed',
          label: t('elapsed'),
          value: formatDuration(state?.updateElapsedMs),
        }));
        const downloaded = formatBytes(state?.updateCacheBytes);
        if (downloaded !== null) {
          progressStats.push(h(Stat, { key: 'downloaded', label: t('downloaded'), value: downloaded }));
        }
        const rate = formatRate(state?.updateCacheRate);
        if (rate !== null) {
          progressStats.push(h(Stat, { key: 'rate', label: t('rateLabel'), value: rate }));
        }
        if ((state?.updatePackageCount ?? 0) > 0) {
          progressStats.push(h(Stat, {
            key: 'packages',
            label: t('fetched'),
            value: t('packages')(state.updatePackageCount),
          }));
        }
      }

      const installCard = h('div', { className: 'duc_card', key: 'install' }, [
        h('div', { className: 'duc_cardTitle', key: 'title' }, t('installSection')),
        h('div', { className: 'duc_hint', key: 'hint' }, t('installHint')),
        h(Row, { key: 'command', label: t('command') }, h('span', { className: 'duc_mono' },
          state?.installCommand ?? `npm install --global ${state?.packageName ?? '@deepseek-ai/dsh'}@${state?.latestVersion ?? '<version>'}`)),
        state?.updating === true
          ? h('div', { key: 'progress' }, [
            // 百分比需要知道总下载量，而 npm 不给；因此是「不确定进度」条 + 真实数字，
            // 而不是一个编出来的百分数。
            h('div', {
              className: 'duc_progress',
              key: 'bar',
              role: 'progressbar',
              'aria-label': t('progress'),
            }, h('div', { className: 'duc_progressBar' })),
            progressStats.length === 0 ? null : h('div', { className: 'duc_stats', key: 'stats' }, progressStats),
            state?.updateStalled === true
              ? h('div', { className: 'duc_status duc_warn', key: 'stalled' },
                t('stalled')(Math.max(1, Math.round((state?.updateSilentMs ?? 0) / 1000))))
              : null,
            h('div', { className: 'duc_hint', key: 'hold' }, t('installingHint')),
          ])
          : null,
        state?.restartRequired === true
          ? h('div', { className: 'duc_status duc_warn', key: 'restart' }, [
            t('restart'),
            // 既然装了新版本就是要重启，索性把按钮放在这句话旁边，少一步来回。
            restartReady && !controlBusy
              ? controlButton('restart', t('lifecycleRestart'), t('lifecycleConfirmRestart'), true, '')
              : null,
          ])
          : null,
        state?.updateResult?.ok === true && state?.restartRequired !== true
          ? h('div', { className: 'duc_status duc_ok', key: 'done' }, t('installed'))
          : null,
        state?.updateResult != null && state.updateResult.ok !== true
          ? h('div', { className: 'duc_status duc_error', key: 'failed' },
            `${t('installFailed')}${state.updateResult.exitCode === undefined ? '' : ` (exit ${String(state.updateResult.exitCode)})`}${state.updateResult.error === undefined ? '' : `：${String(state.updateResult.error)}`}`)
          : null,
        // 装完之后进度条收起来，但总耗时留着——下次遇到「怎么这么久」时有据可查。
        state?.updateResult != null && Number.isFinite(state?.updateElapsedMs)
          ? h('div', { className: 'duc_stats', key: 'timing' },
            h(Stat, { label: t('totalTime'), value: formatDuration(state.updateElapsedMs) }))
          : null,
        Array.isArray(state?.updateOutput) && state.updateOutput.length > 0
          ? h('div', { key: 'logWrap' }, [
            h('div', { className: 'duc_hint', key: 'logTitle' }, t('log')),
            h('pre', { className: 'duc_log', key: 'log' }, state.updateOutput.join('\n')),
          ])
          : null,
      ]);

      // 完整性卡片：把「插件还完整吗」变成一份看得懂的清单，可修时给一个按钮。
      const integrityReport = integrity.report;
      const integritySummary = integrityReport?.summary;
      let integrityStatusText = t('integrityOk');
      let integrityStatusClass = 'duc_status duc_ok';
      if (integrity.failure !== null) {
        integrityStatusText = `${t('integrityUnavailable')} (${integrity.failure})`;
        integrityStatusClass = 'duc_status duc_error';
      } else if (integrityReport === null) {
        integrityStatusText = t('checking');
        integrityStatusClass = 'duc_status';
      } else if (integritySummary.errors > 0) {
        integrityStatusText = t('integrityIssues')(integritySummary.errors, integritySummary.repairable);
        integrityStatusClass = 'duc_status duc_error';
      } else if (integritySummary.warnings > 0) {
        integrityStatusText = t('integrityIssues')(integritySummary.warnings, integritySummary.repairable);
        integrityStatusClass = 'duc_status duc_warn';
      }

      /** 三种状态的记号；用文字符号而不是图标字体，避免多一份资源依赖。 */
      const MARKS = { ok: '✓', warn: '!', error: '✕' };
      const failedRepairs = integrity.outcome === null
        ? []
        : integrity.outcome.repaired.filter((entry) => !entry.ok);
      const integrityCard = h('div', { className: 'duc_card', key: 'integrity' }, [
        h('div', { className: 'duc_cardTitle', key: 'title' }, t('integritySection')),
        h('div', { className: 'duc_hint', key: 'hint' }, t('integrityHint')),
        h('div', {
          className: integrityStatusClass,
          key: 'status',
          role: 'status',
          'aria-live': 'polite',
        }, integrityStatusText),
        integrityReport === null ? null : h('div', { className: 'duc_checks', key: 'checks' },
          integrityReport.checks.map((item) => h('div', { className: 'duc_check', key: item.id }, [
            h('span', { className: `duc_checkMark duc_${item.status}`, key: 'mark' }, MARKS[item.status] ?? item.status),
            h('span', { className: 'duc_checkName', key: 'name' }, checkLabel(t, item.id)),
            // 通过的项目不必展示细节，失败时把路径/原因摆出来才有用。
            item.status === 'ok'
              ? null
              : h('span', { className: 'duc_checkDetail', key: 'detail' }, String(item.detail ?? '')),
          ]))),
        failedRepairs.length > 0
          ? h('div', { className: 'duc_status duc_error', key: 'fixfail' },
            `${t('integrityFixFailed')}：${failedRepairs.map((entry) => `${entry.id}（${entry.error ?? ''}）`).join('；')}`)
          : null,
        integrity.outcome !== null && failedRepairs.length === 0 && integrity.outcome.repairedCount > 0
          ? h('div', { className: 'duc_status duc_ok', key: 'fixed' }, t('integrityFixed')(integrity.outcome.repairedCount))
          : null,
        integrity.outcome !== null && integrity.outcome.repairedCount === 0 && failedRepairs.length === 0
          ? h('div', { className: 'duc_hint', key: 'nothing' }, t('integrityNothingToFix'))
          : null,
        integrity.outcome?.restartRequired === true
          ? h('div', { className: 'duc_status duc_warn', key: 'restart' }, t('integrityRestart'))
          : null,
        h('div', { className: 'duc_actions', key: 'actions' }, [
          h('button', {
            key: 'check',
            type: 'button',
            className: 'duc_button duc_buttonOutline',
            disabled: integrity.pending !== null,
            onClick: () => {
              void integrity.check();
            },
          }, t('integrityCheck')),
          h('button', {
            key: 'repair',
            type: 'button',
            className: 'duc_button duc_buttonPrimary',
            // 没有可自动修复的项时按钮就该是灰的，免得变成「点了没反应」。
            disabled: integrity.pending !== null || (integritySummary?.repairable ?? 0) === 0,
            onClick: () => {
              void integrity.repair();
            },
          }, integrity.pending === 'repair' ? t('integrityRepairing') : t('integrityRepair')),
        ]),
      ]);

      // 运行控制：说清「关浏览器 ≠ 停服务」，并把真的停/重启放进来。
      const lifecycleCard = h('div', { className: 'duc_card', key: 'lifecycle' }, [
        h('div', { className: 'duc_cardTitle', key: 'title' }, t('lifecycleSection')),
        h('div', { className: 'duc_hint', key: 'hint' }, t('lifecycleHint')),
        lifecycle.failure !== null
          ? h('div', { className: 'duc_status duc_error', key: 'fail' }, `${t('lifecycleFailed')}：${lifecycle.failure}`)
          : null,
        lifecycle.outcome !== null
          ? h('div', {
            className: 'duc_status duc_warn',
            key: 'scheduled',
            role: 'status',
            'aria-live': 'polite',
          }, (lifecycle.outcome.action === 'stop' ? t('lifecycleScheduledStop') : t('lifecycleScheduledRestart'))(
            Math.round((lifecycle.outcome.delayMs ?? 2000) / 1000),
          ))
          : null,
        stopReady ? null : h('div', { className: 'duc_hint', key: 'nostop' },
          t('lifecycleMissingStop')(String(lifecycleState?.stopper ?? ''))),
        restartReady ? null : h('div', { className: 'duc_hint', key: 'norestart' },
          t('lifecycleMissingRestart')(String(lifecycleState?.launcher ?? ''))),
        // 上一次动作的真实结果。「点了没反应」之所以难查，就是因为没人告诉你
        // 那个子进程到底起来没有——现在这里会直说。
        state?.lifecycleLast === undefined || lifecycle.outcome !== null
          ? null
          : h('div', {
            className: state.lifecycleLast.ok === true ? 'duc_status duc_ok' : 'duc_status duc_error',
            key: 'last',
          }, state.lifecycleLast.ok === true
            ? t('lifecycleLastOk')(state.lifecycleLast.action === 'stop' ? t('lifecycleStop') : t('lifecycleRestart'))
            : t('lifecycleLastFailed')(String(state.lifecycleLast.error ?? ''))),
        h('div', { className: 'duc_actions', key: 'actions' }, [
          controlButton('stop', t('lifecycleStop'), t('lifecycleConfirmStop'), stopReady, String(lifecycleState?.stopper ?? '')),
          controlButton('restart', t('lifecycleRestart'), t('lifecycleConfirmRestart'), restartReady, String(lifecycleState?.launcher ?? '')),
        ]),
      ]);

      return h(React.Fragment, null, [
        h('style', { key: 'css' }, CSS),
        h('div', { className: 'duc_page', key: 'page' }, [header, versionCard, integrityCard, autoCard, installCard, lifecycleCard]),
      ]);
    }

    /** 本插件需要的服务：没有它们就没有插槽和文案。 */
    const inject = ['slots', 'locale'];

    /**
     * 注册设置页。
     * @param {object} ctx 浏览器插件上下文。
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      // 词典注册在 effect 里，插件卸载时自动移除。
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-update-center: dictionaries');
      // settings.section 由设置外壳声明；外壳尚未挂载时 inject 会等它出现。
      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'updates',
        // order 12：排在「模型」(10) 之后、「插件」(15) 之前。
        order: 12,
        // label 用 thunk，切换语言时会重新求值，不需要重新注册。
        label: () => t('nav'),
        locale: NS,
      }, UpdateCenterPage)), 'dsh-update-center: settings page');
    }

    return { inject, apply };
  },
});
