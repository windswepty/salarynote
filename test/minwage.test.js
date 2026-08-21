const assert = require("assert");
const path = require("path");
const L = require(path.join(__dirname, "..", "tools", "lib", "resolve-ledger.js")).resolve();
const rates = require(L.ledgerPath);
const { checkMinimumWage, exclusionRates, LEGAL } =
  require(path.join(__dirname, "..", "src", "engine", "minwage.js"));

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); console.log(`  PASS  ${n}`); pass++; } catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; } };
const run = (o) => checkMinimumWage(o, rates);

console.log("\n[최저임금 위반 확인]\n");

/* ── ★부칙 함정★ 이 계산기의 핵심 ───────────────────────────── */
t("2024년부터 상여금·복리후생비는 전액 산입된다 (부칙 제2조)", () => {
  // 제6조④ 본문은 25%·7% 를 빼도록 적혀 있지만 부칙이 2024년부터 0으로 정했다.
  // 본문만 읽으면 위반 여부 판정이 뒤집힌다.
  assert.deepStrictEqual(exclusionRates(2024), { bonus: 0, welfare: 0 });
  assert.deepStrictEqual(exclusionRates(2026), { bonus: 0, welfare: 0 });
  assert.deepStrictEqual(exclusionRates(2030), { bonus: 0, welfare: 0 });
});

t("경과기간의 연도별 비율이 부칙과 일치한다", () => {
  const table = {
    2019: [0.25, 0.07], 2020: [0.20, 0.05], 2021: [0.15, 0.03],
    2022: [0.10, 0.02], 2023: [0.05, 0.01],
  };
  for (const [y, [b, w]] of Object.entries(table)) {
    const r = exclusionRates(Number(y));
    assert.strictEqual(r.bonus, b, `${y}년 상여금`);
    assert.strictEqual(r.welfare, w, `${y}년 복리후생비`);
  }
});

t("식대가 전액 산입되어 판정이 뒤집힌다", () => {
  const without = run({ monthlyBasePay: 2_000_000 });
  const withMeal = run({ monthlyBasePay: 2_000_000, monthlyWelfare: 200_000 });
  assert.strictEqual(without.violation, true, "기본급만으로는 미달");
  assert.strictEqual(withMeal.violation, false, "식대 전액 산입으로 충족");
  assert.strictEqual(withMeal.welfareExcluded, 0, "2026년은 미산입분 0");
  assert.ok(withMeal.warnings.some((w) => w.includes("전액 산입")));
});

/* ── 산입 제외 ──────────────────────────────────────────────── */
t("연장·야간·휴일수당은 산입되지 않는다 (제6조④1호)", () => {
  const a = run({ monthlyBasePay: 2_000_000 });
  const b = run({ monthlyBasePay: 2_000_000, overtimePay: 500_000 });
  assert.strictEqual(b.includedWage, a.includedWage, "야근수당으로 최저임금을 채울 수 없다");
  assert.strictEqual(b.violation, true);
  assert.ok(b.warnings.some((w) => w.includes("제6조제4항제1호")));
});

/* ── 주휴시간 포함 환산 ─────────────────────────────────────── */
t("주휴시간을 포함한 월 소정근로시간으로 환산한다", () => {
  const r = run({ monthlyBasePay: 2_156_880, weeklyHours: 40 });
  assert.strictEqual(r.monthlyHours, 209);
  assert.strictEqual(r.effectiveHourly, rates.minimumWage.hourly, "최저임금 월 환산액이면 정확히 최저시급");
  assert.strictEqual(r.violation, false);
});

t("최저임금 월 환산액에서 1원만 모자라도 위반이다", () => {
  const r = run({ monthlyBasePay: rates.minimumWage.monthly209h - 1 });
  assert.strictEqual(r.violation, true);
  assert.ok(r.shortfall >= 1);
});

t("단시간 근로자는 월 소정근로시간이 줄어든다", () => {
  const full = run({ monthlyBasePay: 1_000_000, weeklyHours: 40 });
  const part = run({ monthlyBasePay: 1_000_000, weeklyHours: 20 });
  assert.ok(part.monthlyHours < full.monthlyHours);
  assert.ok(part.effectiveHourly > full.effectiveHourly, "같은 급여면 시간이 적을수록 시급이 높다");
});

t("주 15시간 미만은 주휴시간이 없다", () => {
  const r = run({ monthlyBasePay: 500_000, weeklyHours: 10 });
  assert.strictEqual(r.holidayHoursPerWeek, 0);
});

/* ── 수습 감액 (제5조②) ────────────────────────────────────── */
t("1년 이상 계약의 수습은 90%까지 감액할 수 있다", () => {
  const r = run({ monthlyBasePay: 2_000_000, probation: true, contractMonths: 12 });
  assert.strictEqual(r.probationApplied, true);
  assert.strictEqual(r.appliedMinHourly, Math.floor(rates.minimumWage.hourly * 0.9));
  assert.strictEqual(r.violation, false, "감액 기준으로는 충족");
});

t("계약기간 1년 미만이면 수습이어도 감액 불가", () => {
  const r = run({ monthlyBasePay: 2_000_000, probation: true, contractMonths: 6 });
  assert.strictEqual(r.probationApplied, false);
  assert.strictEqual(r.appliedMinHourly, rates.minimumWage.hourly);
  assert.strictEqual(r.violation, true);
  assert.ok(r.warnings.some((w) => w.includes("1년 미만")));
});

t("단순노무업무는 수습이어도 감액 불가", () => {
  const r = run({ monthlyBasePay: 2_000_000, probation: true, contractMonths: 24, simpleLabor: true });
  assert.strictEqual(r.probationApplied, false);
  assert.ok(r.warnings.some((w) => w.includes("단순노무")));
});

/* ── 미달분 안내 ────────────────────────────────────────────── */
t("위반이면 부족액과 청구 근거를 알린다", () => {
  const r = run({ monthlyBasePay: 2_000_000 });
  assert.ok(r.shortfall > 0);
  assert.strictEqual(r.shortfall, r.requiredMonthly - r.includedWage);
  assert.ok(r.warnings.some((w) => w.includes("제6조제3항")));
  assert.ok(r.warnings.some((w) => w.includes("3년")), "시효 안내");
});

t("적법하면 부족액이 0이다", () => {
  assert.strictEqual(run({ monthlyBasePay: 3_000_000 }).shortfall, 0);
});

/* ── 입력 방어 ──────────────────────────────────────────────── */
t("잘못된 입력을 조용히 통과시키지 않는다", () => {
  assert.throws(() => checkMinimumWage({}, rates), /기본급/);
  assert.throws(() => run({ monthlyBasePay: -1 }), /이상이어야/);
  assert.throws(() => run({ monthlyBasePay: "abc" }), /숫자만/);
  assert.throws(() => run({ monthlyBasePay: 2e6, weeklyHours: 200 }), /범위/);
});

t("계산 근거에 산입 내역과 판정이 담긴다", () => {
  const r = run({ monthlyBasePay: 2_000_000, monthlyWelfare: 200_000 });
  assert.ok(r.basis["산입 임금"].includes("전액 산입"));
  assert.ok(r.basis["환산 시급"].includes("÷"));
  assert.ok(r.basis["판정"].includes("위반 아님"));
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
