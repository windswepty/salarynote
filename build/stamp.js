/**
 * 원장의 숫자를 HTML 본문에 찍어 넣는다.
 *
 * 왜 필요한가:
 * 원장 주석은 "이 파일 외의 곳에 숫자를 하드코딩하지 말 것"이라고 하는데,
 * 실제로는 설명 문단과 푸터에 요율이 손으로 적혀 있었다. 자동 갱신이 병합되면
 * 계산기는 새 요율로 계산하는데 같은 페이지 본문은 옛 요율을 단언하게 된다.
 * 사용자가 보기엔 사이트가 자기 자신과 모순되고, 어느 쪽이 맞는지 알 수 없다.
 *
 * 두 가지를 처리한다.
 *  1. <span data-rate="경로" data-fmt="pct|won|raw">…</span>  → 원장 값으로 교체
 *  2. <!--STAMP:footer--> … <!--/STAMP-->                      → 기준 정보 생성
 *
 * 사용: node build/stamp.js          (쓰기)
 *       node build/stamp.js --check  (검사만, 어긋나면 exit 1)
 */
const fs = require("fs");
const path = require("path");
const { resolve, assertCurrent, assertYearMatchesContent } = require("../tools/lib/resolve-ledger.js");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "web");
const CHECK = process.argv.includes("--check");

const LEDGER = assertCurrent(resolve());   // 새해에 작년 요율을 화면에 찍지 않는다
const rates = JSON.parse(fs.readFileSync(LEDGER.ledgerPath, "utf8"));
assertYearMatchesContent(LEDGER, rates);

/** 'a.b.c' 경로로 원장에서 값을 꺼낸다. 없으면 던진다(조용히 빈칸을 만들지 않는다). */
function pick(p) {
  let cur = rates;
  for (const k of p.split(".")) {
    if (cur == null || !(k in cur)) throw new Error(`원장에 없는 경로: ${p}`);
    cur = cur[k];
  }
  return cur;
}

/** 요율을 사람이 읽는 퍼센트로. 0.03595 -> "3.595%" (뒤 0 제거) */
function pct(v) {
  const s = (v * 100).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return s + "%";
}
const won = (v) => Number(v).toLocaleString("ko-KR") + "원";

function format(value, fmt) {
  if (fmt === "pct") return pct(value);
  if (fmt === "won") return won(value);
  return String(value);
}

/** 푸터에 찍는 기준 정보. 원장이 갱신되면 화면 문구도 같이 바뀐다. */
function footerLine() {
  return (
    `${rates.year}년 기준 · ` +
    `국민연금 ${pct(pick("nationalPension.totalRate"))}, ` +
    `건강보험 ${pct(pick("healthInsurance.totalRate"))}, ` +
    `장기요양 ${pct(pick("longTermCare.rateOfHealthPremium"))}, ` +
    `고용보험 ${pct(pick("employmentInsurance.unemploymentTotalRate"))}, ` +
    `최저임금 ${won(pick("minimumWage.hourly"))} · ` +
    `자료 확인일 ${rates.lastVerified}`
  );
}

const SPAN = /<span data-rate="([^"]+)"(?: data-fmt="([^"]+)")?>([\s\S]*?)<\/span>/g;
const FOOTER = /(<!--STAMP:footer-->)([\s\S]*?)(<!--\/STAMP-->)/g;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".html")) out.push(p);
  }
  return out;
}

let changed = 0, spans = 0, mismatches = [];
for (const file of walk(WEB)) {
  const src = fs.readFileSync(file, "utf8");
  let next = src.replace(SPAN, (m, p, fmt, old) => {
    spans++;
    const want = format(pick(p), fmt || "raw");
    if (old !== want) mismatches.push(`${path.relative(WEB, file)}  ${p}: "${old}" → "${want}"`);
    return `<span data-rate="${p}"${fmt ? ` data-fmt="${fmt}"` : ""}>${want}</span>`;
  });
  next = next.replace(FOOTER, (m, a, old, b) => {
    const want = footerLine();
    if (old.trim() !== want) mismatches.push(`${path.relative(WEB, file)}  footer 갱신 필요`);
    return a + want + b;
  });
  if (next !== src) {
    if (!CHECK) fs.writeFileSync(file, next, "utf8");
    changed++;
  }
}

console.log(`원장 ${path.basename(LEDGER.ledgerPath)} · data-rate ${spans}곳 · 파일 ${changed}개 ${CHECK ? "불일치" : "갱신"}`);
if (CHECK && mismatches.length) {
  console.error("\n★ 화면 숫자가 원장과 어긋납니다. `node build/stamp.js` 를 실행하세요.\n");
  for (const m of mismatches) console.error("  " + m);
  process.exit(1);
}
