// 验证"电脑声音"这条链路：welcome 能力字段 + audioStart/audioStop 协议 + 音频帧格式。
// 用 Node 内置的全局 WebSocket（Node 22+ 自带），无需第三方依赖。

const HOST = process.argv[2] || '127.0.0.1:8848';
const CODE = process.argv[3] || '123456';

let failures = 0;
const log = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

const ws = new WebSocket(`ws://${HOST}/ws`);
ws.binaryType = 'arraybuffer';

let audioFrames = 0;
let audioBytes = 0;
let firstFrame = null;
let welcome = null;

const done = (code) => {
  try { ws.close(); } catch {}
  console.log(failures === 0 ? '\n电脑声音链路验证通过 ✅' : `\n存在 ${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
};

const timer = setTimeout(() => { log(false, '超时'); done(1); }, 20000);

ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', code: CODE, device: 'audio-test' }));

ws.onmessage = (ev) => {
  if (typeof ev.data === 'string') {
    const m = JSON.parse(ev.data);
    if (m.type === 'welcome') {
      welcome = m;
      log(Array.isArray(m.serverAddresses) && m.serverAddresses.length > 0,
        `welcome 带本机地址（供手机端同网段扫描）: ${JSON.stringify(m.serverAddresses)}`);
      log(typeof m.port === 'number' && m.port > 0, `welcome 带端口: ${m.port}`);
      log(typeof m.audioOk === 'boolean', `welcome 带音频能力: audioOk=${m.audioOk} msg=${m.audioMessage || ''}`);
    } else if (m.type === 'authResult' && m.ok) {
      log(true, '配对成功，开始请求声音');
      ws.send(JSON.stringify({ type: 'audioStart', bitrateKbps: 1152 }));
      setTimeout(() => {
        log(audioFrames > 0 || (welcome && welcome.audioOk === false),
          welcome && welcome.audioOk === false
            ? '（本机音频不可用，audioStart 被正确拒绝，属于预期）'
            : `收到音频帧 ${audioFrames} 个 / ${audioBytes} 字节`);
        if (firstFrame) {
          const [magic, ver, rate, ch, bits] = firstFrame;
          log(magic === 0x41, `音频帧魔数 = 0x${magic.toString(16).toUpperCase()} (应为 0x41 'A')`);
          log(ver === 1, `音频帧版本 = ${ver}`);
          log(rate === 48000, `帧内采样率 = ${rate} Hz（应为 48000）`);
          log(ch === 1, `声道 = ${ch}`);
          log(bits === 24, `位深 = ${bits}（应为 24）`);
        }
        clearTimeout(timer);
        done(0);
      }, 4000);
    } else if (m.type === 'audioState') {
      if (m.on === true) {
        log(m.bitrateKbps === 1152, '码率 = ' + m.bitrateKbps + ' kbps（要求 1152 = 24位/48kHz）');
        log(m.sampleRate === 48000, '采样率 = ' + m.sampleRate + ' Hz（要求 48000）');
        log(m.channels === 1 && m.bits === 24, '格式 = 单声道 ' + m.bits + ' 位（要求 24 位）');
      }
      console.log(`      audioState: on=${m.on} ${m.error ? 'error=' + m.error : ''}`);
    }
  } else {
    const buf = new Uint8Array(ev.data);
    if (buf[0] === 0x41) {
      audioFrames++;
      audioBytes += buf.length - 8;
      if (!firstFrame && buf.length >= 8) {
        firstFrame = [buf[0], buf[1], buf[2] | (buf[3] << 8), buf[4], buf[5]];
      }
    }
  }
};

ws.onerror = (e) => { log(false, 'WebSocket 错误: ' + (e.message || '')); done(1); };
