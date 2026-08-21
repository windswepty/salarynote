/**
 * 파비콘 link 태그를 모든 페이지의 <head> 에 심는다.
 *
 * 아이콘 파일 자체는 tools/make-favicon.py 가 만든다. 이 스크립트는 연결만
 * 담당한다. 페이지마다 손으로 넣으면 새 계산기에서 빠지고, 빠진 페이지만
 * 탭 아이콘이 빈 채로 남아 더 어설퍼 보인다.
 *
 *   node build/favicon.js            심는다
 *   node build/favicon.js --check    빠진 곳이 있으면 실패한다 (CI 용)
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "web");
const CHECK = process.argv.includes("--check");

const MARK_OPEN = "<!--FAVICON-->";
const MARK_CLOSE = "<!--/FAVICON-->";

// ico 를 먼저 둔다. 구형 브라우저는 뒤쪽 svg 를 이해하지 못하고,
// 최신 브라우저는 type 이 명시된 svg 를 우선 고른다. 둘 다 만족한다.
const BLOCK = [
  MARK_OPEN,
  '<link rel="icon" href="/favicon.ico" sizes="32x32">',
  '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
  MARK_CLOSE,
].join("\n");

// 아이콘 파일이 없는데 태그만 심으면 404 만 늘어난다. 먼저 확인한다.
for (const f of ["favicon.ico", "favicon.svg", "apple-touch-icon.png"]) {
  if (!fs.existsSync(path.join(WEB, f))) {
    console.error(`아이콘 파일이 없습니다: web/${f}`);
    console.error("  python tools/make-favicon.py 를 먼저 실행하세요.");
    process.exit(1);
  }
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".html")) out.push(p);
  }
  return out;
}

const stale = [];
let changed = 0, skipped = [];

for (const file of walk(WEB)) {
  const rel = path.relative(WEB, file).split(path.sep).join("/");
  const src = fs.readFileSync(file, "utf8");
  if (!/<\/head>/i.test(src)) { skipped.push(rel + " (head 없음)"); continue; }

  const next = src.includes(MARK_OPEN)
    ? src.replace(new RegExp(MARK_OPEN + "[\\s\\S]*?" + MARK_CLOSE.replace("/", "\\/")), BLOCK)
    : src.replace(/([ \t]*)<\/head>/i, BLOCK + "\n$1</head>");

  if (next === src) continue;
  if (CHECK) { stale.push(rel); continue; }
  fs.writeFileSync(file, next, "utf8");
  changed++;
}

if (CHECK) {
  if (stale.length) {
    console.error(`파비콘 태그가 빠졌거나 낡은 파일 ${stale.length}개:`);
    for (const m of stale) console.error("  " + m);
    console.error("\n  node build/favicon.js 를 실행해 다시 심으세요.");
    process.exit(1);
  }
  console.log("파비콘 태그 확인: 전 페이지 일치");
} else {
  console.log(`파비콘 태그 · 갱신 ${changed}개`);
  if (skipped.length) console.log(`제외(정상): ${skipped.join(", ")}`);
}
