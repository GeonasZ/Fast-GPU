const fs = require("fs");
const p = "D:/SomethingStrange/GPUSchedulingPlatform/public/app.js";
let s = fs.readFileSync(p).toString("utf8");
// The file uses CRLF; detect it so the replacement stays consistent.
const NL = s.indexOf("\r\n") >=  ? "\r\n" : "\n";
const start = "for (const field of [";
const si = s.indexOf(start);
if (si < 0) throw new Error("start marker not found");
// The statement body begins right after the closing "])".
let ej = s.indexOf("])", si);
if (ej < 0) throw new Error("end '])' not found");
// Advance past the bracket+paren of "]).
ej += 2;
const head = [
  'for (const field of [',
  '  {',
  '    ids: ["#r2Bucket", "#ossBucket"],',
  '    label: "Bucket Name",',
  '    placeholder: "请输入 Bucket Name",',
  '    description: "对象存储 Bucket Name",',
  '  },',
  '  {',
  '    ids: ["#r2AccessKey", "#ossAccessKey"],',
  '    label: "S3 Access Key ID",',
  '    placeholder: "请输入 S3 Access Key ID",',
  '    description: "在供应商控制台创建的 S3 Access Key ID（不是云账号或登录邮箱）",',
  '  },',
  '  {',
  '    ids: ["#r2SecretKey", "#ossSecretKey"],',
  '    label: "S3 Secret Access Key",',
  '    placeholder: "请输入 S3 Secret Access Key",',
  '    description: "在供应商控制台创建的 S3 Secret Access Key（不是云账号登录密码）",',
  '  },',
  '])',
].join(NL);
s = s.slice(0, si) + head + s.slice(ej);
fs.writeFileSync(p, s, "utf8");
console.log("codex-fix-for done, NL=" + JSON.stringify(NL) + ", length=" + s.length);
