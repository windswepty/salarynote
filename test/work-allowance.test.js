const assert = require("assert");
const path = require("path");
const R = (p) => require(path.join(__dirname, "..", p));
const L = require(path.join(__dirname, "..", "tools", "lib", "resolve-ledger.js")).resolve();
const rates = require(L.ledgerPath);
const { calcWeeklyHolidayPay, calcAnnualLeave, convertWage } = R("src/engine/work-allowance.js");

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); console.log(`  PASS  ${n}`); pass++; } catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; } };

console.log("\n[주휴수당 · 연차 · 환산]\n");

/* ---------- 주휴수당 ---------- */
t("주 40시간 → 8시간분", () => {
  const r = calcWeeklyHolidayPay(40, 10_320, rates);
  assert.strictEqual(r.holidayHours, 8);
  assert.strictEqual(r.amount, 82_560);
});

t("단시간 주 20시간 → 4시간분 (시행령 별표2)", () => {
  // 고용노동부 예시: 주20시간 시급 10,000원 → 4시간 × 10,000 = 40,000원
  const r = calcWeeklyHolidayPay(20, 10_000, rates);
  assert.strictEqual(r.holidayHours, 4);
  assert.strictEqual(r.amount, 40_000);
});

t("주 15시간 미만은 대상이 아니다 (초단시간)", () => {
  const r = calcWeeklyHolidayPay(14, 10_320, rates);
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.amount, 0);
  assert.ok(r.warnings.some((w) => w.includes("초단시간")));
});

t("주 15시간 정확히는 대상이다 (경계)", () => {
  const r = calcWeeklyHolidayPay(15, 10_320, rates);
  assert.strictEqual(r.eligible, true);
  assert.strictEqual(r.holidayHours, 3);
});

t("주 40시간 초과해도 주휴는 8시간이 상한", () => {
  const a = calcWeeklyHolidayPay(40, 10_320, rates);
  const b = calcWeeklyHolidayPay(52, 10_320, rates);
  assert.strictEqual(b.holidayHours, 8);
  assert.strictEqual(b.amount, a.amount);
});

t("최저임금 미만 시급이면 경고한다", () => {
  const r = calcWeeklyHolidayPay(40, 9_000, rates);
  assert.ok(r.warnings.some((w) => w.includes("최저임금")));
});

/* ---------- 연차 ---------- */
t("근속별 연차 일수 (제60조)", () => {
  const table = [[1, 15], [2, 15], [3, 16], [4, 16], [5, 17], [7, 18], [10, 19], [21, 25], [30, 25]];
  for (const [y, expected] of table)
    assert.strictEqual(calcAnnualLeave(y, 0, 100_000).entitledDays, expected, `${y}년`);
});

t("25일 한도를 넘지 않는다", () => {
  assert.strictEqual(calcAnnualLeave(50, 0, 100_000).entitledDays, 25);
});

t("1년 미만은 개근 개월 수만큼, 최대 11일", () => {
  assert.strictEqual(calcAnnualLeave(0.5, 0, 100_000, 6).entitledDays, 6);
  assert.strictEqual(calcAnnualLeave(0.9, 0, 100_000, 12).entitledDays, 11, "12개월은 11일로 클램프");
  // 1년 미만인데 12개월을 넘는 개근은 성립할 수 없는 입력이라 멈춰야 한다
  assert.throws(() => calcAnnualLeave(0.9, 0, 100_000, 20), /범위/);
});

t("미사용 일수가 발생 연차를 넘으면 잘라내고 알려준다", () => {
  const r = calcAnnualLeave(3, 20, 150_000);
  assert.strictEqual(r.unusedDays, 16);
  assert.strictEqual(r.amount, 2_400_000);
  assert.ok(r.warnings.some((w) => w.includes("많아")));
});

t("연차사용촉진 안내가 항상 붙는다", () => {
  assert.ok(calcAnnualLeave(3, 5, 150_000).warnings.some((w) => w.includes("연차사용촉진")));
});

/* ---------- 환산 ---------- */
t("시급 → 월급: 2026년 최저임금 월 환산액과 일치", () => {
  const r = convertWage({ hourly: 10_320 }, rates);
  assert.strictEqual(r.monthlyHours, 209);
  assert.strictEqual(r.monthly, 2_156_880, "고용노동부 고시 월 환산액");
  assert.strictEqual(r.monthly, rates.minimumWage.monthly209h);
});

t("월급 → 시급 역환산이 왕복한다", () => {
  const a = convertWage({ hourly: 12_000 }, rates);
  const b = convertWage({ monthly: a.monthly }, rates);
  assert.strictEqual(b.hourly, 12_000);
});

t("연봉 → 시급 역환산", () => {
  const a = convertWage({ hourly: 15_000 }, rates);
  const b = convertWage({ annual: a.annual }, rates);
  assert.strictEqual(b.hourly, 15_000);
});

t("주 소정근로시간이 줄면 월 시간도 준다", () => {
  const full = convertWage({ hourly: 10_320, weeklyHours: 40 }, rates);
  const part = convertWage({ hourly: 10_320, weeklyHours: 20 }, rates);
  assert.strictEqual(full.monthlyHours, 209);
  assert.strictEqual(part.monthlyHours, 104);
  assert.ok(part.monthly < full.monthly);
});

t("주 15시간 미만은 주휴시간 없이 환산하고 알려준다", () => {
  const r = convertWage({ hourly: 10_320, weeklyHours: 10 }, rates);
  assert.strictEqual(r.holidayHours, 0);
  assert.ok(r.warnings.some((w) => w.includes("주휴시간을 빼고")));
});

t("최저임금 미달이면 최저임금 기준 월급을 함께 알려준다", () => {
  const r = convertWage({ hourly: 9_000 }, rates);
  assert.ok(r.warnings.some((w) => w.includes("최저임금") && w.includes("2,156,880")));
});

t("아무것도 입력하지 않으면 멈춘다", () => {
  assert.throws(() => convertWage({}, rates), /하나를 입력/);
});

t("잘못된 입력을 조용히 통과시키지 않는다", () => {
  assert.throws(() => calcWeeklyHolidayPay(40, -1, rates), /이상이어야/);
  assert.throws(() => calcWeeklyHolidayPay("abc", 10_000, rates), /숫자만/);
  assert.throws(() => convertWage({ hourly: true }, rates), /숫자만/);
  assert.throws(() => convertWage({ weeklyHours: 200, hourly: 1 }, rates), /범위/);
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
