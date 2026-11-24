/**
 * Host half of the remote bridge (proxy + cookie injection).
 *
 * Goal: the local DSH window embeds a remote machine's own `dsh web` UI, so the
 * agent and the tokens stay on that machine. The operator never copies a token.
 *
 * Why a local reverse proxy instead of a plain `ssh -L` forward:
 *  - `dsh web`'s startup token is single-use: whoever exchanges it first gets the
 *    session cookie, and a second exchange of the same URL is rejected. Probing
 *    the token server-side therefore burns it for the browser.
 *  - The session cookie is `SameSite=Strict` and bound to the authority the
 *    server started with, which makes relying on browser cookies for a
 *    cross-port iframe fragile.
 * So the plugin exchanges the token itself, keeps the cookie in the host
 * process, and injects it into every forwarded request (HTTP and WebSocket).
 * The browser then only ever talks to `http://127.0.0.1:<port>/` — no token, no
 * cookie, no SameSite questions.
 *
 * Ports: the proxy listens on `<port>` (same number the remote `dsh web` uses,
 * so the injected `Host` header equals the cookie's authority). The SSH forward
 * uses `<port + 10000>` internally.
 *
 * Token sources, in order: a configured `url`, the remote tmux scrollback, and —
 * when nothing listens on `<port>` — a tmux session the plugin starts itself.
 *
 * Routes (loopback only, like every plain webserver route):
 *   GET /remote-bridge/state[?ensure=1]              -> host phases (no secrets)
 *   GET /remote-bridge/open?host=<alias>[&refresh=1] -> 303 to the local proxy origin
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

const RESTART_DELAY_MS = 4_000;
const PROBE_TIMEOUT_MS = 5_000;
const READY_TIMEOUT_MS = 75_000;
const TOKEN_PATTERN = /http:\/\/127\.0\.0\.1:\d{1,5}\/?\?token=[A-Za-z0-9_-]{10,}/g;

/** `$DSH_HOME`, falling back to the per-user default. */
function resolveDshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  const home = process.env.USERPROFILE || process.env.HOME || '.';
  return path.join(home, '.dsh');
}

export const name = 'remote-bridge';
export const inject = ['webServer'];

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

const ESCAPE_BRIDGE_MARKER = 'dsh-remote-bridge-escape-bridge';

/**
 * The remote page lives in a cross-origin iframe, so Escape pressed while its
 * UI owns focus never reaches the parent document. Inject a tiny listener that
 * forwards only Escape through `postMessage`; the parent validates the sender.
 */
function patchRemoteHtml(html) {
  if (typeof html !== 'string' || html.includes(ESCAPE_BRIDGE_MARKER)) return html;
  const script = `<script id="${ESCAPE_BRIDGE_MARKER}">(function(){try{`
    + 'if(window.__dshRemoteBridgeEscapeInstalled)return;window.__dshRemoteBridgeEscapeInstalled=true;'
    + "window.addEventListener('keydown',function(event){"
    + "if(event.key==='Escape'||event.key==='Esc'){try{window.parent.postMessage({source:'dsh-remote-bridge',type:'escape'},'*')}catch(error){}}"
    + '},true);'
    + '}catch(error){}})();</script>';
  const bodyClose = html.lastIndexOf('</body>');
  if (bodyClose >= 0) return `${html.slice(0, bodyClose)}${script}${html.slice(bodyClose)}`;
  return `${html}${script}`;
}

/** Rewrite a URL's loopback origin to the remote authority the server expects. */
function rewriteRemoteUrl(host, value) {
  return String(value).replace(/^[a-z]+:\/\/[^/]+/i, `http://127.0.0.1:${host.port}`);
}

/**
 * The remote server's request-trust fence compares `Origin` with the `Host` it
 * is asked for, and refuses a mismatch. The browser talks to the proxy port, so
 * both Origin and Referer must be rewritten to the remote authority before the
 * request is forwarded (otherwise every /api call answers 403).
 */
function rewriteOriginHeaders(host, headers) {
  if (headers.origin) headers.origin = `http://127.0.0.1:${host.port}`;
  if (headers.referer) headers.referer = rewriteRemoteUrl(host, headers.referer);
}

function runRemote(alias, script, timeoutMs = 25_000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', alias, '--', 'bash', '-s'], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: String(error?.message ?? error) });
      return;
    }
    const out = [];
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, timeoutMs);
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', () => {});
    child.on('error', (error) => finish({ code: null, stdout: '', stderr: String(error?.message ?? error) }));
    child.on('close', (code) => finish({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: '' }));
    child.stdin.on('error', () => {});
    child.stdin.end(script);
  });
}

export function apply(ctx, config = {}) {
  const hostsFile = typeof config.hostsFile === 'string' && config.hostsFile.length > 0
    ? config.hostsFile
    : path.join(resolveDshHome(), 'remote-bridge-hosts.json');

  const normalizeHost = (entry) => {
    const configuredUrl = typeof entry.url === 'string' && entry.url.length > 0 ? entry.url : undefined;
    let port = Number(entry.port);
    if (!Number.isInteger(port) && configuredUrl) {
      try { port = Number(new URL(configuredUrl).port); } catch { port = Number.NaN; }
    }
    if (!Number.isInteger(port)) port = 3080;
    // One SSH forward per host; local numbers must not collide across hosts even
    // when every remote uses the same 3080, so the tunnel gets a per-host slot
    // and the proxy defaults to an OS-assigned free port.
    const tunnelPort = Number.isInteger(Number(entry.tunnelPort)) ? Number(entry.tunnelPort) : port + 10000;
    const requestedLocalPort = Number(entry.localPort);
    const localPort = Number.isInteger(requestedLocalPort) && requestedLocalPort > 0 ? requestedLocalPort : 0;
    const mode = entry.mode === 'attach' || entry.mode === 'manage' ? entry.mode : 'auto';
    return {
      alias: String(entry.alias),
      label: entry.label ?? String(entry.alias),
      port,
      localPort,
      tunnelPort: tunnelPort <= 65535 ? tunnelPort : port - 1000,
      mode,
      configuredUrl,
      remoteDir: typeof entry.remoteDir === 'string' ? entry.remoteDir : undefined,
      dshBin: typeof entry.dshBin === 'string' && entry.dshBin.length > 0 ? entry.dshBin : 'dsh',
      session: typeof entry.session === 'string' && entry.session.length > 0 ? entry.session : `dsh-web-${port}`,
      takeover: entry.takeover === true,
    };
  };

  // Every remote may use the same remote port (they are different machines), so
  // the local SSH-forward numbers must be made unique here.
  const assignTunnelPorts = (list) => {
    const usedTunnelPorts = new Set();
    for (const host of list) {
      let candidate = host.tunnelPort;
      while (usedTunnelPorts.has(candidate)) candidate += 1;
      host.tunnelPort = candidate;
      usedTunnelPorts.add(candidate);
    }
    return list;
  };

  const defaultEntries = Array.isArray(config.hosts) ? config.hosts : [];

  /** Hosts persisted by the settings panel, or the profile defaults. */
  function readHostEntries() {
    try {
      const raw = JSON.parse(readFileSync(hostsFile, 'utf8'));
      if (Array.isArray(raw?.hosts)) return raw.hosts;
    } catch {
      // Missing or malformed file: fall back to the profile defaults.
    }
    return defaultEntries;
  }

  let hosts = assignTunnelPorts(readHostEntries().map(normalizeHost));
  let states = new Map(hosts.map((host) => [host.alias, { phase: 'idle', error: null, url: null, pending: null, managed: false }]));
  let runtimes = new Map();
  let disposed = false;

  const log = (message) => {
    try { ctx.logger?.info?.(`[remote-bridge] ${message}`); } catch { /* ignore */ }
    console.log(`[remote-bridge] ${message}`);
  };
  const logError = (message) => console.error(`[remote-bridge] ${message}`);

  function runtimeFor(host) {
    let runtime = runtimes.get(host.alias);
    if (!runtime) {
      runtime = { tunnel: null, proxy: null, cookie: null, restarting: false, suppressed: false, acquiring: null };
      runtimes.set(host.alias, runtime);
    }
    return runtime;
  }

  // ---- low level: forward one request through the SSH tunnel ---------------

  /** Send an HTTP request to the remote dsh web via the tunnel with Host forced. */
  function tunnelRequest(host, { path = '/', method = 'GET', headers = {}, cookie, body, timeoutMs = 10_000 } = {}) {
    return new Promise((resolve) => {
      const merged = { ...headers, host: `127.0.0.1:${host.port}` };
      if (cookie) merged.cookie = cookie;
      if (body !== undefined) merged['content-length'] = Buffer.byteLength(body);
      let request;
      try {
        request = http.request({
          host: '127.0.0.1',
          port: host.tunnelPort,
          method,
          path,
          headers: merged,
        }, (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }));
        });
      } catch (error) {
        resolve({ status: 0, headers: {}, body: Buffer.alloc(0), error });
        return;
      }
      const timer = setTimeout(() => { try { request.destroy(); } catch { /* ignore */ } resolve({ status: 0, headers: {}, body: Buffer.alloc(0) }); }, timeoutMs);
      request.on('error', () => { clearTimeout(timer); resolve({ status: 0, headers: {}, body: Buffer.alloc(0) }); });
      request.on('close', () => clearTimeout(timer));
      request.end(body);
    });
  }

  /**
   * Call one authenticated Remote method on the remote host through the bridge.
   * Envelope and per-endpoint argument names are the ones the remote client
   * itself uses (`{type:'client-request', rpcId, method, payload:{args}}`).
   */
  async function remoteRpc(host, method, args, timeoutMs = 30_000) {
    await ensureHost(host);
    const state = states.get(host.alias);
    if (state.phase !== 'ready') throw new Error(state.error ?? `${host.alias} is not ready`);
    const rpcId = `rb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const payload = JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } });
    const result = await tunnelRequest(host, {
      method: 'POST',
      path: `/api/${method}`,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      body: payload,
      cookie: runtimeFor(host).cookie,
      timeoutMs,
    });
    if (result.status !== 200) throw new Error(`remote ${method} answered HTTP ${result.status}`);
    const envelope = JSON.parse(result.body.toString('utf8'));
    if (envelope?.type !== 'server-response') throw new Error(`remote ${method} answered an unexpected envelope`);
    if (!envelope.result?.ok) {
      throw new Error(`${method}: ${envelope.result?.error?.code ?? 'error'} ${envelope.result?.error?.message ?? ''}`.trim());
    }
    return envelope.result.value;
  }

  /** Exchange a single-use startup token for the session cookie. */
  async function exchangeToken(host, tokenUrl) {
    const parsed = new URL(tokenUrl);
    const result = await tunnelRequest(host, { path: `${parsed.pathname}${parsed.search}` });
    const setCookie = result.headers?.['set-cookie'];
    if (result.status !== 303 && result.status !== 302) return undefined;
    const cookies = (Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [])
      .map((entry) => String(entry).split(';')[0])
      .filter((pair) => pair.includes('='));
    if (cookies.length === 0) return undefined;
    const cookie = cookies.join('; ');
    const verified = await tunnelRequest(host, { path: '/', cookie });
    return verified.status === 200 ? cookie : undefined;
  }

  async function acquireCookie(host, urls) {
    const runtime = runtimeFor(host);
    for (const url of urls) {
      const cookie = await exchangeToken(host, url);
      if (cookie) {
        runtime.cookie = cookie;
        return true;
      }
    }
    return false;
  }

  // ---- local proxy --------------------------------------------------------
  //
  // The proxy listens on a local port of its own choosing (config `localPort`,
  // else `<remote port> + 20000`, else an OS-assigned port). It is NOT tied to
  // the remote port: the injected Host header below carries the remote
  // authority the session cookie is bound to, so any local port works and
  // several hosts can be proxied at the same time.

  function startProxy(host) {
    return new Promise((resolve) => {
      const runtime = runtimeFor(host);
      if (runtime.proxy) {
        resolve(runtime.localPort);
        return;
      }
      const server = http.createServer((request, response) => {
        const headers = { ...request.headers };
        delete headers.host;
        delete headers.cookie;
        // Keep upstream responses uncompressed so HTML can be patched below.
        delete headers['accept-encoding'];
        rewriteOriginHeaders(host, headers);
        const upstream = http.request({
          host: '127.0.0.1',
          port: host.tunnelPort,
          method: request.method,
          path: request.url,
          headers: { ...headers, host: `127.0.0.1:${host.port}`, ...(runtime.cookie ? { cookie: runtime.cookie } : {}) },
        }, (upstreamResponse) => {
          const contentType = String(upstreamResponse.headers['content-type'] ?? '');
          if (!contentType.startsWith('text/html')) {
            response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
            upstreamResponse.pipe(response);
            return;
          }
          const chunks = [];
          upstreamResponse.on('data', (chunk) => chunks.push(chunk));
          upstreamResponse.on('end', () => {
            const html = patchRemoteHtml(Buffer.concat(chunks).toString('utf8'));
            const responseHeaders = { ...upstreamResponse.headers };
            delete responseHeaders['content-length'];
            delete responseHeaders['content-encoding'];
            delete responseHeaders['etag'];
            responseHeaders['content-length'] = Buffer.byteLength(html);
            response.writeHead(upstreamResponse.statusCode ?? 200, responseHeaders);
            response.end(html);
          });
          upstreamResponse.on('error', () => {
            if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
            response.end('remote bridge: upstream read failed');
          });
        });
        upstream.on('error', () => {
          if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('remote bridge: upstream connection failed');
        });
        request.pipe(upstream);
      });
      server.on('upgrade', (request, socket, head) => {
        const upstream = net.connect(host.tunnelPort, '127.0.0.1', () => {
          let raw = `${request.method} ${request.url} HTTP/1.1\r\n`;
          for (const [name, value] of Object.entries(request.headers)) {
            if (name === 'host' || name === 'cookie') continue;
            if (name === 'origin') { raw += `Origin: http://127.0.0.1:${host.port}\r\n`; continue; }
            if (name === 'referer') { raw += `Referer: ${rewriteRemoteUrl(host, value)}\r\n`; continue; }
            raw += `${name}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`;
          }
          raw += `Host: 127.0.0.1:${host.port}\r\n`;
          if (runtime.cookie) raw += `Cookie: ${runtime.cookie}\r\n`;
          raw += '\r\n';
          upstream.write(raw);
          if (head?.length) upstream.write(head);
          upstream.pipe(socket);
          socket.pipe(upstream);
        });
        upstream.on('error', () => socket.destroy());
        socket.on('error', () => upstream.destroy());
      });
      runtime.proxy = server;
      const requested = Number.isInteger(host.localPort) && host.localPort > 0 ? host.localPort : 0;
      let settled = false;
      const settle = (port) => {
        if (settled) return;
        settled = true;
        if (port && port > 0) {
          runtime.localPort = port;
          log(`${host.alias}: local proxy listening on 127.0.0.1:${port}`);
          resolve(port);
        } else {
          runtime.proxy = null;
          resolve(0);
        }
      };
      server.on('listening', () => settle(server.address()?.port ?? 0));
      server.on('error', (error) => {
        logError(`${host.alias}: proxy on ${requested || 'auto'} failed: ${error?.message ?? error}`);
        try { server.close(); } catch { /* ignore */ }
        runtime.proxy = null;
        if (requested && /EADDRINUSE|address already in use/i.test(String(error?.message))) {
          // Fall back to an OS-assigned port and try once more.
          host.localPort = 0;
          startProxy(host).then((port) => settle(port), () => settle(0));
          return;
        }
        settle(0);
      });
      server.listen(requested, '127.0.0.1');
    });
  }

  function stopProxy(host) {
    const runtime = runtimeFor(host);
    if (!runtime.proxy) return;
    try { runtime.proxy.close(); } catch { /* ignore */ }
    runtime.proxy = null;
    runtime.cookie = null;
  }

  function startTunnel(host, attempt = 0) {
    const runtime = runtimeFor(host);
    if (runtime.tunnel) return;
    const child = spawn('ssh', [
      '-N',
      '-o', 'BatchMode=yes',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=20',
      '-o', 'ServerAliveCountMax=3',
      '-L', `${host.tunnelPort}:127.0.0.1:${host.port}`,
      host.alias,
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    runtime.tunnel = child;
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (!text) return;
      logError(`tunnel ${host.alias}: ${text}`);
      if (attempt < 4 && /Address already in use|cannot listen/i.test(text)) {
        setTimeout(() => {
          if (disposed || runtime.tunnel) return;
          runtime.tunnel = null;
          startTunnel(host, attempt + 1);
        }, 900).unref?.();
      }
    });
    child.on('exit', (code) => {
      runtime.tunnel = null;
      if (disposed || runtime.suppressed) return;
      logError(`tunnel ${host.alias} exited (code ${code}); reconnecting in ${RESTART_DELAY_MS} ms`);
      const state = states.get(host.alias);
      state.phase = 'error';
      state.error = 'SSH 隧道断开，正在重连…';
      setTimeout(() => {
        if (disposed || runtime.restarting) return;
        runtime.restarting = true;
        ensureHost(host).finally(() => { runtime.restarting = false; });
      }, RESTART_DELAY_MS).unref?.();
    });
  }

  // ---- remote discovery ---------------------------------------------------

  async function captureRemoteUrls(host, sessionName) {
    const targets = sessionName
      ? `tmux list-panes -t ${shellQuote(sessionName)} -F "#{session_name}:#{window_index}.#{pane_index}" 2>/dev/null`
      : 'tmux list-panes -a -F "#{session_name}:#{window_index}.#{pane_index}" 2>/dev/null';
    const script = [
      `${targets} | while IFS= read -r pane; do`,
      '  tmux capture-pane -pJ -t "$pane" -S -8000 2>/dev/null | grep -aoE "http://127\\.0\\.0\\.1:[0-9]{1,5}/\\?token=[A-Za-z0-9_-]{10,}" || true',
      'done | tail -n 8',
    ].join('\n');
    const result = await runRemote(host.alias, script);
    if (result.code !== 0 || result.stdout.trim() === '') return [];
    return [...new Set(result.stdout.match(TOKEN_PATTERN) ?? [])];
  }

  async function startManaged(host) {
    const state = states.get(host.alias);
    const launcher = `$HOME/.dsh/remote-bridge-${host.port}.sh`;
    const content = [
      '#!/bin/bash',
      `cd ${shellQuote(host.remoteDir ?? '$HOME')} 2>/dev/null || cd "$HOME"`,
      `DSH_BIN=${shellQuote(host.dshBin)}`,
      'if ! command -v "$DSH_BIN" >/dev/null 2>&1; then',
      '  for candidate in "$HOME"/.nvm/versions/node/*/bin/dsh "$HOME"/software/node/bin/dsh "$HOME"/.local/bin/dsh /usr/local/bin/dsh; do',
      '    if [ -x "$candidate" ]; then DSH_BIN="$candidate"; break; fi',
      '  done',
      'fi',
      'echo "remote-bridge: resolved dsh=$DSH_BIN"',
      'case "$DSH_BIN" in */*) export PATH="$(dirname "$DSH_BIN"):$PATH";; esac',
      `exec "$DSH_BIN" web --no-open --port ${host.port}`,
    ].join('\n');
    const heredoc = 'DSH_REMOTE_BRIDGE_LAUNCHER';
    const script = [
      'mkdir -p "$HOME/.dsh"',
      `cat > ${launcher} <<'${heredoc}'`,
      content,
      heredoc,
      `chmod +x ${launcher}`,
      `fuser -k -9 ${host.port}/tcp >/dev/null 2>&1 || true`,
      'sleep 1',
      `if tmux has-session -t ${shellQuote(host.session)} 2>/dev/null; then tmux kill-session -t ${shellQuote(host.session)}; fi`,
      `tmux new-session -d -s ${shellQuote(host.session)} "bash ${launcher}"`,
      'sleep 3',
      `tmux capture-pane -pJ -t ${shellQuote(host.session)} -S -400 2>/dev/null | tail -n 25`,
    ].join('\n');
    const result = await runRemote(host.alias, script, 40_000);
    if (result.code !== 0) {
      throw new Error(`在 ${host.alias} 上启动 tmux 托管的 dsh web 失败（退出码 ${result.code}）；请确认远端装了 tmux`);
    }
    state.managed = true;
    log(`${host.alias}: started a tmux-managed dsh web (session ${host.session})`);
    return [...new Set(result.stdout.match(TOKEN_PATTERN) ?? [])];
  }

  function retargetPort(host) {
    for (const other of hosts) {
      if (other.alias === host.alias || other.port !== host.port) continue;
      const otherRuntime = runtimeFor(other);
      const otherState = states.get(other.alias);
      if (otherRuntime.tunnel) {
        otherRuntime.suppressed = true;
        try { otherRuntime.tunnel.kill(); } catch { /* ignore */ }
        otherRuntime.tunnel = null;
        setTimeout(() => { otherRuntime.suppressed = false; }, 3_000).unref?.();
      }
      stopProxy(other);
      otherState.phase = 'idle';
      otherState.url = null;
    }
  }

  async function ensureHost(host, { refresh = false } = {}) {
    const state = states.get(host.alias);
    if (!refresh && state.phase === 'ready' && state.url) return Promise.resolve(state);
    if (state.pending) return state.pending;
    state.pending = (async () => {
      state.phase = 'starting';
      state.error = null;
      try {
        startTunnel(host);
        const localPort = await startProxy(host);
        if (!localPort) throw new Error('本地代理端口无法绑定（可配置 localPort 指定一个空闲端口）');
        const urls = [];
        if (host.configuredUrl) urls.push(host.configuredUrl);
        let managedAttempted = false;
        const deadline = Date.now() + READY_TIMEOUT_MS;
        let lastError = '远端 dsh web 没有响应';
        while (Date.now() < deadline) {
          if (disposed) throw new Error('plugin disposed');
          const listening = await tunnelRequest(host, { path: '/' });
          const remoteUp = listening.status > 0;
          if (remoteUp) {
            const fresh = await captureRemoteUrls(host).catch(() => []);
            for (const url of fresh) if (!urls.includes(url)) urls.unshift(url);
            if (await acquireCookie(host, urls)) {
              state.url = `http://127.0.0.1:${localPort}/`;
              state.phase = 'ready';
              log(`${host.alias}: ready via local proxy port ${localPort} (${state.managed ? 'managed' : 'attach'})`);
              return state;
            }
            lastError = '远端 dsh web 在运行，但所有已知 token 都已失效（通常是一次性 token 被用掉了；等它重新打印 URL 或让插件托管）';
          } else if (host.mode !== 'attach' && !managedAttempted) {
            managedAttempted = true;
            const found = await startManaged(host).catch((error) => {
              lastError = error?.message ?? String(error);
              logError(`${host.alias}: ${lastError}`);
              return [];
            });
            for (const url of found) if (!urls.includes(url)) urls.unshift(url);
            continue;
          }
          if (state.managed) {
            for (const url of await captureRemoteUrls(host, host.session).catch(() => [])) {
              if (!urls.includes(url)) urls.unshift(url);
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          if (!runtimeFor(host).tunnel && !disposed) startTunnel(host);
        }
        throw new Error(lastError);
      } catch (error) {
        state.phase = 'error';
        state.error = error?.message ?? String(error);
        logError(`${host.alias}: ${state.error}`);
      } finally {
        state.pending = null;
      }
      return state;
    })();
    return state.pending;
  }

  // ---- host configuration (settings panel) --------------------------------

  const publicHost = (host) => ({
    alias: host.alias,
    label: host.label,
    port: host.port,
    remoteDir: host.remoteDir,
  });

  /** Accept the settings panel payload, rejecting anything a bridge cannot use. */
  function sanitizeHosts(input) {
    if (!Array.isArray(input)) throw new Error('hosts 必须是数组');
    if (input.length > 32) throw new Error('主机数量过多（最多 32 台）');
    const cleaned = [];
    const seen = new Set();
    for (const entry of input) {
      const alias = String(entry?.alias ?? '').trim();
      if (!/^[A-Za-z0-9._@:-]+$/.test(alias)) {
        throw new Error(`SSH 别名不合法：${JSON.stringify(alias)}（只允许字母、数字和 . _ @ : - ）`);
      }
      if (seen.has(alias)) throw new Error(`SSH 别名重复：${alias}`);
      seen.add(alias);
      const portValue = entry?.port === undefined || entry?.port === '' ? 3080 : Number(entry.port);
      if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
        throw new Error(`${alias}: 端口必须是 1-65535 的整数`);
      }
      const label = typeof entry?.label === 'string' && entry.label.trim() ? entry.label.trim() : alias;
      const remoteDir = typeof entry?.remoteDir === 'string' && entry.remoteDir.trim() ? entry.remoteDir.trim() : undefined;
      cleaned.push({ alias, label, port: portValue, ...(remoteDir ? { remoteDir } : {}) });
    }
    return cleaned;
  }

  function disposeRuntime(host) {
    stopProxy(host);
    const runtime = runtimes.get(host.alias);
    if (runtime?.tunnel) {
      runtime.suppressed = true;
      try { runtime.tunnel.kill(); } catch { /* ignore */ }
    }
  }

  /** Identity of a host's connection-relevant settings (label changes are free). */
  const hostSignature = (host) => JSON.stringify({
    port: host.port,
    remoteDir: host.remoteDir ?? null,
    mode: host.mode,
    configuredUrl: host.configuredUrl ?? null,
    dshBin: host.dshBin,
    session: host.session,
    takeover: host.takeover,
  });

  /**
   * Apply a saved host list with a diff: hosts whose connection settings did
   * not change keep their tunnel, proxy and ready state, so saving the settings
   * panel never reconnects servers the operator did not touch.
   */
  function applyHostList(entries) {
    const previous = new Map(hosts.map((host) => [host.alias, host]));
    const usedTunnelPorts = new Set();
    const nextHosts = [];
    const reconnecting = [];

    for (const entry of entries) {
      const candidate = normalizeHost(entry);
      const existing = previous.get(candidate.alias);
      if (existing && hostSignature(existing) === hostSignature(candidate)) {
        existing.label = candidate.label;
        existing.remoteDir = candidate.remoteDir;
        existing.tunnelPort = existing.tunnelPort;
        nextHosts.push(existing);
        usedTunnelPorts.add(existing.tunnelPort);
        continue;
      }
      let tunnelPort = candidate.port + 10000;
      while (usedTunnelPorts.has(tunnelPort)) tunnelPort += 1;
      if (tunnelPort > 65535) tunnelPort = 20000 + nextHosts.length;
      candidate.tunnelPort = tunnelPort;
      usedTunnelPorts.add(tunnelPort);
      if (existing) disposeRuntime(existing);
      nextHosts.push(candidate);
      reconnecting.push(candidate.alias);
    }

    const kept = new Set(nextHosts.map((host) => host.alias));
    for (const previousHost of hosts) {
      if (!kept.has(previousHost.alias)) disposeRuntime(previousHost);
    }

    const previousStates = states;
    const previousRuntimes = runtimes;
    const reconnectingSet = new Set(reconnecting);
    hosts = nextHosts;
    states = new Map(nextHosts.map((host) => [host.alias, reconnectingSet.has(host.alias) ? {
      phase: 'idle',
      error: null,
      url: null,
      pending: null,
      managed: false,
    } : (previousStates.get(host.alias) ?? {
      phase: 'idle',
      error: null,
      url: null,
      pending: null,
      managed: false,
    })]));
    runtimes = new Map();
    for (const host of nextHosts) {
      // A changed host must start from a clean runtime; only untouched hosts
      // keep their live tunnel/proxy/cookie state.
      if (reconnectingSet.has(host.alias)) continue;
      const previousRuntime = previousRuntimes.get(host.alias);
      if (previousRuntime) runtimes.set(host.alias, previousRuntime);
    }

    log(`host configuration updated (reconnecting: ${reconnecting.join(', ') || 'none'}; kept: ${nextHosts.length - reconnecting.length})`);
    for (const alias of reconnecting) {
      const host = hosts.find((candidate) => candidate.alias === alias);
      if (host) ensureHost(host).catch(() => {});
    }
  }

  /**
   * Force a health check for one host. Unlike `/state?ensure=1` this ignores
   * the cached `ready` phase, so the dock's "重连" can notice that a remote
   * `dsh web` died and let the bridge start one in tmux again.
   */
  async function retryHandler(request, response) {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const host = hosts.find((candidate) => candidate.alias === body.host);
      if (!host) throw new Error(`unknown remote host: ${body.host ?? '(missing host)'}`);
      const state = await ensureHost(host, { refresh: true });
      sendJson(response, 200, {
        ok: state.phase === 'ready',
        alias: host.alias,
        phase: state.phase,
        error: state.error ?? null,
      });
    } catch (error) {
      sendJson(response, 503, { error: String(error?.message ?? error) });
    }
  }

  async function hostsHandler(request, response) {
    if (request.method === 'POST') {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const entries = sanitizeHosts(body?.hosts);
        mkdirSync(path.dirname(hostsFile), { recursive: true });
        writeFileSync(hostsFile, `${JSON.stringify({ version: 1, hosts: entries }, null, 2)}\n`, 'utf8');
        applyHostList(entries);
        sendJson(response, 200, { ok: true, file: hostsFile, hosts: hosts.map(publicHost) });
      } catch (error) {
        sendJson(response, 400, { error: String(error?.message ?? error) });
      }
      return;
    }
    sendJson(response, 200, {
      file: hostsFile,
      hosts: hosts.map(publicHost),
      defaults: defaultEntries.map((entry) => ({ alias: entry.alias, label: entry.label, port: entry.port, remoteDir: entry.remoteDir })),
    });
  }

  function jsonHandler(request, response) {
    const url = new URL(request.url ?? '/', 'http://x');
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    response.end(JSON.stringify({
      hosts: hosts.map((host) => {
        const state = states.get(host.alias);
        const runtime = runtimeFor(host);
        return {
          alias: host.alias,
          label: host.label,
          port: host.port,
          phase: state.phase,
          error: state.error,
          managed: state.managed,
          // Local proxy origin for this host. The browser can embed it directly
          // as an iframe (no token, no /open redirect in the navigation path).
          url: state.phase === 'ready' && runtime.localPort ? `http://127.0.0.1:${runtime.localPort}/` : null,
          localPort: runtime.localPort ?? null,
        };
      }),
    }));
    if (url.searchParams.get('ensure') === '1') {
      for (const host of hosts) ensureHost(host).catch(() => {});
    }
  }

  // ---- unified remote-session browse (list / transcript / prompt) ----------

  function sendJson(response, status, value) {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    response.end(JSON.stringify(value));
  }

  function hostFromQuery(url) {
    const alias = url.searchParams.get('host');
    const host = hosts.find((candidate) => candidate.alias === alias);
    if (!host) throw new Error(`unknown remote host: ${alias ?? '(missing host)'}`);
    return host;
  }

  function partsText(parts) {
    if (!Array.isArray(parts)) return '';
    const pieces = [];
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'text' && typeof part.text === 'string') pieces.push(part.text);
      else if (part.type === 'image') pieces.push('[图片]');
      else if (part.type === 'file') pieces.push('[文件]');
    }
    return pieces.join('\n').trim();
  }

  function compactPreview(value, max = 160) {
    if (value === undefined || value === null) return '';
    let text;
    try { text = typeof value === 'string' ? value : JSON.stringify(value); } catch { text = String(value); }
    text = text.replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }

  function summaryOf(item) {
    const values = item.projections?.values ?? {};
    const title = typeof values.title === 'string' && values.title.trim() ? values.title.trim() : undefined;
    const folder = typeof item.cwd === 'string' && item.cwd.length > 0 ? item.cwd.split('/').filter(Boolean).pop() : undefined;
    return {
      sessionId: item.sessionId,
      title: title ?? (folder ? `${folder}（未命名）` : '（未命名会话）'),
      cwd: item.cwd ?? values.workingDirectory,
      running: item.running === true,
      blank: item.blank === true,
      origin: item.origin === 'subagent' ? 'subagent' : 'session',
      parentSessionId: item.parentSessionId,
      updatedAt: item.updatedAt,
      throughSeq: item.projections?.asOfSeq,
      goalPhase: typeof values.goal?.goal?.phase === 'string' ? values.goal.goal.phase : undefined,
      outputTokens: values.tokenUsage?.outputTokens,
      model: values.modelSelection?.next?.model ?? values.modelSelection?.lastUsed?.model,
    };
  }

  /** Turn raw durable Session events into a small renderable message list. */
  function normalizeRecords(records) {
    const messages = [];
    for (const record of records ?? []) {
      const event = record?.event;
      if (!event || typeof event.seq !== 'number') continue;
      const data = event.data ?? {};
      const message = data.message;
      if (message && (message.role === 'user' || message.role === 'assistant')) {
        const text = partsText(message.content);
        if (text) messages.push({ seq: event.seq, kind: message.role, text, time: event.time });
        continue;
      }
      if (event.type === 'tool/call') {
        const call = data.toolCall ?? data;
        const name = call?.name ?? call?.toolName ?? 'tool';
        messages.push({ seq: event.seq, kind: 'tool', text: `${name} ${compactPreview(call?.arguments ?? call?.input)}`, time: event.time });
        continue;
      }
      if (event.type === 'tool/result') {
        const text = partsText(data.message?.content) || compactPreview(data, 400);
        messages.push({ seq: event.seq, kind: 'tool-result', text: text.slice(0, 1200), time: event.time });
        continue;
      }
      if (event.type === 'turn/end') {
        messages.push({ seq: event.seq, kind: 'info', text: `— 本轮结束（${data.reason?.kind ?? 'done'}）`, time: event.time });
        continue;
      }
      if (event.type === 'session/title' && typeof data.title === 'string') {
        messages.push({ seq: event.seq, kind: 'info', text: `标题：${data.title}`, time: event.time });
      }
    }
    messages.sort((left, right) => left.seq - right.seq);
    return messages;
  }

  async function sessionsHandler(request, response) {
    try {
      const url = new URL(request.url ?? '/', 'http://x');
      const host = hostFromQuery(url);
      const value = await remoteRpc(host, 'session/list', { _request: {} });
      const sessions = (value.items ?? [])
        .map(summaryOf)
        .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
      sendJson(response, 200, {
        host: host.alias,
        label: host.label,
        sessions: sessions.filter((session) => session.origin === 'session'),
        subagents: sessions.filter((session) => session.origin === 'subagent'),
      });
    } catch (error) {
      sendJson(response, 503, { error: String(error?.message ?? error) });
    }
  }

  async function sessionHandler(request, response) {
    try {
      const url = new URL(request.url ?? '/', 'http://x');
      const host = hostFromQuery(url);
      const sessionId = url.searchParams.get('id');
      if (!sessionId) throw new Error('missing session id');
      const maxMessages = Math.min(Math.max(Number(url.searchParams.get('maxMessages')) || 30, 5), 100);
      const beforeSeqRaw = url.searchParams.get('beforeSeq');
      const list = await remoteRpc(host, 'session/list', { _request: {} });
      const summary = (list.items ?? []).find((item) => item.sessionId === sessionId);
      if (!summary) throw new Error(`unknown session ${sessionId}`);
      const pageRequest = {
        address: { kind: 'session', sessionId },
        throughSeq: Number.isFinite(summary.projections?.asOfSeq) ? summary.projections.asOfSeq : Number.MAX_SAFE_INTEGER,
        maxMessages,
      };
      if (beforeSeqRaw) pageRequest.beforeSeq = Number(beforeSeqRaw);
      const page = await remoteRpc(host, 'session/page', { request: pageRequest });
      sendJson(response, 200, {
        host: host.alias,
        sessionId,
        meta: summaryOf(summary),
        running: summary.running === true,
        hasMore: page.hasMore === true,
        messages: normalizeRecords(page.records),
      });
    } catch (error) {
      sendJson(response, 503, { error: String(error?.message ?? error) });
    }
  }

  async function promptHandler(request, response) {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const host = hosts.find((candidate) => candidate.alias === body.host);
      if (!host) throw new Error(`unknown remote host: ${body.host ?? '(missing host)'}`);
      const sessionId = String(body.sessionId ?? '');
      const text = String(body.text ?? '');
      if (!sessionId) throw new Error('missing sessionId');
      if (!text.trim()) throw new Error('empty prompt');
      await remoteRpc(host, 'session/prompt', {
        request: {
          requestId: randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
          clientTimeZone: typeof body.clientTimeZone === 'string' ? body.clientTimeZone : 'Asia/Shanghai',
        },
      });
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendJson(response, 503, { error: String(error?.message ?? error) });
    }
  }

  async function openHandler(request, response) {
    const url = new URL(request.url ?? '/', 'http://x');
    const alias = url.searchParams.get('host');
    const host = hosts.find((candidate) => candidate.alias === alias);
    if (!host) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`unknown remote host: ${alias ?? '(missing host)'}`);
      return;
    }
    await ensureHost(host, { refresh: url.searchParams.get('refresh') === '1' });
    const state = states.get(host.alias);
    if (state.phase === 'ready' && state.url) {
      response.writeHead(303, { location: state.url, 'cache-control': 'no-store' });
      response.end();
      return;
    }
    const message = String(state.error ?? '远程 DSH 正在连接…').replace(/[<&]/g, (character) => (character === '<' ? '&lt;' : '&amp;'));
    response.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(`<!doctype html><meta charset="utf-8"><style>body{font:13px/1.6 system-ui,sans-serif;color:#888;display:flex;height:100vh;margin:0;align-items:center;justify-content:center;padding:24px;text-align:center}</style><p>${message}</p>`);
  }

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({ kind: 'exact', path: '/remote-bridge/state', handler: jsonHandler }),
      ctx.webServer.register({ kind: 'exact', path: '/remote-bridge/open', handler: openHandler }),
      ctx.webServer.register({ kind: 'exact', path: '/remote-bridge/sessions', handler: sessionsHandler }),
      ctx.webServer.register({ kind: 'exact', path: '/remote-bridge/session', handler: sessionHandler }),
      ctx.webServer.register({ kind: 'exact', path: '/remote-bridge/prompt', handler: promptHandler }),
      ctx.webServer.register({ kind: 'exact', path: '/remote-bridge/hosts', handler: hostsHandler }),
      ctx.webServer.register({ kind: 'exact', path: '/remote-bridge/retry', handler: retryHandler }),
    ];
    return () => {
      disposed = true;
      for (const dispose of disposers) {
        try { dispose(); } catch { /* ignore */ }
      }
      for (const host of hosts) {
        stopProxy(host);
        const runtime = runtimeFor(host);
        try { runtime.tunnel?.kill(); } catch { /* ignore */ }
      }
    };
  });

  log(`proxy bridge for ${hosts.length} host(s): ${hosts.map((host) => `${host.alias}:${host.port}->127.0.0.1:${host.port}`).join(', ') || 'none'}`);
}
