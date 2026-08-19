/**
 * 모든 페이지의 상단 내비게이션을 build/pages.js 기준으로 다시 써 넣는다.
 * 계산기가 늘어날 때마다 여러 HTML 을 손으로 고치면 반드시 빠뜨리는 곳이 생긴다.
 *
 *   node build/nav.js
 */
const fs = require("fs");
const path = require("path");
const PAGES = require("./pages.js");

const WEB = path.join(__dirname, "..", "web");
const items = PAGES.filter((p) => p.nav);

function navHtml(currentUrl) {
  const links = items.map((p) => {
    const cur = p.url === currentUrl ? ' aria-current="page"' : "";
    return `    <a href="${p.url}"${cur}>${p.nav}<span class="bar"></span></a>`;
  });
  return `  <nav class="nav">\n${links.join("\n")}\n  </nav>`;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".html")) out.push(p);
  }
  return out;
}

let changed = 0, skipped = [];
for (const file of walk(WEB)) {
  const src = fs.readFileSync(file, "utf8");
  if (!/<nav class="nav">/.test(src)) { skipped.push(path.relative(WEB, file)); continue; }

  // 이 파일이 어느 페이지인지 경로로 판정한다.
  const rel = "/" + path.relative(WEB, file).split(path.sep).join("/");
  const url = rel.replace(/index\.html$/, "");

  const next = src.replace(/  <nav class="nav">[\s\S]*?<\/nav>/, navHtml(url));
  if (next !== src) { fs.writeFileSync(file, next, "utf8"); changed++; }
}

console.log(`내비 항목 ${items.length}개: ${items.map((i) => i.nav).join(" / ")}`);
console.log(`갱신된 파일: ${changed}개`);
if (skipped.length) console.log(`내비 없는 파일(정상): ${skipped.join(", ")}`);
