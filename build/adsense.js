/**
 * 애드센스 코드를 모든 페이지의 <head> 에 심고 ads.txt 를 생성한다.
 *
 * 페이지가 14개라 손으로 넣으면 반드시 빠뜨리는 곳이 생기고, 빠진 페이지는
 * 광고가 안 나오는 게 아니라 '사이트 소유권 확인 실패'로 심사 자체가 막힌다.
 * data/adsense.json 하나만 보고 전부 다시 써 넣는다.
 *
 *   node build/adsense.js            심는다 (원장의 enabled 를 따른다)
 *   node build/adsense.js --check    원장과 어긋나면 실패한다 (CI 용)
 *   node build/adsense.js --off      광고를 끈다 (원장을 false 로 바꾸고 전부 제거)
 *   node build/adsense.js --on       광고를 다시 켠다
 *
 * ★--off 가 필요한 이유★
 * 군인의 지위 및 복무에 관한 기본법 제30조는 군인(현역병 포함, 같은 법 제2조
 * 제1호)이 군무 외에 영리를 목적으로 하는 업무에 종사하는 것을 금지한다.
 * 복무 중에는 광고를 내려야 한다. 그렇다고 사이트를 내릴 이유는 없다 —
 * 호스팅이 무료이고 요율 자동 갱신이 정확도를 지키므로, 광고만 꺼두면
 * 복무 기간에도 색인과 검색 신뢰도는 계속 쌓인다. 전역 후 --on 한 번이면 된다.
 *
 * 끄는 것은 '코드를 지우는 것' 이어야지 '주석 처리' 가 아니다. 주석 안에 남은
 * 스크립트 태그는 언젠가 누가 되살린다. 표식째로 걷어낸다.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "web");
const CFG_PATH = path.join(ROOT, "data", "adsense.json");

const CHECK = process.argv.includes("--check");
const TURN_OFF = process.argv.includes("--off");
const TURN_ON = process.argv.includes("--on");

if (TURN_OFF && TURN_ON) {
  console.error("--off 와 --on 을 같이 쓸 수 없습니다.");
  process.exit(1);
}
if ((TURN_OFF || TURN_ON) && CHECK) {
  console.error("--check 는 상태를 바꾸지 않습니다. --off/--on 과 같이 쓸 수 없습니다.");
  process.exit(1);
}

/**
 * OneDrive 가 동기화 중이면 연속 쓰기가 UNKNOWN(errno -4094) 으로 튕긴다(실측).
 * 원장을 못 쓰면 화면과 원장이 어긋난 채 끝나므로 짧게 재시도한다.
 */
function writeWithRetry(file, text, tries = 5) {
  for (let i = 1; ; i++) {
    try { return fs.writeFileSync(file, text, "utf8"); }
    catch (e) {
      if (i >= tries) throw e;
      const until = Date.now() + 300 * i;
      while (Date.now() < until) { /* 동기 대기 — 빌드 단계라 괜찮다 */ }
    }
  }
}

const CFG = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));

/** --on/--off 는 원장을 먼저 고친다. 화면이 원장을 따라오는 순서여야 한다. */
if (TURN_OFF || TURN_ON) {
  const want = TURN_ON;
  if (CFG.enabled === want) {
    console.log(`이미 ${want ? "켜져" : "꺼져"} 있습니다. 파일만 다시 맞춥니다.`);
  }
  CFG.enabled = want;
  CFG.enabledChangedAt = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  writeWithRetry(CFG_PATH, JSON.stringify(CFG, null, 2) + "\n");
}

const ENABLED = CFG.enabled !== false; // 필드가 없으면 켜진 것으로 본다(기존 동작 유지)

// 광고를 붙이지 않는 파일. 이유는 data/adsense.json 의 $excludedPages 에 적어 뒀다.
const EXCLUDE = new Set(Object.keys(CFG.$excludedPages));

const MARK_OPEN = "<!--ADSENSE-->";
const MARK_CLOSE = "<!--/ADSENSE-->";
/** 표식 한 덩어리. 앞의 들여쓰기와 뒤의 줄바꿈까지 먹어야 껐다 켤 때 빈 줄이 쌓이지 않는다. */
const BLOCK_RE = new RegExp("[ \\t]*" + MARK_OPEN + "[\\s\\S]*?" + MARK_CLOSE + "\\n?", "g");

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
const wrong = [];
let changed = 0, skipped = [];

for (const file of walk(WEB)) {
  const name = path.basename(file);
  const rel = path.relative(WEB, file).split(path.sep).join("/");

  const excluded = EXCLUDE.has(name) || EXCLUDE.has(rel);
  const src = fs.readFileSync(file, "utf8");

  let next;
  if (!ENABLED || excluded) {
    // 꺼진 상태(또는 제외 페이지)에서는 표식이 아예 없어야 한다.
    next = src.replace(BLOCK_RE, "");
    if (excluded && next === src) { skipped.push(rel); continue; }
  } else {
    if (!/<\/head>/i.test(src)) { skipped.push(rel + " (head 없음)"); continue; }
    // ★자리를 고정한다 — 언제나 </head> 바로 앞.★
    // 예전에는 표식이 이미 있으면 그 자리에서 교체했다. 그런데 --off 로 지웠다가
    // --on 으로 되살리면 </head> 앞에 붙어 위치가 달라졌고, 내용이 똑같은데도
    // 16개 파일이 전부 '바뀜' 으로 잡혔다. set-base-url.js 는 내용 해시로
    // lastmod 를 정하므로 그 순간 sitemap 이 전 페이지를 '오늘 수정됨' 으로
    // 신고한다. 한 글자도 안 바뀌었는데 구글에 전부 바뀌었다고 말하는 꼴이고,
    // 그런 신고가 반복되면 구글이 우리 lastmod 를 믿지 않게 된다.
    // 그래서 껐다 켜도 바이트가 같도록 자리를 한 곳으로 못 박는다.
    const stripped = src.replace(BLOCK_RE, "");
    next = stripped.replace(/([ \t]*)<\/head>/i, block + "\n$1</head>");
  }

  if (next === src) continue;

  if (CHECK) { wrong.push(rel); continue; }
  fs.writeFileSync(file, next, "utf8");
  changed++;
}

/**
 * ads.txt — 켜져 있을 때는 반드시 있어야 한다. 없으면 애드센스가 "승인된
 * 판매자를 찾을 수 없음" 경고를 띄우고 일부 광고주가 입찰에서 빠진다.
 * 꺼져 있을 때는 없어야 한다. 광고를 안 싣는데 판매 권한만 선언해 두는 것은
 * '광고를 하지 않는 상태' 라고 말하기 어렵다.
 */
const adsPath = path.join(WEB, "ads.txt");
const wantAds = ENABLED ? adsTxt() : null;
const haveAds = fs.existsSync(adsPath) ? fs.readFileSync(adsPath, "utf8") : null;
if (haveAds !== wantAds) {
  if (CHECK) wrong.push("ads.txt");
  else {
    if (wantAds === null) fs.unlinkSync(adsPath);
    else fs.writeFileSync(adsPath, wantAds, "utf8");
    changed++;
  }
}

const state = ENABLED ? "켜짐" : "꺼짐";

if (CHECK) {
  if (wrong.length) {
    console.error(`애드센스 상태가 원장(${state})과 어긋나는 파일 ${wrong.length}개:`);
    for (const m of wrong) console.error("  " + m);
    console.error("\n  node build/adsense.js 를 실행해 다시 맞추세요.");
    process.exit(1);
  }
  console.log(`애드센스 ${state}: 전 페이지 일치${ENABLED ? ` (ca-${CFG.publisherId})` : ""}`);
} else {
  console.log(`애드센스 ${state} · 갱신 ${changed}개`);
  if (ENABLED) {
    console.log(`ads.txt: ${wantAds.trim()}`);
    if (skipped.length) console.log(`제외(정상): ${skipped.join(", ")}`);
  } else {
    console.log("모든 페이지에서 광고 코드와 ads.txt 를 제거했습니다.");
    console.log("★ 애드센스 계정에서도 광고 게재를 중지하십시오 — 코드만 지우면");
    console.log("  계정은 그대로 살아 있습니다. 애드센스 > 사이트 에서 사이트를 제거하면 확실합니다.");
  }
}
