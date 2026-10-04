'use strict';
/* 局域网远程控制 · 手机端界面
   与 PC 被控端通过 WebSocket 通信：
   - 文本帧：JSON 控制指令（双向）
   - 二进制帧：JPEG 画面（头部 14 字节 + JPEG 数据）
*/

const $ = (sel) => document.querySelector(sel);

const state = {
  // 键盘打开时，单指拖动是「移动画面」还是「移动鼠标」。
  // 默认移动鼠标 —— 不能默认移画面，那会让虚拟鼠标失效。
  panMode: false,
  ws: null,
  authed: false,
  streaming: false,
  monitor: 0,
  monitors: [],
  scale: 1,
  quality: 72,
  maxWidth: 1280,
  fps: 20,
  connected: false,
  drawing: false,
  cursor: { x: 0.5, y: 0.5 },
  lastFrameAt: 0,
  lastStats: '',
  lastMessage: '',
  frameCount: 0,
  cursorTimer: null,
  mode: 'mouse',
  // 搜索电脑用：记住上次连上的主机与网段，以及服务端告知的能力
  lastHost: '',
  serverAddresses: [],
  serverPort: 0,
  audioOk: true,
  audioMessage: '',
  // 虚拟鼠标（触控板式）：单指相对移动指针，轻点左键，长按拖动，双指轻点右键
  vmouse: {
    enabled: false,
    sensitivity: 1.0,   // 手指移动 1 像素对应的指针移动倍率
    dragging: false,    // 是否处于按住拖动状态
    x: 0.5,
    y: 0.5,
    lastTapAt: 0,
  },
  filePath: '',
  clipboardText: '',
};

/* ---------------- 工具函数 ---------------- */
function toast(text, ms = 1800) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

function confirmBox(text) {
  return new Promise((resolve) => {
    $('#confirmText').textContent = text;
    $('#confirm').classList.remove('hidden');
    const done = (v) => {
      $('#confirm').classList.add('hidden');
      $('#confirmYes').onclick = null;
      $('#confirmNo').onclick = null;
      resolve(v);
    };
    $('#confirmYes').onclick = () => done(true);
    $('#confirmNo').onclick = () => done(false);
  });
}

function fmtSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)) + ' ' + units[i];
}

function saveSettings() {
  try {
    localStorage.setItem('lancontrol.settings', JSON.stringify({
      addr: $('#addrInput').value.trim(),
      quality: state.quality, maxWidth: state.maxWidth, fps: state.fps, monitor: state.monitor,
      vmouse: state.vmouse.enabled, sens: state.vmouse.sensitivity,
      vx: +state.vmouse.x.toFixed(4), vy: +state.vmouse.y.toFixed(4),
    }));
  } catch (e) { /* 隐私模式下忽略 */ }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem('lancontrol.settings');
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s.addr) $('#addrInput').value = s.addr;
    if (s.quality) state.quality = s.quality;
    if (s.maxWidth) state.maxWidth = s.maxWidth;
    if (s.fps) state.fps = s.fps;
    if (typeof s.monitor === 'number') state.monitor = s.monitor;
    if (s.vmouse) state.vmouseEnabledOnLoad = true;
    if (s.sens) state.vmouse.sensitivity = s.sens;
    // 记住上次的指针位置：刷新页面/重连后不要"跳回屏幕中央"
    if (typeof s.vx === 'number' && typeof s.vy === 'number') {
      state.vmouse.x = s.vx;
      state.vmouse.y = s.vy;
      state.cursor = { x: s.vx, y: s.vy };
    }
  } catch (e) { }
}

/* ---------------- 连接 ----------------
   注意：界面上的地址输入框是**真正生效**的。
   之前这里写死用 location.host，导致登录页那个地址栏形同摆设 ——
   手输地址、自动搜索找到的地址都不会被采用（这也是"搜不到/只能手动连接"别扭的根源之一）。 */
function normalizeHost(raw) {
  let s = (raw || '').trim();
  if (!s) return location.host;
  s = s.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!/:\d+$/.test(s)) s += ':' + (location.port || '8848');
  return s;
}

function wsUrl(host) {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  return proto + (host || location.host) + '/ws';
}

function connect() {
  const code = $('#codeInput').value.trim();
  // 地址栏可能只填了 IP（或带 http:// 前缀），统一规范化后再用
  const target = normalizeHost($('#addrInput') ? $('#addrInput').value : '');
  if ($('#addrInput')) $('#addrInput').value = target;
  if (!/^\d{4,8}$/.test(code)) {
    setLoginMsg('请输入电脑上显示的配对码（数字）', true);
    return;
  }
  saveSettings();
  state.lastHost = target.split(':')[0];   // 记住网段，供"搜索电脑"直连扫描使用
  setLoginMsg('正在连接 ' + target + ' …');
  $('#connectBtn').disabled = true;

  let settled = false;
  const ws = new WebSocket(wsUrl(target));
  // 用 blob 接收二进制帧：交给 <img> 解码兼容性最好（部分 WebView 的 arraybuffer 路径会出问题）
  ws.binaryType = 'blob';
  state.ws = ws;

  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      try { ws.close(); } catch (e) { }
      setLoginMsg('连接超时：请确认手机与电脑在同一局域网，且被控端正在运行。', true);
      $('#connectBtn').disabled = false;
    }
  }, 8000);

  ws.onopen = () => {
    clearTimeout(timeout);
    settled = true;
    state.connected = true;
    ws.send(JSON.stringify({ type: 'auth', code, device: deviceName() }));

    // 配对码发出去后回写 APK 存档 —— "记住此设备"真正落盘的时机。
    // 是否真的落盘由 APK 内部按复选框状态决定（未勾选就忽略），
    // 这里不再加额外判断：否则第一次连接时存档还是空的，会陷入"永远存不上"的死循环。
    try {
      if (window.LanControlApp && window.LanControlApp.saveRemembered) {
        const host = (($('#addrInput') && $('#addrInput').value) || location.host || '').trim();
        if (code) window.LanControlApp.saveRemembered(host, code);
      }
    } catch (e) { }
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      try { handleMessage(JSON.parse(ev.data)); } catch (e) { /* 忽略异常消息 */ }
      return;
    }
    // 二进制帧有两种：画面（14 字节头，首字节 0x01）与声音（8 字节头，首字节 0x41='A'）
    if (ev.data instanceof Blob) {
      handleBinaryBlob(ev.data);
    } else {
      const buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : new Uint8Array(ev.data.buffer || ev.data);
      routeBinary(buf, 0);
    }
  };

  ws.onerror = () => {
    if (!settled) {
      settled = true;
      clearTimeout(timeout);
      setLoginMsg('无法连接到 ' + target + '，请检查地址与防火墙设置。', true);
      $('#connectBtn').disabled = false;
    }
  };

  ws.onclose = () => {
    state.connected = false;
    state.streaming = false;
    $('#connectBtn').disabled = false;
    if (state.authed) {
      state.authed = false;
      toast('连接已断开');
      $('#login').classList.remove('hidden');
      $('#control').classList.add('hidden');
      $('#waiting').classList.remove('hidden');
    }
  };
}

/* ---------------- 二进制帧路由：画面 vs 声音 ---------------- */
function handleBinaryBlob(blob) {
  // 先读前 2 个字节判断类型
  blob.slice(0, 2).arrayBuffer().then((head) => {
    const h = new Uint8Array(head);
    if (h[0] === 0x41) {
      // 声音帧：帧头 = [0]='A' [1]=ver [2..3]=采样率 [4]=声道 [5]=位深 [6..7]=序号
      // 直接从帧头取采样率/位深 —— 这是权威值，不受 audioState 更新时序影响。
      if (blob.size <= 8) return;
      blob.slice(0, 8).arrayBuffer().then((hb) => {
        const hh = new Uint8Array(hb);
        const rate = hh[2] | (hh[3] << 8);
        const chn = hh[4], bd = hh[5];
        if (rate > 0) audioState.sampleRate = rate;
        if (bd > 0) audioState.bits = bd;
        if (chn > 0) audioState.channels = chn;
        return blob.slice(8).arrayBuffer();
      }).then((ab) => onAudioData(new Uint8Array(ab))).catch(() => { });
    } else {
      // 画面帧：去掉 14 字节头
      if (blob.size <= 14) return;
      handleFrame(blob.slice(14));
    }
  }).catch(() => { /* 忽略 */ });
}

function routeBinary(buf, offset) {
  const tag = buf[offset];
  if (tag === 0x41) {
    if (buf.length - offset <= 8) return;
    const rate = buf[offset + 2] | (buf[offset + 3] << 8);
    if (rate > 0) audioState.sampleRate = rate;
    if (buf[offset + 5] > 0) audioState.bits = buf[offset + 5];
    onAudioData(buf.subarray(offset + 8));
  } else {
    if (buf.length - offset <= 14) return;
    handleFrame(new Blob([buf.subarray(offset + 14)], { type: 'image/jpeg' }));
  }
}

/* ---------------- 电脑声音播放 ----------------
   服务端推送 16 kHz / 单声道 / 16 位小端 PCM，每帧 8 字节头。
   这里用 Web Audio 的 AudioBufferSourceNode 排队播放：每帧建一个短缓冲，
   按累计时间依次 start()，保证连续无爆音。 */
const audioState = {
  enabled: false,       // 用户是否已打开声音
  ctx: null,
  nextTime: 0,
  playing: 0,
  skipped: 0,
  sampleRate: 48000,     // 由电脑端回报覆盖；48000 = 24 位/48 kHz
  bits: 24,             // 样本位深（电脑端回报覆盖）
  bitrateKbps: 1152,     // 24 位/48 kHz = 1152 kbps 无损
  channels: 1,
};

function audioCtx() {
  if (!audioState.ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { audioState.ctx = new AC(); } catch (e) { return null; }
  }
  return audioState.ctx;
}

function onAudioData(bytes) {
  if (!audioState.enabled) return;
  const ctx = audioCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) { } }

  // 位深：优先用帧头声明的值；缺失或非法时**按数据长度自动推断**（自愈）。
  // 为什么必须自愈：服务端发 16 位而客户端按 24 位解析 -> 播放压缩成 2/3（变快变调）；
  // 反过来则拉长成 1.5 倍（放慢变调）。这个坑已经踩过一次，所以不再盲信单一来源。
  let bits = audioState.bits || 0;
  if (bits !== 8 && bits !== 16 && bits !== 24 && bits !== 32) {
    if (bytes.length % 3 === 0 && bytes.length % 2 !== 0) bits = 24;   // 24 位特征
    else bits = 16;
  }
  const bps = bits / 8;
  const n = Math.floor(bytes.length / bps);
  if (n === 0) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const f32 = new Float32Array(n);
  if (bits === 24) {
    // 24 位小端有符号：3 字节拼成 int，再按 2^23 归一化
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      let v = view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getUint8(o + 2) << 16);
      if (v & 0x800000) v -= 0x1000000;      // 符号扩展
      f32[i] = v / 8388608;
    }
  } else if (bits === 32) {
    for (let i = 0; i < n; i++) f32[i] = view.getInt32(i * 4, true) / 2147483648;
  } else if (bits === 8) {
    for (let i = 0; i < n; i++) f32[i] = (view.getInt8(i) ) / 128;
  } else {
    for (let i = 0; i < n; i++) f32[i] = view.getInt16(i * 2, true) / 32768;
  }

  const buf = ctx.createBuffer(1, n, audioState.sampleRate);
  buf.copyToChannel(f32, 0);

  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);

  const now = ctx.currentTime;
  // 落后太多（卡顿）就丢弃追赶，避免延迟越积越大
  if (audioState.nextTime < now - 0.25) {
    audioState.skipped++;
    audioState.nextTime = now + 0.02;
  }
  if (audioState.nextTime < now) audioState.nextTime = now + 0.02;
  try { src.start(audioState.nextTime); } catch (e) { return; }
  src.onended = () => { audioState.playing = Math.max(0, audioState.playing - 1); };
  audioState.playing++;
  audioState.nextTime += buf.duration;
}

function setAudioEnabled(on) {
  const btn = $('#btnAudio');
  if (on) {
    const ctx = audioCtx();
    if (!ctx) { toast('这个浏览器不支持播放声音'); return false; }
    try { ctx.resume(); } catch (e) { }
    audioState.enabled = true;
    audioState.nextTime = 0;
    // 把手机 AudioContext 的真实采样率告诉电脑端，让它按这个率重采样。
    // 之前电脑端固定发 16 kHz，而手机端 AudioContext 通常是 44.1/48 kHz，
    // 采样率不匹配会产生变调与爆音（用户听到的"杂音"）。
    // 优先按码率协商：默认 128 kbps（= 8 kHz 单声道 16 位 PCM）。
    // 之前把手机 AudioContext 的采样率（常见 48 kHz = 768 kbps）直接报给电脑端，
    // 带宽高得多，弱网下更容易卡顿/爆音 —— 改成按码率走。
    send({ type: 'audioStart', bitrateKbps: audioState.bitrateKbps, sampleRate: Math.round(ctx.sampleRate) || 48000 });
    if (btn) { setAudioIcon(true); btn.classList.add('on'); }
    toast('声音已开启（正在接收电脑的声音）');
  } else {
    audioState.enabled = false;
    send({ type: 'audioStop' });
    try {
      if (audioState.ctx) {
        // 关掉正在排队的缓冲，避免关闭后还有余音
        audioState.ctx.close();
        audioState.ctx = null;
      }
    } catch (e) { }
    audioState.nextTime = 0;
    audioState.playing = 0;
    if (btn) { setAudioIcon(false); btn.classList.remove('on'); }
    toast('声音已关闭');
  }
  saveSettings();
  return true;
}

/* ---------------- 声音按钮状态 ----------------
   图标用内联 SVG（emoji 在部分安卓机型不显示）：开 = 有音波，关 = 打叉。 */
const AUDIO_SVG_ON = '<svg viewBox="0 0 24 24" class="ti"><path d="M4 9h3l4-3v12l-4-3H4z"/><path d="M15 9.5a4 4 0 010 5M17.5 7a7.5 7.5 0 010 10" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
const AUDIO_SVG_OFF = '<svg viewBox="0 0 24 24" class="ti"><path d="M4 9h3l4-3v12l-4-3H4z"/><path d="M15 9l5 6M20 9l-5 6" stroke="currentColor" stroke-width="1.8" fill="none"/></svg>';
function setAudioIcon(on) {
  const btn = $('#btnAudio');
  if (btn) btn.innerHTML = on ? AUDIO_SVG_ON : AUDIO_SVG_OFF;
}
function updateAudioButton() {
  const btn = $('#btnAudio');
  if (!btn) return;
  if (state.audioOk === false) {
    btn.classList.remove('on');
    setAudioIcon(false);
    btn.title = '电脑端无法采集系统声音：' + (state.audioMessage || '未知原因');
    btn.style.opacity = '.45';
  } else {
    btn.style.opacity = '';
    setAudioIcon(audioState.enabled);
    btn.title = '声音 开/关（听电脑的声音）';
  }
}

/* ---------------- 搜索电脑（直连扫描，不依赖 UDP 广播） ----------------
   为什么这样做：UDP 广播经常被路由器/防火墙/安全软件拦截（企业网、校园网、
   手机热点尤其常见），所以"广播发现"从来就不是可靠路径。
   这里改用**同网段直连扫描**：向 192.168.x.1~254 的 8848 端口发起 TCP 连接，
   能连上并且 /ping 回应就是被控端。ICMP ping 在浏览器里做不到，但 TCP 连接可以。
   网段来源：优先用已连接（或上次连接）时服务端告知的自身地址；否则让用户先连一次。 */
async function runDiscovery() {
  const bases = new Set();
  const addBase = (ip) => {
    if (!ip || typeof ip !== 'string') return;
    const m = ip.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})$/);
    if (m) bases.add(m[1]);
  };
  // 已连接时记录的服务端地址
  (state.serverAddresses || []).forEach(addBase);
  // 当前页面地址（手动连上时也有用）
  addBase(location.hostname);
  if (state.lastHost) addBase(state.lastHost);

  const list = Array.from(bases);
  if (list.length === 0) {
    setLoginMsg('无法判断电脑所在网段。请先用下面的地址栏手动连接一次，之后再搜索就能自动扫描了。', true);
    return;
  }

  const port = state.serverPort || Number(location.port) || 8848;
  // 先验证"已知地址"：手动连过的地址一定是通的。
  // 这条路径比盲扫可靠得多 —— 用户能手动连上，就一定能被这里确认。
  const knownHosts = [];
  if (state.lastHost) knownHosts.push(state.lastHost);
  (state.serverAddresses || []).forEach((ip) => { if (!knownHosts.includes(ip)) knownHosts.push(ip); });
  if (location.hostname) knownHosts.push(location.hostname);
  const found = [];
  setLoginMsg(`正在扫描 ${list.join(' / ')} 网段的 ${port} 端口…（约 3~5 秒）`);

  // 探测单个地址是否有被控端在监听。
  // 两种手段都试：fetch(no-cors) 在受限 WebView 里通常比 <img> 更可靠；
  // <img> 不受 CORS 限制，但会被 Private Network Access 规则影响。
  const probe = (ip) => new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(ok ? ip : null);
    };
    timer = setTimeout(() => finish(false), 350);
    try {
      fetch(`http://${ip}:${port}/ping`, { mode: 'no-cors', cache: 'no-store' })
        .then(() => finish(true))
        .catch(() => tryImg());
    } catch (e) { tryImg(); }
    function tryImg() {
      if (done) return;
      try {
        const img = new Image();
        img.onload = () => finish(true);
        img.onerror = () => finish(true);
        img.src = `http://${ip}:${port}/favicon.ico?t=${Date.now()}`;
      } catch (e) { finish(false); }
    }
  });

  // 第一步：验证已知地址（手动连过 / 服务端告知 / 当前页面地址）
  if (knownHosts.length) {
    setLoginMsg('正在确认已知地址…');
    for (const h of knownHosts) {
      const hit = await probe(h);
      if (hit) {
        setLoginMsg('已找到 ' + hit + '，正在连接…', false);
        if ($('#addrInput')) $('#addrInput').value = hit + ':' + port;
        connect();
        return;
      }
    }
  }

  let scanned = 0;
  const batchSize = 48;
  for (const base of list) {
    const hosts = [];
    for (let i = 1; i <= 254; i++) hosts.push(`${base}.${i}`);
    for (let i = 0; i < hosts.length; i += batchSize) {
      const batch = hosts.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(probe));
      scanned += batch.length;
      results.forEach((r) => { if (r && !found.includes(r)) found.push(r); });
      setLoginMsg(`正在扫描… ${scanned}/254（已找到 ${found.length} 台）`);
      if (found.length) break;
    }
    if (found.length) break;
  }

  if (found.length === 0) {
    setLoginMsg(`扫描完 ${scanned} 个地址，没找到被控端。请确认：\n` +
      `1) 电脑上的被控端正在运行（控制面板窗口显示"正在运行"）；\n` +
      `2) 手机和电脑在同一个 Wi-Fi 下（不能一个连路由、一个连热点）；\n` +
      `3) 电脑首次运行时在防火墙弹窗里点了"允许访问"。\n` +
      `也可以直接手动输入控制面板上显示的地址。`, true);
    return;
  }

  if (found.length === 1) {
    const ip = found[0];
    setLoginMsg(`找到 ${ip}，正在连接…`, false);
    $('#addrInput').value = `${ip}:${port}`;
    connect();
    return;
  }

  // 找到多台：让用户选
  const pick = await chooseFromList('找到多台电脑，请选择一台：', found.map((ip) => `${ip}:${port}`));
  if (pick) { $('#addrInput').value = pick; connect(); }
}

/** 简单选择框（复用 confirmBox 的样式） */
function chooseFromList(title, items) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    const box = document.createElement('div');
    box.className = 'modal-box';
    const h = document.createElement('p');
    h.textContent = title;
    box.appendChild(h);
    items.forEach((it) => {
      const b = document.createElement('button');
      b.className = 'wide-btn';
      b.textContent = it;
      b.onclick = () => { wrap.remove(); resolve(it); };
      box.appendChild(b);
    });
    const cancel = document.createElement('button');
    cancel.className = 'wide-btn';
    cancel.textContent = '取消';
    cancel.onclick = () => { wrap.remove(); resolve(null); };
    box.appendChild(cancel);
    wrap.appendChild(box);
    document.body.appendChild(wrap);
  });
}

/** 询问 APK 是否已勾选「记住此设备」（浏览器里恒为 false）。 */
function isRememberOn() {
  try {
    const saved = String((window.LanControlApp && window.LanControlApp.getRemembered ? window.LanControlApp.getRemembered() : '') || '');
    return saved.indexOf('|') > 0;
  } catch (e) { return false; }
}

function deviceName() {  const ua = navigator.userAgent;
  const m = ua.match(/\(([^)]+)\)/);
  return m ? m[1].split(';')[1]?.trim() || 'Android 手机' : 'Android 手机';
}

function setLoginMsg(text, isErr) {
  const el = $('#loginMsg');
  el.textContent = text || '';
  el.className = 'msg' + (isErr ? ' err' : '');
}

function send(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(obj));
}

/* ---------------- 服务端消息 ---------------- */
function handleMessage(msg) {
  state.lastMessage = msg.type;
  switch (msg.type) {
    case 'welcome':
      $('#hostName').textContent = msg.host + ' · ' + msg.user;
      state.monitors = msg.monitors || [];
      renderMonitors();
      $('#waitingText').textContent = '正在验证配对码…';
      // 输入注入不可用时（例如程序跑在受限会话里）明确提示，避免用户以为"软件坏了"
      if (msg.inputInjectionOk === false) {
        state.inputBlocked = true;
        toast('[!] 电脑端无法注入鼠标键盘：手机上点了不会有反应。可在电脑上运行「诊断.cmd」查看原因。', 9000);
      }
      // 系统声音能力：不可用时把按钮置灰并说明原因
      state.audioOk = msg.audioOk !== false;
      state.audioMessage = msg.audioMessage || '';
      state.serverAddresses = msg.serverAddresses || [];
      state.serverPort = msg.port || 0;
      // 把被控端版本显示在顶栏：这是判断"手机连到的是哪一份程序"的唯一可靠依据。
      // 之前多次出现"改了却没生效"，根因就是连到了旧的副本/旧目录。
      const verEl = $('#pageVer');
      if (verEl) verEl.textContent = 'v' + (msg.version || '?');
      updateAudioButton();
      break;

    case 'audioState':
      // 电脑端会回报实际使用的采样率，手机端据此校准播放缓冲
      if (msg.on === true) {
        if (msg.sampleRate) audioState.sampleRate = msg.sampleRate;
        if (msg.bitrateKbps) audioState.bitrateKbps = msg.bitrateKbps;
        if (msg.bits) audioState.bits = msg.bits;
        toast('声音已连接：' + (msg.bits || '?') + ' 位 / ' + (msg.sampleRate || '?') + ' Hz / ' + (msg.bitrateKbps || '?') + ' kbps');
      }
      if (msg.on === false) {
        if (msg.error) {
          toast('[!] 无法接收电脑声音：' + msg.error, 9000);
          audioState.enabled = false;
          updateAudioButton();
        }
      }
      break;

    case 'authResult':
      if (!msg.ok) {
        setLoginMsg(msg.message || '配对码不正确', true);
        $('#connectBtn').disabled = false;
        state.authed = false;
        try { state.ws.close(); } catch (e) { }
        return;
      }
      state.authed = true;
      enterControl();
      break;

    case 'streamState':
      state.streaming = !!msg.streaming;
      $('#waiting').classList.toggle('hidden', state.streaming);
      if (state.streaming) $('#waitingText').textContent = '正在建立画面通道…';
      break;

    case 'stats':
      state.lastStats = `${msg.fps} fps · ${msg.kbps} kbps · ${msg.width}px`;
      updateStreamStat();
      break;

    case 'monitors':
      state.monitors = msg.monitors || [];
      state.monitor = msg.monitor ?? 0;
      renderMonitors();
      break;

    case 'powerResult':
      toast(msg.message || '已执行');
      break;

    case 'clipboard':
      state.clipboardText = msg.text || '';
      toast(state.clipboardText ? '电脑剪贴板：' + state.clipboardText.slice(0, 40) : '电脑剪贴板为空');
      if (state.clipboardText) {
        try { navigator.clipboard.writeText(state.clipboardText); } catch (e) { }
      }
      break;

    case 'clipboardSet':
      toast('已写入电脑剪贴板');
      break;

    case 'sysinfo':
      $('#sysInfo').textContent =
        `${msg.host} / ${msg.user}\n${msg.os}\nCPU ${msg.cpuPercent}%  内存 ${msg.memUsedGb}/${msg.memTotalGb} GB\n开机 ${msg.uptime}\n服务器时间 ${msg.serverTime}`;
      break;

    case 'simpleResult':
      toast(msg.message || (msg.ok ? '完成' : '失败'));
      if (msg.ok) refreshFiles();
      break;

    case 'dir':
      renderFiles(msg);
      break;

    case 'error':
      toast(msg.message || '出错了');
      break;

    case 'bye':
      toast('电脑端已断开');
      break;

    case 'cursor':
      // 电脑真实鼠标位置：用于显示指针（远程画面里不含硬件光标）
      if (typeof msg.x === 'number') {
        // trusted === false：电脑端注入没生效，这个坐标不是我们要的位置，
        // 绝不能拿来覆盖本地指针，否则虚拟鼠标的指针会被反复拽回去。
        if (msg.trusted === false) {
          state.cursorUntrusted = true;
          break;
        }
        state.cursorUntrusted = false;
        // 虚拟鼠标刚移动过时不回灌服务端位置，避免与本地指针“打架”
        if (state.vmouse.enabled && performance.now() - (state.vmouse.lastMoveAt || 0) < 250) break;
        state.cursor = { x: msg.x, y: msg.y };
        if (state.vmouse.enabled) { state.vmouse.x = msg.x; state.vmouse.y = msg.y; }
        updateCursor(state.cursor);
      }
      break;
    case 'pong':
      break;

    default:
      break;
  }
}

function enterControl() {  $('#login').classList.add('hidden');
  $('#control').classList.remove('hidden');
  $('#waiting').classList.remove('hidden');
  $('#waitingText').textContent = '正在建立画面通道…';
  // 手动指定过的分辨率优先（避免被上次保存的设置覆盖）
  if (state.forceMaxWidth) state.maxWidth = state.forceMaxWidth;
  updateStreamStat();
  startStream();
  if (state.cursorTimer) clearInterval(state.cursorTimer);
  state.cursorTimer = setInterval(() => { if (state.streaming) send({ type: 'cursor' }); }, 400);
  send({ type: 'sysinfo' });
  // 3 秒后还没画面就把诊断信息放到显眼位置
  setTimeout(() => {
    if (!decodedFrames && !$('#waiting').classList.contains('hidden')) {
      $('#waitingText').textContent = '尚未收到画面，请查看下面的诊断信息';
      updateStreamStat();
    }
  }, 3000);
}

function startStream() {
  send({
    type: 'startStream',
    monitor: state.monitor,
    scale: state.scale,
    quality: state.quality,
    maxWidth: state.maxWidth,
    fps: state.fps,
  });
}

/* ---------------- 画面渲染 ---------------- */
// 说明：很多 Android WebView 对 createImageBitmap + canvas 的支持不稳定（
// 表现为"连上了但一直没画面"），这里改用兼容性最好的 object URL + Image 解码，
// 并保留一个 createImageBitmap 快速路径。任何一帧解码失败都会计数并在状态栏显示。
let pendingFrame = false;
let decodeErrors = 0;
let decodedFrames = 0;
let lastFrameCost = 0;
window.decodedFrames = 0;
window.decodeErrors = 0;
const useImageBitmap = typeof createImageBitmap === 'function';

function handleFrame(blob) {
  // 丢帧：上一帧还在解码就丢掉这一帧，避免延迟累积
  if (pendingFrame) return;
  if (!blob || !blob.size) return;
  pendingFrame = true;
  const started = performance.now();

  const finish = (img, w, h, release) => {
    try {
      const canvas = $('#screen');
      const stage = $('#stage');
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0, w, h);
        // 适配舞台（保持比例居中），每帧重算，旋转屏幕后也能自适应。
        // 注意：不要为了"键盘打开时能拖画面"而自动放大画面 —— 那是强行改变用户
        //    看到的画面尺寸（用户明确反馈"打开虚拟键盘后电脑画面被放大且无法缩放"）。
        //    键盘打开时只做"平移"，缩放交给用户自己的双指手势。
        const sw = stage.clientWidth, sh = stage.clientHeight;
        let scale = Math.min(sw / canvas.width, sh / canvas.height) || 1;
        // 只有用户主动点了「放大画面」才放大。
        // 原因：不放大时画面完整塞在舞台内，可拖动距离为 0，怎么拖都不动；
        // 放大后画面超出舞台，拖动才有意义。默认**不**放大 —— 之前我做成
        // "打开键盘就自动放大"，擅自改变了用户看到的画面尺寸（已被反馈）。
        if (state.kbZoom && document.body.classList.contains('vkbd-open')) scale *= 2.4;
        const dw = Math.max(1, Math.round(canvas.width * scale));
        const dh = Math.max(1, Math.round(canvas.height * scale));
        canvas.style.width = dw + 'px';
        canvas.style.height = dh + 'px';
        const maxPanX = (dw <= sw) ? 0 : (dw - sw);
        if (!state.panX) state.panX = 0;
        if (state.panX > maxPanX) state.panX = maxPanX;
        if (state.panX < -maxPanX) state.panX = -maxPanX;
        canvas.style.left = Math.round((sw - dw) / 2 - state.panX) + 'px';
        // 记录舞台与画面的实际尺寸，供拖动手势计算可移动范围。
        // 四个都必须赋值：之前 stageW/imgW 漏了（一次字符串替换没匹配上、静默失败），
        // 导致 panMaxX() 恒返回 0 —— 表现就是"左右拖动完全没反应"。
        state.stageW = sw;
        state.imgW = dw;
        state.stageH = sh;
        state.imgH = dh;
        const maxPan = (dh <= sh) ? 0 : (dh - sh);
        if (!state.panY) state.panY = 0;
        if (state.panY > maxPan) state.panY = maxPan;
        if (state.panY < -maxPan) state.panY = -maxPan;
        canvas.style.top = Math.round((sh - dh) / 2 - state.panY) + 'px';
      }
      decodedFrames++;
      window.decodedFrames = decodedFrames;
      window.decodeErrors = decodeErrors;
      state.lastFrameAt = performance.now();
      lastFrameCost = state.lastFrameAt - started;
      $('#waiting').classList.add('hidden');
      updateStreamStat();
      const diag = $('#waitingDiag');
      if (diag && !diag.classList.contains('hidden')) diag.classList.add('hidden');
    } catch (e) {
      decodeErrors++;
      updateStreamStat('绘制失败: ' + (e && e.message ? e.message : e));
    } finally {
      if (release) release();
      pendingFrame = false;
    }
  };

  const fail = (why) => {
    decodeErrors++;
    window.decodeErrors = decodeErrors;
    pendingFrame = false;
    updateStreamStat(why);
  };

  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (useImageBitmap) {
      // 快速路径：拿到位图后再画，兼容性与性能兼顾
      createImageBitmap(img).then((bmp) => {
        finish(bmp, bmp.width, bmp.height, () => { bmp.close && bmp.close(); URL.revokeObjectURL(url); });
      }).catch(() => finish(img, w, h, () => URL.revokeObjectURL(url)));
    } else {
      finish(img, w, h, () => URL.revokeObjectURL(url));
    }
  };
  img.onerror = () => { URL.revokeObjectURL(url); fail('画面解码失败'); };
  img.src = url;
}

function updateStreamStat(errorText) {
  const el = $('#statText');
  const parts = [];
  if (errorText) parts.push('[!] ' + errorText);
  if (state.lastStats) parts.push(state.lastStats);
  parts.push('已收 ' + decodedFrames + ' 帧');
  if (decodeErrors) parts.push('失败 ' + decodeErrors);
  if (lastFrameCost > 0) parts.push(lastFrameCost.toFixed(0) + 'ms');
  el.textContent = parts.join(' · ');

  // 首帧还没出来时，把诊断信息直接显示在“正在建立画面通道”下面，
  // 便于一眼判断是「没收到帧」还是「收到了但解码失败」。
  const diag = $('#waitingDiag');
  if (diag) {
    const info = [];
    info.push('已收到画面帧：' + decodedFrames);
    if (decodeErrors) info.push('解码失败：' + decodeErrors);
    info.push('最近消息：' + (state.lastMessage || '无'));
    if (errorText) info.push('错误：' + errorText);
    diag.textContent = info.join('　|　');
  }
}


/* 触摸坐标 -> 归一化桌面坐标 */
function normFromTouch(clientX, clientY) {
  const canvas = $('#screen');
  const rect = canvas.getBoundingClientRect();
  const nx = (clientX - rect.left) / rect.width;
  const ny = (clientY - rect.top) / rect.height;
  return { x: Math.min(1, Math.max(0, nx)), y: Math.min(1, Math.max(0, ny)) };
}

/* ---------------- 手势 ---------------- */
/** 请求把当前这一帧按新的 panY 重新摆放（不重新拉流）。
    只改 canvas 的 top，不等下一帧到达 —— 否则拖动时会一顿一顿。 */
let _redrawPending = false;
function scheduleRedraw() {
  if (_redrawPending) return;
  _redrawPending = true;
  requestAnimationFrame(() => {
    _redrawPending = false;
    applyCanvasLayout();
  });
}

/** 按 state.panY 重新摆放画布（尺寸沿用上一帧的结果）。 */
function applyCanvasLayout() {
  const canvas = $('#screen');
  const stage = $('#stage');
  if (!canvas || !stage) return;
  const sw = stage.clientWidth, sh = stage.clientHeight;
  const dw = parseFloat(canvas.style.width) || canvas.width;
  const dh = parseFloat(canvas.style.height) || canvas.height;
  if (!dw || !dh) return;
  const maxPan = (dh <= sh) ? 0 : (dh - sh);
  if (state.panY > maxPan) state.panY = maxPan;
  if (state.panY < -maxPan) state.panY = -maxPan;
  const maxPanX = (dw <= sw) ? 0 : (dw - sw);
  if (!state.panX) state.panX = 0;
  if (state.panX > maxPanX) state.panX = maxPanX;
  if (state.panX < -maxPanX) state.panX = -maxPanX;
  canvas.style.left = Math.round((sw - dw) / 2 - state.panX) + 'px';
  canvas.style.top = Math.round((sh - dh) / 2 - (state.panY || 0)) + 'px';
}

function setupGestures() {
  const stage = $('#stage');
  let mode = null;              // 'pointer' | 'scroll' | 'vmouse'
  let startTime = 0, startPos = null, moved = 0;
  let lastY = 0, lastX = 0, lastPinch = 0;
  let longPressTimer = null, dragButton = null;
  let scrollAcc = 0;
  // 虚拟鼠标专用状态
  let vLastTapAt = 0, vTapTimer = null, vTwoFingerAt = 0, vLongFired = false, startPosY = 0;

  const endPointer = (cancelled) => {
    clearTimeout(longPressTimer);
    if (mode === 'pointer' && dragButton) {
      send({ type: 'mouse', action: 'up', button: dragButton });
      dragButton = null;
    } else if (mode === 'pointer' && !cancelled) {
      const dt = Date.now() - startTime;
      if (moved < 12 && dt < 260) send({ type: 'mouse', action: 'click', button: 'left', count: 1 });
    }
    mode = null;
    startPos = null;
    moved = 0;
    scrollAcc = 0;
  };

  /* ---- 虚拟鼠标：把指针放到指定归一化位置并同步给电脑 ---- */
  const vmMove = (nx, ny, opts) => {
    const v = state.vmouse;
    v.x = Math.min(1, Math.max(0, nx));
    v.y = Math.min(1, Math.max(0, ny));
    v.lastMoveAt = performance.now();
    state.cursor = { x: v.x, y: v.y };
    updateCursor(state.cursor);
    if (opts && opts.throttle) {
      // 移动过程中节流发送，避免刷爆 WebSocket；最终位置由 touchend/定时补发保证一致
      const now = performance.now();
      if (vmMove._last && now - vmMove._last < 33) return;
      vmMove._last = now;
    }
    send({ type: 'mouse', action: 'move', x: v.x, y: v.y });
  };

  const vmClick = (button, count) => {
    send({ type: 'mouse', action: 'click', button: button || 'left', count: count || 1 });
    const el = $('#vcursor');
    if (el) {
      el.classList.add('press');
      setTimeout(() => el.classList.remove('press'), 130);
    }
    vibrate(12);
  };

  const vmSetDragging = (on) => {
    const v = state.vmouse;
    if (v.dragging === on) return;
    v.dragging = on;
    send({ type: 'mouse', action: on ? 'down' : 'up', button: 'left' });
    const el = $('#vcursor');
    if (el) el.classList.toggle('dragging', on);
    const btn = $('#btnVmouseDrag');
    if (btn) btn.textContent = on ? '松开左键（结束拖动）' : '按住/松开左键（拖动）';
    showHint(on ? '已按住左键（拖动中）— 再长按一次放开' : '已松开左键');
    vibrate(on ? 20 : 12);
  };
  // 抽屉里的“按住/松开”按钮走同一条逻辑
  stage.addEventListener('vmouse-toggle-drag', () => vmSetDragging(!state.vmouse.dragging));

  /** 虚拟鼠标的单指手势 */
  const vmouseStart = (t) => {
    mode = 'vmouse';
    startTime = Date.now();
    startPos = { x: t.clientX, y: t.clientY };
    lastX = t.clientX; lastY = t.clientY;
    moved = 0;
    vLongFired = false;
    longPressTimer = setTimeout(() => {
      // 长按不动：切换“按住拖动”状态（对拖拽窗口/选文本很有用）
      if (moved < 12) {
        vLongFired = true;
        vmSetDragging(!state.vmouse.dragging);
      }
    }, 600);
  };

  /** 虚拟鼠标的双指手势（滚动 / 右键 / 缩放） */
  const vmouseTwoFingerStart = (ev) => {
    clearTimeout(longPressTimer);
    mode = 'vmouse2';
    const [a, b] = [ev.touches[0], ev.touches[1]];
    lastPinch = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    lastY = (a.clientY + b.clientY) / 2;
    lastX = (a.clientX + b.clientX) / 2;
    scrollAcc = 0;
    vTwoFingerAt = Date.now();
    vLongFired = false;
    // 双指按住不动 600ms = 右键（也支持“双指轻点”，见 touchend）
    longPressTimer = setTimeout(() => {
      if (Math.abs(lastY - (startPosY || lastY)) < 14) {
        vLongFired = true;
        vmClick('right', 1);
        showHint('右键');
      }
    }, 600);
  };

  /* ---------- 键盘打开时：拖动画面，方便查看被键盘挡住的内容 ----------
     键盘占了下半屏。这个手势不必反复开合键盘就能看到任意位置。 */
  let panId = null, panStartX = 0, panStartY = 0, panStartPan = 0, panStartPanX = 0;
  // 可拖动范围：
  //   默认（画面完整适配舞台）—— 居中显示，上下/左右各只能移一半
  //   放大后（画面超出舞台）—— 允许拖满**整个**溢出量，
  //     这样画面底边能真正拖到屏幕上、顶边也能拖到屏幕顶；
  //     否则"被挡住的部分"永远差一截看不到（用户反馈"没有完全拖到底部"）。
  const panMaxY = () => {
    const sh = state.stageH || 0, dh = state.imgH || 0;
    if (dh <= sh) return 0;
    return dh - sh;
  };
  const panMaxX = () => {
    const sw = state.stageW || 0, dw = state.imgW || 0;
    if (dw <= sw) return 0;
    return dw - sw;
  };
  stage.addEventListener('touchstart', (ev) => {
    if (!document.body.classList.contains('vkbd-open')) return;   // 只在键盘打开时接管
    if (ev.touches.length !== 1) return;
    const t0 = ev.target;
    if (t0 && t0.closest && t0.closest('#drawer, .panel, #topbar, #toolbar')) return;

    // 只有在「拖动画面」模式开启时才接管单指拖动。
    //
    // 为什么必须做成显式开关：
    //   1) 之前一进这里就 stopImmediatePropagation()，导致**虚拟鼠标在键盘打开时
    //      完全失效**（用户反馈"虚拟鼠标不能正常拖动"）；
    //   2) 想改成"拖黑色留白=移画面、拖画面=移鼠标"，但放大后画面铺满整个舞台，
    //      **根本没有留白可拖** —— 这个区分在实际使用中不成立。
    // 所以交给用户显式切换：默认拖动=移动鼠标，点「拖动画面」后才拖动=移画面。
    if (!state.panMode) return;

    panId = ev.touches[0].identifier;
    panStartX = ev.touches[0].clientX;
    panStartY = ev.touches[0].clientY;
    panStartPan = state.panY || 0;
    panStartPanX = state.panX || 0;
    // 截断，避免"移动鼠标"的手势处理器也收到这次触摸
    ev.stopImmediatePropagation();
  }, { capture: true });

  stage.addEventListener('touchmove', (ev) => {
    if (panId === null) return;
    let t0 = null;
    for (let i = 0; i < ev.touches.length; i++) {
      if (ev.touches[i].identifier === panId) { t0 = ev.touches[i]; break; }
    }
    if (!t0) return;
    const maxY = panMaxY(), maxX = panMaxX();
    let nextY = panStartPan - (t0.clientY - panStartY);    // 手指上滑 -> 看下方
    let nextX = panStartPanX - (t0.clientX - panStartX);
    if (nextY > maxY) nextY = maxY;
    if (nextY < -maxY) nextY = -maxY;
    if (nextX > maxX) nextX = maxX;
    if (nextX < -maxX) nextX = -maxX;
    state.panY = nextY;
    state.panX = nextX;
    scheduleRedraw();
    ev.preventDefault();     // 不再冒泡给"移动鼠标"的手势
    ev.stopPropagation();
  }, { capture: true, passive: false });

  const panEnd = () => {
    if (panId === null) return;
    panId = null;
    scheduleRedraw();
  };
  stage.addEventListener('touchend', panEnd, { capture: true });
  stage.addEventListener('touchcancel', panEnd, { capture: true });

  stage.addEventListener('touchstart', (ev) => {
    if (!state.authed) return;
    // 抽屉 / 面板 / 顶栏 / 工具条里的触摸一律不当作"操作画面"。
    // 这些元素虽然不在 #stage 的 DOM 子树里，但事件会冒泡到 stage，
    // 导致"在菜单里滑动时把滑动当成鼠标操作发给电脑"（用户反馈的误触之一）。
    const t = ev.target;
    if (t && t.closest && t.closest('#drawer, .panel, #topbar, #toolbar, #floatingExit, #floatBar')) return;
    // 注意：这里**不要**自动恢复工具栏。
    // 之前为了"防卡死"在这加了 isBarHidden() → setBarHidden(false)，
    // 结果变成"收起后碰一下屏幕就弹回来"，完全没法安心看全屏画面（用户反馈）。
    // 恢复入口只保留右下角圆钮（已做 click/touchend/pointerup 三重绑定）。
    if (!state.streaming && $('#waiting').classList.contains('hidden') === false) return;
    const vm = state.vmouse.enabled;

    if (ev.touches.length === 1 && mode === null) {
      const t = ev.touches[0];
      if (vm) { vmouseStart(t); return; }
      mode = 'pointer';
      startTime = Date.now();
      startPos = { x: t.clientX, y: t.clientY };
      lastX = t.clientX; lastY = t.clientY;
      moved = 0;
      const p = normFromTouch(t.clientX, t.clientY);
      state.cursor = p;
      updateCursor(p);
      if (state.mode === 'mouse') send({ type: 'mouse', action: 'move', x: p.x, y: p.y });
      longPressTimer = setTimeout(() => {
        if (moved < 12) {
          send({ type: 'mouse', action: 'down', button: 'right' });
          dragButton = 'right';
          showHint('长按：右键拖动中');
        }
      }, 520);
    } else if (ev.touches.length === 2) {
      clearTimeout(longPressTimer);
      if (dragButton) { send({ type: 'mouse', action: 'up', button: dragButton }); dragButton = null; }
      if (vm) {
        startPosY = (ev.touches[0].clientY + ev.touches[1].clientY) / 2;
        vmouseTwoFingerStart(ev);
        return;
      }
      mode = 'scroll';
      const [a, b] = [ev.touches[0], ev.touches[1]];
      lastPinch = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      lastY = (a.clientY + b.clientY) / 2;
    }
  }, { passive: false });

  stage.addEventListener('touchmove', (ev) => {
    if (!state.authed) return;
    ev.preventDefault();

    /* ---- 虚拟鼠标：单指相对移动指针 ---- */
    if (mode === 'vmouse' && ev.touches.length === 1) {
      const t = ev.touches[0];
      const dx = t.clientX - lastX, dy = t.clientY - lastY;
      moved += Math.hypot(dx, dy);
      lastX = t.clientX; lastY = t.clientY;
      if (moved > 12) clearTimeout(longPressTimer);   // 一开始移动就不算长按
      const canvas = $('#screen');
      const rect = canvas.getBoundingClientRect();
      const sens = state.vmouse.sensitivity;
      const nx = state.vmouse.x + (dx * sens) / Math.max(rect.width, 1);
      const ny = state.vmouse.y + (dy * sens) / Math.max(rect.height, 1);
      vmMove(nx, ny, { throttle: true });
      return;
    }

    /* ---- 虚拟鼠标：双指滚动 / 缩放 ---- */
    if (mode === 'vmouse2' && ev.touches.length >= 2) {
      const [a, b] = [ev.touches[0], ev.touches[1]];
      const y = (a.clientY + b.clientY) / 2;
      const x = (a.clientX + b.clientX) / 2;
      const pinch = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      moved += Math.hypot(x - lastX, y - lastY);
      if (Math.abs(pinch - lastPinch) > 30) {
        clearTimeout(longPressTimer);
        if (pinch > lastPinch) state.maxWidth = Math.min(2560, Math.round(state.maxWidth * 1.25));
        else state.maxWidth = Math.max(640, Math.round(state.maxWidth * 0.8));
        lastPinch = pinch;
        send({ type: 'startStream', monitor: state.monitor, scale: state.scale, quality: state.quality, maxWidth: state.maxWidth, fps: state.fps });
        showHint('画面清晰度 ' + state.maxWidth + 'px');
        saveSettings();
      } else {
        scrollAcc += (y - lastY);
        lastY = y;
        if (Math.abs(scrollAcc) > 14) {
          send({ type: 'mouse', action: 'scroll', delta: Math.round(-scrollAcc * 26) });
          scrollAcc = 0;
        }
        const hAcc = x - lastX;
        lastX = x;
        if (Math.abs(hAcc) > 18) send({ type: 'mouse', action: 'hscroll', delta: Math.round(-hAcc * 12) });
      }
      return;
    }

    if (mode === 'pointer' && ev.touches.length === 1) {
      const t = ev.touches[0];
      const dx = t.clientX - lastX, dy = t.clientY - lastY;
      moved += Math.hypot(dx, dy);
      lastX = t.clientX; lastY = t.clientY;
      const p = normFromTouch(t.clientX, t.clientY);
      if (state.mode === 'mouse') send({ type: 'mouse', action: 'move', x: p.x, y: p.y });
      state.cursor = p;
      updateCursor(p);
      if (moved > 40 && dragButton) { /* 拖动中 */ }
      if (moved > 12 && dragButton) { /* 右键拖动 */ }
    } else if (mode === 'scroll' && ev.touches.length >= 1) {
      const [a, b] = [ev.touches[0], ev.touches[1] || ev.touches[0]];
      const y = (a.clientY + b.clientY) / 2;
      const x = (a.clientX + b.clientX) / 2;
      const pinch = ev.touches.length >= 2 ? Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) : lastPinch;
      if (Math.abs(pinch - lastPinch) > 26) {
        // 双指缩放：调整画面清晰度（缩放比例）
        if (pinch > lastPinch) { state.maxWidth = Math.min(2560, Math.round(state.maxWidth * 1.25)); }
        else { state.maxWidth = Math.max(640, Math.round(state.maxWidth * 0.8)); }
        lastPinch = pinch;
        send({ type: 'startStream', monitor: state.monitor, scale: state.scale, quality: state.quality, maxWidth: state.maxWidth, fps: state.fps });
        showHint('画面清晰度 ' + state.maxWidth + 'px');
        saveSettings();
      } else {
        scrollAcc += (y - lastY);
        lastY = y;
        if (Math.abs(scrollAcc) > 14) {
          const delta = Math.round(-scrollAcc * 26);
          send({ type: 'mouse', action: 'scroll', delta });
          scrollAcc = 0;
        }
        const hAcc = x - (lastX || x);
        lastX = x;
        if (Math.abs(hAcc) > 18) send({ type: 'mouse', action: 'hscroll', delta: Math.round(-hAcc * 12) });
      }
    }
  }, { passive: false });

  const onEnd = (ev) => {
    if (ev.touches.length > 0) {
      if (mode === 'scroll') mode = null;
      return;
    }

    /* ---- 虚拟鼠标收尾：判定轻点/双击/双指右键 ---- */
    if (mode === 'vmouse') {
      clearTimeout(longPressTimer);
      const dt = Date.now() - startTime;
      if (moved < 14 && dt < 320 && !vLongFired) {
        const now = Date.now();
        if (now - vLastTapAt < 320) {
          // 快速连点两次 = 双击
          clearTimeout(vTapTimer);
          vmClick('left', 2);
          showHint('双击');
          vLastTapAt = 0;
        } else {
          vLastTapAt = now;
          // 稍等一会，判断是否为双击
          vTapTimer = setTimeout(() => {
            vmClick('left', 1);
            vLastTapAt = 0;
          }, 240);
        }
      }
      // 松手时补发一次最终位置，保证与手指抬起处一致
      send({ type: 'mouse', action: 'move', x: state.vmouse.x, y: state.vmouse.y });
      mode = null;
      moved = 0;
      hideHint();
      return;
    }

    if (mode === 'vmouse2') {
      clearTimeout(longPressTimer);
      const dt = Date.now() - vTwoFingerAt;
      // 双指轻点（没怎么动）= 右键
      if (moved < 16 && dt < 320 && !vLongFired) {
        vmClick('right', 1);
        showHint('右键');
      }
      mode = null;
      moved = 0;
      hideHint();
      return;
    }

    endPointer(false);
    hideHint();
  };
  stage.addEventListener('touchend', onEnd);
  stage.addEventListener('touchcancel', () => { endPointer(true); hideHint(); });

  // 桌面浏览器调试用
  stage.addEventListener('mousemove', (ev) => {
    if (!state.authed || !('ontouchstart' in window)) {
      if (!state.authed) return;
      const p = normFromTouch(ev.clientX, ev.clientY);
      state.cursor = p; updateCursor(p);
      send({ type: 'mouse', action: 'move', x: p.x, y: p.y });
    }
  });
  stage.addEventListener('mousedown', (ev) => {
    if (!state.authed || 'ontouchstart' in window) return;
    send({ type: 'mouse', action: 'down', button: ev.button === 2 ? 'right' : 'left' });
  });
  stage.addEventListener('mouseup', (ev) => {
    if (!state.authed || 'ontouchstart' in window) return;
    send({ type: 'mouse', action: 'up', button: ev.button === 2 ? 'right' : 'left' });
  });
  stage.addEventListener('contextmenu', (ev) => ev.preventDefault());
  stage.addEventListener('wheel', (ev) => {
    if (!state.authed) return;
    ev.preventDefault();
    send({ type: 'mouse', action: 'scroll', delta: Math.round(-ev.deltaY * 2) });
  }, { passive: false });
}

function updateCursor(p) {
  const stage = $('#stage');
  const canvas = $('#screen');
  const rect = canvas.getBoundingClientRect();
  // 首帧还没到时 canvas 尺寸为 0，直接按舞台比例兜底定位，避免指针被画到角落/中央假象
  const valid = rect.width > 1 && rect.height > 1;
  const sx = valid ? rect.left - stage.getBoundingClientRect().left : 0;
  const sy = valid ? rect.top - stage.getBoundingClientRect().top : 0;
  const w = valid ? rect.width : stage.clientWidth;
  const h = valid ? rect.height : stage.clientHeight;
  const left = (sx + p.x * w) + 'px';
  const top = (sy + p.y * h) + 'px';
  const c = $('#cursor');
  if (c) { c.style.left = left; c.style.top = top; }
  // 虚拟鼠标指针与真实光标同位置显示（虚拟鼠标模式下显示的是它）
  const vc = $('#vcursor');
  if (vc) { vc.style.left = left; vc.style.top = top; }
}

function showHint(text) {
  const el = $('#gestureHint');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(showHint._t);
  showHint._t = setTimeout(() => el.classList.add('hidden'), 1400);
}
function hideHint() { $('#gestureHint').classList.add('hidden'); }

/* ---------------- 虚拟鼠标模式 ---------------- */
let calibrationOn = false;

/** 校准检查：在画面外叠加 3×3 参考点。
 *  点其中一个点后，指针尖端应当正好落在该点上；若整体偏移，就说明坐标映射有问题。 */
function toggleCalibration() {
  const stage = $('#stage');
  let layer = $('#calibLayer');
  if (calibrationOn) {
    if (layer) layer.remove();
    calibrationOn = false;
    return;
  }
  layer = document.createElement('div');
  layer.id = 'calibLayer';
  layer.className = 'calib-layer';
  const canvas = $('#screen');
  const rect = canvas.getBoundingClientRect();
  const sr = stage.getBoundingClientRect();
  const ox = rect.left - sr.left, oy = rect.top - sr.top;
  [0.05, 0.5, 0.95].forEach((ny) => {
    [0.05, 0.5, 0.95].forEach((nx) => {
      const d = document.createElement('div');
      d.className = 'calib-dot';
      d.style.left = (ox + nx * rect.width) + 'px';
      d.style.top = (oy + ny * rect.height) + 'px';
      d.title = `x=${nx} y=${ny}`;
      d.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (!state.vmouse.enabled) setVmouseEnabled(true);
        state.vmouse.x = nx;
        state.vmouse.y = ny;
        state.cursor = { x: nx, y: ny };
        updateCursor(state.cursor);
        send({ type: 'mouse', action: 'move', x: nx, y: ny });
        showHint('已把指针移到该参考点：箭头尖端应正好落在圆心上');
      });
      layer.appendChild(d);
    });
  });
  stage.appendChild(layer);
  calibrationOn = true;
}

function setVmouseEnabled(on) {
  state.vmouse.enabled = !!on;
  document.body.classList.toggle('vmouse', state.vmouse.enabled);
  const vc = $('#vcursor');
  if (vc) vc.classList.toggle('hidden', !state.vmouse.enabled);

  // 工具条高亮 + 顶栏图标，两处必须一起刷新。
  // 之前 setVmouseEnabled 只改工具条、点顶栏按钮时又只改顶栏，
  // 于是"切换后总有一处图标不更新"（用户反馈"图标未更新"）。
  document.querySelectorAll('.tb').forEach((x) => {
    const act = x.dataset.act;
    if (act === 'vmouse') x.classList.toggle('active', state.vmouse.enabled);
    else if (act === 'mouse') x.classList.toggle('active', !state.vmouse.enabled && state.mode !== 'scroll');
    else if (act === 'scroll') x.classList.toggle('active', !state.vmouse.enabled && state.mode === 'scroll');
  });
  const vmTopBtn = $('#btnVmouseTop');
  if (vmTopBtn) {
    vmTopBtn.classList.toggle('on', state.vmouse.enabled);
    vmTopBtn.setAttribute('title', state.vmouse.enabled ? '虚拟鼠标：开' : '虚拟鼠标：关');
  }
  // 抽屉里的选择状态
  document.querySelectorAll('.chip[data-mode]').forEach((c) =>
    c.classList.toggle('active', (c.dataset.mode === 'vmouse') === state.vmouse.enabled));
  const opts = $('#vmouseOptions');
  if (opts) opts.classList.toggle('hidden', !state.vmouse.enabled);
  const tip = $('#modeTip');
  if (tip) {
    tip.textContent = state.vmouse.enabled
      ? '虚拟鼠标：手指在屏幕上滑动来移动指针（手指不遮挡光标），像笔记本触控板一样。'
      : '直接点击：手指点到哪，电脑光标就跳到哪；轻点=左键，长按=右键。';
  }

  if (state.vmouse.enabled) {
    // 指针接管：把当前位置同步给电脑
    updateCursor({ x: state.vmouse.x, y: state.vmouse.y });
    send({ type: 'mouse', action: 'move', x: state.vmouse.x, y: state.vmouse.y });
    saveSettings();
  } else {
    if (state.vmouse.dragging) { send({ type: 'mouse', action: 'up', button: 'left' }); state.vmouse.dragging = false; }
    const vc2 = $('#vcursor');
    if (vc2) vc2.classList.remove('dragging');
  }
}

/* ---------------- 显示器 ---------------- */
function renderMonitors() {
  const box = $('#monitorList');
  box.innerHTML = '';
  state.monitors.forEach((m) => {
    const b = document.createElement('button');
    b.className = 'chip' + (m.index === state.monitor ? ' active' : '');
    b.textContent = m.label || ('显示器 ' + (m.index + 1));
    b.onclick = () => {
      state.monitor = m.index;
      $('#monLabel').textContent = m.label || ('显示器 ' + (m.index + 1));
      send({ type: 'setMonitor', monitor: m.index });
      startStream();
      renderMonitors();
      saveSettings();
    };
    box.appendChild(b);
  });
  const cur = state.monitors.find((m) => m.index === state.monitor);
  if (cur) $('#monLabel').textContent = cur.label;
}

/* ---------------- 按键与文本 ---------------- */
const KEYS = [
  ['Esc', ['escape']], ['Tab', ['tab']], ['Win', ['win']], ['Alt+Tab', ['alt', 'tab']],
  ['Ctrl+C', ['ctrl', 'c']], ['Ctrl+V', ['ctrl', 'v']], ['Ctrl+X', ['ctrl', 'x']], ['Ctrl+Z', ['ctrl', 'z']],
  ['Ctrl+A', ['ctrl', 'a']], ['Ctrl+S', ['ctrl', 's']], ['Ctrl+F', ['ctrl', 'f']], ['Ctrl+W', ['ctrl', 'w']],
  ['Enter', ['enter']], ['Backspace', ['backspace']], ['Delete', ['delete']], ['Alt+F4', ['alt', 'f4']],
  ['←', ['left']], ['↑', ['up']], ['↓', ['down']], ['→', ['right']],
  ['PgUp', ['pageup']], ['PgDn', ['pagedown']], ['Home', ['home']], ['End', ['end']],
  ['F5', ['f5']], ['F11', ['f11']], ['Win+D', ['win', 'd']], ['Win+E', ['win', 'e']],
  ['音量+', ['volume_up']], ['音量-', ['volume_down']], ['静音', ['volume_mute']], ['播放/暂停', ['media_play']],
];

/* ---------------- 虚拟键盘 ----------------
   服务端键名见 InputInjector.KeyMap（backspace/enter/esc/space/left/up/... 以及符号名）。
   修饰键是"粘滞"的：点 Ctrl 后它保持激活，再点 C 就发出 Ctrl+C 组合，然后自动松开。 */
const VK_MODS = [];
// 真实键盘没有独立的修饰键行，修饰键在最下一排（Ctrl Win Alt 空格 Alt Win 菜单 Ctrl）。
// VK_MODS 保留为空数组：渲染逻辑仍会用到，为空就不再生成那一行 —— 之前自造了一行
// Ctrl/Shift/Alt/Win，属于重复按键。
// 左右两侧的 Alt/Win/Ctrl 在真实键盘上是同一个键，共用同一份粘滞状态。
// shiftL/shiftR 也必须在这里归一 —— 之前别名表漏了它们，导致两个 Shift 键
// 掉进普通键分支，发出的 'shiftL' 服务端不认，表现就是"Shift 键完全无效"。
const VK_MOD_ALIAS = { alt2: 'alt', win2: 'win', ctrl2: 'ctrl', shiftL: 'shift', shiftR: 'shift' };

/** 把键名归一到"修饰键名"；不是修饰键则返回空串。 */
function vkModOf(name) {
  const m = VK_MOD_ALIAS[name] || name;
  return (m === 'shift' || m === 'ctrl' || m === 'alt' || m === 'win') ? m : '';
}
// 分两页：常用页只放打字最需要的键，功能页放 F 键 / 导航 / 媒体键。
// 之前把 7 行全塞一起，屏幕根本放不下（用户反馈"键盘依旧占满画面"）。
const VK_PAGES = [
  // 布局对齐真实键盘：Tab 在数字行最左、退格在最右，主键区就是标准 4 行 + 空格行。
  // 早期把 Tab/回车/Del/方向键挤在顶部一行，既不像真实键盘、又把主键区挤窄了。
  { name: '常用', rows: [
    // 布局完全对齐真实键盘（对照实物照片逐排核对）：
    //   F1-F12 / ` 1..0 - = 退格 / Tab Q..P [ ] \ / Caps A..L ; ' 回车 /
    //   Shift Z..M , . / Shift / Ctrl Win Alt 空格 Alt Win 菜单 Ctrl
    // 修饰键放在**最下一排**，不再单独占一行
    // —— 早期我自造了一行 Ctrl/Shift/Alt/Win，属于重复按键。
    [['f1', 'F1', 'k15'], ['f2', 'F2', 'k15'], ['f3', 'F3', 'k15'], ['f4', 'F4', 'k15'], ['f5', 'F5', 'k15'],
     ['f6', 'F6', 'k15'], ['f7', 'F7', 'k15'], ['f8', 'F8', 'k15'], ['f9', 'F9', 'k15'], ['f10', 'F10', 'k15'],
     ['f11', 'F11', 'k15'], ['f12', 'F12', 'k15']],
    [['backtick', '`', ''], ['1', '1', ''], ['2', '2', ''], ['3', '3', ''], ['4', '4', ''], ['5', '5', ''],
     ['6', '6', ''], ['7', '7', ''], ['8', '8', ''], ['9', '9', ''], ['0', '0', ''],
     ['minus', '-', ''], ['plus', '=', ''], ['backspace', '退格', 'k2']],
    [['tab', 'Tab', 'k15'], ['q', 'q', ''], ['w', 'w', ''], ['e', 'e', ''], ['r', 'r', ''], ['t', 't', ''],
     ['y', 'y', ''], ['u', 'u', ''], ['i', 'i', ''], ['o', 'o', ''], ['p', 'p', ''],
     ['lbracket', '[', ''], ['rbracket', ']', ''], ['backslash', '\\', 'k15']],
    [['capslock', 'Caps', 'k2'], ['a', 'a', ''], ['s', 's', ''], ['d', 'd', ''], ['f', 'f', ''], ['g', 'g', ''],
     ['h', 'h', ''], ['j', 'j', ''], ['k', 'k', ''], ['l', 'l', ''], ['semicolon', ';', ''],
     ['quote', "'", ''], ['enter', '回车', 'k25']],
    [['shiftL', 'Shift', 'k25'], ['z', 'z', ''], ['x', 'x', ''], ['c', 'c', ''], ['v', 'v', ''],
     ['b', 'b', ''], ['n', 'n', ''], ['m', 'm', ''], ['comma', ',', ''], ['period', '.', ''],
     ['slash', '/', ''], ['shiftR', 'Shift', 'k25']],
    [['ctrl', 'Ctrl', 'k15'], ['win', 'Win', 'k15'], ['alt', 'Alt', 'k15'],
     ['space', '空格', 'space'],
     ['alt2', 'Alt', 'k15'], ['win2', 'Win', 'k15'], ['apps', '菜单', 'k15'], ['ctrl2', 'Ctrl', 'k15']],
  ] },
  { name: '功能', rows: [
    // Esc / Del / 方向键放在这里 —— 主键区已按真实键盘重排，这些键不属于主键区
    [['esc', 'Esc', 'k15'], ['delete', 'Del', 'k15'], ['insert', 'Ins', 'k15'],
     ['left', '左', 'k15'], ['up', '上', 'k15'], ['down', '下', 'k15'], ['right', '右', 'k15']],
    [['f1', 'F1', 'k15'], ['f2', 'F2', 'k15'], ['f3', 'F3', 'k15'], ['f4', 'F4', 'k15'], ['f5', 'F5', 'k15'], ['f6', 'F6', 'k15']],
    [['f7', 'F7', 'k15'], ['f8', 'F8', 'k15'], ['f9', 'F9', 'k15'], ['f10', 'F10', 'k15'], ['f11', 'F11', 'k15'], ['f12', 'F12', 'k15']],
    [['printscreen', 'PrtSc', 'k2'], ['scrolllock', 'ScrLk', 'k2'], ['pause', 'Pause', 'k2'], ['apps', '菜单', 'k2']],
    [['home', 'Home', 'k2'], ['end', 'End', 'k2'], ['pageup', 'PgUp', 'k2'], ['pagedown', 'PgDn', 'k2']],
    [['volume_mute', '静音', 'k2'], ['volume_down', '音量-', 'k2'], ['volume_up', '音量+', 'k2'], ['apps', '菜单', 'k2']],
    [['media_prev', '上一曲', 'k2'], ['media_play', '播放', 'k2'], ['media_next', '下一曲', 'k2'], ['media_stop', '停止', 'k2']],
  ] },
];
// 需要按 Shift 才能打出的符号（键名 -> 未按 Shift 时显示的字符）
const VK_SHIFTED = {
  backtick: '~', '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
  minus: '_', plus: '+', lbracket: '{', rbracket: '}', backslash: '|',
  semicolon: ':', quote: '"', comma: '<', period: '>', slash: '?',
};

const vkState = { mods: new Set(), lastMod: '', lastModAt: 0, longPressTimer: null, page: 0, caps: false, repeatTimer: null };

/** 长按字母/数字 = 连续输出（像真实键盘按住不放）。
    首字立即发出，450ms 后开始连发，间隔 110ms 并逐渐加快。 */
function vkBindRepeat(btn, name) {
  const stop = () => { clearTimeout(vkState.repeatTimer); vkState.repeatTimer = null; };
  const start = () => {
    stop();
    vkState.suppressClick = false;
    let delay = 450, interval = 110;
    const tick = () => {
      if (vkScroll.active) { stop(); return; }   // 手指滑走了就停
      vkTap(name);
      interval = Math.max(45, interval - 8);     // 逐渐加快
      vkState.repeatTimer = setTimeout(tick, interval);
    };
    vkState.repeatTimer = setTimeout(() => { vkState.suppressClick = true; tick(); }, delay);
  };
  btn.addEventListener('touchstart', start, { passive: true });
  btn.addEventListener('touchend', stop);
  btn.addEventListener('touchcancel', stop);
  btn.addEventListener('mousedown', start);
  btn.addEventListener('mouseup', stop);
  btn.addEventListener('mouseleave', stop);
}

/** 长按某个键 = 单独发送它（无需先预备组合键）。
    这是 Shift/Ctrl/Alt/Win 之外的"想单独按一下"的通用兜底。 */
function vkBindPress(btn, name, label) {
  const start = () => {
    clearTimeout(vkState.longPressTimer);
    vkState.longPressTimer = setTimeout(() => {
      vkState.longPressTimer = null;
      send({ type: 'key', action: 'tap', keys: [name] });
      vibrate(14);
      toast('已单独发送 ' + label, 1200);
      vkState.suppressClick = true;
    }, 550);
  };
  const cancel = () => { clearTimeout(vkState.longPressTimer); vkState.longPressTimer = null; };
  btn.addEventListener('touchstart', start, { passive: true });
  btn.addEventListener('touchend', cancel);
  btn.addEventListener('touchcancel', cancel);
  btn.addEventListener('mousedown', start);
  btn.addEventListener('mouseup', cancel);
  btn.addEventListener('mouseleave', cancel);
}

function vkShowKey(name, label) {
  if (name === 'shiftL' || name === 'shiftR') return 'Shift';
  // Caps 等效于"锁定的 Shift"：Caps 亮着时字母也该显示大写。
  // 之前这里只判断 shift，所以点了 Caps 字母不变 —— 用户反馈"字母也没有大写"。
  const upper = vkState.mods.has('shift') || vkState.caps;
  if (!upper) return label;
  if (VK_SHIFTED[name]) return VK_SHIFTED[name];
  return /^[a-z]$/.test(label) ? label.toUpperCase() : label;
}

function renderVkbd() {
  const mods = $('#vkbdMods');
  const body = $('#vkbdBody');
  if (!mods || !body) return;

  const paintMods = () => {
    mods.querySelectorAll('.vkbd-key').forEach((b) => {
      b.classList.toggle('on', vkState.mods.has(b.dataset.mod));
    });
  };
  const paintLabels = () => {
    body.querySelectorAll('.vkbd-key').forEach((b) => {
      const nm = b.dataset.key;
      if (nm && b.dataset.label) b.textContent = vkShowKey(nm, b.dataset.label);
    });
  };

  // 修饰键行（只渲染一次）
  if (!mods.children.length) {
    VK_MODS.forEach(([name, label]) => {
      const b = document.createElement('button');
      b.className = 'vkbd-key mod k15';
      b.dataset.mod = name;
      b.textContent = label;
      b.onclick = () => vkModTap(name, label, paintMods, paintLabels);
      mods.appendChild(b);
    });
  }

  // 分页标签 + 当前页键区
  body.innerHTML = '';
  const tabs = document.createElement('div');
  tabs.className = 'vkbd-tabs';
  VK_PAGES.forEach((p, idx) => {
    const tb = document.createElement('button');
    tb.className = 'vkbd-tab' + (idx === vkState.page ? ' on' : '');
    tb.textContent = p.name;
    tb.onclick = () => { vkState.page = idx; renderVkbd(); };
    tabs.appendChild(tb);
  });
  body.appendChild(tabs);

  const page = VK_PAGES[vkState.page] || VK_PAGES[0];
  body.classList.toggle('vkbd-page-fn', page.name === '功能');   // 功能页行高更矮（CSS 用）
  page.rows.forEach((row) => {
    const r = document.createElement('div');
    r.className = 'vkbd-row';
    row.forEach(([name, label, w]) => {
      const b = document.createElement('button');
      b.className = 'vkbd-key ' + (w || '');
      b.dataset.key = name;
      b.style.flexGrow = vkWeight(w, label);   // 撑满整行，不用固定像素宽度
      // 真实键盘的修饰键（底排的 Ctrl/Win/Alt 与左右 Shift）都走粘滞逻辑
      const modName = vkModOf(name);
      if (modName) {
        b.dataset.mod = modName;
        b.textContent = label;
        b.onclick = () => vkModTap(name, label, paintMods, paintLabels);
      } else {
        b.dataset.label = label;
        b.textContent = label;
        if (name === 'capslock') b.classList.toggle('on', vkState.caps);   // Caps 开着时高亮
        b.onclick = () => {
          if (vkState.suppressClick) { vkState.suppressClick = false; return; }
          vkTap(name);
        };
        // 字母 / 数字 / 退格 / Del：长按连续输出（退格连续删字符是刚需）
        if (/^[a-z0-9]$/.test(name) || name === 'backspace' || name === 'delete') vkBindRepeat(b, name);
        else vkBindPress(b, name, label);
      }
      r.appendChild(b);
    });
    body.appendChild(r);
  });
  paintMods();
  vkPaintState();   // 底排的 Ctrl/Win/Alt 与 Caps 也要高亮（它们不走 VK_MODS 那一行）
  vkPaintArmed();
}

/** 把"当前预备了哪些修饰键"显示在面板标题旁。
    存在的意义：高亮只靠颜色，一旦颜色没生效就完全无从判断；
    显示文字状态后，"点 Ctrl 到底有没有被记住"一眼可见，不用再猜。 */
function vkPaintArmed() {
  const el = document.getElementById('vkbdArmed');
  if (!el) return;
  const list = [...vkState.mods];
  if (!list.length && !vkState.caps) { el.textContent = ''; return; }
  const names = { ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', win: 'Win' };
  const parts = list.map((m) => names[m] || m);
  if (vkState.caps) parts.push('Caps');
  el.textContent = '已预备 ' + parts.join(' + ');
}

/** 刷新修饰键 / Caps 的高亮。
    底排的 Ctrl/Win/Alt 是普通按钮（不再走 VK_MODS 那一行），
    所以必须按 data-key 统一判断 —— 否则"点了 Ctrl 图标不变色"（用户反馈）。 */
function vkPaintState() {
  document.querySelectorAll('#vkbdBody .vkbd-key').forEach((b) => {
    const k = b.dataset.key;
    if (!k) return;
    const mod = vkModOf(k);
    let lit = false;
    if (mod) lit = vkState.mods.has(mod);
    else if (k === 'capslock') lit = vkState.caps;

    // 同时设 class 和**内联样式**（内联优先级最高）。
    // 只用 class 时，一旦有任何样式优先级/缓存问题，用户看到的就是"点了不高亮"，
    // 而从代码上完全看不出毛病 —— 这个坑已经反复出现好几轮了。
    b.classList.toggle('on', lit);
    if (lit) {
      b.style.background = '#4da3ff';
      b.style.color = '#06121f';
      b.style.borderColor = '#4da3ff';
      b.style.fontWeight = '700';
    } else {
      b.style.background = '';
      b.style.color = '';
      b.style.borderColor = '';
      b.style.fontWeight = '';
    }
  });
}

/** 修饰键：单击预备组合，双击单独发送该键。 */
function vkModTap(name, label, paintMods, paintLabels) {
  name = vkModOf(name) || name;   // shiftL/shiftR、右侧 Alt/Win/Ctrl 都归一到同一个状态
  const now = Date.now();
  const isDouble = vkState.lastMod === name && (now - (vkState.lastModAt || 0)) < 420;
  vkState.lastMod = name;
  vkState.lastModAt = now;
  if (isDouble) {
    vkState.mods.delete(name);
    vkState.lastMod = '';
    send({ type: 'key', action: 'tap', keys: [name] });
    vibrate(12);
    toast('已单独发送 ' + label, 1200);
  } else if (vkState.mods.has(name)) {
    vkState.mods.delete(name);
  } else {
    vkState.mods.add(name);
  }
  if (paintMods) paintMods();
  if (paintLabels) paintLabels();
  // 关键：必须在这里刷新"底排修饰键高亮"和"已预备"文字。
  // 之前只调了 paintMods（它只扫 #vkbdMods，而我们的修饰键在底排 #vkbdBody 里）
  // 和 paintLabels，导致 vkState.mods 明明写进去了、界面上却毫无变化
  // —— 这正是"连携键没有高亮"的真正原因，已用 tools/test-vkbd-logic.mjs 实测确认。
  vkPaintState();
  vkPaintArmed();
  if (!isDouble) vibrate(10);
}
/** 按键的 flex 份数：按键宽类和标签长度估算，保证整行撑满、又不会把窄键压没。
    之前用固定像素宽度，屏幕一宽两边就各留一大块空白（用户反馈"两边很空"）。 */
function vkWeight(w, label) {
  // 按真实键盘的键宽比例（相对字母键 = 1 份）：
  //   Caps ≈ 1.4、Shift ≈ 1.8、Enter ≈ 1.9、退格 ≈ 1.9、Tab ≈ 1.5、空格 ≈ 6
  // 之前 Caps/Shift 给到 2.0/2.5 太宽，把字母键挤窄了
  // —— 用户反馈"大写键和 shift 键改短一些，以适配现实键盘的键位"。
  const base = w === 'k3' ? 3
    : w === 'k25' ? 1.8
      : w === 'k2' ? 1.9
        : w === 'k15' ? 1.5
          : w === 'space' ? 6
            : 1;
  // 长标签（如"退格""回车"）额外给一点，避免文字被挤出
  const extra = (label && label.length > 2) ? 0.3 : 0;
  return (base + extra).toFixed(2);
}

/** 点一个普通键：若粘滞着修饰键则发组合键，否则单键。 */
/** 滑动过程中不要触发按键 —— 手指在键盘上滑动（想滚动看更多键）时若按下某个键就会误发。
    用户反馈"滑动界面时容易触发按键功能"。 */
const vkScroll = { active: false, x: 0, y: 0 };

function vkScrollGuardInit() {
  const opts = { passive: true, capture: true };
  const start = (ev) => {
    const t = ev.touches ? ev.touches[0] : ev;
    vkScroll.x = t.clientX; vkScroll.y = t.clientY; vkScroll.active = false;
  };
  const move = (ev) => {
    const t = ev.touches ? ev.touches[0] : ev;
    // 超过 8px 判定为"滑动"，不是"点击"（点按时自然抖动一般 <5px）
    if (Math.abs(t.clientX - vkScroll.x) > 8 || Math.abs(t.clientY - vkScroll.y) > 8) {
      vkScroll.active = true;
    }
  };
  const end = () => { setTimeout(() => { vkScroll.active = false; }, 60); };
  document.addEventListener('touchstart', start, opts);
  document.addEventListener('touchmove', move, opts);
  document.addEventListener('touchend', end, opts);
  document.addEventListener('touchcancel', end, opts);
}

function vkTap(name) {
  if (vkScroll.active) return;   // 正在滑动，忽略这次"点击"
  // Caps：本地记录开关状态（用于按钮高亮 + 字母显示大写），同时把按键发给电脑。
  // 之前完全没记录状态，用户看到的就是"Caps 点了没反应、字母也不变大写"。
  if (name === 'capslock') {
    vkState.caps = !vkState.caps;
    send({ type: 'key', action: 'tap', keys: ['capslock'] });
    vibrate(12);
    renderVkbd();
    toast(vkState.caps ? '大写锁定：开' : '大写锁定：关', 1200);
    return;
  }
  const mods = [...vkState.mods].filter((m) => m !== 'capslock');
  const combo = mods.concat([name]);
  send({ type: 'key', action: 'tap', keys: combo });
  vibrate(12);
  if (mods.length) {
    // 组合键发完自动松开修饰键（否则下一次点击又会带上，很容易误操作）
    vkState.mods.clear();
    renderVkbd();      // 重新渲染会同时刷新修饰键与 Caps 的高亮
    toast('已发送 ' + combo.map((k) => k[0].toUpperCase() + k.slice(1)).join(' + '), 1200);
  }
}

function renderKeys() {
  const grid = $('#keyGrid');
  grid.innerHTML = '';
  KEYS.forEach(([label, keys]) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { send({ type: 'key', action: 'tap', keys }); vibrate(12); };
    grid.appendChild(b);
  });
}

function vibrate(ms) { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) { } }

/* ---------------- 文件管理 ---------------- */
// 属于"打开某个面板"的按钮 —— openPanel 只负责这些按钮的高亮。
// 其余按钮（全屏 / 虚拟鼠标 / 鼠标 / 滚动）是**模式**状态，由各自的逻辑维护，
// 不能被 openPanel 顺手清掉。
const PANEL_ACTS = ['keys', 'vkbd', 'input', 'files', 'power', 'custom'];

function openPanel(id) {
  // 键盘打开时隐藏下方工具栏：面板是绝对定位，不这样处理会和工具栏叠在一起
  //（用户看到的就是"上方栏目未与下方工具栏同步"）。
  const wasOpen = document.body.classList.contains('vkbd-open');
  document.body.classList.toggle('vkbd-open', id === 'vkbdPanel');
  // 键盘收起时**不复位画面位置**：用户拖到哪里就停在哪里。
  // （之前这里把 pan 归零，用户反馈"取消拖动后又回到屏幕中央"。）
  // 只有舞台尺寸变化（旋转屏幕等）时才由 applyCanvasLayout 自动钳制回可见范围。
  void wasOpen;
  document.querySelectorAll('.panel').forEach((p) => p.classList.add('hidden'));
  $('#drawer').classList.add('hidden');
  if (id) $('#' + id).classList.remove('hidden');
  // 只更新"面板类"按钮的高亮；不要无条件重写所有 .tb 的 active ——
  // 那样会把全屏 / 虚拟鼠标 / 鼠标 / 滚动 这些**模式类**按钮的高亮一起抹掉
  //（用户反馈"全屏模式下图标不会更新"就是这个原因）。
  document.querySelectorAll('.tb').forEach((b) => {
    if (!PANEL_ACTS.includes(b.dataset.act)) return;
    b.classList.toggle('active', b.dataset.act === panelAct(id));
  });
}
/** 面板拖动调高：把手在面板顶部，向上拖变高、向下拖变矮。
    结果写进 localStorage —— 不同机型屏幕差别大，让用户自己定，比写死比例靠谱。 */
function setupPanelGrips() {
  document.querySelectorAll('.panel-grip').forEach((grip) => {
    const panel = grip.parentElement;
    if (!panel) return;
    let startY = 0, startH = 0, dragging = false;

    // 恢复上次拖出来的高度
    try {
      const saved = localStorage.getItem('panelH:' + panel.id);
      if (saved) {
        const h = parseInt(saved, 10);
        if (h > 80) { panel.style.height = h + 'px'; panel.classList.add('manual'); }
      }
    } catch (e) { }

    const down = (ev) => {
      const t0 = ev.touches ? ev.touches[0] : ev;
      dragging = true;
      startY = t0.clientY;
      startH = panel.getBoundingClientRect().height;
      panel.classList.add('manual');
      ev.preventDefault();
    };
    const move = (ev) => {
      if (!dragging) return;
      const t0 = ev.touches ? ev.touches[0] : ev;
      const dy = startY - t0.clientY;          // 向上拖 = 变高
      let h = startH + dy;
      const maxH = window.innerHeight - 80;    // 至少给画面上方留 80px
      if (h < 120) h = 120;
      if (h > maxH) h = maxH;
      panel.style.height = h + 'px';
      ev.preventDefault();
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      try { localStorage.setItem('panelH:' + panel.id, String(Math.round(panel.getBoundingClientRect().height))); } catch (e) { }
    };

    grip.addEventListener('touchstart', down, { passive: false });
    grip.addEventListener('touchmove', move, { passive: false });
    grip.addEventListener('touchend', up);
    grip.addEventListener('touchcancel', up);
    grip.addEventListener('mousedown', down);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

function panelAct(id) {
  return ({ keysPanel: 'keys', vkbdPanel: 'vkbd', inputPanel: 'input', filesPanel: 'files', powerPanel: 'power', customPanel: 'custom' })[id] || '';
}

function refreshFiles(path) {
  if (path === undefined) path = state.filePath || '';
  const url = '/api/files' + (path ? '?path=' + encodeURIComponent(path) : '');
  fetch(url).then((r) => r.json()).then((data) => renderFiles(data)).catch(() => toast('读取目录失败'));
}

function renderFiles(data) {
  state.filePath = data.path === '::drives' ? '' : data.path;
  const bc = $('#breadcrumb');
  bc.innerHTML = '';
  const shortcuts = data.shortcuts || [];
  shortcuts.forEach((s, i) => {
    const a = document.createElement('a');
    a.href = 'javascript:void(0)';
    a.textContent = s.name;
    a.onclick = () => refreshFiles(s.path === '::drives' ? '' : s.path);
    bc.appendChild(a);
    if (i < shortcuts.length - 1) bc.appendChild(document.createTextNode(' · '));
  });
  const pathLine = document.createElement('div');
  pathLine.textContent = data.path === '::drives' ? '此电脑' : (data.path || '');
  bc.appendChild(pathLine);

  const list = $('#fileList');
  list.innerHTML = '';
  if (data.parent) {
    const row = document.createElement('div');
    row.className = 'file-row';
    row.innerHTML = '<span class="fi">↑</span><span class="fn"><b>返回上一级</b></span>';
    row.onclick = () => refreshFiles(data.parent);
    list.appendChild(row);
  }
  (data.items || []).forEach((it) => {
    const row = document.createElement('div');
    row.className = 'file-row';

    const icon = document.createElement('span');
    icon.className = 'fi';
    icon.textContent = it.dir ? 'DIR' : fileIcon(it.ext);

    const nameBox = document.createElement('span');
    nameBox.className = 'fn';
    const b = document.createElement('b');
    b.textContent = it.name;
    const small = document.createElement('small');
    small.textContent = it.dir ? '文件夹' : `${fmtSize(it.size)} · ${it.modified || ''}`;
    nameBox.appendChild(b); nameBox.appendChild(small);

    const acts = document.createElement('span');
    acts.className = 'acts';

    if (it.dir) {
      const open = document.createElement('button');
      open.textContent = '打开';
      open.onclick = () => refreshFiles(it.path);
      acts.appendChild(open);
      const up = document.createElement('button');
      up.textContent = '传到此';
      up.onclick = () => { state.filePath = it.path; $('#fileInput').click(); };
      acts.appendChild(up);
    } else {
      const dl = document.createElement('button');
      dl.textContent = '下载';
      dl.onclick = () => { location.href = '/download?path=' + encodeURIComponent(it.path); toast('已开始下载：' + it.name); };
      acts.appendChild(dl);
    }

    const del = document.createElement('button');
    del.textContent = '删除';
    del.onclick = async () => {
      const ok = await confirmBox(`确定删除“${it.name}”吗？此操作不可撤销。`);
      if (!ok) return;
      fetch('/api/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: it.path }) })
        .then((r) => r.json()).then((res) => { toast(res.message); refreshFiles(); });
    };
    acts.appendChild(del);

    row.appendChild(icon); row.appendChild(nameBox); row.appendChild(acts);
    list.appendChild(row);
  });
  if (!(data.items || []).length && !data.parent) {
    const empty = document.createElement('div');
    empty.className = 'file-row';
    empty.textContent = '（此目录为空）';
    list.appendChild(empty);
  }
}

function fileIcon(ext) {
  // 用文字徽标而不是 emoji：emoji 字形在部分安卓机型/WebView 上不存在会显示成空白
  const map = {
    jpg: 'IMG', jpeg: 'IMG', png: 'IMG', gif: 'IMG', bmp: 'IMG', webp: 'IMG',
    mp4: 'VID', mkv: 'VID', avi: 'VID', mov: 'VID',
    mp3: 'SND', wav: 'SND', flac: 'SND',
    zip: 'ZIP', rar: 'ZIP', '7z': 'ZIP', exe: 'EXE', msi: 'EXE', apk: 'APK',
    pdf: 'PDF', doc: 'DOC', docx: 'DOC', xls: 'XLS', xlsx: 'XLS', ppt: 'PPT', pptx: 'PPT',
    txt: 'TXT', md: 'TXT',
  };
  return map[ext] || 'FILE';
}

function uploadFiles(files) {
  if (!files || !files.length) return;
  const dir = state.filePath || '';
  let index = 0;
  const status = $('#uploadStatus');

  const next = () => {
    if (index >= files.length) {
      status.textContent = '全部上传完成';
      status.className = 'msg ok';
      refreshFiles();
      return;
    }
    const f = files[index++];
    const fd = new FormData();
    fd.append('file', f, f.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload?dir=' + encodeURIComponent(dir));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round(e.loaded / e.total * 100);
        status.textContent = `上传 ${f.name}：${pct}% (${fmtSize(e.loaded)}/${fmtSize(e.total)})`;
        status.className = 'msg';
      }
    };
    xhr.onload = () => {
      try {
        const res = JSON.parse(xhr.responseText);
        status.textContent = `${f.name}：${res.message || '完成'}`;
        status.className = 'msg ' + (res.ok ? 'ok' : 'err');
      } catch (e) { status.textContent = f.name + '：上传完成'; }
      next();
    };
    xhr.onerror = () => { status.textContent = f.name + '：上传失败'; status.className = 'msg err'; next(); };
    xhr.send(fd);
  };
  next();
}

/* ---------------- 电源 ---------------- */
async function doPower(action, label) {
  let delay = 0;
  if (action === 'shutdown' || action === 'restart') {
    const ok = await confirmBox(`确定要让电脑「${label}」吗？\n将在 30 秒后执行，期间可以取消。`);
    if (!ok) return;
    delay = 30;
  } else if (action === 'logoff') {
    const ok = await confirmBox('确定要注销当前用户吗？未保存的工作会丢失。');
    if (!ok) return;
  }
  send({ type: 'power', action, delay });
}

/* ---------------- 初始化 ---------------- */
function boot() {
  loadSettings();
  renderKeys();
  setupGestures();
  setupPanelGrips();
  vkScrollGuardInit();

  // 提示条的文案 + 「拖动画面」/「放大画面」两个按钮的外观，全部由这一个函数决定。
  //
  // 为什么必须集中：之前这三处各写一份更新代码（一键按钮里写一次、各自 onclick 里
  // 再写一次），必然漏掉 —— 实际就出现了"提示文字说拖动中、按钮却还是灰的"这种
  // 状态与外观不一致（用户截图反馈）。
  // 现在唯一的规则是：**任何改动 state 的地方，改完调一次 syncKbButtons()**。
  window.syncKbButtons = () => {
    const panBtn = $('#vkbdPan');
    const zoomBtn = $('#vkbdZoom');
    const txt = document.getElementById('vkbdTipText');
    const go = document.getElementById('vkbdTipGo');

    if (panBtn) {
      panBtn.classList.toggle('on', !!state.panMode);
      panBtn.textContent = state.panMode ? '拖动中' : '拖动画面';
    }
    if (zoomBtn) {
      zoomBtn.classList.toggle('on', !!state.kbZoom);
      zoomBtn.textContent = state.kbZoom ? '还原大小' : '放大画面';
    }
    if (txt) {
      if (state.panMode && state.kbZoom) {
        txt.textContent = '拖动中：单指拖动画面可上下左右查看（此时不能移动鼠标）';
      } else if (state.panMode) {
        txt.textContent = '已允许拖动，但画面未放大 —— 画面完整显示时没有可移动的空间，请点「放大画面」';
      } else {
        txt.textContent = '拖动画面需先点「放大画面」，再点「拖动画面」';
      }
    }
    if (go) {
      // 两步都完成了就不必再显示一键按钮
      const done = state.panMode && state.kbZoom;
      go.style.display = done ? 'none' : '';
      go.textContent = state.panMode ? '先放大画面' : '一键放大并允许拖动';
    }
  };
  // 兼容旧调用点
  window.refreshKbTip = window.syncKbButtons;

  // 「拖动画面」按钮：默认拖动=移动鼠标；开启后拖动=移动画面。
  // 必须做成显式开关 —— 混合判定（按落点区分）在放大后不成立，而且会屏蔽虚拟鼠标。
  const panBtn = $('#vkbdPan');
  if (panBtn) {
    panBtn.onclick = (ev) => {
      if (ev) ev.stopPropagation();
      state.panMode = !state.panMode;
      // 关闭拖动模式**不复位画面**：用户拖到哪里就停在哪里。
      // （之前这里主动把 pan 归零，用户反馈"取消拖动后又回到屏幕中央"。）
      // 不弹 Toast：按钮点亮状态 + 提示条已经说明了当前模式，
      // 再弹一次同样的话就是重复提示（用户反馈"通知重复了"）。
      window.syncKbButtons();
      if (state.panMode) {
        // 只在这一种情况下给提示：用户开了拖动但没放大，此时拖不动，容易困惑
        if (!state.kbZoom) toast('画面未放大，拖动没有可移动的空间 —— 请先点「放大画面」', 3000);
      } else {
        toast('已恢复：拖动=移动鼠标（画面停在当前位置）', 2200);
      }
    };
  }

  // 一键按钮：同时打开"放大"与"拖动"，省得用户自己摸索两步。
  const tipGo = document.getElementById('vkbdTipGo');
  if (tipGo) {
    tipGo.onclick = (ev) => {
      if (ev) ev.stopPropagation();
      state.kbZoom = true;
      state.panMode = true;
      scheduleRedraw();
      window.syncKbButtons();
      // 也不弹 Toast：提示条已变成"拖动中：单指拖动画面可上下左右查看"，
      // 按钮也都点亮了，状态一目了然。
    };
  }

  // 「放大画面」按钮：放大后才拖得动（不放大时可拖距离为 0）
  const zoomBtn = $('#vkbdZoom');
  if (zoomBtn) {
    zoomBtn.onclick = (ev) => {
      if (ev) ev.stopPropagation();
      state.kbZoom = !state.kbZoom;
      state.panX = 0; state.panY = 0;
      scheduleRedraw();
      // 同样不弹 Toast（按钮文字在"放大画面"/"还原大小"之间切换，已足够明确）。
      // 但如果用户是在拖动模式下取消放大，画面就没得拖了，这时要提醒一句。
      window.syncKbButtons();
      if (state.panMode && !state.kbZoom) {
        toast('已还原大小：拖动没有可移动的空间了（画面完整显示）', 2600);
      }
    };
  }

  $('#connectBtn').onclick = connect;
  $('#codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
  $('#discoverBtn').onclick = runDiscovery;

  $('#btnKeyboard').onclick = () => openPanel('keysPanel');
  const fs2 = $('#btnFullscreen2');
  if (fs2) fs2.onclick = toggleFullscreen;
  // 工具条里的全屏开关：顶栏在沉浸模式下会被隐藏，必须有一个**常驻**的全屏切换入口，
  // 否则用户进了全屏就再也切不回来（已踩过这个坑）。
  const fsBar = $('#btnFsBar');
  if (fsBar) {
    // 三重事件绑定：不同 WebView 对 fixed/absolute 按钮的事件派发不一致，
    // 只绑 click 会出现"点了没反应"（全屏退不出的根因之一）。
    const fsBtn = (ev) => {
      if (ev) { try { ev.preventDefault(); ev.stopPropagation(); } catch (e) { } }
      toggleFullscreen();
    };
    fsBar.addEventListener('click', fsBtn, true);
    fsBar.addEventListener('touchend', fsBtn, true);
    fsBar.addEventListener('pointerup', fsBtn, true);
  }
  $('#btnMenu').onclick = () => {
    $('#drawer').classList.remove('hidden');
    send({ type: 'sysinfo' });
  };
  $('#drawerClose').onclick = () => $('#drawer').classList.add('hidden');
  document.querySelectorAll('.panel-close').forEach((b) => b.onclick = () => openPanel(null));
  document.querySelectorAll('.tb').forEach((b) => {
    b.onclick = () => {
      const act = b.dataset.act;
      if (act === 'mouse' || act === 'scroll' || act === 'vmouse') {
        // 点“虚拟鼠标”= 在直接点击/虚拟鼠标之间切换；点“鼠标”= 明确用直接点击
        if (act === 'vmouse') setVmouseEnabled(!state.vmouse.enabled);
        else { setVmouseEnabled(false); state.mode = act; }
        if (!state.vmouse.enabled) state.mode = act === 'scroll' ? 'scroll' : 'mouse';
        openPanel(null);
        showHint(state.vmouse.enabled
          ? '虚拟鼠标：单指滑动移动指针 · 轻点左键 · 长按拖动 · 双指轻点右键'
          : (state.mode === 'scroll' ? '双指上下滚动画面' : '单指移动 / 轻点左键 / 长按右键 / 双指滚动'));
        return;
      }
      if (act === 'more') { $('#drawer').classList.remove('hidden'); send({ type: 'sysinfo' }); return; }
      const map = { keys: 'keysPanel', vkbd: 'vkbdPanel', input: 'inputPanel', files: 'filesPanel', power: 'powerPanel', custom: 'customPanel' };
      openPanel(map[act]);
      if (act === 'vkbd') { renderVkbd(); refreshKbTip(); }   // vkbd-open 由 openPanel 统一 toggle
      if (act === 'files') refreshFiles();
    };
  });

  const doPanic = async () => {
    const ok = await confirmBox('断开与电脑的连接？');
    if (ok) { send({ type: 'disconnect' }); try { state.ws.close(); } catch (e) { } }
  };
  $('#btnPanic').onclick = doPanic;
  $('#btnDisconnect').onclick = doPanic;
  // 供悬浮断开按钮复用（沉浸模式下右上角常驻）
  window.disconnectNow = async (reason) => {
    const ok = await confirmBox('断开与电脑的连接？');
    if (ok) { send({ type: 'disconnect' }); try { state.ws.close(); } catch (e) { } }
  };

  document.querySelectorAll('[data-power]').forEach((b) => {
    b.onclick = () => {
      const action = b.dataset.power;
      const label = b.querySelector('span')?.textContent || action;
      doPower(action, label);
    };
  });

  // 声音格式手动指定：听感异常时用户可强制 16/24 位（自动 = 按帧头 + 长度推断）
  document.querySelectorAll('.chip[data-audiofmt]').forEach((c) => c.onclick = () => {
    const v = Number(c.dataset.audiofmt);
    audioState.forceBits = v || 0;
    audioState.bits = v || 0;      // 0 表示交回自动判断
    setActive('.chip[data-audiofmt]', c);
    toast(v ? ('声音格式已固定为 ' + v + ' 位') : '声音格式：自动识别');
  });  document.querySelectorAll('.chip[data-q]').forEach((c) => c.onclick = () => {
    state.quality = Number(c.dataset.q);
    setActive('.chip[data-q]', c); startStream(); saveSettings();
  });
  document.querySelectorAll('.chip[data-w]').forEach((c) => c.onclick = () => {
    state.maxWidth = Number(c.dataset.w);
    setActive('.chip[data-w]', c); startStream(); saveSettings();
  });
  document.querySelectorAll('.chip[data-fps]').forEach((c) => c.onclick = () => {
    state.fps = Number(c.dataset.fps);
    setActive('.chip[data-fps]', c); startStream(); saveSettings();
  });

  $('#btnFullscreen').onclick = toggleFullscreen;

  // 全屏状态变化时同步按钮与提示（全屏 API 生效时用 API 的回调，否则靠 CSS 沉浸模式）
  ['fullscreenchange', 'webkitfullscreenchange'].forEach((ev) =>
    document.addEventListener(ev, () => {
      // body.fs 标记"真全屏"，保证此时右上角一定有退出入口
      document.body.classList.toggle('fs', isRealFullscreen());
      updateFullscreenUi();
    }, false));
  $('#btnClipboard').onclick = () => send({ type: 'clipboardGet' });

  // 虚拟鼠标：抽屉里的操作方式切换 / 灵敏度 / 居中
  document.querySelectorAll('.chip[data-mode]').forEach((c) => {
    c.onclick = () => setVmouseEnabled(c.dataset.mode === 'vmouse');
  });
  document.querySelectorAll('.chip[data-sens]').forEach((c) => {
    c.onclick = () => {
      state.vmouse.sensitivity = Number(c.dataset.sens) || 1.3;
      setActive('.chip[data-sens]', c);
      saveSettings();
      showHint('灵敏度 ' + state.vmouse.sensitivity.toFixed(1) + '×');
    };
  });
  const centerBtn = $('#btnVmouseCenter');
  if (centerBtn) {
    centerBtn.onclick = () => {
      state.vmouse.x = 0.5;
      state.vmouse.y = 0.5;
      state.cursor = { x: 0.5, y: 0.5 };
      updateCursor(state.cursor);
      send({ type: 'mouse', action: 'move', x: 0.5, y: 0.5 });
      showHint('光标已移到屏幕中央');
    };
  }
  // 校准检查：画面上叠加 3×3 参考点，方便肉眼确认指针落点是否准确
  const checkBtn = $('#btnVmouseCheck');
  if (checkBtn) {
    checkBtn.onclick = () => {
      toggleCalibration();
      showHint(calibrationOn ? '已显示 9 个参考点：点一下任意参考点，指针尖端应正好落在它上面' : '已关闭参考点');
    };
  }
  // 明确的拖动开关：比"长按切换"更容易发现，状态与长按共享
  const dragBtn = $('#btnVmouseDrag');
  if (dragBtn) {
    dragBtn.onclick = () => {
      // 直接触发与长按相同的切换逻辑（通过自定义事件复用）
      stage.dispatchEvent(new CustomEvent('vmouse-toggle-drag'));
    };
  }
  $('#btnSendClipboard').onclick = async () => {
    try {
      const text = await navigator.clipboard.readText();
      send({ type: 'clipboardSet', text });
    } catch (e) { toast('无法读取手机剪贴板，请在下方文本框手动输入'); }
  };

  $('#btnSendText').onclick = () => sendTyped(false);
  $('#btnSendEnter').onclick = () => sendTyped(true);
  $('#btnMkdir').onclick = () => {
    const name = prompt('新文件夹名称');
    if (!name) return;
    fetch('/api/mkdir', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: state.filePath, name }),
    }).then((r) => r.json()).then((res) => { toast(res.message); refreshFiles(); });
  };
  $('#btnUpload').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = (e) => { uploadFiles(e.target.files); e.target.value = ''; };

  // 快捷键：物理键盘（外接键盘 / 电脑浏览器）
  window.addEventListener('keydown', (e) => {
    if (!state.authed) return;
    if (document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    const map = { Escape: ['escape'], Enter: ['enter'], Backspace: ['backspace'], Tab: ['tab'], Delete: ['delete'], ArrowUp: ['up'], ArrowDown: ['down'], ArrowLeft: ['left'], ArrowRight: ['right'] };
    if (map[e.key]) { e.preventDefault(); send({ type: 'key', action: 'tap', keys: map[e.key] }); return; }
    if (e.ctrlKey && e.key.length === 1) { e.preventDefault(); send({ type: 'key', action: 'tap', keys: ['ctrl', e.key.toLowerCase()] }); return; }
    if (e.altKey && e.key === 'Tab') { e.preventDefault(); send({ type: 'key', action: 'tap', keys: ['alt', 'tab'] }); return; }
    if (e.key.length === 1) send({ type: 'text', text: e.key });
  });

  window.addEventListener('resize', () => { if (state.lastFrameAt) { /* 下一帧会自动重排 */ } });
  window.addEventListener('beforeunload', () => { try { state.ws && state.ws.close(); } catch (e) { } });

  // 支持 ?ip=192.168.1.5:8848 直接带上地址（供 App 扫码/发现后跳转）
  const params = new URLSearchParams(location.search);
  if (params.get('ip')) $('#addrInput').value = params.get('ip');
  if (params.get('code')) { $('#codeInput').value = params.get('code'); }
  // ?maxw=1024 可强制指定输出宽度（画面不显示时的排查手段之一）
  const maxw = Number(params.get('maxw'));
  if (maxw >= 320 && maxw <= 2560) {
    state.forceMaxWidth = maxw;
    state.maxWidth = maxw;
    document.querySelectorAll('.chip[data-w]').forEach((c) => c.classList.toggle('active', Number(c.dataset.w) === maxw));
  }
  // 与 APK 打通"记住此设备"：App 存档里有配对码就自动填上并直连
  try {
    if (window.LanControlApp && window.LanControlApp.getRemembered) {
      const saved = String(window.LanControlApp.getRemembered() || '');
      const bar = saved.indexOf('|');
      if (bar > 0) {
        const savedAddr = saved.slice(0, bar);
        const savedCode = saved.slice(bar + 1);
        if (!$('#addrInput').value && savedAddr) $('#addrInput').value = savedAddr;
        if (!$('#codeInput').value && savedCode) $('#codeInput').value = savedCode;
        if (savedAddr && savedCode) { setLoginMsg('已记住此设备，正在连接…', false); connect(); }
      }
    }
  } catch (e) { }

  if (params.get('auto') === '1') connect();

  // 悬浮圆钮：唤回工具条（任何模式下只要工具条被收起就出现）
  const floatBar = $('#floatBar');
  if (floatBar) {
    // 三种事件都绑：不同 WebView 对 position:fixed 按钮的事件派发方式不一致，
    // 只绑 click 在某些机型上会"点了没反应"。
    const wake = (ev) => {
      if (ev) { try { ev.preventDefault(); ev.stopPropagation(); } catch (e) { } }
      setBarHidden(false);
    };
    floatBar.addEventListener('click', wake, true);
    floatBar.addEventListener('touchend', wake, true);
    floatBar.addEventListener('pointerup', wake, true);
  }
  const floatingExit = $('#floatingExit');
  if (floatingExit) {
    // 断开连接（沉浸模式下常驻右上角，保证任何情况下都有退出入口）
    floatingExit.onclick = (ev) => { ev.stopPropagation(); disconnectNow('用户主动断开'); };
  }
  // ---- 兜底：document 级点击委托 ----
  // 部分 WebView 里 position:fixed 元素的直接 onclick 会失效（点了没反应），
  // 这里用捕获阶段的委托再兜一次，保证这两个悬浮钮在任何机型上都能点。
  document.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!t || !t.closest) return;
    if (t.closest('#floatBar')) { ev.preventDefault(); setBarHidden(false); return; }
    if (t.closest('#floatingExit')) {
      ev.preventDefault();
      if (typeof disconnectNow === 'function') disconnectNow('用户主动断开');
    }
  }, true);
  // 顶栏的虚拟鼠标开关（不用进抽屉就能切换）
  const vmTop = $('#btnVmouseTop');
  if (vmTop) {
    vmTop.onclick = (ev) => {
      ev.stopPropagation();
      const on = !state.vmouse.enabled;
      setVmouseEnabled(on);   // 图标刷新已收进 setVmouseEnabled，两处不会再不同步
      toast(on ? '虚拟鼠标：开（滑动屏幕移动电脑光标）' : '虚拟鼠标：关（改为直接点击）');
    };
    vmTop.classList.toggle('on', !!state.vmouse.enabled);
  }
  // 声音开关
  const audioBtn = $('#btnAudio');
  if (audioBtn) {
    audioBtn.onclick = (ev) => {
      ev.stopPropagation();
      if (!state.authed) { toast('请先连接并输入配对码'); return; }
      setAudioEnabled(!audioState.enabled);
    };
  }
  // 「收起工具条」：收起后右下角出现圆钮，随时可唤回
  const barHide = $('#btnBarHide');
  if (barHide) {
    barHide.onclick = (ev) => {
      ev.stopPropagation();
      setBarHidden(true);
      toast('工具条已收起；点右下角圆钮可唤回');
    };
  }

  // 启动时默认保持普通界面（工具条一定在），避免用户找不到功能入口。
  // 需要开机即全屏的，可在 App 里用 URL 参数 fullscreen=1 打开。
  const params0 = new URLSearchParams(location.search);
  if (params0.get('fullscreen') === '1') {
    enterImmersive(true);
  }
  updateFullscreenUi();
  setInterval(updateFullscreenUi, 2000);

  // 恢复上次的设置：画质/分辨率/帧率/灵敏度/虚拟鼠标
  document.querySelectorAll('.chip[data-q]').forEach((c) => c.classList.toggle('active', Number(c.dataset.q) === state.quality));
  document.querySelectorAll('.chip[data-w]').forEach((c) => c.classList.toggle('active', Number(c.dataset.w) === state.maxWidth));
  document.querySelectorAll('.chip[data-fps]').forEach((c) => c.classList.toggle('active', Number(c.dataset.fps) === state.fps));
  document.querySelectorAll('.chip[data-sens]').forEach((c) => c.classList.toggle('active', Number(c.dataset.sens) === state.vmouse.sensitivity));
  setVmouseEnabled(!!state.vmouseEnabledOnLoad);
}

function sendTyped(withEnter) {
  const el = $('#textInput');
  const text = el.value;
  if (!text) { if (withEnter) send({ type: 'key', action: 'tap', keys: ['enter'] }); return; }
  send({ type: 'text', text: withEnter ? text + '\n' : text, replaceAll: $('#chkReplace').checked });
  el.value = '';
}

function setActive(selector, el) {
  document.querySelectorAll(selector).forEach((x) => x.classList.toggle('active', x === el));
}

/* ---------------- 全屏 / 沉浸模式 ----------------
   手机 WebView 对 Fullscreen API 支持很不一致，所以做了两层：
   1) 先尝试标准/带前缀的 requestFullscreen；
   2) 无论成功与否都叠加“沉浸模式”：隐藏顶栏、底部工具条缩小成悬浮按钮，
      并常驻一个圆形按钮可以把工具条收起来/放出来 —— 保证任何情况下都能操作。
*/
function isImmersive() { return document.body.classList.contains('immersive'); }
function isBarHidden() { return document.body.classList.contains('barhidden'); }

/** 收起/唤出底部工具条（任何模式下都可用；收起后右下角出现圆钮） */
function setBarHidden(hidden) {
  document.body.classList.toggle('barhidden', !!hidden);
  updateFullscreenUi();
}
function isRealFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

function enterImmersive(showBar) {
  document.body.classList.add('immersive');
  document.body.classList.toggle('barhidden', !showBar);
  updateFullscreenUi();
}

function exitImmersive() {
  document.body.classList.remove('immersive');
  document.body.classList.remove('barhidden');
  updateFullscreenUi();
}

/** 无条件退出全屏 + 沉浸模式（不判断当前状态，直接清干净）。
    之前"退不出全屏"的根因就是退出分支依赖状态判断，一旦某个标记没同步到
    就会走到"进入全屏"的分支里，越点越出不来。现在退出是幂等的硬清场。 */
function exitFullscreenHard() {
  try {
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen();
    else if (document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen();
  } catch (e) { }
  document.body.classList.remove('immersive');
  document.body.classList.remove('barhidden');
  document.body.classList.remove('fs');
  try { updateFullscreenUi(); } catch (e) { }
}

function toggleFullscreen() {
  const el = document.documentElement;
  const inFs = isImmersive() || isRealFullscreen() || document.body.classList.contains('fs');
  if (inFs) {
    exitFullscreenHard();
    toast('已退出全屏 / 沉浸模式');
    return;
  }
  startFullscreen(el);
}

/** 进入全屏（抽出来便于单独调用）。 */
function startFullscreen(el) {
  let requested = null;
  try {
    if (el.requestFullscreen) requested = el.requestFullscreen();
    else if (el.webkitRequestFullscreen) requested = el.webkitRequestFullscreen();
  } catch (e) { requested = null; }

  const done = () => {
    enterImmersive(true);   // 工具条保持完整显示（想收起时点工具条最右边的"收起"按钮）
    toast('已进入沉浸模式；顶部信息栏已隐藏，工具条仍在底部');
  };
  if (requested && typeof requested.then === 'function') requested.then(done).catch(done);
  else done();
}

/* 全屏状态的界面同步。
   注意：这里**绝对不能用 textContent / innerHTML 去改图标按钮**！
   之前写成 fb.textContent = ''，会把按钮里的 SVG 整个抹掉，
   圆钮就变成一个没有图标的空按钮 —— 用户看到"点了没反应"其实就是图标没了。
   现在只切换 CSS 类（.on / .barhidden），图标由 CSS 各自决定。 */
function updateFullscreenUi() {
  const active = isImmersive() || isRealFullscreen();
  const b2 = $('#btnFullscreen2');
  if (b2) {
    b2.classList.toggle('on', active);
    b2.setAttribute('title', active ? '退出全屏 / 沉浸模式' : '全屏 / 沉浸模式');
  }
  const fsBar = $('#btnFsBar');
  if (fsBar) fsBar.classList.toggle('active', active);
}

boot();
