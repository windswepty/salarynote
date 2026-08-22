/**
 * 4대보험 요율표 페이지 검증.
 *
 * 이 페이지의 요율은 사이트에서 가장 많이 인용될 숫자다. 틀리면 계산기가
 * 맞아도 소용이 없다.
 *
 * ★화면에 적힌 요율로 직접 곱해 엔진 결과가 나오는지 본다.★
 * 원장과 문자열만 비교하면 '원장 값을 잘못 가공한' 오류를 놓친다. 실제로
 * 장기요양보험을 13.14% 의 절반인 6.57% 로 적었다가 여기서 걸렸다. 근로자는
 * 자기 몫 건강보험료에 13.14% 를 그대로 곱해서 낸다.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "web");
const PAGE = path.join(WEB, "insurance-rates", "index.html");

const { resolve } = require(path.join(ROOT, "tools", "lib", "resolve-ledger.js"));
const L = resolve();
const rates = JSON.parse(fs.readFileSync(L.ledgerPath, "utf8"));
const { calcSocialInsurance } = require(path.join(ROOT, "src", "engine", "insurance.js"));

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); console.log(`  PASS  ${n}`); pass++; } catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; } };

const html = fs.readFileSync(PAGE, "utf8");
const num = (s) => Number(String(s).replace(/,/g, ""));
/** 화면의 "1.8%" 를 100 으로 나누면 0.018000000000000002 이 된다.
 *  요율 비교는 반드시 허용오차로 한다. 엄격 비교하면 멀쩡한 값이 실패한다. */
const sameRate = (a, b) => Math.abs(a - b) < 1e-9;

const payDate = rates.nationalPension.baseIncomeBrackets
  .reduce((a, b) => (a.from > b.from ? a : b)).from;

/** 요율표에서 한 항목의 근로자·사업주·합계를 읽는다. */
function rateRow(name) {
  const re = new RegExp(
    `<th scope="row">${name}[^<]*</th><td class="num">([\\d.]+)%</td>` +
    `<td class="num">([\\d.]+)%</td><td class="num"><b>([\\d.]+)%</b>`);
  const m = html.match(re);
  assert.ok(m, `요율표에서 '${name}' 행을 못 찾았다`);
  return { worker: Number(m[1]) / 100, owner: Number(m[2]) / 100, total: Number(m[3]) / 100 };
}

/** 월급별 표 한 행. 국민연금 뒤의 " *" 는 상한 적용 표시다. */
const ROW = new RegExp(
  '\\?v=(\\d+)">[\\d,]+</a></th>' +
  '<td class="num">([\\d,]+)( \\*)?</td>' +   // 국민연금
  '<td class="num">([\\d,]+)</td>' +          // 건강보험
  '<td class="num drop">([\\d,]+)</td>' +     // 장기요양
  '<td class="num drop">([\\d,]+)</td>' +     // 고용보험
  '<td class="num"><b>([\\d,]+)</b>');        // 합계

function wageRows() {
  const body = html.split("<!--BYWAGE-->")[1].split("<!--/BYWAGE-->")[0];
  const out = [];
  for (const line of body.split("\n")) {
    const m = line.match(ROW);
    if (m) out.push({
      wage: Number(m[1]), pension: num(m[2]), capped: !!m[3],
      health: num(m[4]), care: num(m[5]), employment: num(m[6]), total: num(m[7]),
    });
  }
  return out;
}

const wages = wageRows();
if (wages.length === 0) {
  console.error("  월급별 표를 한 행도 읽지 못했습니다. 파서가 HTML 과 어긋납니다.");
  process.exit(1);
}

console.log("\n[4대보험 요율표]\n");

t("요율이 원장과 일치한다", () => {
  const want = [
    ["국민연금", rates.nationalPension.totalRate],
    ["건강보험", rates.healthInsurance.totalRate],
    ["고용보험", rates.employmentInsurance.unemploymentTotalRate],
    ["장기요양보험", rates.longTermCare.rateOfHealthPremium],
  ];
  for (const [name, v] of want)
    assert.ok(sameRate(rateRow(name).total, v), `${name}: 화면 ${rateRow(name).total} ≠ 원장 ${v}`);
});

t("★화면의 근로자 요율로 곱하면 엔진 금액이 나온다★", () => {
  // 원장 값을 잘못 가공한 오류는 문자열 비교로는 안 걸린다. 실제로 곱해 본다.
  const w = 3_500_000;
  const e = calcSocialInsurance(w, rates, payDate);

  const np = rateRow("국민연금").worker;
  assert.ok(Math.abs(w * np - e.pension.amount) < 10,
    `국민연금: ${w} × ${np} = ${w * np} ≠ ${e.pension.amount}`);

  const hi = rateRow("건강보험").worker;
  assert.ok(Math.abs(w * hi - e.health.amount) < 10,
    `건강보험: ${w} × ${hi} = ${w * hi} ≠ ${e.health.amount}`);

  const ei = rateRow("고용보험").worker;
  assert.ok(Math.abs(w * ei - e.employment.amount) < 10,
    `고용보험: ${w} × ${ei} = ${w * ei} ≠ ${e.employment.amount}`);
});

t("★장기요양은 급여가 아니라 건강보험료에 곱한다★", () => {
  // 13.14% 를 노사가 나눈 6.57% 로 적었다가 걸린 자리다. 근로자는 자기 몫
  // 건강보험료에 13.14% 를 그대로 곱한다.
  const w = 3_500_000;
  const e = calcSocialInsurance(w, rates, payDate);
  const ltc = rateRow("장기요양보험").worker;

  assert.ok(Math.abs(e.health.amount * ltc - e.care.amount) < 10,
    `건강보험료 ${e.health.amount} × ${ltc} = ${e.health.amount * ltc} ≠ ${e.care.amount}`);
  assert.ok(sameRate(ltc, rates.longTermCare.rateOfHealthPremium),
    `근로자 요율을 절반으로 나눠 적었다: 화면 ${ltc} ≠ 원장 ${rates.longTermCare.rateOfHealthPremium}`);
  assert.ok(/건강보험료에 곱함/.test(html), "무엇에 곱하는지 화면에 적혀 있지 않다");
});

t("근로자 + 사업주 = 합계 (장기요양 제외)", () => {
  for (const name of ["국민연금", "건강보험", "고용보험"]) {
    const r = rateRow(name);
    assert.ok(Math.abs(r.worker + r.owner - r.total) < 1e-9,
      `${name}: ${r.worker} + ${r.owner} ≠ ${r.total}`);
  }
});

t("상·하한이 원장과 일치한다", () => {
  const b = rates.healthInsurance.premiumBounds;
  const np = rates.nationalPension.baseIncomeBrackets
    .reduce((a, x) => (a.from > x.from ? a : x));
  for (const v of [np.min, np.max, b.totalMin, b.totalMax])
    assert.ok(html.includes(v.toLocaleString("ko-KR")), `상·하한 ${v} 가 화면에 없다`);
  assert.ok(html.includes("보험료액 기준"), "건강보험 상한이 보수월액 기준으로 오해될 수 있다");
});

t("★월급별 표가 엔진과 한 원도 다르지 않다★", () => {
  const bad = [];
  for (const r of wages) {
    const e = calcSocialInsurance(r.wage, rates, payDate);
    if (e.pension.amount !== r.pension) bad.push(`${r.wage} 연금: ${r.pension} ≠ ${e.pension.amount}`);
    if (e.health.amount !== r.health) bad.push(`${r.wage} 건강: ${r.health} ≠ ${e.health.amount}`);
    if (e.care.amount !== r.care) bad.push(`${r.wage} 요양: ${r.care} ≠ ${e.care.amount}`);
    if (e.employment.amount !== r.employment) bad.push(`${r.wage} 고용: ${r.employment} ≠ ${e.employment.amount}`);
    if (e.total !== r.total) bad.push(`${r.wage} 합계: ${r.total} ≠ ${e.total}`);
  }
  assert.strictEqual(bad.length, 0, bad.slice(0, 5).join("\n        "));
});

t("항목 합이 합계와 맞는다", () => {
  for (const r of wages)
    assert.strictEqual(r.pension + r.health + r.care + r.employment, r.total,
      `월급 ${r.wage}`);
});

t("★상한 구간이 표 안에 있고 표시된다★", () => {
  // 상한이 걸리는 구간을 보여주지 않으면 '고소득일수록 계속 늘어난다' 는
  // 오해가 남는다. 표가 상한 아래에서 끝나면 이 검사가 실패한다.
  const capped = wages.filter((r) => r.capped);
  assert.ok(capped.length > 0, "상한이 적용된 행이 하나도 없다");
  const cap = rates.nationalPension.baseIncomeBrackets
    .reduce((a, x) => (a.from > x.from ? a : x)).max;
  for (const r of capped)
    assert.ok(r.wage > cap, `월급 ${r.wage} 는 상한(${cap}) 이하인데 * 가 붙었다`);
  for (const r of wages.filter((x) => !x.capped))
    assert.ok(r.wage <= cap, `월급 ${r.wage} 는 상한 초과인데 * 가 없다`);
  assert.ok(html.includes("상한이 적용된 구간"), "* 표시의 뜻이 화면에 없다");
});

t("상한 구간에서 국민연금이 더 늘지 않는다", () => {
  const capped = wages.filter((r) => r.capped);
  const first = capped[0].pension;
  for (const r of capped)
    assert.strictEqual(r.pension, first, `월급 ${r.wage} 에서 상한 넘어 증가`);
});

t("빌드 --check 가 원장과의 어긋남을 잡는다", () => {
  execFileSync(process.execPath, [path.join(ROOT, "build", "insurance-rates.js"), "--check"],
    { cwd: ROOT, stdio: "pipe" });
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
