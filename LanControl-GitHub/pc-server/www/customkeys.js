// 触屏按键：悬浮在画面上的可拖动按键 + 编辑器（参考"熊猫助手"那类按键映射工具）。
//
// 普通模式：
//   轻点按键 -> 发送按键给电脑
//   长按按键 -> 进入编辑
// 编辑模式（工具条上的开关进入）：
//   工具条：数量 · 添加 · 撤销 · 删除 · 设置
//   拖动按键换位置，靠近中线/中心会吸附并显示参考线
//   点按键 -> 选中（高亮）+ 右侧设置面板：形状 / 缩放 / 绑定 / 切换开关 / 自定义文本
//
// 位置按**舞台百分比**保存（不是像素），换机型、旋转屏幕都不跑偏。
// 只依赖主程序的全局函数：$()、send()、toast()、vibrate()、openPanel()。
'use strict';

(function () {
  const STORE_KEY = 'lancontrol.customTouchKeys';
  const VIEW_KEY = 'lancontrol.customTouchView';
  const SNAP = 0.018;          // 吸附阈值（占舞台比例），约等于屏幕的 1.8%

  /** 默认按键：位置照参考图（左侧一列 ESC/1-5，右下角 右键/SPACE/左键）。 */
  const DEFAULTS = [
    { label: 'ESC', keys: 'esc', x: 0.055, y: 0.12 },
    { label: '1', keys: '1', x: 0.055, y: 0.28 },
    { label: '2', keys: '2', x: 0.055, y: 0.38 },
    { label: '3', keys: '3', x: 0.055, y: 0.48 },
    { label: '4', keys: '4', x: 0.055, y: 0.58 },
    { label: '5', keys: '5', x: 0.055, y: 0.68 },
    { label: 'SPACE', keys: 'space', x: 0.80, y: 0.72, wide: true },
    { label: '左键', keys: 'mouse:left', x: 0.90, y: 0.72 },
    { label: '右键', keys: 'mouse:right', x: 0.72, y: 0.72 },
  ];

  let items = [];
  let opacity = 0.55;
  let hidden = true;          // 默认隐藏，避免误挡画面；在「更多设置」里打开
  let editMode = false;
  let selected = -1;
  let undoStack = [];          // 撤销用的快照
  let editingIdx = -1;         // 设置面板里正在编辑的条目
  let panelCollapsed = false;  // 设置面板是否收起（收起后不挡画面）

  // ---------- 存储 ----------
  function norm(it, i) {
    return {
      label: String(it.label || ('键' + (i + 1))),
      keys: String(it.keys || ''),
      x: typeof it.x === 'number' ? it.x : 0.5,
      y: typeof it.y === 'number' ? it.y : 0.4,
      wide: !!it.wide,
      shape: it.shape === 'square' || it.shape === 'rounded' ? it.shape : 'circle',
      scale: typeof it.scale === 'number' && it.scale >= 0.5 && it.scale <= 2 ? it.scale : 1,
      toggle: !!it.toggle,
      on: !!it.on,
      repeat: !!it.repeat,     // 长按连发
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw == null) items = DEFAULTS.map(norm);
      else {
        const arr = JSON.parse(raw);
        items = Array.isArray(arr) ? arr.map(norm) : DEFAULTS.map(norm);
      }
    } catch (e) {
      items = DEFAULTS.map(norm);
    }
    try {
      const v = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}');
      if (typeof v.opacity === 'number' && v.opacity >= 0.1 && v.opacity <= 1) opacity = v.opacity;
      if (typeof v.hidden === 'boolean') hidden = v.hidden;
    } catch (e) { /* 忽略 */ }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(items)); } catch (e) { }
  }
  function saveView() {
    try { localStorage.setItem(VIEW_KEY, JSON.stringify({ opacity, hidden })); } catch (e) { }
  }
  function snapshot() {
    undoStack.push(JSON.stringify(items));
    if (undoStack.length > 30) undoStack.shift();
    refreshToolbar();
  }
  function undo() {
    const s = undoStack.pop();
    if (!s) { toast('没有可撤销的操作', 1600); return; }
    try { items = JSON.parse(s).map(norm); } catch (e) { }
    selected = -1;
    save(); renderOverlay(); renderList(); refreshToolbar(); hideSnapLines();
    toast('已撤销', 1400);
  }

  // ---------- 按键解析 ----------
  //
  // 绑定支持两类：
  //   1) 键盘按键：esc / space / ctrl c …
  //   2) 鼠标动作：mouse:left / mouse:right / mouse:middle（点击）
  //      —— 这类必须单独识别。之前「左键/右键」被绑成了 left/right，
  //      那在服务端是**方向键**，点下去只会移动光标而不是点击（用户反馈"失效"）。
  const MOUSE_RE = /^mouse:(left|right|middle)$/i;

  /** 把 "ctrl c" 解析成 ['ctrl','c']；兼容用户会写的加号/中文逗号。 */
  function parseKeys(s) {
    return String(s || '')
      .replace(/[，,、+]/g, ' ')
      .split(/\s+/)
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
  }

  /** 绑定的显示文字（鼠标动作显示成中文，否则直接显示键名）。 */
  function describeKeys(keysStr) {
    const s = String(keysStr || '').trim();
    const m = s.match(MOUSE_RE);
    if (m) {
      const b = m[1].toLowerCase();
      return b === 'left' ? '鼠标左键' : b === 'right' ? '鼠标右键' : '鼠标中键';
    }
    return s;
  }

  /** 发送绑定的动作：鼠标动作走 mouse 消息，其余当键盘组合键。 */
  function sendBinding(keysStr) {
    const s = String(keysStr || '').trim();
    const m = s.match(MOUSE_RE);
    if (m) {
      send({ type: 'mouse', action: 'click', button: m[1].toLowerCase(), count: 1 });
      return true;
    }
    const keys = parseKeys(s);
    if (!keys.length) return false;
    send({ type: 'key', action: 'tap', keys: keys });
    return true;
  }

  function fire(idx) {
    const it = items[idx];
    if (!it) return;
    if (!String(it.keys || '').trim()) { toast('这个按键还没绑定', 2000); return; }
    if (!sendBinding(it.keys)) { toast('这个按键的绑定无效', 2000); return; }
    vibrate(14);
    if (it.toggle) {
      it.on = !it.on;
      const box = document.getElementById('customOverlay');
      const btn = box && box.querySelectorAll('.ck-btn')[idx];
      if (btn) btn.classList.toggle('on', it.on);
      save();
    }
  }

  // ---------- 固定可选按键 ----------
  //
  // 用户不必手输键名 —— 点一下就填进绑定，连续点多个即组成组合键。
  // 键名必须与服务端 VkMap 一致（tools/test-keysync.mjs 会核对）。
  const KEY_GROUPS = [
    {
      title: '修饰键（可组合）',
      keys: [['ctrl', 'Ctrl'], ['shift', 'Shift'], ['alt', 'Alt'], ['win', 'Win']],
    },
    {
      title: '编辑键',
      keys: [['esc', 'Esc'], ['tab', 'Tab'], ['space', '空格'], ['backspace', '退格'],
        ['enter', '回车'], ['delete', 'Del'], ['insert', 'Ins'], ['capslock', 'Caps']],
    },
    {
      title: '方向与翻页',
      keys: [['left', '←'], ['up', '↑'], ['down', '↓'], ['right', '→'],
        ['home', 'Home'], ['end', 'End'], ['pageup', 'PgUp'], ['pagedown', 'PgDn']],
    },
    {
      title: '功能键',
      keys: [['f1', 'F1'], ['f2', 'F2'], ['f3', 'F3'], ['f4', 'F4'], ['f5', 'F5'], ['f6', 'F6'],
        ['f7', 'F7'], ['f8', 'F8'], ['f9', 'F9'], ['f10', 'F10'], ['f11', 'F11'], ['f12', 'F12']],
    },
    {
      title: '数字',
      keys: [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5'],
        ['6', '6'], ['7', '7'], ['8', '8'], ['9', '9'], ['0', '0']],
    },
    {
      title: '字母',
      keys: 'abcdefghijklmnopqrstuvwxyz'.split('').map((c) => [c, c.toUpperCase()]),
    },
    {
      title: '音量',
      keys: [['volume_mute', '静音'], ['volume_down', '音量-'], ['volume_up', '音量+']],
    },
    {
      title: '鼠标点击',
      keys: [['mouse:left', '左键'], ['mouse:right', '右键'], ['mouse:middle', '中键']],
    },
  ];

  function renderPicker() {
    const box = document.getElementById('ckPicker');
    if (!box) return;
    box.innerHTML = '';
    KEY_GROUPS.forEach((g) => {
      const sec = document.createElement('div');
      sec.className = 'ck-pick-sec';
      const title = document.createElement('div');
      title.className = 'ck-pick-title';
      title.textContent = g.title;
      sec.appendChild(title);

      const grid = document.createElement('div');
      grid.className = 'ck-pick-grid';
      g.keys.forEach((pair) => {
        const name = pair[0], label = pair[1];
        const b = document.createElement('button');
        b.className = 'ck-pick-key' + (name.indexOf(':') >= 0 ? ' mouse' : '');
        b.textContent = label;
        b.dataset.pick = name;
        b.onclick = (ev) => {
          if (ev) ev.stopPropagation();
          pickKey(name);
        };
        grid.appendChild(b);
      });
      sec.appendChild(grid);
      box.appendChild(sec);
    });
    highlightPicked();
  }

  /** 点选择器里的键：追加到绑定（连续点即组合键），再次点击同一键即取消。 */
  function pickKey(name) {
    if (selected < 0 || !items[selected]) { toast('先点画面上的一个按键选中它', 2200); return; }
    const it = items[selected];
    let parts = String(it.keys || '').trim().split(/\s+/).filter(Boolean);

    if (name.indexOf(':') >= 0) {
      // 鼠标动作是独立的一整项，不能和键盘键混在一起
      parts = (parts.length === 1 && parts[0] === name) ? [] : [name];
    } else {
      parts = parts.filter((p) => p.indexOf(':') < 0);   // 混入键盘键时先丢掉鼠标动作
      const at = parts.indexOf(name);
      if (at >= 0) parts.splice(at, 1);                  // 再点一次 = 取消
      else parts.push(name);
    }
    it.keys = parts.join(' ');
    save();
    applyBindingToDom();
    highlightPicked();
  }

  /** 把当前绑定同步到输入框与列表。 */
  function applyBindingToDom() {
    const it = selected >= 0 ? items[selected] : null;
    if (!it) return;
    const k = document.getElementById('ckOptKeys');
    if (k) k.value = it.keys;
    renderList();
  }

  /** 已选中的键在网格里高亮，一眼看出当前绑定了什么。 */
  function highlightPicked() {
    const box = document.getElementById('ckPicker');
    if (!box) return;
    const it = selected >= 0 ? items[selected] : null;
    const parts = it ? String(it.keys || '').split(/\s+/).filter(Boolean) : [];
    box.querySelectorAll('.ck-pick-key').forEach((b) => {
      b.classList.toggle('on', parts.indexOf(b.dataset.pick) >= 0);
    });
  }

  // ---------- 长按连发 ----------
  //
  // 只维护**一个**全局定时器：同时只可能按着一个按键，这样比每个按钮各持一个
  // 定时器简单，也不会出现"松手了还在发"的泄漏。
  let repeatTimer = null;

  function stopRepeat() {
    if (repeatTimer) { clearTimeout(repeatTimer); repeatTimer = null; }
    const box = document.getElementById('customOverlay');
    if (box) box.querySelectorAll('.ck-btn.repeating').forEach((b) => b.classList.remove('repeating'));
  }

  /** 开始连发：立即发一次，然后每 interval 毫秒一次，逐渐加快到最快 45ms。 */
  function startRepeat(idx) {
    stopRepeat();
    const it = items[idx];
    if (!it) return;
    const box = document.getElementById('customOverlay');
    const btn = box && box.querySelectorAll('.ck-btn')[idx];
    if (btn) btn.classList.add('repeating');

    fire(idx);                       // 第一下立即发出，不要有延迟感
    let interval = 120;
    const tick = () => {
      const cur = items[idx];
      if (!cur) { stopRepeat(); return; }
      fire(idx);
      interval = Math.max(45, interval - 10);   // 逐渐加快
      repeatTimer = setTimeout(tick, interval);
    };
    repeatTimer = setTimeout(tick, interval);
  }

  // ---------- 参考线 ----------
  function showSnapLines(snapX, snapY) {
    const box = document.getElementById('customOverlay');
    if (!box) return;
    let vx = document.getElementById('ckSnapV');
    let hy = document.getElementById('ckSnapH');
    let c = document.getElementById('ckSnapC');
    if (!vx) {
      const mk = (id, cls) => {
        const d = document.createElement('div');
        d.id = id; d.className = 'ck-snap ' + cls;
        box.appendChild(d);
        return d;
      };
      vx = mk('ckSnapV', 'v'); hy = mk('ckSnapH', 'h'); c = mk('ckSnapC', 'c');
    }
    vx.classList.toggle('hidden', !snapX);
    hy.classList.toggle('hidden', !snapY);
    c.classList.toggle('hidden', !(snapX && snapY));
  }
  function hideSnapLines() {
    ['ckSnapV', 'ckSnapH', 'ckSnapC'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    });
  }

  // ---------- 渲染 ----------
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const sizeOf = (it) => Math.round(46 * (it.scale || 1));

  function renderOverlay() {
    const box = document.getElementById('customOverlay');
    if (!box) return;
    // 只清按键与占位，保留参考线元素
    Array.from(box.querySelectorAll('.ck-btn')).forEach((n) => n.remove());
    box.classList.toggle('hidden', (hidden && !editMode) || items.length === 0);
    box.style.opacity = String(opacity);
    box.classList.toggle('editing', editMode);

    items.forEach((it, idx) => {
      const b = document.createElement('button');
      const sz = sizeOf(it);
      b.className = 'ck-btn shape-' + (it.shape || 'circle') + (it.wide ? ' wide' : '') +
        (editMode && selected === idx ? ' selected' : '') + (it.toggle && it.on ? ' on' : '') +
        (it.repeat ? ' repeat' : '');
      b.textContent = it.label;
      b.style.left = (clamp01(it.x) * 100).toFixed(2) + '%';
      b.style.top = (clamp01(it.y) * 100).toFixed(2) + '%';
      b.style.minWidth = sz + 'px';
      b.style.height = sz + 'px';
      b.style.fontSize = Math.max(10, Math.round(13 * (it.scale || 1))) + 'px';
      bindButton(b, idx);
      box.appendChild(b);
    });

    refreshToolbar();
  }

  /** 轻点=发送；长按=连发（若开了）或进入编辑；**只有编辑模式才能拖动**。 */
  function bindButton(btn, idx) {
    let sx = 0, sy = 0, moved = false, dragging = false;
    let holdTimer = null, longFired = false;

    const onStart = (ev) => {
      const t = ev.touches ? ev.touches[0] : ev;
      sx = t.clientX; sy = t.clientY;
      moved = false; dragging = false; longFired = false;
      btn.classList.add('pressed');

      holdTimer = setTimeout(() => {
        holdTimer = null; longFired = true;
        vibrate(24);
        const it = items[idx];
        if (editMode) {
          selectButton(idx);
        } else if (it && it.repeat) {
          startRepeat(idx);          // 长按连发
        } else {
          setEditMode(true);         // 未开连发：长按进入编辑
          selectButton(idx);
        }
      }, 600);

      ev.stopPropagation();
      if (ev.preventDefault) ev.preventDefault();
    };

    const onMove = (ev) => {
      // 只有编辑模式才允许拖动 —— 平时拖动会误改位置（用户要求改成编辑后才可拖）
      if (!editMode) return;

      const t = ev.touches ? ev.touches[0] : ev;
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 8) return;   // 8px 内算抖动
      moved = true;
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      dragging = true;

      const st = document.getElementById('stage');
      if (!st) return;
      const r = st.getBoundingClientRect();
      if (!r.width || !r.height) return;
      let x = clamp01((t.clientX - r.left) / r.width);
      let y = clamp01((t.clientY - r.top) / r.height);

      // 吸附：靠近水平中线 / 垂直中线时自动对齐（和参考图里的十字参考线一致）
      const snapX = Math.abs(x - 0.5) < SNAP;
      const snapY = Math.abs(y - 0.5) < SNAP;
      if (snapX) x = 0.5;
      if (snapY) y = 0.5;
      showSnapLines(snapX, snapY);

      items[idx].x = x; items[idx].y = y;
      btn.style.left = (x * 100).toFixed(2) + '%';
      btn.style.top = (y * 100).toFixed(2) + '%';
      ev.stopPropagation();
      if (ev.preventDefault) ev.preventDefault();
    };

    const onEnd = (ev) => {
      btn.classList.remove('pressed');
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      stopRepeat();
      hideSnapLines();
      if (dragging) {
        save();
      } else if (!longFired && !moved) {
        if (editMode) selectButton(idx);
        else fire(idx);
      }
      if (ev && ev.stopPropagation) ev.stopPropagation();
    };

    btn.addEventListener('touchstart', onStart, { passive: false });
    btn.addEventListener('touchmove', onMove, { passive: false });
    btn.addEventListener('touchend', onEnd);
    btn.addEventListener('touchcancel', onEnd);
    btn.addEventListener('mousedown', onStart);
    btn.addEventListener('mousemove', (ev) => { if (dragging || moved) onMove(ev); });
    btn.addEventListener('mouseup', onEnd);
    btn.addEventListener('mouseleave', (ev) => { if (dragging) onEnd(ev); });
  }

  // ---------- 编辑模式 ----------
  function setEditMode(on) {
    editMode = !!on;
    if (!on) { selected = -1; hideSnapLines(); }
    document.body.classList.toggle('ck-editing', editMode);
    const bar = document.getElementById('ckToolbar');
    if (bar) bar.classList.toggle('hidden', !editMode);
    renderOverlay();
    refreshOptions();
    toast(editMode ? '编辑模式：拖动按键换位置，点按键改设置' : '已退出编辑', 2000);
  }

  function selectButton(idx) {
    selected = idx;
    renderOverlay();
    refreshOptions();
    highlightPicked();
    // 把当前值回填到设置面板的输入框
    if (idx >= 0 && items[idx]) {
      const l = document.getElementById('ckOptLabel');
      const k = document.getElementById('ckOptKeys');
      if (l) l.value = items[idx].label;
      if (k) k.value = items[idx].keys;
    }
  }

  function addButton() {
    snapshot();
    const n = items.length;
    items.push(norm({ label: '新按键', keys: 'space', x: 0.5, y: 0.4 + (n % 4) * 0.1 }));
    save(); renderOverlay();
    selectButton(items.length - 1);
    toast('已添加，请在右侧设置里改名称和绑定', 2400);
  }

  function deleteSelected() {
    if (selected < 0 || selected >= items.length) { toast('先点一个按键选中它', 2000); return; }
    snapshot();
    items.splice(selected, 1);
    selected = -1;
    save(); renderOverlay(); renderList(); refreshOptions();
    toast('已删除', 1500);
  }

  /** 收起/展开右侧设置面板。收起后不挡画面，只留一条把手。 */
  function setPanelCollapsed(on) {
    panelCollapsed = !!on;
    const panel = document.getElementById('ckOptions');
    if (panel) panel.classList.toggle('collapsed', panelCollapsed);
  }

  // ---------- 设置面板（右侧） ----------
  function refreshOptions() {
    const panel = document.getElementById('ckOptions');
    if (!panel) return;
    const it = selected >= 0 ? items[selected] : null;
    panel.classList.toggle('hidden', !editMode || !it);
    panel.classList.toggle('collapsed', panelCollapsed);
    document.querySelectorAll('[data-shape]').forEach((b) => {
      b.classList.toggle('active', !!it && (it.shape || 'circle') === b.dataset.shape);
    });
    document.querySelectorAll('[data-scale]').forEach((b) => {
      b.classList.toggle('active', !!it && Math.abs((it.scale || 1) - parseFloat(b.dataset.scale)) < 0.01);
    });
    const tg = document.getElementById('ckOptToggle');
    if (tg) tg.classList.toggle('on', !!it && it.toggle);
    const rp = document.getElementById('ckOptRepeat');
    if (rp) rp.classList.toggle('on', !!it && it.repeat);
    if (it) {
      const l = document.getElementById('ckOptLabel');
      const k = document.getElementById('ckOptKeys');
      if (l && document.activeElement !== l) l.value = it.label;
      if (k && document.activeElement !== k) k.value = it.keys;
    }
  }

  function applyToSelected(fn) {
    if (selected < 0 || !items[selected]) { toast('先点一个按键选中它', 2000); return; }
    snapshot();
    fn(items[selected]);
    save(); renderOverlay(); renderList(); refreshOptions();
  }

  // ---------- 工具条 ----------
  function refreshToolbar() {
    const cnt = document.getElementById('ckCount');
    if (cnt) cnt.textContent = String(items.length);
    const undoBtn = document.getElementById('ckUndo');
    if (undoBtn) undoBtn.disabled = undoStack.length === 0;
  }

  // ---------- 设置面板里的列表 ----------
  function renderList() {
    const list = document.getElementById('customList');
    if (!list) return;
    list.innerHTML = '';
    if (!items.length) {
      const p = document.createElement('p');
      p.className = 'tip-inline';
      p.textContent = '（还没有按键，用上面的输入框添加）';
      list.appendChild(p);
      return;
    }
    items.forEach((it, idx) => {
      const row = document.createElement('div');
      row.className = 'custom-item';
      const info = document.createElement('div');
      info.className = 'ci-label';
      const nm = document.createElement('div');
      nm.textContent = it.label;
      const kk = document.createElement('div');
      kk.className = 'ci-keys';
      kk.textContent = (describeKeys(it.keys) || '(未绑定)') + (it.toggle ? ' · 切换' : '') + (it.repeat ? ' · 长按连发' : '');
      info.appendChild(nm); info.appendChild(kk);
      row.appendChild(info);

      const mk = (text, cls, fn) => {
        const b = document.createElement('button');
        b.textContent = text;
        if (cls) b.className = cls;
        b.onclick = fn;
        row.appendChild(b);
      };
      mk('编辑', '', () => {
        editingIdx = idx;
        const l = document.getElementById('customLabel');
        const k = document.getElementById('customKeys');
        if (l) l.value = it.label;
        if (k) k.value = it.keys;
        const btn = document.getElementById('btnCustomSave');
        if (btn) btn.textContent = '保存修改';
        toast('已载入「' + it.label + '」', 1800);
      });
      mk('删除', 'danger', () => {
        snapshot();
        items.splice(idx, 1);
        if (editingIdx === idx) { editingIdx = -1; clearForm(); }
        if (selected === idx) selected = -1;
        save(); renderOverlay(); renderList();
        toast('已删除', 1500);
      });
      list.appendChild(row);
    });
  }

  function clearForm() {
    const l = document.getElementById('customLabel');
    const k = document.getElementById('customKeys');
    if (l) l.value = '';
    if (k) k.value = '';
    const btn = document.getElementById('btnCustomSave');
    if (btn) btn.textContent = '添加 / 保存';
  }

  function onSubmit() {
    const le = document.getElementById('customLabel');
    const ke = document.getElementById('customKeys');
    const label = (le && le.value ? le.value : '').trim();
    const raw = (ke && ke.value ? ke.value : '').trim();
    // 鼠标动作要原样保留（不能被当空格拆开），其余走键名解析
    const keys = MOUSE_RE.test(raw) ? raw.toLowerCase() : parseKeys(raw).join(' ');
    if (!label) { toast('请填写显示文字', 2000); return; }
    if (!keys) { toast('请填写要发送的按键', 2000); return; }
    snapshot();
    if (editingIdx >= 0 && editingIdx < items.length) {
      items[editingIdx] = Object.assign({}, items[editingIdx], { label: label, keys: keys });
      toast('已保存「' + label + '」', 1800);
    } else {
      const n = items.length;
      items.push(norm({ label: label, keys: keys, x: 0.5, y: 0.35 + (n % 5) * 0.08 }));
      toast('已添加「' + label + '」', 1800);
    }
    editingIdx = -1;
    save(); clearForm(); renderOverlay(); renderList();
  }

  function refreshViewButtons() {
    const show = document.getElementById('btnCustomShow');
    const hide = document.getElementById('btnCustomHide');
    if (show) show.classList.toggle('active', !hidden);
    if (hide) hide.classList.toggle('active', hidden);
    document.querySelectorAll('[data-op]').forEach((b) => {
      b.classList.toggle('active', Math.abs(parseFloat(b.dataset.op) - opacity) < 0.01);
    });
  }

  // ---------- 初始化 ----------
  function init() {
    load();
    renderOverlay();
    renderList();
    renderPicker();
    refreshViewButtons();

    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };

    on('btnOpenCustom', () => {
      if (typeof openPanel === 'function') openPanel('customPanel');
      renderList(); refreshViewButtons();
    });
    on('btnCustomShow', () => { hidden = false; saveView(); renderOverlay(); refreshViewButtons(); });
    on('btnCustomHide', () => { hidden = true; saveView(); renderOverlay(); refreshViewButtons(); });
    on('btnCustomSave', onSubmit);
    on('btnCustomCancel', () => { editingIdx = -1; clearForm(); });
    on('btnEnterEdit', () => {
      if (typeof openPanel === 'function') openPanel(null);   // 收起面板，露出画面
      setEditMode(true);
    });

    // 工具条
    on('ckToggle', () => setEditMode(!editMode));
    on('ckAdd', addButton);
    on('ckUndo', undo);
    on('ckDel', deleteSelected);
    on('ckGear', () => {
      if (typeof openPanel === 'function') openPanel('customPanel');
      renderList(); refreshViewButtons();
    });

    // 设置面板里的形状 / 缩放 / 切换开关
    document.querySelectorAll('[data-shape]').forEach((b) => {
      b.onclick = () => applyToSelected((it) => {
        it.shape = b.dataset.shape;
        it.wide = b.dataset.shape !== 'circle';
      });
    });
    document.querySelectorAll('[data-scale]').forEach((b) => {
      b.onclick = () => applyToSelected((it) => { it.scale = parseFloat(b.dataset.scale); });
    });
    on('ckOptToggle', () => applyToSelected((it) => { it.toggle = !it.toggle; if (!it.toggle) it.on = false; }));
    on('ckOptRepeat', () => applyToSelected((it) => { it.repeat = !it.repeat; }));
    // 「›」改成收起面板而不是关闭 —— 关闭会把选中也清掉，用户想连改几个按键时很别扭
    on('ckOptClose', () => setPanelCollapsed(true));
    on('ckOptReveal', () => setPanelCollapsed(false));
    on('ckPanelToggle', () => setPanelCollapsed(!panelCollapsed));
    on('ckPickClear', () => {
      if (selected < 0 || !items[selected]) { toast('先点一个按键选中它', 2200); return; }
      snapshot();
      items[selected].keys = '';
      save(); applyBindingToDom(); highlightPicked();
      toast('已清空绑定', 1600);
    });

    // 名称 / 绑定：边打字边生效（不用点保存，改完就能看到）
    const bind = (id, field) => {
      const el = document.getElementById(id);
      if (!el || !el.addEventListener) return;
      el.addEventListener('input', () => {
        if (selected < 0 || !items[selected]) return;
        const v = el.value;
        if (field === 'label') items[selected].label = v || '按键';
        else items[selected].keys = MOUSE_RE.test(v.trim()) ? v.trim().toLowerCase() : parseKeys(v).join(' ');
        save();
        const box = document.getElementById('customOverlay');
        const btns = box ? box.querySelectorAll('.ck-btn') : [];
        if (btns[selected]) btns[selected].textContent = items[selected].label;
        if (field === 'keys') { renderList(); highlightPicked(); }
      });
    };
    bind('ckOptLabel', 'label');
    bind('ckOptKeys', 'keys');

    document.querySelectorAll('[data-op]').forEach((b) => {
      b.onclick = () => {
        const v = parseFloat(b.dataset.op);
        if (!isNaN(v)) { opacity = v; saveView(); renderOverlay(); refreshViewButtons(); }
      };
    });
  }

  // 暴露给自检脚本
  window.LanControlCustomKeys = {
    parseKeys: parseKeys,
    describeKeys: describeKeys,
    pickKey: pickKey,
    selectButton: selectButton,
    setPanelCollapsed: setPanelCollapsed,
    get panelCollapsed() { return panelCollapsed; },
    startRepeat: startRepeat,
    stopRepeat: stopRepeat,
    highlightPicked: highlightPicked,
    KEY_GROUPS: KEY_GROUPS,
    sendBinding: sendBinding,
    fire: fire,
    load: load,
    save: save,
    get items() { return items; },
    set items(v) { items = v; },
    get opacity() { return opacity; },
    get editMode() { return editMode; },
    get undoDepth() { return undoStack.length; },
    setEditMode: setEditMode,
    undo: undo,
    addButton: addButton,
    deleteSelected: deleteSelected,
    DEFAULTS: DEFAULTS,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
