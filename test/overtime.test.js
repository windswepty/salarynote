const assert = require("assert");
const path = require("path");
const L = require(path.join(__dirname, "..", "tools", "lib", "resolve-ledger.js")).resolve();
const rates = require(L.ledgerPath);
const { calcOvertimePay, LEGAL } = require(path.join(__dirname, "..", "src", "engine", "overtime.js"));

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); console.log(`  PASS  ${n}`); pass++; } catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; } };
const run = (o) => calcOvertimePay({ hourlyOrdinaryWage: 15000, employees: 10, ...o }, rates);

console.log("\n[연장·야간·휴일근로수당]\n");

/* ── 제56조 배수 ────────────────────────────────────────────── */
t("연장근로는 통상임금의 1.5배 (제56조①)", () => {
  const r = run({ overtimeHours: 10 });
  assert.strictEqual(r.overtimePay, 10 * 15000 * 1.5);
});

t("야간근로는 0.5배 '가산'이다 (제56조③)", () => {
  // 야간은 그 자체가 별도 근로가 아니라 가산이므로 0.5 만 더한다.
  const r = run({ nightHours: 4 });
  assert.strictEqual(r.nightPay, 4 * 15000 * 0.5);
});

t("연장이 야간에 걸치면 합쳐서 2배가 된다", () => {
  const r = run({ overtimeHours: 4, nightHours: 4 });
  assert.strictEqual(r.overtimePay + r.nightPay, 4 * 15000 * 2, "연장 1.5 + 야간 0.5");
});

t("휴일근로는 8시간 이내 1.5배, 초과 2배 (제56조②)", () => {
  const within = run({ holidayHours: 8 });
  assert.strictEqual(within.holidayPay, 8 * 15000 * 1.5);
  const over = run({ holidayHours: 10 });
  assert.strictEqual(over.holidayPay, 8 * 15000 * 1.5 + 2 * 15000 * 2);
  assert.strictEqual(over.holidayWithin8, 8);
  assert.strictEqual(over.holidayOver8, 2);
});

t("휴일 8시간 경계에서 배수가 바뀐다", () => {
  const a = run({ holidayHours: 8 }), b = run({ holidayHours: 9 });
  assert.strictEqual(b.holidayPay - a.holidayPay, 15000 * 2, "9번째 시간은 2배");
});

/* ── ★5인 미만 사업장★ 이 계산기의 핵심 ───────────────────── */
t("5인 미만은 가산수당이 발생하지 않는다", () => {
  const r = run({ employees: 4, overtimeHours: 10, nightHours: 4, holidayHours: 10 });
  assert.strictEqual(r.premiumApplies, false);
  // 일한 시간만큼의 통상임금은 그대로 받는다(가산분만 없다).
  assert.strictEqual(r.overtimePay, 10 * 15000);
  assert.strictEqual(r.nightPay, 0, "야간은 가산분뿐이라 0");
  assert.strictEqual(r.holidayPay, 10 * 15000);
  assert.ok(r.warnings.some((w) => w.includes("별표1")), "근거를 밝혀야 한다");
});

t("상시 5명이 경계다 (제11조①)", () => {
  assert.strictEqual(run({ employees: 4 }).premiumApplies, false);
  assert.strictEqual(run({ employees: 5 }).premiumApplies, true);
  assert.strictEqual(LEGAL.minEmployeesForPremium, 5);
});

t("5인 경계에서 금액이 실제로 갈린다", () => {
  const w = { overtimeHours: 10, nightHours: 4, holidayHours: 10 };
  const small = run({ ...w, employees: 4 }), big = run({ ...w, employees: 5 });
  assert.strictEqual(small.total, 300000);
  assert.strictEqual(big.total, 495000);
  assert.ok(big.total > small.total);
});

/* ── 통상시급 산정 ──────────────────────────────────────────── */
t("월 통상임금에서 시급을 환산한다", () => {
  const r = calcOvertimePay(
    { monthlyOrdinaryWage: 3_135_000, monthlyHours: 209, employees: 10, overtimeHours: 1 }, rates);
  assert.strictEqual(r.hourlyOrdinaryWage, 15000, "3,135,000 ÷ 209 = 15,000");
  assert.ok(r.basis["통상시급"].includes("209시간"));
});

t("통상시급 직접 입력이 월 통상임금보다 우선한다", () => {
  const r = calcOvertimePay(
    { hourlyOrdinaryWage: 20000, monthlyOrdinaryWage: 3_135_000, employees: 10, overtimeHours: 1 }, rates);
  assert.strictEqual(r.hourlyOrdinaryWage, 20000);
});

t("최저임금 미만 통상시급이면 경고한다", () => {
  const r = run({ hourlyOrdinaryWage: 9000, overtimeHours: 1 });
  assert.ok(r.warnings.some((w) => w.includes("최저임금")));
});

/* ── 입력 방어 ──────────────────────────────────────────────── */
t("잘못된 입력을 조용히 통과시키지 않는다", () => {
  assert.throws(() => calcOvertimePay({ hourlyOrdinaryWage: 15000, overtimeHours: 1 }, rates), /상시 근로자 수/);
  assert.throws(() => calcOvertimePay({ employees: 10, overtimeHours: 1 }, rates), /월 통상임금/);
  assert.throws(() => run({ overtimeHours: -1 }), /이상이어야/);
  assert.throws(() => run({ overtimeHours: "abc" }), /숫자만/);
  assert.throws(() => run({ overtimeHours: 500 }), /범위/);
});

t("근로시간을 안 넣으면 0원이 나온다", () => {
  const r = run({});
  assert.strictEqual(r.total, 0);
});

t("계산 근거에 적용 여부와 산식이 담긴다", () => {
  const r = run({ employees: 4, overtimeHours: 5 });
  assert.ok(r.basis["가산 적용"].includes("미적용"));
  assert.ok(r.basis["연장근로"].includes("×"));
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
