// 虚拟键盘端到端自检：模拟手机端发出的按键消息，验证服务端接受并回报。
// 服务端无法在沙箱里真正注入按键（SetCursorPos/SendInput 被拒），
// 所以这里验证的是"消息被正确解析、没有报错、连接保持正常"。
const HOST = process.argv[2] || '127.0.0.1:8848';
const CODE = process.argv[3] || '123456';

const ws = new WebSocket(`ws://${HOST}/ws`);
let failures = 0;
const log = (ok, msg) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + msg); if (!ok) failures++; };

// 与网页 app.js 的 VK_ROWS 保持一致：取各类键各一个做抽样
const samples = [
  { keys: ['a'], desc: '单字母 a' },
  { keys: ['1'], desc: '数字 1' },
  { keys: ['enter'], desc: '回车' },
  { keys: ['backspace'], desc: '退格' },
  { keys: ['esc'], desc: 'Esc' },
  { keys: ['space'], desc: '空格' },
  { keys: ['up'], desc: '方向键 上' },
  { keys: ['f5'], desc: 'F5' },
  { keys: ['semicolon'], desc: '符号 ;' },
  { keys: ['ctrl', 'c'], desc: '组合键 Ctrl+C' },
  { keys: ['ctrl', 'shift', 'esc'], desc: '组合键 Ctrl+Shift+Esc（任务管理器）' },
  { keys: ['alt', 'f4'], desc: '组合键 Alt+F4' },
  { keys: ['win', 'd'], desc: '组合键 Win+D' },
  // 单独发送修饰键（双击/长按走的就是这条）——Win 单独按必须能弹出开始菜单
  { keys: ['win'], desc: '单独发送 Win（开始菜单）' },
  { keys: ['ctrl'], desc: '单独发送 Ctrl' },
  { keys: ['shift'], desc: '单独发送 Shift' },
  // 本次新增到键盘上的键
  { keys: ['printscreen'], desc: 'PrtSc 截屏' },
  { keys: ['scrolllock'], desc: 'ScrLk' },
  { keys: ['pause'], desc: 'Pause' },
  { keys: ['insert'], desc: 'Ins' },
  { keys: ['home'], desc: 'Home' },
  { keys: ['end'], desc: 'End' },
  { keys: ['delete'], desc: 'Del' },
  { keys: ['apps'], desc: '菜单键' },
  { keys: ['pageup'], desc: 'PgUp' },
  { keys: ['pagedown'], desc: 'PgDn' },
  { keys: ['volume_mute'], desc: '静音' },
  { keys: ['volume_down'], desc: '音量-' },
  { keys: ['volume_up'], desc: '音量+' },
  { keys: ['media_prev'], desc: '上一曲' },
  { keys: ['media_play'], desc: '播放/暂停' },
  { keys: ['media_next'], desc: '下一曲' },
  { keys: ['capslock'], desc: 'Caps' },
  { keys: ['lbracket'], desc: '符号 [' },
  { keys: ['backslash'], desc: '符号 \\' },
  { keys: ['quote'], desc: '符号 单引号' },
  { keys: ['slash'], desc: '符号 /' },
];

let sent = 0;
const t0 = Date.now();

ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', code: CODE, device: 'vkbd-test' }));

ws.onmessage = (ev) => {
  if (typeof ev.data !== 'string') return;
  let m; try { m = JSON.parse(ev.data); } catch { return; }

  if (m.type === 'authResult') {
    log(m.ok === true, '配对成功');
    // 逐个发送按键（间隔 60ms，模拟真实点击节奏）
    const timer = setInterval(() => {
      if (sent >= samples.length) {
        clearInterval(timer);
        setTimeout(() => {
          log(ws.readyState === 1, `发送 ${samples.length} 组按键后连接仍然正常`);
          console.log(failures === 0 ? '\n虚拟键盘链路验证通过 ✅' : `\n存在 ${failures} 项问题 ❌`);
          try { ws.close(); } catch { }
          process.exit(failures === 0 ? 0 : 1);
        }, 400);
        return;
      }
      const s = samples[sent++];
      ws.send(JSON.stringify({ type: 'key', action: 'tap', keys: s.keys }));
      console.log(`      已发送 ${s.desc}`);
    }, 60);
    return;
  }
  if (m.type === 'error') log(false, '服务端返回错误: ' + JSON.stringify(m));
};

ws.onerror = () => { log(false, 'WebSocket 连接失败'); process.exit(1); };
setTimeout(() => { log(false, '超时'); process.exit(1); }, 20000);
