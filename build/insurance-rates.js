/**
 * 4대보험 요율표 페이지의 숫자를 생성한다.
 *
 *   node build/insurance-rates.js            다시 계산해 써 넣는다
 *   node build/insurance-rates.js --check    원장과 어긋나면 실패한다 (CI 용)
 *
 * 채우는 자리는 셋이다.
 *   <!--RATES-->     요율표 (근로자·사업주·합계)
 *   <!--BOUNDS-->    상·하한표
 *   <!--BYWAGE-->    월급별 보험료표
 *
 * 요율은 화면에 적힌 숫자 중 가장 많이 인용되는 값이다. 원장이 갱신됐는데
 * 이 페이지만 옛 숫자로 남으면, 계산기는 맞고 표는 틀린 상태가 된다.
 * 그래서 손으로 쓰지 않고 원장에서 전부 다시 만든다.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "web");
const PAGE = path.join(WEB, "insurance-rates", "index.html");

const { resolve } = require(path.join(ROOT, "tools", "lib", "resolve-ledger.js"));
const LEDGER = resolve();
const rates = JSON.parse(fs.readFileSync(LEDGER.ledgerPath, "utf8"));
const { calcSocialInsurance } = require(path.join(ROOT, "src", "engine", "insurance.js"));

const CHECK = process.argv.includes("--check");

const won = (n) => Math.round(n).toLocaleString("ko-KR");
/** 0.0475 → "4.75%". 불필요한 0 은 떼되 값은 절대 반올림하지 않는다. */
const pct = (v) => (v * 100).toFixed(6).replace(/0+$/, "").replace(/\.$/, "") + "%";

/* 월급별 표의 구간. 국민연금 하한(41만)과 상한(659만)이 모두 표 안에 들어와야
   상·하한이 실제로 어떻게 작동하는지 눈으로 확인할 수 있다. */
const WAGE_FROM = 1_000_000;
const WAGE_TO = 12_000_000;
const WAGE_STEP = 500_000;

const latestBracket = rates.nationalPension.baseIncomeBrackets
  .reduce((a, b) => (a.from > b.from ? a : b));
const payDate = latestBracket.from;

/* ── 1. 요율표 ─────────────────────────────────────────────── */
function ratesHtml() {
  const np = rates.nationalPension;
  const hi = rates.healthInsurance;
  const ei = rates.employmentInsurance;
  const ltc = rates.longTermCare;

  const row = (name, worker, owner, total, note) =>
    `    <tr><th scope="row">${name}</th>` +
    `<td class="num">${worker}</td><td class="num">${owner}</td>` +
    `<td class="num"><b>${total}</b></td>` +
    (note ? `<td class="note">${note}</td>` : `<td class="note"></td>`) +
    `</tr>`;

  const body = [
    row("국민연금", pct(np.employeeRate), pct(np.totalRate - np.employeeRate), pct(np.totalRate),
      "기준소득월액 기준"),
    row("건강보험", pct(hi.employeeRate), pct(hi.totalRate - hi.employeeRate), pct(hi.totalRate),
      "보수월액 기준"),
    // ★13.14% 를 노사가 절반씩 나눠 6.57% 라고 적으면 틀린다.★
    // 이 요율은 급여가 아니라 '각자가 부담한 건강보험료' 에 곱한다. 근로자는
    // 자기 몫 건강보험료에 13.14% 를 그대로 곱해서 낸다(실측: 125,820 × 13.14%
    // = 16,530원). 나눠 적으면 근로자 부담이 절반으로 보이는 셈이라 위험하다.
    row("장기요양보험", pct(ltc.rateOfHealthPremium), pct(ltc.rateOfHealthPremium),
      pct(ltc.rateOfHealthPremium),
      `각자의 건강보험료에 곱함 (급여 대비 ${pct(ltc.rateOfIncome)})`),
    row("고용보험 (실업급여)", pct(ei.employeeRate), pct(ei.unemploymentTotalRate - ei.employeeRate),
      pct(ei.unemploymentTotalRate), "보수월액 기준"),
  ].join("\n");

  return `<table class="stable rtable">
  <thead><tr><th scope="col">항목</th><th scope="col" class="num">근로자</th><th scope="col" class="num">사업주</th><th scope="col" class="num">합계</th><th scope="col" class="note">기준</th></tr></thead>
  <tbody>
${body}
  </tbody>
</table>`;
}

/* ── 2. 상·하한표 ──────────────────────────────────────────── */
function boundsHtml() {
  const b = rates.healthInsurance.premiumBounds;
  const rows = [
    ["국민연금 기준소득월액", won(latestBracket.min) + "원", won(latestBracket.max) + "원",
      `${latestBracket.from} ~ ${latestBracket.to}`],
    ["건강보험 보험료 (노사 합산)", won(b.totalMin) + "원", won(b.totalMax) + "원",
      "보수월액이 아니라 보험료액 기준"],
  ].map(([k, lo, hi, note]) =>
    `    <tr><th scope="row">${k}</th><td class="num">${lo}</td><td class="num">${hi}</td>` +
    `<td class="note">${note}</td></tr>`).join("\n");

  return `<table class="stable rtable">
  <thead><tr><th scope="col">구분</th><th scope="col" class="num">하한</th><th scope="col" class="num">상한</th><th scope="col" class="note">비고</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>`;
}

/* ── 3. 월급별 보험료표 ────────────────────────────────────── */
function byWageHtml() {
  const out = [];
  for (let w = WAGE_FROM; w <= WAGE_TO; w += WAGE_STEP) {
    // 인자는 위치 기반이다. 객체로 넘기면 payDate 가 undefined 로 떨어진다.
    const r = calcSocialInsurance(w, rates, payDate);
    const capped = r.pension.basis["상한적용"] ? " *" : "";
    out.push(
      `    <tr><th scope="row"><a href="/four-insurance/?v=${w}">${won(w)}</a></th>` +
      `<td class="num">${won(r.pension.amount)}${capped}</td>` +
      `<td class="num">${won(r.health.amount)}</td>` +
      `<td class="num drop">${won(r.care.amount)}</td>` +
      `<td class="num drop">${won(r.employment.amount)}</td>` +
      `<td class="num"><b>${won(r.total)}</b></td></tr>`);
  }
  return `<table class="stable">
  <thead><tr><th scope="col">월 급여</th><th scope="col" class="num">국민연금</th><th scope="col" class="num">건강보험</th><th scope="col" class="num drop">장기요양</th><th scope="col" class="num drop">고용보험</th><th scope="col" class="num">합계</th></tr></thead>
  <tbody>
${out.join("\n")}
  </tbody>
</table>`;
}

/* ── 써 넣기 ───────────────────────────────────────────────── */
const BLOCKS = {
  RATES: ratesHtml(),
  BOUNDS: boundsHtml(),
  BYWAGE: byWageHtml(),
};

if (!fs.existsSync(PAGE)) {
  console.error(`페이지가 없습니다: ${path.relative(ROOT, PAGE)}`);
  process.exit(1);
}

let src = fs.readFileSync(PAGE, "utf8");
let next = src;
for (const [name, html] of Object.entries(BLOCKS)) {
  const open = `<!--${name}-->`, close = `<!--/${name}-->`;
  if (!next.includes(open)) {
    console.error(`${open} 표식이 없습니다.`);
    process.exit(1);
  }
  next = next.replace(
    new RegExp(open + "[\\s\\S]*?" + close.replace("/", "\\/")),
    open + "\n" + html + "\n" + close);
}

if (CHECK) {
  if (next !== src) {
    console.error("4대보험 요율표가 원장과 어긋납니다.");
    console.error("  node build/insurance-rates.js 를 돌려 다시 만드십시오.");
    process.exit(1);
  }
  console.log(`4대보험 요율표 확인: 원장과 일치 (${LEDGER.year}년)`);
} else {
  fs.writeFileSync(PAGE, next, "utf8");
  const n = (WAGE_TO - WAGE_FROM) / WAGE_STEP + 1;
  console.log(`4대보험 요율표 · 월급별 ${n}행 (${won(WAGE_FROM)} ~ ${won(WAGE_TO)})`);
  console.log(`  국민연금 ${pct(rates.nationalPension.totalRate)} · 건강보험 ${pct(rates.healthInsurance.totalRate)}` +
    ` · 장기요양 ${pct(rates.longTermCare.rateOfHealthPremium)} · 고용보험 ${pct(rates.employmentInsurance.unemploymentTotalRate)}`);
  console.log(`  기준소득월액 ${won(latestBracket.min)} ~ ${won(latestBracket.max)} (${latestBracket.from} ~ ${latestBracket.to})`);
}
