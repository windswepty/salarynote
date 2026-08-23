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
const crypto = require("crypto");

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

/**
 * ★lastmod 는 '빌드한 날' 이 아니라 '그 페이지가 실제로 바뀐 날' 이어야 한다.★
 *
 * 예전에는 전 URL 에 오늘 날짜를 일괄로 찍었다. build/all.js 가 이 스크립트를
 * 매번 부르므로, 요율 확인 기록만 갱신하는 주간 하트비트 커밋 하나에도 16개
 * 페이지 전부가 '오늘 수정됨' 으로 바뀌었다. 실제로는 한 글자도 안 바뀌었는데
 * 구글에는 전부 바뀌었다고 신고하는 셈이다. 그런 신고가 반복되면 구글은 이
 * 사이트의 lastmod 를 신뢰하지 않게 되고, 진짜로 바뀐 날 재크롤링이 늦어진다.
 * 검색 유입이 전부인 사이트에서 스스로 신호를 망가뜨리는 짓이다.
 *
 * 그래서 페이지 내용의 해시를 기록해 두고, 해시가 바뀐 날에만 날짜를 올린다.
 * git 이력을 쓰지 않는 이유는 Actions 의 얕은 클론에서 파일별 커밋 날짜를
 * 신뢰할 수 없기 때문이다.
 */
const LASTMOD_DB = path.join(ROOT, "data", "page-lastmod.json");
const today = new Date().toISOString().slice(0, 10);

function pageFile(url) {
  return path.join(WEB, url === "/" ? "index.html" : path.join(url.slice(1), "index.html"));
}

/** sitemap 에 실을 lastmod. 내용 해시가 그대로면 기록된 날짜를 유지한다. */
function lastmodFor(db, url) {
  const file = pageFile(url);
  if (!fs.existsSync(file)) return { date: today, hash: null };

  // sitemap 날짜 자체를 바꾸는 부분(생성물 표식)은 해시에서 빼야 순환이 생기지 않는다.
  const body = fs.readFileSync(file, "utf8");
  const hash = crypto.createHash("sha256").update(body).digest("hex").slice(0, 16);

  const prev = db[url];
  if (prev && prev.hash === hash) return { date: prev.date, hash };
  return { date: today, hash };
}

let db = {};
try { db = JSON.parse(fs.readFileSync(LASTMOD_DB, "utf8")); } catch (_) {}

const nextDb = {};
let bumped = 0;
const entries = PAGES.map((p) => {
  const { date, hash } = lastmodFor(db, p.url);
  nextDb[p.url] = { date, hash };
  // 날짜가 아니라 내용 해시가 바뀐 것을 센다. 같은 날 두 번 고치면 날짜는
  // 그대로라 날짜로 세면 0 이 나와 바뀐 줄 모른다.
  if (!db[p.url] || db[p.url].hash !== hash) bumped++;
  return `  <url>\n    <loc>${baseUrl}${p.url}</loc>\n    <lastmod>${date}</lastmod>\n` +
    `    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>`;
});

const sitemap =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  entries.join("\n") +
  `\n</urlset>\n`;

fs.writeFileSync(path.join(WEB, "sitemap.xml"), sitemap, "utf8");
fs.writeFileSync(LASTMOD_DB, JSON.stringify(nextDb, null, 1) + "\n", "utf8");

console.log(`기준 주소: ${baseUrl}`);
console.log(`치환된 파일: ${touched}개`);
console.log(`sitemap.xml: ${PAGES.length}개 URL · lastmod 갱신 ${bumped}개`);
// 남아 있는 치환 토큰이 실제로 있을 때만 알린다.
// 예전에는 contact 인자가 없으면 무조건 경고했는데, web/ 에는 이미 그 토큰이
// 하나도 없어서 매 빌드마다 거짓 경고가 떴다. 거짓 경고가 반복되면 빌드 출력을
// 통째로 무시하게 되고, 나중에 진짜 경고가 섞였을 때 놓친다.
const leftover = walk(WEB).filter((f) => fs.readFileSync(f, "utf8").includes("__CONTACT_EMAIL__"));
if (leftover.length) {
  console.log(`주의: __CONTACT_EMAIL__ 토큰이 ${leftover.length}개 파일에 남아 있습니다. ` +
    `node build/set-base-url.js <주소> <이메일> 로 채우십시오.`);
}
