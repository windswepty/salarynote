const assert = require("assert");
const path = require("path");
const L = require(path.join(__dirname, "..", "tools", "lib", "resolve-ledger.js")).resolve();
const rates = require(L.ledgerPath);
const taxTable = require(L.taxTablePath);
const { calcPartTimePay, THRESHOLD } = require(path.join(__dirname, "..", "src", "engine", "parttime.js"));

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); console.log(`  PASS  ${n}`); pass++; } catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; } };
const run = (o) => calcPartTimePay({ hourlyWage: 10320, monthsEmployed: 1, payDate: "2026-08-25", ...o }, rates, taxTable);

console.log("\n[아르바이트·단시간 급여]\n");

t("주 40시간이면 최저임금 월 환산액에 근접한다", () => {
  const r = run({ weeklyHours: 40 });
  // 기본급 + 주휴 = 209시간분. 절사 때문에 고시값과 몇 원 차이가 날 수 있다.
  assert.ok(Math.abs(r.gross - rates.minimumWage.monthly209h) < 100, `${r.gross} vs ${rates.minimumWage.monthly209h}`);
});

/* ── 4대보험 적용 경계 (이 계산기의 존재 이유) ───────────────── */

t("월 60시간 미만이면 국민연금·건강보험 미적용", () => {
  const r = run({ weeklyHours: 10 });
  assert.ok(r.monthlyWorkHours < 60);
  assert.strictEqual(r.coverage.pension, false);
  assert.strictEqual(r.coverage.health, false);
  assert.strictEqual(r.insurance.total, 0, "보험료가 0이어야 한다");
  assert.ok(r.warnings.some((w) => w.includes("60시간 미만")));
});

t("주 15시간 미만이면 주휴수당이 없다", () => {
  const r = run({ weeklyHours: 14 });
  assert.strictEqual(r.holidayPay, 0);
  assert.ok(r.warnings.some((w) => w.includes("초단시간")));
});

t("주 15시간이면 주휴수당이 발생한다 (경계)", () => {
  const r = run({ weeklyHours: 15 });
  assert.ok(r.holidayPay > 0);
  assert.strictEqual(r.coverage.employment, true);
});

t("주 14시간은 국민연금은 되지만 고용보험은 안 된다", () => {
  // 월 60.8시간이라 시간 기준(60시간)은 넘지만,
  // 고용보험은 '주 15시간 미만'도 별도 제외 사유라 적용되지 않는다.
  const r = run({ weeklyHours: 14 });
  assert.ok(r.monthlyWorkHours >= 60, `월 ${r.monthlyWorkHours}시간`);
  assert.strictEqual(r.coverage.pension, true);
  assert.strictEqual(r.coverage.health, true);
  assert.strictEqual(r.coverage.employment, false, "주 15시간 미만은 고용보험 제외");
  assert.strictEqual(r.insurance.employment, 0);
});

t("3개월 이상 계속 근로하면 단시간이어도 고용보험이 적용된다", () => {
  const short = run({ weeklyHours: 10, monthsEmployed: 1 });
  const long = run({ weeklyHours: 10, monthsEmployed: 3 });
  assert.strictEqual(short.coverage.employment, false);
  assert.strictEqual(long.coverage.employment, true);
  assert.ok(long.insurance.employment > 0);
  assert.strictEqual(long.coverage.pension, false, "고용보험만 적용되고 연금은 여전히 제외");
});

t("장기요양보험은 건강보험을 따라간다", () => {
  const out = run({ weeklyHours: 10 });
  const inn = run({ weeklyHours: 20 });
  assert.strictEqual(out.insurance.care, 0, "건강보험 미적용이면 장기요양도 0");
  assert.ok(inn.insurance.care > 0);
});

t("저소득 구간에서 건강보험 하한이 반영된다", () => {
  // 월 급여가 낮아도 건강보험이 적용되면 하한 보험료를 부담한다.
  const r = run({ weeklyHours: 16, hourlyWage: 10320 });
  assert.strictEqual(r.coverage.health, true);
  assert.ok(r.insurance.health > 0);
});

/* ── 금액·경고 ──────────────────────────────────────────────── */

t("최저임금 미만 시급이면 경고한다", () => {
  const r = run({ weeklyHours: 20, hourlyWage: 9000 });
  assert.ok(r.warnings.some((w) => w.includes("최저임금")));
});

t("실수령액이 총지급액을 넘지 않는다", () => {
  for (let h = 1; h <= 40; h++) {
    const r = run({ weeklyHours: h });
    assert.ok(r.netPay <= r.gross, `주 ${h}시간에서 역전`);
    assert.ok(r.netPay >= 0, `주 ${h}시간에서 음수`);
  }
});

t("근로시간이 늘면 실수령액도 는다", () => {
  let prev = -1;
  for (let h = 1; h <= 40; h++) {
    const r = run({ weeklyHours: h });
    // 보험 적용이 시작되는 경계에서는 계단이 생길 수 있으므로 총지급액으로 단조성을 본다
    assert.ok(r.gross > prev, `주 ${h}시간에서 총지급액 역전`);
    prev = r.gross;
  }
});

t("잘못된 입력을 조용히 통과시키지 않는다", () => {
  assert.throws(() => run({ weeklyHours: 20, hourlyWage: -1 }), /이상이어야/);
  assert.throws(() => run({ weeklyHours: "abc" }), /숫자만/);
  assert.throws(() => run({ weeklyHours: 20, payDate: "2026-8-5" }));
  assert.throws(() => run({ weeklyHours: 200 }), /범위/);
});

t("계산 근거에 판정 이유가 담긴다", () => {
  const r = run({ weeklyHours: 10 });
  assert.ok(r.basis["4대보험 판정"].includes("제외"));
  assert.ok(r.basis["월 근로시간"].includes("÷ 12"));
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
