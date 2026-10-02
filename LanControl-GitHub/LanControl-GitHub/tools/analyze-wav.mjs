// 分析 16 位单声道 WAV，判断录音是否正常（还是杂音/削波/直流偏置）。
// 用法: node analyze-wav.mjs <file.wav>
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const buf = readFileSync(file);

if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
  console.log('不是合法的 RIFF/WAVE 文件');
  process.exit(1);
}
// 解析 chunk
let pos = 12, fmt = null, data = null;
while (pos + 8 <= buf.length) {
  const id = buf.toString('ascii', pos, pos + 4);
  const size = buf.readUInt32LE(pos + 4);
  const body = buf.subarray(pos + 8, pos + 8 + size);
  if (id === 'fmt ') {
    fmt = {
      audioFormat: body.readUInt16LE(0),
      channels: body.readUInt16LE(2),
      sampleRate: body.readUInt32LE(4),
      byteRate: body.readUInt32LE(8),
      bitsPerSample: body.readUInt16LE(14),
    };
  } else if (id === 'data') {
    data = body;
  }
  pos += 8 + size + (size % 2);
}

console.log('文件:', file);
console.log('格式:', JSON.stringify(fmt));
const kbps = fmt.byteRate * 8 / 1000;
console.log('码率:', kbps.toFixed(1), 'kbps');
console.log('数据字节:', data.length, ' 时长:', (data.length / fmt.byteRate).toFixed(2), 's');

const n = Math.floor(data.length / (fmt.bitsPerSample / 8));
if (n === 0) { console.log('没有音频样本'); process.exit(0); }

// 按实际位深读取（8 / 16 / 24 / 32），别写死 16 —— 否则 24 位数据会被误判成削波噪声
const fullScale = Math.pow(2, fmt.bitsPerSample - 1);
const readSample = (i) => {
  const o = i * (fmt.bitsPerSample / 8);
  if (fmt.bitsPerSample === 24) {
    let v = data[o] | (data[o + 1] << 8) | (data[o + 2] << 16);
    if (v & 0x800000) v -= 0x1000000;      // 符号扩展
    return v;
  }
  if (fmt.bitsPerSample === 32) return data.readInt32LE(o);
  if (fmt.bitsPerSample === 8) return data.readInt8(o);
  return data.readInt16LE(o);
};

// 统计
let sum = 0, sumSq = 0, peak = 0, clipped = 0, zeroRuns = 0, maxZeroRun = 0, run = 0;
const samples = new Int32Array(n);
const clipLevel = fullScale - Math.max(2, Math.round(fullScale * 0.0002));
for (let i = 0; i < n; i++) {
  const s = readSample(i);
  samples[i] = s;
  sum += s;
  sumSq += s * s;
  const a = Math.abs(s);
  if (a > peak) peak = a;
  if (a >= clipLevel) clipped++;
  if (s === 0) { run++; if (run > maxZeroRun) maxZeroRun = run; }
  else { if (run > 20) zeroRuns++; run = 0; }
}
const mean = sum / n;
const rms = Math.sqrt(sumSq / n);
const db = (v) => (v <= 0 ? '-inf' : (20 * Math.log10(v / fullScale)).toFixed(1) + ' dBFS');

// 过零率（粗略判断是否有内容/是否像噪声）
let zc = 0;
for (let i = 1; i < n; i++) if ((samples[i - 1] < 0) !== (samples[i] < 0)) zc++;
const zcr = zc / (n / fmt.sampleRate);

// 分段 RMS，看是否随时间变化（音乐应该有起伏；恒定噪声则变化很小）
const segs = 8, segLen = Math.floor(n / segs);
const segRms = [];
for (let k = 0; k < segs; k++) {
  let acc = 0;
  for (let i = k * segLen; i < (k + 1) * segLen && i < n; i++) acc += samples[i] * samples[i];
  segRms.push(Math.sqrt(acc / segLen));
}
const rmsMin = Math.min(...segRms), rmsMax = Math.max(...segRms);

console.log('');
console.log('峰值:', peak, `(${db(peak)})`);
console.log('RMS :', rms.toFixed(1), `(${db(rms)})`);
console.log('直流偏置:', mean.toFixed(2), '(正常应接近 0)');
console.log('削波样本:', clipped, clipped > n * 0.01 ? '  <-- 过多，会听成"破音/杂音"' : '');
console.log('过零率:', zcr.toFixed(0), 'Hz', zcr > fmt.sampleRate * 0.35 ? '  <-- 过高，像白噪声' : '');
console.log('长静音段:', zeroRuns);
console.log('分段 RMS 变化:', rmsMin.toFixed(0), '~', rmsMax.toFixed(0),
  (rmsMax > 0 && rmsMin / rmsMax < 0.25) ? '  <-- 有明显起伏（像音乐/语音，正常）' : '  <-- 基本恒定（可能是噪声/静音）');

console.log('');
if (peak < fullScale * 0.001) console.log('结论: 基本全是静音');
else if (clipped > n * 0.02) console.log('结论: 严重削波 —— 这就是"杂音"的来源（增益过大）');
else if (zcr > fmt.sampleRate * 0.35) console.log('结论: 内容像宽带噪声 —— 采样格式/字节序可能不对');
else console.log('结论: 波形看起来是正常的音频内容');

// 导出前 8 段的 RMS 供快速目视
console.log('分段 RMS:', segRms.map((v) => v.toFixed(0)).join(' '));
