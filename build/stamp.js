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

/**
 * 원장에서 바로 꺼낼 수 없고 계산해야 하는 값들.
 *
 * 실업급여 코호트는 배열이라 경로 조회로는 못 뽑는다. 그런데 화면의 날짜
 * 입력 상한이 바로 이 값이어야 한다. 손으로 max="2026-12-31" 을 적어 두면
 * 2027년에 그 달력은 작년까지만 고를 수 있고 사용자는 이유를 모른다.
 */
const DERIVED = (() => {
  const u = JSON.parse(fs.readFileSync(
    path.join(ROOT, "data", `unemployment-${LEDGER.year}.json`), "utf8"));
  const from = u.cohorts.map((c) => c.leaveDateFrom).sort();
  const to = u.cohorts.map((c) => c.leaveDateTo).sort();
  // 육아휴직도 원장이 지원 시작일을 정한다. 2025-01-01 전에 시작한 휴직은
  // 부칙 적용례 때문에 계산하지 않기로 했고, 엔진이 그 날짜로 거부한다.
  // 달력 하한이 그와 어긋나면 사용자는 고를 수 있는 날짜를 거부당한다.
  const pl = JSON.parse(fs.readFileSync(
    path.join(ROOT, "data", "parental-leave-2026.json"), "utf8"));

  return {
    "unemployment.leaveDateMin": from[0],
    "unemployment.leaveDateMax": to[to.length - 1],
    "parentalLeave.startFrom": pl["$supportedRange"].leaveStartFrom,
  };
})();

/** 'a.b.c' 경로로 원장에서 값을 꺼낸다. 없으면 던진다(조용히 빈칸을 만들지 않는다). */
function pick(p) {
  if (p in DERIVED) return DERIVED[p];
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
  // 입력칸 기본값은 '원' 글자 없이 콤마만 넣는다. attachComma 가 붙이는 형식과 같다.
  if (fmt === "comma") return Number(value).toLocaleString("ko-KR");
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

/**
 * ★입력칸의 속성값도 원장에서 찍는다.★
 *
 *   <input data-stamp="max:unemployment.cohortEnd" max="2026-12-31">
 *   <input data-stamp="value:nonTaxable.mealAllowanceMonthlyCap|comma" value="200,000">
 *
 * 왜 필요한가: 화면 '본문' 의 숫자만 원장과 맞추고 입력칸 속성은 손으로 두었다.
 * 그래서 실업급여 페이지의 max="2026-12-31" 처럼 연도가 박힌 값이 감시망 밖에
 * 남았다. 2027-01-01 이 되면 그 달력은 작년까지만 고를 수 있고, 사용자는
 * 이유를 모른 채 계산을 못 한다. 기본값도 마찬가지다 — 식대 비과세 한도가
 * 바뀌면 계산기 기본값만 옛 금액으로 남아 조용히 다른 답을 보여준다.
 *
 * 형식: data-stamp="속성이름:원장경로[|서식]"  (여러 개는 공백으로 구분)
 */
const STAMPED = /<(input|select)\s([^>]*?)data-stamp="([^"]+)"([^>]*)>/g;

/** 태그 문자열에서 attr="..." 를 새 값으로 바꾼다. 없으면 끝에 붙인다. */
function setAttr(tag, attr, value) {
  const re = new RegExp(`(\\s${attr}=")([^"]*)(")`);
  if (re.test(tag)) return tag.replace(re, `$1${value}$3`);
  return tag.replace(/\s*$/, ` ${attr}="${value}"`);
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".html")) out.push(p);
  }
  return out;
}

let changed = 0, spans = 0, attrs = 0, mismatches = [];
for (const file of walk(WEB)) {
  const src = fs.readFileSync(file, "utf8");
  let next = src.replace(SPAN, (m, p, fmt, old) => {
    spans++;
    const want = format(pick(p), fmt || "raw");
    if (old !== want) mismatches.push(`${path.relative(WEB, file)}  ${p}: "${old}" → "${want}"`);
    return `<span data-rate="${p}"${fmt ? ` data-fmt="${fmt}"` : ""}>${want}</span>`;
  });
  next = next.replace(STAMPED, (whole, tag, before, spec, after) => {
    let rebuilt = `<${tag} ${before}data-stamp="${spec}"${after}`;
    for (const one of spec.trim().split(/\s+/)) {
      const [attr, rest] = one.split(":");
      if (!attr || !rest) {
        mismatches.push(`${path.relative(WEB, file)}  data-stamp 형식 오류: "${one}" (속성:경로 이어야 함)`);
        continue;
      }
      const [p, fmt] = rest.split("|");
      const want = String(format(pick(p), fmt || "raw"));
      attrs++;
      const cur = (rebuilt.match(new RegExp(`\\s${attr}="([^"]*)"`)) || [])[1];
      if (cur !== want) {
        mismatches.push(`${path.relative(WEB, file)}  ${attr}=${p}: "${cur}" → "${want}"`);
      }
      rebuilt = setAttr(rebuilt, attr, want);
    }
    return rebuilt.endsWith(">") ? rebuilt : rebuilt + ">";
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

console.log(`원장 ${path.basename(LEDGER.ledgerPath)} · data-rate ${spans}곳 · data-stamp ${attrs}곳 · 파일 ${changed}개 ${CHECK ? "불일치" : "갱신"}`);
if (CHECK && mismatches.length) {
  console.error("\n★ 화면 숫자가 원장과 어긋납니다. `node build/stamp.js` 를 실행하세요.\n");
  for (const m of mismatches) console.error("  " + m);
  process.exit(1);
}
