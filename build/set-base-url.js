/**
 * 사이트의 정규 주소(canonical)를 한 번에 바꾸고 sitemap 을 생성한다.
 *
 *   node build/set-base-url.js https://salarynote-xxx.pages.dev
 *   node build/set-base-url.js https://salarynote.kr        (도메인 구입 후)
 *
 * canonical 을 소유하지 않은 도메인으로 두면 색인에 해롭기 때문에
 * 소스에는 __BASE_URL__ 토큰만 두고 배포 직전에 실제 주소를 넣는다.
 * 도메인을 나중에 사도 이 명령 한 번이면 전부 따라 바뀐다.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "web");

const baseUrl = (process.argv[2] || "").replace(/\/+$/, "");
const contact = process.argv[3] || process.env.SN_CONTACT || "";

if (!/^https?:\/\/[^\s/]+$/.test(baseUrl)) {
  console.error("사용법: node build/set-base-url.js https://example.com [문의이메일]");
  process.exit(1);
}

/** 페이지 정의는 build/pages.js 한 곳에서 관리한다. */
const PAGES = require("./pages.js");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(html|txt|xml)$/.test(e.name)) out.push(p);
  }
  return out;
}

let touched = 0;
for (const file of walk(WEB)) {
  const before = fs.readFileSync(file, "utf8");
  let after = before.split("__BASE_URL__").join(baseUrl);
  if (contact) after = after.split("__CONTACT_EMAIL__").join(contact);
  if (after !== before) { fs.writeFileSync(file, after, "utf8"); touched++; }
}

const today = new Date().toISOString().slice(0, 10);
const sitemap =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  PAGES.map((p) =>
    `  <url>\n    <loc>${baseUrl}${p.url}</loc>\n    <lastmod>${today}</lastmod>\n` +
    `    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>`
  ).join("\n") +
  `\n</urlset>\n`;

fs.writeFileSync(path.join(WEB, "sitemap.xml"), sitemap, "utf8");

console.log(`기준 주소: ${baseUrl}`);
console.log(`치환된 파일: ${touched}개`);
console.log(`sitemap.xml: ${PAGES.length}개 URL`);
if (!contact) console.log("주의: 문의 이메일이 비어 있어 __CONTACT_EMAIL__ 토큰이 그대로 남아 있습니다.");
