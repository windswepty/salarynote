const assert = require("assert");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const DATA = require(path.join(ROOT, "data", "parental-leave-2026.json"));
const { calcParentalLeave, resolveTier } =
  require(path.join(ROOT, "src", "engine", "parental-leave.js"));

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); console.log(`  PASS  ${n}`); pass++; } catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; } };
const run = (o) => calcParentalLeave({ leaveStartDate: "2026-03-01", months: 12, ...o }, DATA);
const at = (r, m) => r.monthly.find((x) => x.month === m);

console.log("\n[육아휴직 급여]\n");

/* ── 구간별 급여율과 상한 (시행령 제95조제1항) ─────────────── */
t("1~3개월은 통상임금 100%, 상한 250만원", () => {
  const r = run({ monthlyOrdinaryWage: 2_000_000 });
  for (const m of [1, 2, 3]) {
    assert.strictEqual(at(r, m).rate, 1.0, `${m}개월차 급여율`);
    assert.strictEqual(at(r, m).amount, 2_000_000, `${m}개월차 금액`);
  }
  const high = run({ monthlyOrdinaryWage: 5_000_000 });
  assert.strictEqual(at(high, 1).amount, 2_500_000, "상한 250만원");
});

t("4~6개월은 통상임금 100%, 상한 200만원", () => {
  const r = run({ monthlyOrdinaryWage: 3_000_000 });
  for (const m of [4, 5, 6]) {
    assert.strictEqual(at(r, m).rate, 1.0);
    assert.strictEqual(at(r, m).amount, 2_000_000, `${m}개월차 상한`);
  }
});

t("7개월째부터 통상임금 80%, 상한 160만원", () => {
  const r = run({ monthlyOrdinaryWage: 1_500_000 });
  assert.strictEqual(at(r, 7).rate, 0.8);
  assert.strictEqual(at(r, 7).amount, 1_200_000, "150만 × 80%");
  const high = run({ monthlyOrdinaryWage: 3_000_000 });
  assert.strictEqual(at(high, 7).amount, 1_600_000, "80% 적용 후 상한");
});

t("구간 경계에서 금액이 바뀐다 (3/4, 6/7)", () => {
  const r = run({ monthlyOrdinaryWage: 3_000_000 });
  assert.strictEqual(at(r, 3).amount, 2_500_000);
  assert.strictEqual(at(r, 4).amount, 2_000_000, "4개월차부터 상한 200만");
  assert.strictEqual(at(r, 6).amount, 2_000_000);
  assert.strictEqual(at(r, 7).amount, 1_600_000, "7개월차부터 80%·상한 160만");
});

t("구간 조회가 '이상~이하'로 동작한다", () => {
  assert.strictEqual(resolveTier(DATA.tiers, 3).capMonthly, 2_500_000);
  assert.strictEqual(resolveTier(DATA.tiers, 4).capMonthly, 2_000_000);
  assert.strictEqual(resolveTier(DATA.tiers, 6).capMonthly, 2_000_000);
  assert.strictEqual(resolveTier(DATA.tiers, 7).capMonthly, 1_600_000);
  assert.strictEqual(resolveTier(DATA.tiers, 18).capMonthly, 1_600_000, "마지막 구간은 열려 있다");
});

/* ── 하한 (최저임금 비연동) ─────────────────────────────────── */
t("전 구간 하한은 70만원이다", () => {
  const r = run({ monthlyOrdinaryWage: 500_000 });
  for (const m of [1, 5, 10]) assert.strictEqual(at(r, m).amount, 700_000, `${m}개월차`);
  assert.ok(r.warnings.some((w) => w.includes("최저임금과 연동되지 않는")));
});

t("★하한은 최저임금과 무관한 고정값이다★", () => {
  // 구직급여 하한은 최저임금 연동이지만 육아휴직 급여는 아니다. 혼동 방지.
  assert.strictEqual(DATA.floorMonthly, 700_000);
  const rates = require(path.join(ROOT, "data", "rates-2026.json"));
  const minWageBased = rates.minimumWage.hourly * 8 * 0.8;
  assert.notStrictEqual(DATA.floorMonthly, minWageBased, "최저임금 기반 값과 같으면 안 된다");
});

t("하한은 급여율을 곱한 뒤에 적용된다", () => {
  // 통상임금 80만원 → 7개월차 80% = 64만원 → 하한 70만원으로 올라간다
  const r = run({ monthlyOrdinaryWage: 800_000 });
  assert.strictEqual(at(r, 7).raw, 640_000);
  assert.strictEqual(at(r, 7).amount, 700_000);
  assert.strictEqual(at(r, 7).bound, "하한");
});

/* ── 한부모 특례 (시행령 제95조의3제3항) ───────────────────── */
t("한부모는 1~3개월 상한이 300만원이다", () => {
  const sp = run({ monthlyOrdinaryWage: 3_500_000, singleParent: true });
  const gen = run({ monthlyOrdinaryWage: 3_500_000 });
  assert.strictEqual(at(sp, 1).amount, 3_000_000);
  assert.strictEqual(at(gen, 1).amount, 2_500_000);
  assert.ok(sp.total > gen.total);
});

t("한부모도 4개월차부터는 일반 규정과 같다", () => {
  const sp = run({ monthlyOrdinaryWage: 3_500_000, singleParent: true });
  const gen = run({ monthlyOrdinaryWage: 3_500_000 });
  for (const m of [4, 6, 7, 12]) {
    assert.strictEqual(at(sp, m).amount, at(gen, m).amount, `${m}개월차`);
  }
});

/* ── ★적용 범위 제한★ ──────────────────────────────────────── */
t("2025-01-01 이전에 시작한 휴직은 계산을 거부한다", () => {
  // 부칙 제3조·제7조에 따라 한 건 안에서 새 규정과 종전 규정이 섞인다.
  // 종전 규정 값을 확정하지 못했으므로 추정 대신 거부한다.
  for (const d of ["2024-12-31", "2024-06-01", "2020-01-01"]) {
    assert.throws(
      () => calcParentalLeave({ leaveStartDate: d, months: 12, monthlyOrdinaryWage: 3e6 }, DATA),
      /계산하지 않습니다/,
      `${d} 가 거부되지 않았다`
    );
  }
});

t("2025-01-01 당일은 계산된다 (경계)", () => {
  const r = calcParentalLeave(
    { leaveStartDate: "2025-01-01", months: 3, monthlyOrdinaryWage: 3e6 }, DATA);
  assert.strictEqual(r.total, 7_500_000);
});

t("거부 메시지가 이유를 설명한다", () => {
  try {
    calcParentalLeave({ leaveStartDate: "2024-01-01", months: 3, monthlyOrdinaryWage: 3e6 }, DATA);
    assert.fail("거부되지 않았다");
  } catch (e) {
    assert.ok(e.message.includes("2025년 1월 1일"), "기준일을 밝혀야 한다");
    assert.ok(!/undefined|\$/.test(e.message), "내부 변수명이 노출됐다");
  }
});

/* ── 총액·합계 ──────────────────────────────────────────────── */
t("총액이 월별 지급액의 합과 일치한다", () => {
  for (const w of [700_000, 2_000_000, 3_000_000, 9_000_000]) {
    const r = run({ monthlyOrdinaryWage: w });
    assert.strictEqual(r.total, r.monthly.reduce((s, x) => s + x.amount, 0), `통상 ${w}`);
    assert.strictEqual(r.monthly.length, 12);
  }
});

t("통상임금이 오르면 총액이 줄지 않는다 (단조성)", () => {
  let prev = -1;
  for (let w = 500_000; w <= 6_000_000; w += 50_000) {
    const total = run({ monthlyOrdinaryWage: w }).total;
    assert.ok(total >= prev, `통상 ${w} 에서 역전`);
    prev = total;
  }
});

t("개월 수가 늘면 총액도 는다", () => {
  let prev = 0;
  for (let m = 1; m <= 18; m++) {
    const total = run({ monthlyOrdinaryWage: 3_000_000, months: m }).total;
    assert.ok(total > prev, `${m}개월에서 역전`);
    prev = total;
  }
});

t("12개월을 넘기면 추가 사용 요건을 알린다", () => {
  const r = run({ monthlyOrdinaryWage: 3e6, months: 18 });
  assert.ok(r.warnings.some((w) => w.includes("3개월 이상 사용")));
  assert.strictEqual(r.monthly.length, 18);
});

/* ── 안내·법적 리스크 ───────────────────────────────────────── */
t("수급 자격을 단정하지 않는다", () => {
  const r = run({ monthlyOrdinaryWage: 3e6 });
  assert.ok(r.warnings.some((w) => w.includes("고용센터가 판단")));
  assert.ok(!r.warnings.some((w) => /받을 수 있습니다|받게 됩니다/.test(w)));
});

t("사후지급금 폐지를 명시한다", () => {
  // 인터넷에 '25%는 복직 후'라는 옛 정보가 많아 오해를 부른다.
  const r = run({ monthlyOrdinaryWage: 3e6 });
  assert.ok(r.warnings.some((w) => w.includes("사후지급금") && w.includes("폐지")));
});

t("부모 모두 특례는 계산하지 않고 안내만 한다", () => {
  const r = run({ monthlyOrdinaryWage: 3e6 });
  assert.ok(r.warnings.some((w) => w.includes("계산하지 않습니다")));
  assert.strictEqual(DATA.bothParents.$uiDisabled, true);
});

/* ── 입력 방어 ──────────────────────────────────────────────── */
t("잘못된 입력을 조용히 통과시키지 않는다", () => {
  assert.throws(() => calcParentalLeave({ leaveStartDate: "2026-03-01", months: 12 }, DATA), /통상임금/);
  assert.throws(() => run({ monthlyOrdinaryWage: 3e6, months: undefined }), /개월 수/);
  assert.throws(() => run({ monthlyOrdinaryWage: -1 }), /이상이어야/);
  assert.throws(() => run({ monthlyOrdinaryWage: "abc" }), /숫자만/);
  assert.throws(() => run({ monthlyOrdinaryWage: 3e6, months: 2.5 }), /정수/);
  assert.throws(() => run({ monthlyOrdinaryWage: 3e6, months: 99 }), /범위/);
  assert.throws(() => run({ monthlyOrdinaryWage: 3e6, leaveStartDate: "2026-3-1" }));
});

t("계산 근거에 구간별 내역이 담긴다", () => {
  const r = run({ monthlyOrdinaryWage: 3e6 });
  assert.ok(r.basis["구간별 지급액"].includes("1~3개월차"));
  assert.ok(r.basis["총 예상액"].includes("12개월"));
  assert.ok(r.basis["적용 기준"].includes("제95조"));
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
