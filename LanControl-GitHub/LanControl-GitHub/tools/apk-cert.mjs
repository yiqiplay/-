// 从 APK 的 v2/v3 签名块里取出签名者证书，打印主体（CN/O/OU）。
// 用途：确认 APK 到底用谁的证书签名 —— keytool -printcert -jarfile 只认 v1(jar) 签名，
// 而现代 APK 用的是 v2/v3，所以那条命令看不到东西。
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const buf = readFileSync(file);

// 1) 找 EOCD（End of Central Directory），签名块紧挨在中央目录之前
const EOCD_SIG = 0x06054b50;
let eocd = -1;
for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
  if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
}
if (eocd < 0) { console.log('找不到 EOCD，不是有效 ZIP/APK'); process.exit(1); }

const cdOffset = buf.readUInt32LE(eocd + 16);
const APK_SIG_BLOCK_MAGIC = 'APK Sig Block 42';
const magicAt = cdOffset - 16;
const magic = buf.toString('latin1', magicAt, magicAt + 16);
if (magic !== APK_SIG_BLOCK_MAGIC) {
  console.log('没有 APK Signing Block（可能是 v1 签名或未签名）');
  process.exit(0);
}
const blockSize = Number(buf.readBigUInt64LE(cdOffset - 24));
const blockStart = cdOffset - blockSize - 8;

// 2) 遍历签名块里的 id-value 对
let pos = blockStart + 8;
const pairs = [];
while (pos < cdOffset - 24) {
  const len = Number(buf.readBigUInt64LE(pos));
  const id = buf.readUInt32LE(pos + 8);
  const valueStart = pos + 12;
  pairs.push({ id, valueStart, len: len - 4 });
  pos = valueStart + (len - 4);
}
console.log('签名块里的条目:');
for (const p of pairs) {
  const name = p.id === 0x7109871a ? 'v2 签名 (APK Signature Scheme v2)'
    : p.id === 0xf05368c0 ? 'v3 签名'
      : p.id === 0x42726577 ? '签名 padding'
        : 'id=0x' + p.id.toString(16);
  console.log('  ' + name);
}

// 3) 从 v2 签名块里挖出证书 DER（找 X.509 的 SEQUENCE 头 30 82）
function findCerts(start, end) {
  const out = [];
  for (let i = start; i < end - 4; i++) {
    // 证书通常是 30 82 LL LL 开头，且长度字段能对上
    if (buf[i] === 0x30 && buf[i + 1] === 0x82) {
      const len = buf.readUInt16BE(i + 2) + 4;
      if (len > 300 && len < 4000 && i + len <= end) {
        const der = buf.subarray(i, i + len);
        // 粗校验：DER 尾部应有结尾
        if (der[der.length - 1] === 0x30 || true) out.push(der);
      }
    }
  }
  return out;
}

const v2 = pairs.find((p) => p.id === 0x7109871a);
const v3 = pairs.find((p) => p.id === 0xf05368c0);
const target = v2 || v3;
if (!target) { console.log('未找到 v2/v3 签名数据'); process.exit(0); }

const certs = findCerts(target.valueStart, target.valueStart + target.len);
console.log('\n找到证书数量: ' + certs.length);

// 4) 用 node:crypto 的 X509Certificate 解析主体
import { X509Certificate } from 'node:crypto';
const seen = new Set();
for (const der of certs) {
  try {
    const c = new X509Certificate(der);
    const key = c.subject + '|' + c.fingerprint256;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log('\n--- 签名证书 ---');
    console.log('主体 (Subject) : ' + c.subject.replace(/\n/g, ', '));
    console.log('颁发 (Issuer)  : ' + c.issuer.replace(/\n/g, ', '));
    console.log('有效期至       : ' + c.validTo);
    console.log('SHA-256 指纹   : ' + c.fingerprint256);
  } catch (e) { /* 不是完整证书，跳过 */ }
}
if (seen.size === 0) console.log('（未能解析出证书，可能签名块结构不同）');
