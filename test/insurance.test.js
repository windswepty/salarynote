const assert = require("assert");
const path = require("path");
const rates = require(path.join(__dirname, "..", "data", "rates-2026.json"));
const {
  calcSocialInsurance,
  calcNationalPension,
} = require(path.join(__dirname, "..", "src", "engine", "insurance.js"));

let pass = 0;
let fail = 0;

function t(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message}`);
    fail++;
  }
}

console.log("\n[4대보험 계산 엔진]\n");

t("월 300만원 / 2026-08 지급 — 표준 케이스", () => {
  const r = calcSocialInsurance(3_000_000, rates, "2026-08-18");
  assert.strictEqual(r.pension.amount, 142_500, "국민연금");
  assert.strictEqual(r.health.amount, 107_850, "건강보험");
  assert.strictEqual(r.care.amount, 14_170, "장기요양");
  assert.strictEqual(r.employment.amount, 27_000, "고용보험");
  assert.strictEqual(r.total, 291_520, "합계");
});

t("월 800만원 / 2026-08 지급 — 국민연금 상한(659만) 적용", () => {
  const r = calcSocialInsurance(8_000_000, rates, "2026-08-18");
  assert.strictEqual(r.pension.amount, 313_020, "국민연금 상한");
  assert.strictEqual(r.pension.basis.상한적용, true);
  assert.strictEqual(r.pension.basis.기준소득월액, 6_590_000);
  assert.strictEqual(r.health.amount, 287_600, "건강보험은 상한 없음");
});

t("월 800만원 / 2026-06-30 지급 — 7월 이전이라 상한 637만 적용", () => {
  const r = calcSocialInsurance(8_000_000, rates, "2026-06-30");
  assert.strictEqual(r.pension.basis.기준소득월액, 6_370_000);
  assert.strictEqual(r.pension.amount, 302_570);
});

t("7월 1일 경계에서 상한이 바뀐다", () => {
  const before = calcNationalPension(8_000_000, rates, "2026-06-30").amount;
  const after = calcNationalPension(8_000_000, rates, "2026-07-01").amount;
  assert.notStrictEqual(before, after, "6/30과 7/1의 국민연금이 같으면 안 됨");
  assert.strictEqual(before, 302_570);
  assert.strictEqual(after, 313_020);
});

t("월 30만원 — 국민연금 하한(41만) 적용", () => {
  const r = calcNationalPension(300_000, rates, "2026-08-18");
  assert.strictEqual(r.basis.하한적용, true);
  assert.strictEqual(r.basis.기준소득월액, 410_000);
  assert.strictEqual(r.amount, 19_470);
});

t("기준소득월액은 1,000원 미만 절사된다", () => {
  const r = calcNationalPension(3_000_999, rates, "2026-08-18");
  assert.strictEqual(r.basis.기준소득월액, 3_000_000);
});

t("부동소수점 오차로 10원이 사라지지 않는다", () => {
  // 3,000,000 x 0.009 = 27,000 이 정확히 나와야 한다
  const r = calcSocialInsurance(3_000_000, rates, "2026-08-18");
  assert.strictEqual(r.employment.amount, 27_000);
  // 여러 금액대에서 절사 결과가 반드시 10의 배수인지
  for (let w = 1_000_000; w <= 9_000_000; w += 137_000) {
    const x = calcSocialInsurance(w, rates, "2026-08-18");
    for (const k of ["pension", "health", "care", "employment"]) {
      assert.strictEqual(x[k].amount % 10, 0, `${k} @ ${w}`);
    }
  }
});

t("요율표에 없는 날짜는 조용히 틀리지 않고 에러를 낸다", () => {
  assert.throws(
    () => calcNationalPension(3_000_000, rates, "2030-01-01"),
    /기준소득월액 구간을 찾을 수 없습니다/
  );
});

t("계산 근거가 화면에 쓸 수 있게 함께 반환된다", () => {
  const r = calcSocialInsurance(3_000_000, rates, "2026-08-18");
  assert.ok(r.pension.basis.산식.includes("4.750%"));
  assert.ok(r.care.basis.산식.includes("13.14%"));
  assert.strictEqual(r.pension.basis.적용기간, "2026-07-01 ~ 2027-06-30");
});

/* ── ★회귀★ 지급일 형식 검증 ──────────────────────────────────────
 *
 * 구간 판정(b.from <= d <= b.to)은 문자열 사전순 비교다.
 * 사전순 비교가 날짜 순서와 일치하는 것은 0 패딩된 고정폭 ISO 형식일 때뿐이므로,
 * 형식 검증 없이는 조용히 잘못된 구간이 선택된다.
 */

t("★회귀★ 0 패딩 없는 지급일은 하반기 구간으로 잘못 빨려가지 않고 거부된다", () => {
  // 이전: '2026-1-15' >= '2026-07-01' 이 true (5번째 문자 '1' > '0')
  //       → 1월 급여인데 하반기 상한 659만이 적용되어 국민연금이 10,450원 틀렸다.
  assert.throws(
    () => calcNationalPension(9_000_000, rates, "2026-1-15"),
    /형식이 올바르지 않습니다/
  );
  assert.throws(
    () => calcNationalPension(9_000_000, rates, "2026-01-5"),
    /형식이 올바르지 않습니다/
  );
  // 올바르게 패딩된 값은 상·하반기가 실제로 갈려야 한다.
  assert.strictEqual(calcNationalPension(9_000_000, rates, "2026-01-15").amount, 302_570);
  assert.strictEqual(calcNationalPension(9_000_000, rates, "2026-08-15").amount, 313_020);
});

t("★회귀★ 달력에 존재하지 않는 날짜를 거부한다", () => {
  for (const d of ["2026-13-45", "2026-02-31", "2026-06-31", "2026-00-10", "2026-11-00"]) {
    assert.throws(
      () => calcNationalPension(3_000_000, rates, d),
      /존재하지 않는 날짜|형식이 올바르지 않습니다/,
      `${d} 가 통과했다`
    );
  }
  // 윤년은 정상 통과해야 한다 (2028년은 윤년, 요율표 범위 밖이라 다른 에러가 난다)
  assert.throws(
    () => calcNationalPension(3_000_000, rates, "2026-02-29"),
    /존재하지 않는 날짜/,
    "2026년은 평년이므로 2/29는 없다"
  );
});

t("★회귀★ 문자열이 아닌 지급일(Date 객체·숫자)을 명확한 메시지로 거부한다", () => {
  // 이전에는 'payDate.slice is not a function' TypeError 가 났다.
  for (const d of [new Date("2026-08-18"), 20260818, null, undefined, {}]) {
    assert.throws(
      () => calcNationalPension(3_000_000, rates, d),
      /문자열이어야 합니다/,
      `${JSON.stringify(d)} 가 통과했다`
    );
  }
});

t("ISO datetime 문자열은 앞 10자리만 잘라 계속 허용한다", () => {
  const r = calcNationalPension(9_000_000, rates, "2026-01-15T09:00:00.000Z");
  assert.strictEqual(r.amount, 302_570);
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
