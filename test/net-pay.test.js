const assert = require("assert");
const path = require("path");
const rates = require(path.join(__dirname, "..", "data", "rates-2026.json"));
const table = require(path.join(
  __dirname,
  "..",
  "data",
  "simplified-tax-table-2026.json"
));
const { calcNetPay } = require(path.join(
  __dirname,
  "..",
  "src",
  "engine",
  "net-pay.js"
));

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

const run = (o) => calcNetPay(o, rates, table);

console.log("\n[실수령액 통합 엔진]\n");

/* ── 1. 표준 케이스 ────────────────────────────────────────────── */

t("월 300만원 / 가족 1명 / 비과세 0 — 전 항목 대조", () => {
  const r = run({ monthlySalary: 3_000_000, dependents: 1, payDate: "2026-08-18" });
  assert.strictEqual(r.gross, 3_000_000);
  assert.strictEqual(r.insuranceBase, 3_000_000);
  assert.strictEqual(r.taxBase, 3_000_000);
  assert.strictEqual(r.insurance.pension, 142_500);
  assert.strictEqual(r.insurance.health, 107_850);
  assert.strictEqual(r.insurance.care, 14_170);
  assert.strictEqual(r.insurance.employment, 27_000);
  assert.strictEqual(r.insurance.total, 291_520);
  assert.strictEqual(r.incomeTax, 74_350); // 정답지: 3,000천원 / 1명
  assert.strictEqual(r.localIncomeTax, 7_430); // 74,350 x 10% = 7,435 → 절사
  assert.strictEqual(r.totalDeduction, 373_300);
  assert.strictEqual(r.netPay, 2_626_700);
});

t("합계는 항상 부분의 합과 일치한다", () => {
  for (const income of [1_000_000, 3_000_000, 7_777_777, 12_000_000]) {
    for (const dep of [1, 3, 12]) {
      const r = run({ monthlySalary: income, dependents: dep, payDate: "2026-08-18" });
      assert.strictEqual(
        r.totalDeduction,
        r.insurance.total + r.incomeTax + r.localIncomeTax,
        `공제합계 ${income}/${dep}`
      );
      assert.strictEqual(
        r.insurance.total,
        r.insurance.pension + r.insurance.health + r.insurance.care + r.insurance.employment
      );
      assert.strictEqual(r.netPay, r.gross - r.totalDeduction, `실수령 ${income}/${dep}`);
    }
  }
});

/* ── 2. ★핵심★ 비과세 처리 — 4대보험과 소득세의 부과기준은 동일하다 ── */

t("비과세는 4대보험 보수월액과 소득세 월급여액에서 '똑같이' 빠진다", () => {
  // 총지급 320만 + 비과세 20만 은, 총지급 300만 + 비과세 0 과
  // 4대보험·소득세가 완전히 같아야 한다. 다르면 부과기준을 잘못 잡은 것이다.
  const a = run({ monthlySalary: 3_000_000, dependents: 1, payDate: "2026-08-18" });
  const b = run({
    monthlySalary: 3_200_000,
    nonTaxable: 200_000,
    dependents: 1,
    payDate: "2026-08-18",
  });
  assert.strictEqual(b.insuranceBase, a.insuranceBase, "4대보험 보수월액");
  assert.strictEqual(b.taxBase, a.taxBase, "소득세 월급여액");
  assert.strictEqual(b.insurance.total, a.insurance.total, "4대보험 합계");
  assert.strictEqual(b.incomeTax, a.incomeTax, "소득세");
  assert.strictEqual(b.localIncomeTax, a.localIncomeTax, "지방소득세");
  assert.strictEqual(b.totalDeduction, a.totalDeduction, "공제 합계");
});

t("비과세분은 총지급액에 그대로 남아 실수령액을 늘린다", () => {
  const a = run({ monthlySalary: 3_000_000, dependents: 1, payDate: "2026-08-18" });
  const b = run({
    monthlySalary: 3_200_000,
    nonTaxable: 200_000,
    dependents: 1,
    payDate: "2026-08-18",
  });
  // 공제는 같고 총지급액만 20만원 크므로 실수령액도 정확히 20만원 크다.
  assert.strictEqual(b.netPay - a.netPay, 200_000);
  assert.strictEqual(b.netPay, b.gross - b.totalDeduction);
});

t("비과세를 소득세에만 반영하는 흔한 오류가 없는지 (보험료가 실제로 줄어든다)", () => {
  const full = run({ monthlySalary: 3_000_000, dependents: 1, payDate: "2026-08-18" });
  const withNT = run({
    monthlySalary: 3_000_000,
    nonTaxable: 200_000,
    dependents: 1,
    payDate: "2026-08-18",
  });
  assert.strictEqual(withNT.insuranceBase, 2_800_000);
  assert.ok(
    withNT.insurance.total < full.insurance.total,
    "비과세가 있으면 4대보험도 반드시 줄어야 한다"
  );
  assert.ok(withNT.incomeTax < full.incomeTax, "소득세도 줄어야 한다");
});

t("국민연금 상·하한 clamp 는 총지급액이 아니라 과세대상급여에 적용된다", () => {
  // 총지급 700만 + 비과세 50만 → 보수월액 650만. 상한 659만 미만이므로 clamp 없음.
  const r = run({
    monthlySalary: 7_000_000,
    nonTaxable: 500_000,
    dependents: 1,
    payDate: "2026-08-18",
  });
  assert.strictEqual(r.insuranceBase, 6_500_000);
  assert.strictEqual(r.detail.insurance.pension.basis.기준소득월액, 6_500_000);
  assert.strictEqual(r.detail.insurance.pension.basis.상한적용, false);
});

/* ── 3. 학자금 (보수적 처리) ───────────────────────────────────── */

t("학자금은 소득세 월급여액에서만 빠지고 4대보험 보수에는 남는다", () => {
  // 별표2 비고 5호에 근거한 보수적 처리. 근거는 코드 주석 참조.
  const r = run({
    monthlySalary: 3_000_000,
    tuition: 200_000,
    dependents: 1,
    payDate: "2026-08-18",
  });
  assert.strictEqual(r.insuranceBase, 3_000_000, "4대보험 보수는 안 줄어든다");
  assert.strictEqual(r.taxBase, 2_800_000, "소득세 월급여액만 줄어든다");
  assert.strictEqual(r.insurance.total, 291_520);
  assert.strictEqual(r.incomeTax, 56_800); // 2,800~2,820천원 / 1명
  assert.ok(
    r.warnings.some((w) => w.includes("학자금")),
    "보수적 처리를 했다는 사실을 경고로 알려야 한다"
  );
});

t("학자금 기본값 0 이면 두 부과기준은 완전히 같다", () => {
  const r = run({
    monthlySalary: 4_000_000,
    nonTaxable: 200_000,
    dependents: 2,
    payDate: "2026-08-18",
  });
  assert.strictEqual(r.insuranceBase, r.taxBase);
  assert.ok(r.basis.some((b) => b.includes("동일")));
});

/* ── 4. 연봉 → 월급 환산 ───────────────────────────────────────── */

t("연봉 6,000만원 ÷ 12 = 월 500만원, 월급 직접 입력과 결과가 같다", () => {
  const a = run({ annualSalary: 60_000_000, dependents: 2, payDate: "2026-08-18", nonTaxable: 200_000 });
  const b = run({ monthlySalary: 5_000_000, dependents: 2, payDate: "2026-08-18", nonTaxable: 200_000 });
  assert.strictEqual(a.gross, 5_000_000);
  assert.strictEqual(a.taxBase, 4_800_000);
  assert.strictEqual(a.insurance.total, 466_430);
  assert.strictEqual(a.incomeTax, 278_810);
  assert.strictEqual(a.localIncomeTax, 27_880);
  assert.strictEqual(a.netPay, 4_226_880);
  assert.deepStrictEqual(
    { g: a.gross, i: a.insurance.total, t: a.incomeTax, n: a.netPay },
    { g: b.gross, i: b.insurance.total, t: b.incomeTax, n: b.netPay }
  );
});

t("퇴직금 포함 연봉(÷13)은 계산은 하되 반드시 경고를 단다", () => {
  const r = run({
    annualSalary: 60_000_000,
    monthsPerYear: 13,
    dependents: 2,
    payDate: "2026-08-18",
  });
  assert.strictEqual(r.gross, 4_615_384, "1원 미만 절사");
  assert.ok(
    r.warnings.some((w) => w.includes("무효")),
    "퇴직금 분할지급 약정 무효 경고(대법원 2007다90760)가 있어야 한다"
  );
});

t("÷12 일 때는 퇴직금 경고가 붙지 않는다", () => {
  const r = run({ annualSalary: 60_000_000, dependents: 1, payDate: "2026-08-18" });
  assert.ok(!r.warnings.some((w) => w.includes("2007다90760")));
});

/* ── 5. 지급일 (국민연금 상·하한 구간) ─────────────────────────── */

t("지급일이 7월 1일을 넘으면 국민연금 상한이 바뀐다", () => {
  const jun = run({ monthlySalary: 8_000_000, dependents: 1, payDate: "2026-06-30" });
  const jul = run({ monthlySalary: 8_000_000, dependents: 1, payDate: "2026-07-01" });
  assert.strictEqual(jun.insurance.pension, 302_570);
  assert.strictEqual(jul.insurance.pension, 313_020);
  // 소득세는 지급일과 무관하므로 같아야 한다.
  assert.strictEqual(jun.incomeTax, jul.incomeTax);
  assert.ok(jul.netPay < jun.netPay);
});

/* ── 6. 원천징수 비율 / 가족수 / 자녀 ──────────────────────────── */

t("80% 선택이 소득세와 지방소득세에 함께 반영된다", () => {
  const hundred = run({ monthlySalary: 12_000_000, dependents: 4, payDate: "2026-08-18" });
  const eighty = run({
    monthlySalary: 12_000_000,
    dependents: 4,
    payDate: "2026-08-18",
    withholdingRatio: 0.8,
  });
  assert.strictEqual(hundred.incomeTax, 1_881_840);
  assert.strictEqual(eighty.incomeTax, 1_505_470); // 1,881,840 x 80% = 1,505,472 → 절사
  assert.strictEqual(eighty.localIncomeTax, 150_540); // 150,547 → 절사
  assert.strictEqual(eighty.insurance.total, hundred.insurance.total, "보험료는 무관");
  assert.ok(eighty.netPay > hundred.netPay);
});

t("가족 11명 초과도 통합 경로에서 동작한다", () => {
  const r = run({ monthlySalary: 12_000_000, dependents: 13, payDate: "2026-08-18" });
  const base = run({ monthlySalary: 12_000_000, dependents: 11, payDate: "2026-08-18" });
  assert.strictEqual(r.incomeTax, base.incomeTax - 60_000);
});

t("자녀 수는 기본 0이라 아무 영향이 없다 (UI 미노출 방침)", () => {
  const a = run({ monthlySalary: 5_000_000, dependents: 4, payDate: "2026-08-18" });
  const b = run({
    monthlySalary: 5_000_000,
    dependents: 4,
    children: 0,
    payDate: "2026-08-18",
  });
  assert.strictEqual(a.incomeTax, b.incomeTax);
  assert.strictEqual(a.detail.incomeTax.detail.자녀공제, undefined);
});

/* ── 7. 경계 / 저소득 ──────────────────────────────────────────── */

t("표 하한 미만 급여 — 소득세·지방소득세 0, 4대보험만 공제", () => {
  const r = run({ monthlySalary: 700_000, dependents: 1, payDate: "2026-08-18" });
  assert.strictEqual(r.incomeTax, 0);
  assert.strictEqual(r.localIncomeTax, 0);
  assert.strictEqual(r.insurance.total, 68_010);
  assert.strictEqual(r.netPay, 631_990);
});

t("★회귀★ 비과세가 총지급액보다 크면 조용히 0으로 누르지 않고 거부한다", () => {
  // 이전 구현은 Math.max(0, gross - nonTaxable) 로 조용히 clamp 했다.
  // 그 결과 비과세 자리에 총급여를 잘못 넣는 흔한 UI 오류가
  // '보험료 19,470원만 공제된 그럴듯한 결과' 로 삼켜졌다.
  assert.throws(
    () =>
      run({
        monthlySalary: 1_000_000,
        nonTaxable: 1_500_000,
        dependents: 1,
        payDate: "2026-08-18",
      }),
    /초과합니다/
  );
  // 학자금도 같다. 비과세+학자금 합계로 판정한다.
  assert.throws(
    () =>
      run({
        monthlySalary: 3_000_000,
        tuition: 9_999_999,
        dependents: 1,
        payDate: "2026-08-18",
      }),
    /초과합니다/
  );
  assert.throws(
    () =>
      run({
        monthlySalary: 3_000_000,
        nonTaxable: 2_000_000,
        tuition: 1_500_000,
        dependents: 1,
        payDate: "2026-08-18",
      }),
    /초과합니다/
  );
});

t("비과세가 총지급액과 '같은' 것은 성립하므로 통과시킨다", () => {
  // 전액 비과세는 이론상 가능하다. 초과만 막고 동일은 막지 않는다.
  const r = run({
    monthlySalary: 1_000_000,
    nonTaxable: 1_000_000,
    dependents: 1,
    payDate: "2026-08-18",
  });
  assert.strictEqual(r.insuranceBase, 0);
  assert.strictEqual(r.taxBase, 0);
  assert.strictEqual(r.incomeTax, 0);
  assert.strictEqual(r.netPay, r.gross - r.totalDeduction);
  // 보수월액 0원인데 국민연금 하한이 부과되는 상황은 반드시 고지해야 한다.
  assert.ok(
    r.warnings.some((w) => w.includes("하한")),
    "보수월액 0원 + 국민연금 하한 적용 경고가 있어야 한다"
  );
});

t("실수령액은 거시적으로는 소득이 늘수록 늘어난다 (성긴 표본 기준)", () => {
  // ★주의★ 이 테스트는 173,000원 간격의 성긴 표본이라 아래 '법정 계단' 두 곳을
  // 우연히 건너뛴다. 전 구간 단조증가를 보장하지 않는다.
  // 실제 역전 지점은 바로 아래 회귀 테스트에 못박아 두었다.
  let prev = -1;
  for (let g = 800_000; g <= 20_000_000; g += 173_000) {
    const r = run({ monthlySalary: g, dependents: 1, payDate: "2026-08-18" });
    assert.ok(r.netPay > prev, `${g}원에서 실수령액 역전: ${prev} → ${r.netPay}`);
    prev = r.netPay;
  }
});

/* ── 7-B. ★회귀★ 법정 계단으로 인한 실수령액 역전 2곳 ────────────
 *
 * 아래 두 지점은 버그가 아니라 별표2 정본에 실재하는 불연속이다.
 * PDF 원문 대조와 독립 재구현 차등 테스트(4,422,090건)로 양쪽 모두 확인되었다.
 * 여기 못박아 두는 이유는 반대다 — 나중에 누가 '월급 올렸는데 실수령이 줄어든다'는
 * 사용자 신고를 보고 이 계단을 '평활화' 하려 들면 즉시 실패하게 만들기 위해서다.
 * 원장을 고쳐서 이 테스트를 통과시키지 말 것. 표는 법령 원문 그대로가 맞다.
 * ★UI 는 이 구간에서 반드시 안내 문구를 노출해야 한다.★
 */

t("★회귀★ 5,840천원 계단 — 실수령액이 역전되며 이것이 정본대로다", () => {
  // 별표2 508행: 5,840~5,860 구간에서 세액이 구간폭(20,000원)보다 크게 뛴다.
  // 가족 1명 +19,910 / 2명 +19,900 / 3명 이상 +28,470. 표 646행 중 최대 계단이다.
  // 월급여 5,840천원 x 12 = 총급여 7,008만원으로 7,000만원 경계에 대응한다. [추론]
  const a1 = run({ monthlySalary: 5_820_000, dependents: 1, payDate: "2026-08-18" });
  const b1 = run({ monthlySalary: 5_840_000, dependents: 1, payDate: "2026-08-18" });
  assert.strictEqual(a1.netPay, 4_758_950);
  assert.strictEqual(b1.netPay, 4_755_110);
  assert.ok(b1.netPay < a1.netPay, "가족 1명: 20,000원 인상에 실수령액이 3,840원 줄어야 한다");
  assert.strictEqual(a1.netPay - b1.netPay, 3_840);

  const a3 = run({ monthlySalary: 5_820_000, dependents: 3, payDate: "2026-08-18" });
  const b3 = run({ monthlySalary: 5_840_000, dependents: 3, payDate: "2026-08-18" });
  assert.strictEqual(a3.netPay, 4_876_470);
  assert.strictEqual(b3.netPay, 4_863_210);
  assert.strictEqual(a3.netPay - b3.netPay, 13_260, "가족 3명은 13,260원 역전");
});

t("★회귀★ 10,000천원 이음매 25,000원 계단 — 1원 인상에 실수령 27,499원 감소", () => {
  // 10,000,000원(exactCapRow) → 10,000,001원(초과구간 산식) 에서
  // 소득세가 정확히 25,000원 점프한다. 법문상 의도된 불연속이며 버그가 아니다.
  const at = run({ monthlySalary: 10_000_000, dependents: 1, payDate: "2026-08-18" });
  const over = run({ monthlySalary: 10_000_001, dependents: 1, payDate: "2026-08-18" });
  assert.strictEqual(at.incomeTax, 1_507_400);
  assert.strictEqual(over.incomeTax, 1_532_400);
  assert.strictEqual(over.incomeTax - at.incomeTax, 25_000, "25,000원 계단을 없애지 말 것");
  assert.strictEqual(at.netPay, 7_532_110);
  assert.strictEqual(over.netPay, 7_504_611);
  assert.ok(over.netPay < at.netPay);
});

/* ── 8. 입력 검증 ─────────────────────────────────────────────── */

t("연봉과 월급을 동시에 주거나 둘 다 안 주면 에러", () => {
  assert.throws(
    () => run({ annualSalary: 1, monthlySalary: 1, dependents: 1, payDate: "2026-08-18" }),
    /정확히 하나만/
  );
  assert.throws(() => run({ dependents: 1, payDate: "2026-08-18" }), /정확히 하나만/);
});

t("지급일이 없으면 에러 (국민연금 구간이 7월에 바뀌므로 생략 불가)", () => {
  assert.throws(
    () => run({ monthlySalary: 3_000_000, dependents: 1 }),
    /payDate/
  );
});

t("음수 비과세·학자금은 거부한다", () => {
  assert.throws(
    () => run({ monthlySalary: 3_000_000, nonTaxable: -1, dependents: 1, payDate: "2026-08-18" }),
    /음수/
  );
});

/* ── 8-B. ★회귀★ 총지급액 타입·범위 검증 ──────────────────────────
 * 이전 구현은 Math.floor 의 강제변환에 기대어 빈 문자열·불리언·배열을
 * 조용히 통과시켰다. Math.floor('') === 0 이라 빈 입력창이 그대로 넘어오면
 * 총지급액 0원 + 국민연금 하한 19,470원 = 실수령액 -19,470원이 나왔다.
 */

t("★회귀★ 숫자가 아닌 총지급액은 강제변환하지 않고 거부한다", () => {
  const bad = ["", "3000000", true, false, [3_000_000], {}, null, NaN, Infinity];
  for (const v of bad) {
    assert.throws(
      () => run({ monthlySalary: v, dependents: 1, payDate: "2026-08-18" }),
      /숫자여야 합니다|정확히 하나만/,
      `총지급액 ${JSON.stringify(v)} 가 통과했다`
    );
  }
});

t("★회귀★ 음수 총지급액은 거부한다", () => {
  assert.throws(
    () => run({ monthlySalary: -1_000_000, dependents: 1, payDate: "2026-08-18" }),
    /음수/
  );
  assert.throws(
    () => run({ annualSalary: -36_000_000, dependents: 1, payDate: "2026-08-18" }),
    /음수/
  );
});

t("★회귀★ 숫자가 아닌 비과세·학자금은 거부하고, 소수는 원 단위로 정규화한다", () => {
  assert.throws(
    () => run({ monthlySalary: 3_200_000, nonTaxable: "200000", dependents: 1, payDate: "2026-08-18" }),
    /숫자여야 합니다/
  );
  // 소수점 비과세액이 그대로 흘러가면 보수월액이 2,999,999.3 이 되어 건강보험료가 10원 틀렸다.
  const r = run({
    monthlySalary: 3_200_000,
    nonTaxable: 200_000.7,
    dependents: 1,
    payDate: "2026-08-18",
  });
  assert.strictEqual(r.insuranceBase, 3_000_000, "보수월액은 정수여야 한다");
  assert.strictEqual(r.insurance.health, 107_850);
  // 반환 객체에도 정규화된 숫자가 담겨야 한다 (UI 가 그대로 산술에 쓴다)
  assert.strictEqual(typeof r.nonTaxable, "number");
  assert.strictEqual(r.nonTaxable, 200_000);
  assert.strictEqual(typeof r.tuition, "number");
});

t("★회귀★ 오버플로를 일으키는 거대 입력은 -Infinity 대신 에러를 낸다", () => {
  // Number.MAX_VALUE 는 유한수라 Number.isFinite 검사를 통과한 뒤
  // 결과가 Infinity 로 오버플로해 실수령액 -Infinity 가 조용히 반환됐다.
  assert.throws(
    () => run({ monthlySalary: Number.MAX_VALUE, dependents: 1, payDate: "2026-08-18" }),
    /범위를 벗어났습니다/
  );
  assert.ok(rates.inputLimits.maxMonthlySalary > 0, "한계값은 원장에서 읽는다");
  // 한계값 이내는 정상 동작하며 결과가 반드시 유한해야 한다.
  const r = run({
    monthlySalary: rates.inputLimits.maxMonthlySalary,
    dependents: 1,
    payDate: "2026-08-18",
  });
  assert.ok(Number.isFinite(r.netPay) && Number.isFinite(r.totalDeduction));
});

t("★회귀★ 총지급액 0원은 계산하되 음수 실수령액을 반드시 경고한다", () => {
  // 무급휴직 등 보수 0원인 달이 실재하므로 throw 하지 않는다.
  // 다만 국민연금 하한 때문에 실수령액이 음수가 되므로 조용히 넘기면 안 된다.
  const r = run({ monthlySalary: 0, dependents: 1, payDate: "2026-08-18" });
  assert.strictEqual(r.gross, 0);
  assert.strictEqual(r.netPay, -19_470);
  assert.ok(r.warnings.some((w) => w.includes("음수")), "음수 실수령액 경고 필요");
  assert.ok(r.warnings.some((w) => w.includes("하한")), "보수월액 0원 경고 필요");
});

/* ── 8-C. ★회귀★ 지급일 형식 검증 ─────────────────────────────────
 * 국민연금 구간 판정이 문자열 사전순 비교라 0 패딩이 빠지면 조용히 틀린다.
 * '2026-1-15' 는 5번째 문자에서 '1' > '0' 이라 '2026-07-01' 보다 크다고 판정되어
 * 1월 급여인데 하반기 상한액(659만)이 적용됐다. 월 900만원 기준 10,450원 오차.
 */

t("★회귀★ 0 패딩 없는 지급일은 조용히 잘못된 구간을 고르지 않고 거부한다", () => {
  assert.throws(
    () => run({ monthlySalary: 9_000_000, dependents: 1, payDate: "2026-1-15" }),
    /형식이 올바르지 않습니다/
  );
  // 올바른 형식은 정상 동작하며, 상반기/하반기 상한이 실제로 달라야 한다.
  const jan = run({ monthlySalary: 9_000_000, dependents: 1, payDate: "2026-01-15" });
  const aug = run({ monthlySalary: 9_000_000, dependents: 1, payDate: "2026-08-15" });
  assert.strictEqual(jan.insurance.pension, 302_570, "상반기 상한 637만");
  assert.strictEqual(aug.insurance.pension, 313_020, "하반기 상한 659만");
});

t("★회귀★ 달력에 없는 날짜와 문자열 아닌 지급일을 거부한다", () => {
  for (const d of ["2026-13-45", "2026-02-31", "2026-06-31", "2026-00-10"]) {
    assert.throws(
      () => run({ monthlySalary: 3_000_000, dependents: 1, payDate: d }),
      /존재하지 않는 날짜|형식이 올바르지 않습니다/,
      `${d} 가 통과했다`
    );
  }
  assert.throws(
    () => run({ monthlySalary: 3_000_000, dependents: 1, payDate: new Date("2026-08-18") }),
    /문자열이어야 합니다/
  );
  assert.throws(
    () => run({ monthlySalary: 3_000_000, dependents: 1, payDate: 20260818 }),
    /문자열이어야 합니다/
  );
});

/* ── 8-D. ★회귀★ 연봉 환산 제수 ──────────────────────────────────── */

t("★회귀★ 12/13 외의 연봉 환산 제수는 거부한다", () => {
  for (const m of [-12, 0, 0.5, 1, 24, "12", null, NaN]) {
    assert.throws(
      () =>
        run({ annualSalary: 36_000_000, monthsPerYear: m, dependents: 1, payDate: "2026-08-18" }),
      /monthsPerYear/,
      `제수 ${JSON.stringify(m)} 가 통과했다`
    );
  }
});

t("★회귀★ 문자열 '12' 때문에 엉뚱한 퇴직금 경고가 뜨지 않는다", () => {
  // 이전 구현은 '12' !== 12 라서 계산은 맞는데 판례 경고만 잘못 붙었다.
  // 지금은 애초에 거부하므로, 정상 입력 12 에 경고가 없는지만 확인한다.
  const r = run({ annualSalary: 36_000_000, monthsPerYear: 12, dependents: 1, payDate: "2026-08-18" });
  assert.strictEqual(r.gross, 3_000_000);
  assert.ok(!r.warnings.some((w) => w.includes("2007다90760")));
});

/* ── 9. 근거(basis)와 고지 ─────────────────────────────────────── */

t("전체 계산 과정이 basis 로 노출된다", () => {
  const r = run({
    monthlySalary: 3_200_000,
    nonTaxable: 200_000,
    dependents: 1,
    payDate: "2026-08-18",
  });
  assert.ok(Array.isArray(r.basis) && r.basis.length >= 8);
  assert.ok(r.basis.some((b) => b.includes("과세대상급여")));
  assert.ok(r.basis.some((b) => b.includes("국민연금")));
  assert.ok(r.basis.some((b) => b.includes("소득세")));
  assert.ok(r.basis.some((b) => b.includes("지방소득세")));
  assert.ok(r.basis.some((b) => b.includes("실수령액")));
  // 상세 근거 객체도 함께 온다
  assert.ok(r.detail.insurance.pension.basis.산식);
  assert.ok(r.detail.incomeTax.detail.조회.적용구간);
  assert.ok(r.detail.localIncomeTax.basis.근거);
});

t("계산기의 구조적 한계가 경고로 함께 나온다", () => {
  const r = run({ monthlySalary: 3_000_000, dependents: 1, payDate: "2026-08-18" });
  assert.ok(r.warnings.some((w) => w.includes("추정치")));
  assert.ok(r.warnings.some((w) => w.includes("연말정산")));
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
