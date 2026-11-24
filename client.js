window.__ModuleLoader__.load({
  id: 'dsh-remote-bridge',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const CSS = `
.rb-trigger{display:flex;align-items:center;gap:8px;width:100%;border:0;background:transparent;color:inherit;font:inherit;padding:6px 8px;border-radius:6px;cursor:pointer;opacity:.85}
.rb-trigger:hover{background:rgba(127,127,127,.16);opacity:1}
.rb-trigger .rb-icon{width:18px;height:18px;display:block;flex:none}
.rb-overlay{position:fixed;inset:0;z-index:2147483000;background:#111}
.rb-frame{position:absolute;inset:0;width:100%;height:100%;border:0;display:block;background:#fff}
.rb-wait{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:13px/1.6 system-ui,sans-serif;color:#c9cdd2;padding:24px;text-align:center;background:#141518;z-index:1}
.rb-dock{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:2147483001;display:flex;align-items:center;justify-content:center;-webkit-app-region:no-drag;font:12.5px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
.rb-bar{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:12px;background:rgba(18,19,22,.88);border:1px solid rgba(255,255,255,.14);box-shadow:0 8px 30px rgba(0,0,0,.45);color:#e8eaed;backdrop-filter:blur(8px);transition:opacity .16s ease, transform .16s ease, background .16s ease;max-width:96vw;flex-wrap:wrap;justify-content:center}
.rb-bar *{-webkit-app-region:no-drag}
.rb-bar.rb-collapsed{opacity:.55;padding:4px 10px;cursor:default}
.rb-bar.rb-collapsed:hover{opacity:.8}
.rb-pill{display:flex;align-items:center;gap:7px;color:#cfd3d8;font:inherit;cursor:default;white-space:nowrap}
.rb-pill-hint{color:#7d838a;font-size:11px}
.rb-sep{width:1px;height:18px;background:rgba(255,255,255,.16);margin:0 2px}
.rb-tabs{display:flex;gap:4px}
.rb-tab{display:flex;align-items:center;gap:6px;border:1px solid transparent;background:transparent;color:#cfd3d8;font:inherit;padding:4px 10px;border-radius:999px;cursor:pointer;max-width:200px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.rb-tab:hover{background:rgba(255,255,255,.1)}
.rb-tab.rb-active{background:rgba(76,141,255,.18);border-color:#4c8dff;color:#dce7ff}
.rb-dot{width:8px;height:8px;border-radius:50%;flex:none}
.rb-status{color:#9aa0a6;max-width:42vw;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;padding:0 4px}
.rb-btn{border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.06);color:#e8eaed;font:inherit;padding:4px 10px;border-radius:8px;cursor:pointer}
.rb-btn:hover{background:rgba(255,255,255,.16)}
.rb-btn[disabled]{opacity:.45;cursor:default}
.rb-modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.55);display:grid;place-items:center;padding:24px;z-index:2147483002;-webkit-app-region:no-drag}
.rb-modal{width:min(720px,94vw);max-height:82vh;margin:auto;display:flex;flex-direction:column;background:#1b1c1f;color:#e8eaed;border:1px solid rgba(255,255,255,.14);border-radius:12px;box-shadow:0 24px 80px rgba(0,0,0,.5);font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.rb-modal *{-webkit-app-region:no-drag}
.rb-modal-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.12)}
.rb-modal-body{padding:12px 14px;overflow:auto;display:flex;flex-direction:column;gap:8px}
.rb-modal-foot{display:flex;gap:8px;justify-content:flex-end;align-items:center;padding:10px 14px;border-top:1px solid rgba(255,255,255,.12)}
.rb-cfg-labels,.rb-cfg-row{display:grid;grid-template-columns:1.1fr 1.1fr 78px 1.3fr 26px;gap:6px;align-items:center}
.rb-cfg-labels{color:#9aa0a6;font-size:11.5px;padding:0 1px}
.rb-cfg-row input{width:100%;box-sizing:border-box;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.18);color:inherit;border-radius:6px;padding:5px 7px;font:inherit}
.rb-cfg-row input:focus{outline:1px solid #4c8dff;border-color:#4c8dff}
.rb-x{border:0;background:transparent;color:#9aa0a6;cursor:pointer;font-size:15px;line-height:1;padding:2px}
.rb-x:hover{color:#ff9b9b}
.rb-hint{color:#9aa0a6;font-size:11.5px}
.rb-err{color:#ff9b9b;font-size:12px;padding:0 2px}
`;

    const HOST_COLORS = ['#4c8dff', '#e8873c', '#37b06b', '#b06bd4', '#d45f8a', '#3aa9b8'];
    function hostColor(alias) {
      let hash = 0;
      for (const character of String(alias)) hash = (hash * 31 + character.charCodeAt(0)) % 997;
      return HOST_COLORS[hash % HOST_COLORS.length];
    }

    async function readJson(url, options) {
      const response = await fetch(url, options);
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(value?.error ?? `HTTP ${response.status}`);
      return value;
    }

    function RemoteView({ visible, onClose }) {
      const [info, setInfo] = useState(null);
      const [selected, setSelected] = useState(null);
      // Per-host iframe generation: only 重连 or a settings change bumps it, so
      // switching tabs never reloads a page that is already mounted.
      const [frames, setFrames] = useState({});
      const [loaded, setLoaded] = useState({});
      const [hovered, setHovered] = useState(false);
      const [recentlyActive, setRecentlyActive] = useState(true);
      const [configOpen, setConfigOpen] = useState(false);
      const [retrying, setRetrying] = useState(false);
      const [stateTick, setStateTick] = useState(0);
      const collapseTimer = useRef(null);
      const iframeRefs = useRef(new Map());

      // Escape pressed inside the (cross-origin) remote iframe is forwarded by
      // the script the host proxy injects; only frames we own are trusted.
      useEffect(() => {
        if (!visible) return undefined;
        const onMessage = (event) => {
          const data = event?.data;
          if (!data || data.source !== 'dsh-remote-bridge' || data.type !== 'escape') return;
          let owned = false;
          for (const frame of iframeRefs.current.values()) {
            try {
              if (frame && frame.contentWindow === event.source) { owned = true; break; }
            } catch {
              // Cross-origin access to contentWindow can throw in odd cases.
            }
          }
          if (!owned) return;
          if (configOpen) { setConfigOpen(false); return; }
          onClose();
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
      }, [visible, configOpen, onClose]);

      useEffect(() => {
        if (!visible) return undefined;
        let cancelled = false;
        const tick = async () => {
          try {
            const data = await readJson('/remote-bridge/state?ensure=1', { cache: 'no-store' });
            if (cancelled) return;
            setInfo(data);
            setSelected((current) => current ?? data.hosts?.[0]?.alias ?? null);
          } catch (error) {
            if (!cancelled) setInfo({ hosts: [], error: String(error?.message ?? error) });
          }
        };
        tick();
        const timer = setInterval(tick, 2500);
        return () => { cancelled = true; clearInterval(timer); };
      }, [visible, stateTick]);

      useEffect(() => {
        if (!visible) return undefined;
        const onKey = (event) => { if (event.key === 'Escape' && !configOpen) onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [onClose, visible, configOpen]);

      useEffect(() => {
        if (!visible) return undefined;
        setRecentlyActive(true);
        const timer = setTimeout(() => setRecentlyActive(false), 2600);
        return () => clearTimeout(timer);
      }, [visible]);

      const enterDock = useCallback(() => {
        if (collapseTimer.current) { clearTimeout(collapseTimer.current); collapseTimer.current = null; }
        setHovered(true);
      }, []);
      const leaveDock = useCallback(() => {
        setHovered(false);
        if (collapseTimer.current) clearTimeout(collapseTimer.current);
        collapseTimer.current = setTimeout(() => setHovered(false), 700);
      }, []);
      useEffect(() => () => { if (collapseTimer.current) clearTimeout(collapseTimer.current); }, []);

      const bumpFrame = useCallback((alias) => {
        if (!alias) return;
        setFrames((current) => ({ ...current, [alias]: (current[alias] ?? 0) + 1 }));
      }, []);

      const reconnect = useCallback(async () => {
        if (retrying || !selected) return;
        setRetrying(true);
        try {
          await readJson('/remote-bridge/retry', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ host: selected }),
          });
        } catch {
          // Detail arrives through the next state poll.
        } finally {
          bumpFrame(selected);
          setStateTick((value) => value + 1);
          setRetrying(false);
        }
      }, [retrying, selected, bumpFrame]);

      const hosts = info?.hosts ?? [];
      const current = hosts.find((host) => host.alias === selected);
      const frameFor = (host) => `${host.url}${host.url.includes('?') ? '&' : '?'}h=${encodeURIComponent(host.alias)}&n=${frames[host.alias] ?? 0}`;
      const mountedHosts = hosts.filter((host) => host.phase === 'ready' && host.url);
      const selectedFrame = current?.phase === 'ready' && current?.url ? frameFor(current) : null;
      const selectedLoaded = Boolean(current?.alias && loaded[current.alias] === selectedFrame);

      let status;
      if (!hosts.length) status = info?.error ? `读取失败：${info.error}` : '没有配置远程服务器';
      else if (!current) status = '';
      else if (current.phase === 'ready') status = selectedLoaded ? '已连接' : '加载中…';
      else if (current.phase === 'starting') status = '正在连接远端…';
      else if (current.phase === 'error') status = `出错：${current.error}`;
      else status = '未连接';

      const expanded = hovered || recentlyActive;
      const dotColor = current?.phase === 'ready' ? hostColor(current.alias) : (current?.phase === 'error' ? '#e05d5d' : '#c9a227');

      return h('div', { className: 'rb-overlay', style: visible ? { display: 'block' } : { display: 'none' } },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        // One iframe per host, kept mounted: switching tabs only toggles display.
        mountedHosts.map((host) => {
          const frame = frameFor(host);
          return h('iframe', {
            key: host.alias,
            className: 'rb-frame',
            style: { display: host.alias === selected ? 'block' : 'none' },
            src: frame,
            title: host.label,
            allow: 'clipboard-write; fullscreen',
            ref: (node) => {
              if (node) iframeRefs.current.set(host.alias, node);
              else iframeRefs.current.delete(host.alias);
            },
            onLoad: () => setLoaded((currentLoaded) => ({ ...currentLoaded, [host.alias]: frame })),
          });
        }),
        selectedFrame
          ? null
          : h('div', { className: 'rb-wait' },
            hosts.length
              ? (current ? status : '正在读取主机状态…')
              : '没有配置远程服务器：点下方「配置」添加一台（SSH 别名 + 端口）。'),
        h('div', { className: 'rb-dock', onMouseEnter: enterDock, onMouseLeave: leaveDock },
          h('div', { className: 'rb-bar' + (expanded ? '' : ' rb-collapsed') },
            expanded
              ? [
                h('div', { key: 'tabs', className: 'rb-tabs' }, hosts.map((host) => h('button', {
                  key: host.alias,
                  type: 'button',
                  className: 'rb-tab' + (host.alias === selected ? ' rb-active' : ''),
                  title: host.error ?? host.label,
                  onClick: () => setSelected(host.alias),
                },
                  h('span', { className: 'rb-dot', style: { background: host.phase === 'ready' ? hostColor(host.alias) : '#6b7075' } }),
                  host.label))),
                h('span', { key: 'sep1', className: 'rb-sep' }),
                h('span', { key: 'status', className: 'rb-status' }, status),
                h('span', { key: 'sep2', className: 'rb-sep' }),
                h('button', { key: 'config', type: 'button', className: 'rb-btn', onClick: () => setConfigOpen(true), title: '添加/编辑远程服务器（SSH 别名与端口）' }, '配置'),
                h('button', {
                  key: 'reconnect',
                  type: 'button',
                  className: 'rb-btn',
                  disabled: retrying,
                  onClick: reconnect,
                  title: '检查远端 dsh web；没有运行时会自动用 tmux 启动一个',
                }, retrying ? '检查中…' : '重连'),
                h('button', { key: 'close', type: 'button', className: 'rb-btn', onClick: onClose }, '关闭 (Esc)'),
              ]
              : h('div', { className: 'rb-pill' },
                h('span', { className: 'rb-dot', style: { background: dotColor } }),
                h('span', null, current?.label ?? '远程 DSH'),
                h('span', { className: 'rb-pill-hint' }, '悬停展开')))),
        configOpen
          ? h(ConfigDialog, {
            onClose: () => setConfigOpen(false),
            onSaved: (changedAliases) => {
              setConfigOpen(false);
              for (const alias of changedAliases ?? []) bumpFrame(alias);
              setStateTick((value) => value + 1);
            },
          })
          : null);
    }

    function ConfigDialog({ onClose, onSaved }) {
      const [rows, setRows] = useState(null);
      const [initial, setInitial] = useState(new Map());
      const [file, setFile] = useState('');
      const [error, setError] = useState(null);
      const [saving, setSaving] = useState(false);

      useEffect(() => {
        let cancelled = false;
        readJson('/remote-bridge/hosts', { cache: 'no-store' }).then((value) => {
          if (cancelled) return;
          setFile(value.file ?? '');
          const list = (value.hosts ?? []).map((host) => ({
            alias: host.alias ?? '',
            label: host.label ?? '',
            port: String(host.port ?? 3080),
            remoteDir: host.remoteDir ?? '',
          }));
          setRows(list);
          setInitial(new Map(list.map((row) => [row.alias, `${row.port}|${row.remoteDir}`])));
        }).catch((caught) => {
          if (cancelled) return;
          setError(String(caught?.message ?? caught));
          setRows([]);
        });
        return () => { cancelled = true; };
      }, []);

      useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [onClose]);

      const update = (index, patch) => {
        setRows((current) => current.map((row, position) => (position === index ? { ...row, ...patch } : row)));
      };
      const addRow = () => setRows((current) => [...(current ?? []), { alias: '', label: '', port: '3080', remoteDir: '' }]);
      const removeRow = (index) => setRows((current) => current.filter((_row, position) => position !== index));

      const save = async () => {
        if (saving) return;
        setSaving(true);
        setError(null);
        try {
          const cleaned = (rows ?? []).map((row) => ({
            alias: row.alias.trim(),
            label: row.label.trim() || row.alias.trim(),
            port: Number(row.port),
            remoteDir: row.remoteDir.trim() || undefined,
          }));
          const value = await readJson('/remote-bridge/hosts', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ hosts: cleaned }),
          });
          // Only hosts whose connection settings changed need a fresh iframe.
          const changed = [];
          for (const host of value.hosts ?? []) {
            const signature = `${host.port}|${host.remoteDir ?? ''}`;
            const before = initial.get(host.alias);
            if (before !== signature) changed.push(host.alias);
          }
          onSaved?.(changed);
        } catch (caught) {
          setError(String(caught?.message ?? caught));
        } finally {
          setSaving(false);
        }
      };

      return h('div', { className: 'rb-modal-backdrop', onMouseDown: (event) => { if (event.target === event.currentTarget) onClose(); } },
        h('div', { className: 'rb-modal' },
          h('div', { className: 'rb-modal-head' },
            h('strong', null, '远程服务器配置'),
            h('span', { className: 'rb-hint' }, rows === null ? '' : `${rows.length} 台`),
            h('button', {
              type: 'button',
              className: 'rb-x',
              style: { marginLeft: 'auto', fontSize: '16px' },
              title: '关闭',
              onClick: onClose,
            }, '✕')),
          h('div', { className: 'rb-modal-body' },
            h('div', { className: 'rb-hint' }, 'SSH 别名取自 ~/.ssh/config（例如 XZY、2903）；端口是该机器上 dsh web 的端口，默认 3080。远端目录可留空（默认 $HOME）。保存后只有改动过的主机会重新连接。'),
            h('div', { className: 'rb-cfg-labels' },
              h('span', null, 'SSH 别名'),
              h('span', null, '显示名'),
              h('span', null, '远端端口'),
              h('span', null, '远端目录（可选）'),
              h('span', null, '')),
            rows === null
              ? h('div', { className: 'rb-hint' }, '读取中…')
              : rows.map((row, index) => h('div', { className: 'rb-cfg-row', key: index },
                h('input', { value: row.alias, placeholder: 'XZY', onChange: (event) => update(index, { alias: event.target.value }) }),
                h('input', { value: row.label, placeholder: 'XZY (zongyao)', onChange: (event) => update(index, { label: event.target.value }) }),
                h('input', { value: row.port, inputMode: 'numeric', placeholder: '3080', onChange: (event) => update(index, { port: event.target.value.replace(/[^0-9]/g, '') }) }),
                h('input', { value: row.remoteDir, placeholder: '/data/zongyao', onChange: (event) => update(index, { remoteDir: event.target.value }) }),
                h('button', { type: 'button', className: 'rb-x', title: '删除这一台', onClick: () => removeRow(index) }, '✕'))),
            h('div', null,
              h('button', { type: 'button', className: 'rb-btn', onClick: addRow }, '＋ 添加服务器')),
            file ? h('div', { className: 'rb-hint' }, `保存位置：${file}`) : null,
            error ? h('div', { className: 'rb-err' }, error) : null),
          h('div', { className: 'rb-modal-foot' },
            h('button', { type: 'button', className: 'rb-btn', onClick: onClose }, '取消'),
            h('button', { type: 'button', className: 'rb-btn', disabled: saving || rows === null, onClick: save }, saving ? '保存中…' : '保存并生效'))));
    }

    function BridgeTrigger({ wide }) {
      const [mounted, setMounted] = useState(false);
      const [open, setOpen] = useState(false);
      return h(React.Fragment, null,
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h('button', {
          type: 'button',
          className: 'rb-trigger',
          title: '远程 DSH 服务器（在窗口内查看远端会话）',
          onClick: () => {
            setMounted(true);
            setOpen(true);
          },
        },
        h('svg', {
          className: 'rb-icon',
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('rect', { x: 3, y: 4, width: 18, height: 12, rx: 2 }),
        h('path', { d: 'M8 20h8M12 16v4' })),
        wide ? h('span', null, '远程') : null),
        mounted ? h(RemoteView, { visible: open, onClose: () => setOpen(false) }) : null);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'remote-bridge',
          order: 20,
        }, BridgeTrigger));
      },
    };
  },
});
