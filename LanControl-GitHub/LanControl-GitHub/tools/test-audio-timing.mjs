// 音频时长自检：实测"服务端每秒实际发出多少字节"，与帧头声明的采样率对账。
// 判据：bytes/秒 必须等于 采样率 × 声道 × (位深/8)。
//   - 对得上 → 服务端时序正确，问题在手机端播放
//   - 对不上（尤其偏小 1/3 或 2/3）→ 服务端重采样/发送有问题
import { setTimeout as sleep } from 'node:timers/promises';

const HOST = process.argv[2] || '127.0.0.1:8848';
const CODE = process.argv[3] || '123456';
const SECONDS = Number(process.argv[4] || 6);

const ws = new WebSocket(`ws://${HOST}/ws`);
ws.binaryType = 'arraybuffer';

let fmt = null;            // { rate, ch, bits }
let bytes = 0, frames = 0;
let t0 = 0, t1 = 0;
let started = false;

const finish = () => {
  try { ws.send(JSON.stringify({ type: 'audioStop' })); } catch {}
  const wall = (t1 - t0) / 1000;
  if (!fmt || wall <= 0 || bytes === 0) {
    console.log('未收到音频数据（电脑当前没有播放声音时属于正常）');
    try { ws.close(); } catch {}
    process.exit(0);
  }
  const bps = fmt.rate * fmt.ch * (fmt.bits / 8);
  const actual = bytes / wall;
  const ratio = actual / bps;
  const declaredKbps = Math.round(bps * 8 / 1000);
  const actualKbps = Math.round(actual * 8 / 1000);

  console.log(`帧头声明: ${fmt.bits} 位 / ${fmt.rate} Hz / ${fmt.ch} 声道`);
  console.log(`理论字节率: ${bps} B/s  (${declaredKbps} kbps)`);
  console.log(`实测字节率: ${Math.round(actual)} B/s  (${actualKbps} kbps)`);
  console.log(`实测/理论 = ${ratio.toFixed(3)}`);
  console.log(`时长 ${wall.toFixed(2)}s，音频帧 ${frames} 个，共 ${bytes} 字节`);
  console.log('');
  if (Math.abs(ratio - 1) < 0.05) {
    console.log('结论: 服务端时序正确 ✅ —— 慢放/变调出在手机端播放环节');
  } else if (ratio < 0.85) {
    console.log(`结论: 服务端发得太少（只有理论的 ${(ratio * 100).toFixed(0)}%）❌`);
    console.log('      这会让手机端"慢放 + 变调" —— 问题在服务端重采样/发送节奏');
  } else if (ratio > 1.15) {
    console.log(`结论: 服务端发得过多（理论的 ${(ratio * 100).toFixed(0)}%）❌ —— 会表现为快放`);
  } else {
    console.log('结论: 偏差在测量误差范围内，基本正常');
  }
  try { ws.close(); } catch {}
  process.exit(0);
};

const timer = setTimeout(finish, SECONDS * 1000 + 1500);

ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', code: CODE, device: 'audio-timing' }));

ws.onmessage = (ev) => {
  if (typeof ev.data === 'string') {
    const m = JSON.parse(ev.data);
    if (m.type === 'authResult' && m.ok) {
      console.log('已配对，开始播放声音并计时（请让电脑持续出声）…');
      ws.send(JSON.stringify({ type: 'audioStart', bitrateKbps: 1152 }));
      // 等 1.5 秒让采集稳定，再开始计时
      setTimeout(() => { started = true; t0 = Date.now(); }, 1500);
    } else if (m.type === 'audioState' && m.on === true && m.sampleRate) {
      console.log(`服务端回报: ${m.bits} 位 / ${m.sampleRate} Hz / ${m.bitrateKbps} kbps`);
    } else if (m.type === 'audioState' && m.on === false && m.error) {
      console.log('服务端拒绝: ' + m.error);
      clearTimeout(timer);
      try { ws.close(); } catch {}
      process.exit(0);
    }
  } else {
    const buf = new Uint8Array(ev.data);
    if (buf[0] !== 0x41) return;
    if (!fmt) fmt = { rate: buf[2] | (buf[3] << 8), ch: buf[4], bits: buf[5] };
    if (!started) return;
    t1 = Date.now();
    bytes += buf.length - 8;
    frames++;
  }
};

ws.onerror = () => { console.log('WebSocket 连接失败'); process.exit(1); };
