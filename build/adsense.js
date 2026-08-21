/**
 * 애드센스 코드를 모든 페이지의 <head> 에 심고 ads.txt 를 생성한다.
 *
 * 페이지가 14개라 손으로 넣으면 반드시 빠뜨리는 곳이 생기고, 빠진 페이지는
 * 광고가 안 나오는 게 아니라 '사이트 소유권 확인 실패'로 심사 자체가 막힌다.
 * data/adsense.json 하나만 보고 전부 다시 써 넣는다.
 *
 *   node build/adsense.js            심는다
 *   node build/adsense.js --check    빠진 곳이 있으면 실패한다 (CI 용)
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "web");
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "adsense.json"), "utf8"));

const CHECK = process.argv.includes("--check");

// 광고를 붙이지 않는 파일. 이유는 data/adsense.json 의 $excludedPages 에 적어 뒀다.
const EXCLUDE = new Set(Object.keys(CFG.$excludedPages));

const MARK_OPEN = "<!--ADSENSE-->";
const MARK_CLOSE = "<!--/ADSENSE-->";

function snippet() {
  const src = `${CFG.scriptSrc}?client=ca-${CFG.publisherId}`;
  return [
    MARK_OPEN,
    `<script async src="${src}" crossorigin="anonymous"></script>`,
    MARK_CLOSE,
  ].join("\n");
}

function adsTxt() {
  const a = CFG.adsTxt;
  // ads.txt 는 한 줄에 하나씩, 쉼표로 구분한다. 마지막 줄바꿈이 없으면
  // 일부 크롤러가 마지막 줄을 무시하므로 반드시 넣는다.
  return `${a.domain}, ${CFG.publisherId}, ${a.relationship}, ${a.certificationAuthorityId}\n`;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".html")) out.push(p);
  }
  return out;
}

const block = snippet();
const missing = [];
let changed = 0, skipped = [];

for (const file of walk(WEB)) {
  const name = path.basename(file);
  const rel = path.relative(WEB, file).split(path.sep).join("/");

  if (EXCLUDE.has(name) || EXCLUDE.has(rel)) { skipped.push(rel); continue; }

  const src = fs.readFileSync(file, "utf8");
  if (!/<\/head>/i.test(src)) { skipped.push(rel + " (head 없음)"); continue; }

  let next;
  if (src.includes(MARK_OPEN)) {
    // 이미 있으면 통째로 교체한다. 게시자 ID 가 바뀌어도 한 번에 따라온다.
    next = src.replace(
      new RegExp(MARK_OPEN + "[\\s\\S]*?" + MARK_CLOSE.replace("/", "\\/")),
      block
    );
  } else {
    next = src.replace(/([ \t]*)<\/head>/i, block + "\n$1</head>");
  }

  if (next === src) continue;

  if (CHECK) { missing.push(rel); continue; }
  fs.writeFileSync(file, next, "utf8");
  changed++;
}

// ads.txt — 이게 없으면 애드센스가 "승인된 판매자를 찾을 수 없음" 경고를 띄우고
// 일부 광고주가 입찰에서 빠진다. 수익에 직접 영향이 있다.
const adsPath = path.join(WEB, "ads.txt");
const want = adsTxt();
const have = fs.existsSync(adsPath) ? fs.readFileSync(adsPath, "utf8") : null;
if (have !== want) {
  if (CHECK) missing.push("ads.txt");
  else { fs.writeFileSync(adsPath, want, "utf8"); changed++; }
}

if (CHECK) {
  if (missing.length) {
    console.error(`애드센스 코드가 빠졌거나 낡은 파일 ${missing.length}개:`);
    for (const m of missing) console.error("  " + m);
    console.error("\n  node build/adsense.js 를 실행해 다시 심으세요.");
    process.exit(1);
  }
  console.log(`애드센스 코드 확인: 전 페이지 일치 (ca-${CFG.publisherId})`);
} else {
  console.log(`애드센스 코드 ca-${CFG.publisherId} · 갱신 ${changed}개`);
  console.log(`ads.txt: ${want.trim()}`);
  if (skipped.length) console.log(`제외(정상): ${skipped.join(", ")}`);
}
