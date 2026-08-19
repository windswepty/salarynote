const assert = require("assert");
const path = require("path");
const { calcSeverance } = require(path.join(__dirname, "..", "src", "engine", "severance.js"));

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
};

console.log("\n[퇴직금 계산 엔진]\n");

const BASE = {
  hireDate: "2023-03-01", leaveDate: "2026-03-01",
  base3m: 9_000_000, extra3m: 600_000,
  annualBonus: 4_000_000, annualLeaveAllowance: 1_200_000,
};

t("표준 케이스 — 3년 근속", () => {
  const r = calcSeverance(BASE);
  assert.strictEqual(r.serviceDays, 1096, "재직일수(2024 윤년 포함)");
  assert.strictEqual(r.periodDays, 90, "산정기간 12/1~3/1 = 31+31+28");
  assert.strictEqual(r.bonusPortion, 1_000_000, "상여금 3/12");
  assert.strictEqual(r.leavePortion, 300_000, "연차수당 3/12");
  assert.strictEqual(r.totalWage, 10_900_000);
  assert.strictEqual(r.amount, 10_909_954);
  assert.strictEqual(r.eligible, true);
});

t("계속근로 1년 미만이면 지급 대상이 아니다", () => {
  const r = calcSeverance({ ...BASE, hireDate: "2025-06-01", leaveDate: "2026-03-01" });
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.amount, 0);
  assert.ok(r.warnings.some((w) => w.includes("1년(365일) 미만")));
});

t("정확히 365일이면 지급 대상이다 (경계)", () => {
  const r = calcSeverance({ ...BASE, hireDate: "2025-03-01", leaveDate: "2026-03-01" });
  assert.strictEqual(r.serviceDays, 365);
  assert.strictEqual(r.eligible, true);
  assert.ok(r.amount > 0);
});

t("364일이면 대상이 아니다 (경계)", () => {
  const r = calcSeverance({ ...BASE, hireDate: "2025-03-02", leaveDate: "2026-03-01" });
  assert.strictEqual(r.serviceDays, 364);
  assert.strictEqual(r.eligible, false);
});

t("평균임금이 통상임금보다 적으면 통상임금을 쓴다 (근로기준법 제2조 제2항)", () => {
  const low = { ...BASE, base3m: 3_000_000, extra3m: 0, annualBonus: 0, annualLeaveAllowance: 0 };
  const without = calcSeverance(low);
  const withOrd = calcSeverance({ ...low, ordinaryDailyWage: 80_000 });
  assert.strictEqual(without.averageDaily, 33_333);
  assert.strictEqual(withOrd.ordinaryApplied, true);
  assert.strictEqual(withOrd.appliedDaily, 80_000);
  assert.ok(withOrd.amount > without.amount, "하한 적용 시 퇴직금이 늘어야 한다");
  assert.ok(withOrd.warnings.some((w) => w.includes("제2조 제2항")));
});

t("통상임금이 평균임금보다 낮으면 평균임금을 유지한다", () => {
  const r = calcSeverance({ ...BASE, ordinaryDailyWage: 50_000 });
  assert.strictEqual(r.ordinaryApplied, false);
  assert.strictEqual(r.appliedDaily, r.averageDaily);
});

t("통상임금 미입력 시 하한 비교를 건너뛴다고 경고한다", () => {
  const r = calcSeverance(BASE);
  assert.ok(r.warnings.some((w) => w.includes("하한 비교를 건너뛰었습니다")));
});

t("제외기간이 산정기간에서 빠진다", () => {
  const r = calcSeverance({ ...BASE, excludedDays: 30 });
  assert.strictEqual(r.periodDays, 60);
  assert.ok(r.averageDaily > calcSeverance(BASE).averageDaily, "일수가 줄면 일평균은 오른다");
});

t("제외기간이 산정기간보다 길면 멈춘다", () => {
  assert.throws(() => calcSeverance({ ...BASE, excludedDays: 200 }), /제외기간/);
});

t("산정기간 일수는 달마다 다르다 (89~92일)", () => {
  for (const leaveDate of ["2026-01-01", "2026-03-01", "2026-06-01", "2026-09-01", "2026-12-01"]) {
    const r = calcSeverance({ ...BASE, hireDate: "2020-01-01", leaveDate });
    assert.ok(r.periodDays >= 89 && r.periodDays <= 92, `${leaveDate} -> ${r.periodDays}일`);
  }
});

t("잘못된 날짜 형식은 조용히 통과하지 않는다", () => {
  assert.throws(() => calcSeverance({ ...BASE, hireDate: "2023-3-1" }));
  assert.throws(() => calcSeverance({ ...BASE, leaveDate: "2026-02-31" }));
  assert.throws(() => calcSeverance({ ...BASE, leaveDate: "" }));
});

t("퇴사일이 입사일보다 앞서면 멈춘다", () => {
  assert.throws(() => calcSeverance({ ...BASE, hireDate: "2026-05-01", leaveDate: "2026-03-01" }), /퇴사일/);
});

t("금액 입력을 조용히 뭉개지 않는다", () => {
  assert.throws(() => calcSeverance({ ...BASE, base3m: -1 }), /0보다 작을/);
  assert.throws(() => calcSeverance({ ...BASE, base3m: true }), /숫자만/);
  assert.throws(() => calcSeverance({ ...BASE, base3m: "abc" }), /숫자만/);
  assert.throws(() => calcSeverance({ ...BASE, base3m: 1e13 }), /범위/);
  assert.strictEqual(calcSeverance({ ...BASE, extra3m: "" }).totalWage, 10_300_000, "빈값은 0으로");
});

t("계산 근거가 화면에 쓸 수 있게 반환된다", () => {
  const r = calcSeverance({ ...BASE, ordinaryDailyWage: 200_000 });
  assert.ok(r.basis["1일 평균임금"].includes("÷"));
  assert.ok(r.basis["적용 임금"].includes("통상임금"));
  assert.ok(r.basis["퇴직금"].includes("× 30일"));
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
