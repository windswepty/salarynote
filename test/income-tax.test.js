const assert = require("assert");
const path = require("path");
const rates = require(path.join(__dirname, "..", "data", "rates-2026.json"));
const table = require(path.join(
  __dirname,
  "..",
  "data",
  "simplified-tax-table-2026.json"
));
const {
  calcIncomeTax,
  calcLocalIncomeTax,
  calcWithholding,
  lookupTableTax,
} = require(path.join(__dirname, "..", "src", "engine", "income-tax.js"));

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

/** 자주 쓰는 축약 */
const tax = (income, dependents, opt = {}) =>
  calcIncomeTax({ monthlyIncome: income, dependents, ...opt }, table, rates)
    .amount;

console.log("\n[근로소득세 간이세액표 엔진]\n");

/* ── 1. 확보된 정답지 ──────────────────────────────────────────── */

t("정답지 — 월 2,500천원 / 가족 1명 = 35,600원, 2명 = 28,600원", () => {
  assert.strictEqual(tax(2_500_000, 1), 35_600);
  assert.strictEqual(tax(2_500_000, 2), 28_600);
});

t("정답지 — 월 3,000천원 / 가족 1명 = 74,350원, 2명 = 56,850원", () => {
  assert.strictEqual(tax(3_000_000, 1), 74_350);
  assert.strictEqual(tax(3_000_000, 2), 56_850);
});

t("정답지 — 월 4,000천원 / 가족 1명 = 195,960원, 2명 = 167,950원", () => {
  assert.strictEqual(tax(4_000_000, 1), 195_960);
  assert.strictEqual(tax(4_000_000, 2), 167_950);
});

t("정답지 — 월 5,000천원 / 가족 1명 = 335,470원, 2명 = 306,710원", () => {
  assert.strictEqual(tax(5_000_000, 1), 335_470);
  assert.strictEqual(tax(5_000_000, 2), 306_710);
});

t("정답지 — 3,000~3,020천원 행의 가족 1~11명 전체", () => {
  const expected = [
    74_350, 56_850, 31_940, 26_690, 21_440, 17_100, 13_730, 10_350, 6_980,
    3_600, 0,
  ];
  for (let n = 1; n <= 11; n++) {
    assert.strictEqual(tax(3_000_000, n), expected[n - 1], `가족 ${n}명`);
  }
});

/* ── 2. 구간 경계 (이상 ~ 미만) ────────────────────────────────── */

t("구간은 '이상 ~ 미만' — 3,020천원은 다음 행으로 넘어간다", () => {
  const a = calcIncomeTax(
    { monthlyIncome: 3_019_999, dependents: 1 },
    table,
    rates
  );
  const b = calcIncomeTax(
    { monthlyIncome: 3_020_000, dependents: 1 },
    table,
    rates
  );
  assert.strictEqual(a.amount, 74_350, "3,019,999원은 아직 3,000~3,020 행");
  assert.ok(b.amount > a.amount, "3,020,000원은 다음 행이라 세액이 커져야 함");
  assert.ok(a.detail.조회.적용구간.includes("3,000"));
  assert.ok(b.detail.조회.적용구간.includes("3,020"));
});

t("구간 하한 자체는 그 구간에 포함된다", () => {
  // 2,500천원은 2,500~2,510 행의 하한. 정답지 값과 같아야 한다.
  assert.strictEqual(tax(2_500_000, 1), 35_600);
  assert.strictEqual(tax(2_509_999, 1), 35_600);
  assert.notStrictEqual(tax(2_510_000, 1), 35_600);
});

t("표 전체 구간이 빈틈없이 조회된다 (770천원~10,000천원)", () => {
  // 모든 행의 하한/상한-1 을 훑어 예외 없이 조회되는지 확인
  for (const row of table.rows) {
    const lo = row[0] * 1000;
    const hi = row[1] * 1000 - 1;
    assert.strictEqual(tax(lo, 1), row[2], `하한 ${row[0]}천원`);
    assert.strictEqual(tax(hi, 1), row[2], `상한직전 ${row[1]}천원`);
  }
});

/* ── 3. 표 하한 미만 ───────────────────────────────────────────── */

t("표 하한(770천원) 미만이면 세액 0원", () => {
  assert.strictEqual(tax(769_999, 1), 0);
  assert.strictEqual(tax(0, 1), 0);
  assert.strictEqual(tax(500_000, 5), 0);
  const r = calcIncomeTax({ monthlyIncome: 500_000, dependents: 1 }, table, rates);
  assert.strictEqual(r.detail.조회.구분, "표 하한 미만");
});

t("하한 770천원 자체는 표에 있고, 최저 구간의 세액은 0원", () => {
  const r = calcIncomeTax({ monthlyIncome: 770_000, dependents: 1 }, table, rates);
  assert.strictEqual(r.detail.조회.구분, "간이세액표 조회");
  assert.strictEqual(r.amount, 0);
});

/* ── 4. 상한(10,000천원) 정확값과 초과 ─────────────────────────── */

t("월급여가 정확히 10,000천원이면 exactCapRow 를 쓴다", () => {
  const r = calcIncomeTax(
    { monthlyIncome: 10_000_000, dependents: 1 },
    table,
    rates
  );
  assert.strictEqual(r.amount, 1_507_400);
  assert.strictEqual(r.detail.조회.구분, "상한 정확값(별도 행)");
});

t("9,980~10,000천원 행과 10,000천원 정확값은 다른 값이다", () => {
  assert.strictEqual(tax(9_999_999, 1), 1_503_990); // 마지막 표 행
  assert.strictEqual(tax(10_000_000, 1), 1_507_400); // 별도 행
});

t("10,000천원을 1원이라도 넘으면 초과 산식으로 넘어간다 (+25,000원 계단)", () => {
  // 이 계단은 법문상 의도된 불연속이다. 버그가 아니므로 값으로 못박는다.
  // 근거: 2번 구간 상수 1,397,000 = 4,000천원 x 98% x 35% + 25,000 으로
  //       25,000원이 다음 구간에 그대로 이월되어 있다.
  const at = calcIncomeTax({ monthlyIncome: 10_000_000, dependents: 1 }, table, rates);
  const over = calcIncomeTax({ monthlyIncome: 10_000_001, dependents: 1 }, table, rates);
  assert.strictEqual(at.amount, 1_507_400);
  assert.strictEqual(over.amount, 1_532_400);
  assert.strictEqual(over.amount - at.amount, 25_000);
  assert.strictEqual(over.detail.조회.구분, "상한 초과 산식");
});

t("25,000원 계단은 가족수 11개 열 전부에서 동일하다", () => {
  for (let n = 1; n <= 11; n++) {
    const at = tax(10_000_000, n);
    const over = tax(10_000_001, n);
    assert.strictEqual(over - at, 25_000, `가족 ${n}명`);
  }
});

t("초과 구간 6개 산식 — 회귀 기대값 (가족 1명, cap 1,507,400)", () => {
  const expected = [
    [10_500_000, 1_703_900],
    [12_000_000, 2_218_400],
    [14_000_000, 2_904_400], // 구간1 = 구간2 경계
    [20_000_000, 5_138_800],
    [28_000_000, 8_118_000], // 구간2 = 구간3 경계
    [30_000_000, 8_902_000], // 구간3 = 구간4 경계
    [45_000_000, 14_902_000], // 구간4 = 구간5 경계
    [50_000_000, 17_002_000],
    [87_000_000, 32_542_000], // 구간5 = 구간6 경계
    [100_000_000, 38_392_000],
  ];
  for (const [income, want] of expected) {
    assert.strictEqual(tax(income, 1), want, `월급여 ${income}`);
  }
});

t("초과 구간 5개 경계는 완전 연속이다 (11개 가족수 열 전부)", () => {
  // 25,000원 계단은 10,000천원 이음매 단 한 곳뿐이고 그 위로는 이어져야 한다.
  const seams = [14_000_000, 28_000_000, 30_000_000, 45_000_000, 87_000_000];
  for (const seam of seams) {
    for (let n = 1; n <= 11; n++) {
      const before = tax(seam, n); // 경계값은 '이하'라 앞 구간
      const after = tax(seam + 1, n); // 1원 넘으면 뒤 구간
      assert.ok(
        Math.abs(after - before) <= 10,
        `${seam} 경계 가족 ${n}명: ${before} → ${after} (10원 절사 폭을 넘는 점프)`
      );
    }
  }
});

t("98%는 앞 3개 구간에만 적용된다 (한계세율로 확인)", () => {
  // 1,000,000원을 더했을 때의 증가분으로 실효 한계세율을 본다.
  const marginal = (base) => (tax(base + 1_000_000, 1) - tax(base, 1)) / 1_000_000;
  assert.ok(Math.abs(marginal(11_000_000) - 0.98 * 0.35) < 1e-4, "구간1 98%x35%");
  assert.ok(Math.abs(marginal(20_000_000) - 0.98 * 0.38) < 1e-4, "구간2 98%x38%");
  assert.ok(Math.abs(marginal(50_000_000) - 0.42) < 1e-4, "구간5 98% 없음");
  assert.ok(Math.abs(marginal(90_000_000) - 0.45) < 1e-4, "구간6 98% 없음");
});

t("초과 구간에서 가족수는 cap 에만 영향을 준다", () => {
  // 같은 소득이면 가족수별 세액 차이 = cap 차이 그대로여야 한다.
  const caps = table.exactCapRow.values;
  for (let n = 1; n <= 11; n++) {
    const diff = tax(20_000_000, 1) - tax(20_000_000, n);
    assert.strictEqual(diff, caps[0] - caps[n - 1], `가족 ${n}명`);
  }
});

/* ── 5. 가족수 11명 초과 ───────────────────────────────────────── */

t("가족 11명 초과 — 별표2 비고 4호 규칙", () => {
  // 초과 구간에서는 (10명 세액 - 11명 세액) 이 항상 30,000원 상수다.
  const t11 = tax(12_000_000, 11);
  const t12 = tax(12_000_000, 12);
  const t13 = tax(12_000_000, 13);
  assert.strictEqual(tax(12_000_000, 10) - t11, 30_000);
  assert.strictEqual(t12, t11 - 30_000);
  assert.strictEqual(t13, t11 - 60_000);
});

t("가족 11명 초과 — 표 구간에서도 규칙이 적용된다", () => {
  // 3,000~3,020천원 행: 10명 3,600 / 11명 0 → 차감단위 3,600
  const r = calcIncomeTax({ monthlyIncome: 3_000_000, dependents: 12 }, table, rates);
  assert.strictEqual(r.detail.가족수초과.차감단위, 3_600);
  assert.strictEqual(r.detail.가족수초과.초과인원, 1);
  assert.strictEqual(r.amount, 0, "0 - 3,600 = 음수 → 0원 클램프");
});

t("가족수가 많아 음수가 되면 0원으로 클램프된다", () => {
  assert.strictEqual(tax(3_000_000, 30), 0);
  assert.strictEqual(tax(12_000_000, 200), 0);
});

/* ── 6. 80 / 100 / 120% 선택 ───────────────────────────────────── */

t("80% 선택 — 월 4,000천원 / 1명 = 156,760원 (10원 미만 절사)", () => {
  // 195,960 x 80% = 156,768 → 10원 미만 절사 → 156,760
  const r = calcIncomeTax(
    { monthlyIncome: 4_000_000, dependents: 1, withholdingRatio: 0.8 },
    table,
    rates
  );
  assert.strictEqual(r.beforeRounding, 156_768);
  assert.strictEqual(r.amount, 156_760);
});

t("120% 선택 — 월 4,000천원 / 1명 = 235,150원 (10원 미만 절사)", () => {
  // 195,960 x 120% = 235,152 → 235,150
  const r = calcIncomeTax(
    { monthlyIncome: 4_000_000, dependents: 1, withholdingRatio: 1.2 },
    table,
    rates
  );
  assert.strictEqual(r.beforeRounding, 235_152);
  assert.strictEqual(r.amount, 235_150);
});

t("100% 는 표값 그대로 (이미 10원 단위라 절사 무영향)", () => {
  assert.strictEqual(tax(4_000_000, 1, { withholdingRatio: 1.0 }), 195_960);
  assert.strictEqual(tax(4_000_000, 1), 195_960, "미지정 시 기본 100%");
});

t("법정 선택비율(80/100/120%) 외의 값은 조용히 계산되지 않고 에러", () => {
  assert.throws(
    () =>
      calcIncomeTax(
        { monthlyIncome: 4_000_000, dependents: 1, withholdingRatio: 0.9 },
        table,
        rates
      ),
    /원천징수 선택비율/
  );
});

/* ── 7. 자녀 공제 (기본 0, UI 미노출) ──────────────────────────── */

t("자녀 수 기본값은 0이며 아무것도 차감하지 않는다", () => {
  const r = calcIncomeTax({ monthlyIncome: 4_000_000, dependents: 3 }, table, rates);
  assert.strictEqual(r.detail.자녀공제, undefined);
  assert.strictEqual(r.amount, tax(4_000_000, 3));
});

t("자녀 공제 로직 자체는 별표2 비고 3호대로 동작한다 (연령기준 미확정)", () => {
  // 공제액보다 세액이 충분히 큰 구간을 골라 클램프가 끼어들지 않게 한다.
  const income = 8_000_000;
  const base = tax(income, 3);
  const c = rates.childTaxCredit;
  const threePlus = c.threePlusBase + c.threePlusPerExtra * 2; // 자녀 4명
  assert.ok(base > threePlus, "이 케이스는 0원 클램프에 걸리면 안 된다");
  assert.strictEqual(tax(income, 3, { children: 1 }), base - c.one);
  assert.strictEqual(tax(income, 3, { children: 2 }), base - c.two);
  assert.strictEqual(tax(income, 3, { children: 4 }), base - threePlus);
});

t("자녀 공제로 음수가 되면 0원 (비고 3호 단서)", () => {
  // 세액이 작은 구간에서 공제액이 더 크면 0원이어야 한다.
  assert.strictEqual(tax(1_500_000, 2, { children: 3 }), 0);
});

/* ── 8. 지방소득세 ─────────────────────────────────────────────── */

t("지방소득세 = 소득세의 10%, 10원 미만 절사", () => {
  assert.strictEqual(calcLocalIncomeTax(74_350, rates).amount, 7_430);
  assert.strictEqual(calcLocalIncomeTax(195_960, rates).amount, 19_590);
  assert.strictEqual(calcLocalIncomeTax(35_600, rates).amount, 3_560);
  assert.strictEqual(calcLocalIncomeTax(0, rates).amount, 0);
});

t("지방소득세는 반올림이 아니라 절사다", () => {
  // 74,350 x 10% = 7,435 → 반올림이면 7,440, 절사면 7,430
  assert.strictEqual(calcLocalIncomeTax(74_350, rates).amount, 7_430);
});

t("calcWithholding 은 소득세와 지방소득세를 함께 낸다", () => {
  const r = calcWithholding(
    { monthlyIncome: 3_000_000, dependents: 1 },
    table,
    rates
  );
  assert.strictEqual(r.incomeTax.amount, 74_350);
  assert.strictEqual(r.localIncomeTax.amount, 7_430);
  assert.strictEqual(r.total, 81_780);
});

/* ── 9. 단수·정합성 ────────────────────────────────────────────── */

t("모든 결과는 10원의 배수다", () => {
  for (let income = 800_000; income <= 60_000_000; income += 331_000) {
    for (const ratio of [0.8, 1.0, 1.2]) {
      for (const n of [1, 4, 11, 15]) {
        const a = tax(income, n, { withholdingRatio: ratio });
        assert.strictEqual(a % 10, 0, `${income} / ${n}명 / ${ratio}`);
        assert.strictEqual(
          calcLocalIncomeTax(a, rates).amount % 10,
          0,
          `지방소득세 ${income}`
        );
      }
    }
  }
});

t("세액은 소득에 대해 단조증가한다 (10,000천원 계단 포함)", () => {
  let prev = -1;
  for (let income = 700_000; income <= 30_000_000; income += 97_000) {
    const a = tax(income, 2);
    assert.ok(a >= prev, `${income}원에서 세액이 감소: ${prev} → ${a}`);
    prev = a;
  }
});

t("가족수가 늘면 세액은 줄거나 같다", () => {
  for (const income of [2_500_000, 4_000_000, 9_999_000, 10_000_000, 25_000_000]) {
    for (let n = 1; n < 11; n++) {
      assert.ok(tax(income, n) >= tax(income, n + 1), `${income} / ${n}명`);
    }
  }
});

/* ── 10. 입력 검증 ─────────────────────────────────────────────── */

t("잘못된 입력은 조용히 틀리지 않고 에러를 낸다", () => {
  assert.throws(
    () => calcIncomeTax({ monthlyIncome: 3_000_000, dependents: 0 }, table, rates),
    /공제대상가족 수/
  );
  assert.throws(
    () => calcIncomeTax({ monthlyIncome: -1, dependents: 1 }, table, rates),
    /월급여액/
  );
  assert.throws(
    () =>
      calcIncomeTax(
        { monthlyIncome: 3_000_000, dependents: 1, children: -1 },
        table,
        rates
      ),
    /자녀 수/
  );
});

/* ── 11. 근거(basis) 노출 ──────────────────────────────────────── */

t("계산 근거가 화면에 쓸 수 있게 함께 반환된다", () => {
  const r = calcIncomeTax({ monthlyIncome: 3_000_000, dependents: 1 }, table, rates);
  assert.ok(Array.isArray(r.basis) && r.basis.length > 0);
  assert.ok(r.basis[0].includes("3,000"), "적용 행 구간이 문장에 있어야 함");
  assert.strictEqual(r.detail.조회.조회값, 74_350);
  assert.strictEqual(r.detail.선택비율.표기, "100%");
  assert.strictEqual(r.detail.단수처리.단위, 10);

  const o = calcIncomeTax({ monthlyIncome: 20_000_000, dependents: 1 }, table, rates);
  assert.ok(o.detail.조회.원문.includes("1,397,000"), "초과구간은 원문 문언도 노출");
  assert.ok(o.detail.조회.산식.includes("초과액"));

  const l = calcLocalIncomeTax(74_350, rates);
  assert.ok(l.basis.근거.includes("제103조의13"));
});

t("데이터가 기계 판독형으로 보강되어 있다 (하드코딩 금지 원칙 확인)", () => {
  for (const seg of table.overflowFormulas) {
    assert.strictEqual(typeof seg.constant, "number", seg.expr);
    assert.strictEqual(typeof seg.pct, "number", seg.expr);
    assert.strictEqual(typeof seg.hasNinetyEight, "boolean", seg.expr);
  }
  const flags = table.overflowFormulas.map((s) => s.hasNinetyEight);
  assert.deepStrictEqual(
    flags,
    [true, true, true, false, false, false],
    "98%는 앞 3개 구간에만"
  );
  // 경계 상수가 직전 구간 산식으로 역산되는지 (전사 오류 검출)
  const f = table.overflowFormulas;
  for (let i = 1; i < f.length; i++) {
    const prev = f[i - 1];
    const width = (f[i].fromKRW1000 - prev.fromKRW1000) * 1000;
    const carried =
      prev.constant +
      (prev.hasNinetyEight
        ? (width * 98 * prev.pct) / 10000
        : (width * prev.pct) / 100);
    assert.strictEqual(
      f[i].constant,
      carried,
      `구간 ${f[i].fromKRW1000}천원 상수 역산 불일치`
    );
  }
});

/* ── ★회귀★ lookupTableTax 입력 검증 ─────────────────────────────
 *
 * lookupTableTax 는 module.exports 로 공개된 API 다. calcIncomeTax 를 거치지 않고
 * UI 가 '간이세액표 조회값 미리보기' 용도로 직접 호출할 수 있다.
 * 가드가 없을 때 실제로 반환되던 값들을 그대로 못박아 둔다.
 */

t("★회귀★ 가족수 0 이하면 행의 '천원 경계값'을 세액으로 반환하지 않고 거부한다", () => {
  // 이전: lookupTableTax(3000000, 0) === 3020  (행의 '미만' 경계 3,020천원)
  //       lookupTableTax(3000000, -1) === 3000 (행의 '이상' 경계 3,000천원)
  // basis.산식 까지 '간이세액표 [3,000 ~ 3,020천원] x 가족 0명 = 3,020원' 으로
  // 그럴듯하게 나와 화면에서 오류를 알아챌 수 없었다.
  for (const n of [0, -1, -5]) {
    assert.throws(
      () => lookupTableTax(3_000_000, n, table),
      /공제대상가족 수는/,
      `가족수 ${n} 이 통과했다`
    );
  }
});

t("★회귀★ 가족수 11 초과면 undefined/NaN 대신 거부한다", () => {
  // 이전: lookupTableTax(3000000, 12) === undefined
  //       lookupTableTax(12000000, 12) === NaN (cap 이 undefined 라 산식 전체가 NaN)
  for (const income of [3_000_000, 10_000_000, 12_000_000]) {
    assert.throws(
      () => lookupTableTax(income, 12, table),
      /공제대상가족 수는/,
      `${income}원 / 가족 12명이 통과했다`
    );
  }
  // 11명 초과 규칙은 calcIncomeTax 가 처리한다는 안내가 에러 메시지에 있어야 한다.
  assert.throws(() => lookupTableTax(3_000_000, 12, table), /calcIncomeTax/);
  // 경계값 11 은 정상 동작해야 한다.
  assert.strictEqual(lookupTableTax(3_000_000, 11, table).amount, 0);
  assert.strictEqual(lookupTableTax(3_000_000, 1, table).amount, 74_350);
});

t("★회귀★ 정수가 아닌 가족수를 거부한다", () => {
  for (const n of [1.5, null, undefined, NaN, "1", true, [1]]) {
    assert.throws(
      () => lookupTableTax(3_000_000, n, table),
      /공제대상가족 수는/,
      `가족수 ${JSON.stringify(n)} 이 통과했다`
    );
  }
});

t("★회귀★ 월급여액 타입 검증 — null/음수가 0원으로 흡수되지 않는다", () => {
  // 이전: null < 770000 이 true 라 '표 하한 미만' 분기로 빨려 들어가 0원을 반환했고,
  //       NaN 은 원인과 무관한 '10,000천원 초과 구간' 에러 메시지를 냈다.
  for (const v of [null, undefined, -1, NaN, Infinity, -Infinity, "3000000", true, {}]) {
    assert.throws(
      () => lookupTableTax(v, 1, table),
      /월급여액이 올바르지 않습니다/,
      `월급여액 ${JSON.stringify(v)} 가 통과했다`
    );
  }
  // 0원은 유효한 입력이며 표 하한 미만이라 0원이다.
  assert.strictEqual(lookupTableTax(0, 1, table).amount, 0);
});

t("★회귀★ 소수점 월급여액이 부동소수점 잡음을 세액에 남기지 않는다", () => {
  // 이전: lookupTableTax(10000000.0000001, 1) === 1532400.0000000345
  // 1원도 안 되는 잡음이 '초과구간' 으로 귀속을 밀어내고 세액에 소수 꼬리를 남겼다.
  // 원 단위 미만을 절사하므로 10,000,000원(exactCapRow)으로 귀속되어야 한다.
  const r = lookupTableTax(10_000_000.0000001, 1, table);
  assert.strictEqual(r.amount, 1_507_400);

  // ★불변식★ 소수 입력의 결과는 절사한 정수 입력의 결과와 항상 같아야 한다.
  //   (초과구간 세액 자체는 excess x 0.343 처럼 법문상 비정수일 수 있다.
  //    그건 정상이며, 10원 절사는 calcIncomeTax 가 마지막에 한 번만 한다.)
  for (const income of [12_345_678.9, 30_000_000.5, 87_000_000.25, 4_166_666.666]) {
    for (const n of [1, 5, 11]) {
      assert.strictEqual(
        lookupTableTax(income, n, table).amount,
        lookupTableTax(Math.floor(income), n, table).amount,
        `${income} / 가족 ${n}명: 소수 입력이 절사 입력과 다른 결과를 냈다`
      );
    }
  }

  // 절사가 구간 귀속을 바꾸지 않는지 확인 (표 구간 내부)
  assert.strictEqual(lookupTableTax(2_999_999.99, 1, table).amount, 73_060);
  assert.strictEqual(lookupTableTax(3_000_000.01, 1, table).amount, 74_350);
  assert.strictEqual(lookupTableTax(9_999_999.99, 1, table).amount, 1_503_990);

  // 최종 세액(calcIncomeTax)은 소수 입력에서도 항상 10원 단위 정수여야 한다.
  for (const income of [12_345_678.9, 4_166_666.666, 8_333_333.333]) {
    const x = calcIncomeTax({ monthlyIncome: income, dependents: 2 }, table, rates);
    assert.ok(Number.isInteger(x.amount) && x.amount % 10 === 0, `${income} → ${x.amount}`);
  }
});

t("★회귀★ 오버플로 입력은 Infinity 세액 대신 에러를 낸다", () => {
  assert.throws(
    () =>
      calcIncomeTax(
        { monthlyIncome: Number.MAX_VALUE, dependents: 1 },
        table,
        rates
      ),
    /범위를 벗어났습니다/
  );
  // 한계값 이내는 정상 동작하고 결과가 유한해야 한다.
  const r = calcIncomeTax(
    { monthlyIncome: rates.inputLimits.maxMonthlySalary, dependents: 1 },
    table,
    rates
  );
  assert.ok(Number.isFinite(r.amount) && r.amount > 0);
});

t("가족 11명 초과 음수 클램프 — 원문에 단서가 없는 [추론]이나 동작은 유지한다", () => {
  // 별표2 비고 4호에는 비고 3호와 달리 '음수면 0원' 단서가 없다.
  // 원문을 축자 해석하면 -7,200원이 나오지만 원천징수세액은 음수일 수 없다.
  // 이 클램프를 제거하면 안 된다는 것을 못박는다.
  const r = calcIncomeTax({ monthlyIncome: 3_000_000, dependents: 13 }, table, rates);
  assert.strictEqual(r.amount, 0, "축자 해석이면 -7,200원이지만 0으로 클램프한다");
  assert.ok(r.basis.some((b) => b.includes("음수")));
  // 클램프가 구속되지 않는 구간에서는 정상적으로 차감된다.
  const big = calcIncomeTax({ monthlyIncome: 12_000_000, dependents: 13 }, table, rates);
  const base = calcIncomeTax({ monthlyIncome: 12_000_000, dependents: 11 }, table, rates);
  assert.strictEqual(big.amount, base.amount - 60_000);
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
