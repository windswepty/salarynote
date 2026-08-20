/**
 * 실업급여(구직급여) 계산 엔진 테스트.
 *
 * 정답지는 두 종류다.
 *  1) 고용24 공식 모의계산기 실측 (data/sources/unemployment-official-oracle-2026.json)
 *  2) 법제처 원문 별표1 (10칸 전부를 여기서 표로 못박는다)
 *
 * 별표1을 코드가 아니라 테스트에도 표로 박아 두는 이유: 원장 JSON 을 누가 잘못 고쳐도
 * 여기서 걸린다. 별표1은 2019.8.27 개정 이후 2028.1.1까지 변경 예정이 없으므로
 * 이 표가 바뀌었다면 그건 사고다.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { calcUnemploymentBenefit, benefitDaysTable, resolveCohort } =
  require(path.join(ROOT, "src", "engine", "unemployment.js"));

const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "unemployment-2026.json"), "utf8"));
const ORACLE = JSON.parse(fs.readFileSync(
  path.join(ROOT, "data", "sources", "unemployment-official-oracle-2026.json"), "utf8"));
const L = require(path.join(ROOT, "tools", "lib", "resolve-ledger.js")).resolve();
const RATES = JSON.parse(fs.readFileSync(L.ledgerPath, "utf8"));
const HISTORY = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "rates-history.json"), "utf8"));

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
};

console.log("\n[실업급여(구직급여) 계산 엔진]\n");

/** 공식 계산기 입력을 엔진 입력으로 옮긴다. ave_sal 은 이미 평균임금일액이다. */
const fromOracle = (i, leaveDate = "2026-03-02") => ({
  leaveDate,
  averageDailyWage: i.ave_sal,
  age: i.old,
  insuredMonths: i.prd,
  dailyWorkHours: i.appontWorkHr === undefined ? 8 : i.appontWorkHr,
  disabled: i.dspsnAt === "Y",
});

const run = (input) => calcUnemploymentBenefit(input, DATA);

// ── 1. 공식 정답지 ─────────────────────────────────────────────
t(`공식 모의계산기 요청 5케이스가 전부 일치한다`, () => {
  for (const c of ORACLE.requestedCases) {
    const r = run(fromOracle(c.input));
    assert.strictEqual(r.days, c.expected.days, `${c.label} 소정급여일수`);
    assert.strictEqual(r.dailyAmount, c.expected.dailyAmount, `${c.label} 구직급여일액`);
    assert.strictEqual(r.totalAmount, c.expected.total, `${c.label} 총액`);
    assert.strictEqual(r.bound, c.expected.bound, `${c.label} 구속`);
  }
  console.log(`        (${ORACLE.requestedCases.length}건 대조)`);
});

t(`공식 모의계산기 경계 프로브 ${ORACLE.boundaryProbes.length}건이 전부 일치한다`, () => {
  for (const c of ORACLE.boundaryProbes) {
    const r = run(fromOracle(c.input));
    assert.strictEqual(r.days, c.expected.days, `${c.label} 일수`);
    assert.strictEqual(r.dailyAmount, c.expected.dailyAmount, `${c.label} 일액`);
    assert.strictEqual(r.totalAmount, c.expected.total, `${c.label} 총액`);
  }
});

t("공식 계산기와 같은 소수 유지 규칙을 쓴다 (원 단위 절사/반올림을 하지 않는다)", () => {
  const r = run(fromOracle({ old: 30, prd: 12, appontWorkHr: 8, ave_sal: 110081 }));
  assert.strictEqual(r.dailyAmount, 66048.6);
  assert.strictEqual(r.dailyAmountIsFractional, true);
  assert.strictEqual(r.totalAmount, 9_907_290);
  assert.ok(r.warnings.some((w) => w.includes("단수처리")), "단수처리 미확정 경고가 있어야 한다");
});

// ── 2. 별표1 전 칸 못박기 ──────────────────────────────────────
const BYLPYO1 = {
  // [연령구간][피보험기간구간] — 고용보험법 별표1 (개정 2019.8.27), 원문 그대로
  under50:   { lt1y: 120, y1to3: 150, y3to5: 180, y5to10: 210, y10plus: 240 },
  age50plus: { lt1y: 120, y1to3: 180, y3to5: 210, y5to10: 240, y10plus: 270 },
};
const MONTHS_IN = { lt1y: 6, y1to3: 24, y3to5: 48, y5to10: 90, y10plus: 200 };

t("별표1 10칸이 원장에 정확히 들어 있다", () => {
  assert.deepStrictEqual(DATA.durationTable.days, BYLPYO1);
});

t("별표1 10칸이 엔진 조회로도 전부 재현된다", () => {
  let checked = 0;
  for (const [ageId, row] of Object.entries(BYLPYO1)) {
    const age = ageId === "under50" ? 35 : 55;
    for (const [periodId, expected] of Object.entries(row)) {
      const r = run({ leaveDate: "2026-03-02", monthlyWage: 3_000_000, age, insuredMonths: MONTHS_IN[periodId] });
      assert.strictEqual(r.ageBracket, ageId);
      assert.strictEqual(r.periodBracket, periodId);
      assert.strictEqual(r.days, expected, `${ageId}/${periodId}`);
      checked++;
    }
  }
  assert.strictEqual(checked, 10, "10칸 전부를 확인해야 한다");
});

t("별표1을 화면용 표로 그대로 꺼낼 수 있다", () => {
  const tb = benefitDaysTable(DATA);
  assert.strictEqual(tb.columns.length, 5);
  assert.strictEqual(tb.rows.length, 2);
  assert.deepStrictEqual(tb.rows[0].days, [120, 150, 180, 210, 240]);
  assert.deepStrictEqual(tb.rows[1].days, [120, 180, 210, 240, 270]);
  assert.ok(tb.remark.includes("장애인"));
  assert.ok(tb.basis.includes("별표 1"));
});

// ── 3. 경계 ────────────────────────────────────────────────────
t("연령 경계 — 만 49세는 '50세 미만', 만 50세는 '50세 이상' (경계값은 위쪽 구간)", () => {
  const base = { leaveDate: "2026-03-02", monthlyWage: 3_000_000, insuredMonths: 36 };
  assert.strictEqual(run({ ...base, age: 48 }).days, 180);
  assert.strictEqual(run({ ...base, age: 49 }).days, 180);
  assert.strictEqual(run({ ...base, age: 50 }).days, 210, "만 50세는 '50세 이상' 행이다");
  assert.strictEqual(run({ ...base, age: 51 }).days, 210);
  assert.strictEqual(run({ ...base, age: 49 }).ageBracket, "under50");
  assert.strictEqual(run({ ...base, age: 50 }).ageBracket, "age50plus");
});

t("피보험기간 경계 1년 — 11개월은 120일, 12개월은 150일", () => {
  const base = { leaveDate: "2026-03-02", monthlyWage: 3_000_000, age: 30 };
  assert.strictEqual(run({ ...base, insuredMonths: 11 }).days, 120);
  assert.strictEqual(run({ ...base, insuredMonths: 12 }).days, 150);
});

t("피보험기간 경계 3년 — 35개월은 150일, 36개월은 180일", () => {
  const base = { leaveDate: "2026-03-02", monthlyWage: 3_000_000, age: 30 };
  assert.strictEqual(run({ ...base, insuredMonths: 35 }).days, 150);
  assert.strictEqual(run({ ...base, insuredMonths: 36 }).days, 180);
});

t("피보험기간 경계 5년 — 59개월은 180일, 60개월은 210일", () => {
  const base = { leaveDate: "2026-03-02", monthlyWage: 3_000_000, age: 30 };
  assert.strictEqual(run({ ...base, insuredMonths: 59 }).days, 180);
  assert.strictEqual(run({ ...base, insuredMonths: 60 }).days, 210);
});

t("피보험기간 경계 10년 — 119개월은 210일, 120개월은 240일", () => {
  const base = { leaveDate: "2026-03-02", monthlyWage: 3_000_000, age: 30 };
  assert.strictEqual(run({ ...base, insuredMonths: 119 }).days, 210);
  assert.strictEqual(run({ ...base, insuredMonths: 120 }).days, 240);
});

t("50세 이상도 같은 경계에서 갈린다", () => {
  const base = { leaveDate: "2026-03-02", monthlyWage: 3_000_000, age: 55 };
  assert.strictEqual(run({ ...base, insuredMonths: 11 }).days, 120);
  assert.strictEqual(run({ ...base, insuredMonths: 12 }).days, 180);
  assert.strictEqual(run({ ...base, insuredMonths: 119 }).days, 240);
  assert.strictEqual(run({ ...base, insuredMonths: 120 }).days, 270);
});

t("장애인은 실제 나이와 무관하게 50세 이상 행을 쓴다 (별표1 비고)", () => {
  const base = { leaveDate: "2026-03-02", monthlyWage: 3_000_000, age: 30 };
  assert.strictEqual(run({ ...base, insuredMonths: 36 }).days, 180);
  assert.strictEqual(run({ ...base, insuredMonths: 36, disabled: true }).days, 210);
  assert.strictEqual(run({ ...base, insuredMonths: 120, disabled: true }).days, 270);
  assert.strictEqual(run({ ...base, insuredMonths: 36, disabled: true }).ageBracket, "age50plus");
  assert.ok(run({ ...base, insuredMonths: 36, disabled: true }).ageBracketLabel.includes("장애인"));
});

// ── 4. 상한 / 하한 ─────────────────────────────────────────────
t("하한 구속 — 저임금이면 최저구직급여일액이 적용된다 (제46조제2항)", () => {
  const r = run({ leaveDate: "2026-03-02", monthlyWage: 2_000_000, age: 30, insuredMonths: 12 });
  assert.strictEqual(r.rawBaseDaily, 66_666, "floor(2,000,000/30)");
  assert.strictEqual(r.minBaseDaily, 82_560, "10,320 × 8");
  assert.strictEqual(r.dailyAmount, 66_048, "82,560 × 80%");
  assert.strictEqual(r.bound, "하한");
  assert.strictEqual(r.floorBinding, true);
  assert.strictEqual(r.totalAmount, 9_907_200);
});

t("상한 구속 — 고임금이면 기초일액 상한이 적용된다 (제45조제5항)", () => {
  const r = run({ leaveDate: "2026-03-02", monthlyWage: 5_000_000, age: 40, insuredMonths: 60 });
  assert.strictEqual(r.rawBaseDaily, 166_666);
  assert.strictEqual(r.baseDaily, 113_500, "시행령 제68조제1항 상한");
  assert.strictEqual(r.dailyAmount, 68_100, "113,500 × 60%");
  assert.strictEqual(r.bound, "상한");
  assert.strictEqual(r.capBinding, true);
  assert.strictEqual(r.days, 210);
  assert.strictEqual(r.totalAmount, 14_301_000);
});

t("상·하한 사이 구간은 구속되지 않는다", () => {
  const r = run({ leaveDate: "2026-03-02", averageDailyWage: 112_000, age: 30, insuredMonths: 12 });
  assert.strictEqual(r.bound, "없음");
  assert.strictEqual(r.dailyAmount, 67_200);
  assert.strictEqual(r.floorBinding, false);
  assert.strictEqual(r.capBinding, false);
});

t("★하한은 66,048원 고정이 아니다★ — 1일 소정근로시간에 비례한다 (제45조제4항)", () => {
  // 하한이 실제로 구속되도록 충분히 낮은 임금을 넣는다(각 시간대의 하한 = 8,256 × 시간).
  const base = { leaveDate: "2026-03-02", averageDailyWage: 5_000, age: 30, insuredMonths: 12 };
  assert.strictEqual(run({ ...base, dailyWorkHours: 8 }).dailyAmount, 66_048);
  assert.strictEqual(run({ ...base, dailyWorkHours: 4 }).dailyAmount, 33_024);
  assert.strictEqual(run({ ...base, dailyWorkHours: 2 }).dailyAmount, 16_512);
  assert.strictEqual(run({ ...base, dailyWorkHours: 1 }).dailyAmount, 8_256);
  for (const h of [1, 2, 4, 8]) assert.strictEqual(run({ ...base, dailyWorkHours: h }).bound, "하한");
  // 공식 계산기 실측과 같은 4시간 케이스(하한 구속)
  assert.strictEqual(run({ ...base, averageDailyWage: 50_000, dailyWorkHours: 4 }).dailyAmount, 33_024);
  // 시간이 짧아도 임금이 하한 위면 구속되지 않는다 — 하한은 '시간에 비례'하지 '무조건'이 아니다.
  assert.strictEqual(run({ ...base, averageDailyWage: 50_000, dailyWorkHours: 1 }).dailyAmount, 30_000);
  assert.ok(run({ ...base, dailyWorkHours: 4 }).warnings.some((w) => w.includes("소정근로시간에 비례")));
});

t("상한은 소정근로시간과 무관하게 고정이다", () => {
  const base = { leaveDate: "2026-03-02", averageDailyWage: 999_999, age: 30, insuredMonths: 12 };
  for (const h of [1, 2, 4, 8]) assert.strictEqual(run({ ...base, dailyWorkHours: h }).dailyAmount, 68_100, `${h}시간`);
});

t("2026년에는 상·하한 역전이 없다 (여유 2,052원)", () => {
  const r = run({ leaveDate: "2026-03-02", monthlyWage: 3_000_000, age: 30, insuredMonths: 12 });
  assert.strictEqual(r.inverted, false);
  assert.strictEqual(r.maxDaily, 68_100);
  assert.strictEqual(r.minDaily, 66_048);
  assert.strictEqual(r.maxDaily - r.minDaily, 2_052);
  assert.ok(r.basis["상·하한 역전 여부"].includes("역전 없음"));
});

// ── 5. ★역전★ ─────────────────────────────────────────────────
/** 최저임금이 올라 하한이 상한을 넘어선 가상 원장. 2027년 이후 실제로 발생할 수 있다. */
function invertedLedger() {
  const d = JSON.parse(JSON.stringify(DATA));
  d.cohorts[0].minWageHourly = 15_000; // 하한(8h) = 15,000 × 8 × 0.8 = 96,000 > 상한 68,100
  return d;
}

t("★역전 시 하한이 이긴다★ — 저임금 케이스 (제46조제2항에 상한 단서가 없다)", () => {
  const d = invertedLedger();
  const r = calcUnemploymentBenefit(
    { leaveDate: "2026-03-02", averageDailyWage: 50_000, age: 30, insuredMonths: 12 }, d);
  assert.strictEqual(r.inverted, true);
  assert.strictEqual(r.minDaily, 96_000);
  assert.strictEqual(r.maxDaily, 68_100);
  assert.strictEqual(r.dailyAmount, 96_000, "하한이 상한을 넘어서도 하한을 적용해야 한다");
  assert.strictEqual(r.bound, "하한");
});

t("★역전★ — 상한에 걸린 고임금자도 하한으로 끌어올려진다", () => {
  const d = invertedLedger();
  const r = calcUnemploymentBenefit(
    { leaveDate: "2026-03-02", averageDailyWage: 999_999, age: 30, insuredMonths: 12 }, d);
  assert.strictEqual(r.inverted, true);
  assert.strictEqual(r.baseDaily, 113_500, "기초일액 단계에서는 상한이 걸린다");
  assert.strictEqual(r.dailyAmount, 96_000, "제46조제2항이 최종 단계에서 하한으로 덮어쓴다");
  assert.strictEqual(r.totalAmount, 96_000 * 150);
});

t("★역전★ 사실이 basis 와 경고에 드러난다", () => {
  const d = invertedLedger();
  const r = calcUnemploymentBenefit(
    { leaveDate: "2026-03-02", averageDailyWage: 100_000, age: 30, insuredMonths: 12 }, d);
  assert.ok(r.basis["상·하한 역전 여부"].includes("역전"), "basis 에 역전 표시");
  assert.ok(r.basis["상·하한 역전 여부"].includes("제46조제2항"), "basis 에 근거 조문");
  assert.ok(r.warnings.some((w) => w.includes("제46조제2항") && w.includes("하한이 우선")),
    "역전 경고가 하한 우선을 명시해야 한다");
});

t("역전이 아니면 역전 경고를 띄우지 않는다", () => {
  const r = run({ leaveDate: "2026-03-02", monthlyWage: 3_000_000, age: 30, insuredMonths: 12 });
  assert.ok(!r.warnings.some((w) => w.includes("하한이 우선")));
});

// ── 6. 이직일 분기 (대통령령 제35934호 부칙 제4조) ─────────────
t("★이직일 분기★ — 2025년 이직자에게는 종전 상한(66,000)과 종전 하한(64,192)이 적용된다", () => {
  const r = run({ leaveDate: "2025-12-31", averageDailyWage: 999_999, age: 30, insuredMonths: 12 });
  assert.strictEqual(r.cohortId, "2025");
  assert.strictEqual(r.maxBaseDaily, 110_000);
  assert.strictEqual(r.dailyAmount, 66_000);
  assert.strictEqual(r.minDaily, 64_192, "10,030 × 8 × 80%");
});

t("★이직일 분기★ — 하루 차이로 값이 갈린다 (2025-12-31 vs 2026-01-01)", () => {
  const base = { averageDailyWage: 999_999, age: 30, insuredMonths: 120 };
  const y2025 = run({ ...base, leaveDate: "2025-12-31" });
  const y2026 = run({ ...base, leaveDate: "2026-01-01" });
  assert.strictEqual(y2025.dailyAmount, 66_000);
  assert.strictEqual(y2026.dailyAmount, 68_100);
  assert.strictEqual(y2026.dailyAmount - y2025.dailyAmount, 2_100, "1일 2,100원 차이");
  assert.strictEqual(y2026.totalAmount - y2025.totalAmount, 2_100 * 240,
    "240일이면 504,000원 차이. 이직일을 안 받으면 이만큼 조용히 틀린다.");
});

t("2025년 이직자도 하한이 정상 작동한다", () => {
  const r = run({ leaveDate: "2025-06-01", averageDailyWage: 30_000, age: 30, insuredMonths: 12 });
  assert.strictEqual(r.dailyAmount, 64_192);
  assert.strictEqual(r.bound, "하한");
});

t("지원 범위 밖 이직일은 조용히 최신 값으로 폴백하지 않고 거부한다", () => {
  assert.throws(
    () => run({ leaveDate: "2024-12-31", monthlyWage: 3_000_000, age: 30, insuredMonths: 12 }),
    /지원|찾을 수 없/);
});

t("코호트 해석기가 경계를 정확히 나눈다", () => {
  assert.strictEqual(resolveCohort(DATA, "2025-01-01").id, "2025");
  assert.strictEqual(resolveCohort(DATA, "2025-12-31").id, "2025");
  assert.strictEqual(resolveCohort(DATA, "2026-01-01").id, "2026");
  assert.strictEqual(resolveCohort(DATA, "2026-12-31").id, "2026");
  // 지원 범위를 넘는 미래는 최신 코호트로 폴백하지 않고 거부하는 것이 정답이다.
  // 예전에는 2030-05-05 가 조용히 '2026' 으로 흘러들어 틀린 금액을 냈다.
  assert.throws(() => resolveCohort(DATA, "2030-05-05"), /아직 계산할 수 없습니다/);
});

// ── 7. 평균임금 환산 규칙 ──────────────────────────────────────
t("월평균임금은 공식 계산기와 같은 ÷30 규칙으로 환산하고 그 사실을 알린다", () => {
  const r = run({ leaveDate: "2026-03-02", monthlyWage: 3_500_000, age: 30, insuredMonths: 12 });
  assert.strictEqual(r.averageWageRule, "divide30");
  assert.strictEqual(r.rawBaseDaily, 116_666, "floor(3,500,000 / 30)");
  assert.ok(r.warnings.some((w) => w.includes("÷ 30")));
  assert.ok(r.basis["평균임금일액"].includes("÷ 30"));
});

t("평균임금일액을 직접 넣으면 그 값을 그대로 쓴다", () => {
  const r = run({ leaveDate: "2026-03-02", averageDailyWage: 100_000, monthlyWage: 9_999_999, age: 30, insuredMonths: 12 });
  assert.strictEqual(r.averageWageRule, "actual");
  assert.strictEqual(r.rawBaseDaily, 100_000, "직접 입력이 우선한다");
  assert.ok(!r.warnings.some((w) => w.includes("÷ 30")));
});

// ── 8. 기간 규정 ───────────────────────────────────────────────
t("대기기간 7일을 총액에서 차감하지 않는다 (제50조제1항)", () => {
  const r = run({ leaveDate: "2026-03-02", monthlyWage: 3_000_000, age: 30, insuredMonths: 12 });
  assert.strictEqual(r.totalAmount, r.days * r.dailyAmount, "총액 = 일수 × 일액");
  assert.strictEqual(r.waitingDays, 7);
  assert.ok(r.basis["총 예상 수령액"].includes("차감하지 않는다"));
});

t("수급기간 만료일은 이직일 다음 날부터 12개월이다 (제48조제1항)", () => {
  assert.strictEqual(run({ leaveDate: "2026-01-31", monthlyWage: 3e6, age: 30, insuredMonths: 12 }).benefitWindowEnd, "2027-01-31");
  assert.strictEqual(run({ leaveDate: "2026-08-20", monthlyWage: 3e6, age: 30, insuredMonths: 12 }).benefitWindowEnd, "2027-08-20");
  assert.strictEqual(run({ leaveDate: "2026-12-31", monthlyWage: 3e6, age: 30, insuredMonths: 12 }).benefitWindowEnd, "2027-12-31");
  // 윤년 2/29 이직일은 '다음 해에 없는 날짜' 처리가 필요하지만,
  // 현재 지원 범위(2025-01-01 ~ 2026-12-31)에 2월 29일이 없어 공개 API 로 도달할 수 없다.
  // 2028 코호트를 추가할 때 이 케이스를 반드시 다시 테스트할 것.
  assert.ok(
    DATA.cohorts.every((c) => !(c.leaveDateFrom <= "2028-02-29" && "2028-02-29" <= c.leaveDateTo)),
    "2028-02-29 가 지원 범위에 들어왔다면 윤년 테스트를 복구해야 한다"
  );
});

// ── 9. 안내·경고 ───────────────────────────────────────────────
t("이직 사유를 판정하지 않는다는 사실을 반드시 알린다 (제58조)", () => {
  const r = run({ leaveDate: "2026-03-02", monthlyWage: 3_000_000, age: 30, insuredMonths: 12 });
  assert.ok(r.warnings.some((w) => w.includes("제58조") && w.includes("판정하지 않습니다")));
  assert.ok(r.warnings.some((w) => w.includes("고용센터")));
});

t("피보험 단위기간 180일 요건이 재직일수와 다르다는 것을 알린다 (제41조제1항)", () => {
  const r = run({ leaveDate: "2026-03-02", monthlyWage: 3_000_000, age: 30, insuredMonths: 12 });
  assert.ok(r.warnings.some((w) => w.includes("180일") && w.includes("보수 지급의 기초가 된 날")));
});

t("가입기간이 짧으면 180일 요건 미달 가능성을 경고한다", () => {
  const r = run({ leaveDate: "2026-03-02", monthlyWage: 3_000_000, age: 30, insuredMonths: 5 });
  assert.ok(r.warnings.some((w) => w.includes("요건을 채우지 못했을 가능성")));
});

t("피보험기간 합산(3년 이내 재취득)을 알린다 — 재직기간과 다르다", () => {
  const r = run({ leaveDate: "2026-03-02", monthlyWage: 3_000_000, age: 30, insuredMonths: 12 });
  assert.ok(r.warnings.some((w) => w.includes("고용보험 총 가입기간") && w.includes("3년 이내")));
});

t("65세 이상은 제10조제2항 적용 제외 가능성을 알린다", () => {
  const r = run({ leaveDate: "2026-03-02", monthlyWage: 3_000_000, age: 66, insuredMonths: 12 });
  assert.ok(r.warnings.some((w) => w.includes("제10조제2항")));
  assert.ok(!run({ leaveDate: "2026-03-02", monthlyWage: 3e6, age: 40, insuredMonths: 12 })
    .warnings.some((w) => w.includes("제10조제2항")));
});

t("범위 밖 제도(자영업자·예술인·연장급여)를 다루지 않는다고 밝힌다", () => {
  const r = run({ leaveDate: "2026-03-02", monthlyWage: 3_000_000, age: 30, insuredMonths: 12 });
  assert.ok(r.warnings.some((w) => w.includes("자영업자") && w.includes("연장급여")));
});

t("계산 근거가 화면에 쓸 수 있게 전부 반환된다", () => {
  const r = run({ leaveDate: "2026-03-02", monthlyWage: 3_000_000, age: 30, insuredMonths: 12 });
  for (const k of ["적용 기준(이직일)", "평균임금일액", "최저기초일액", "기초일액 상한", "기초일액",
                   "구직급여일액", "하한 비교(제46조제2항)", "상·하한 역전 여부", "적용 구속",
                   "소정급여일수", "총 예상 수령액", "수급기간 만료일"]) {
    assert.ok(r.basis[k], `basis["${k}"] 누락`);
    assert.ok(String(r.basis[k]).length > 5, `basis["${k}"] 가 비어 있다`);
  }
  assert.ok(r.basis["소정급여일수"].includes("별표 1"));
  assert.ok(r.basis["최저기초일액"].includes("제45조제4항"));
});

// ── 10. 입력 방어 ──────────────────────────────────────────────
t("이직일이 없거나 형식이 틀리면 던진다", () => {
  const base = { monthlyWage: 3_000_000, age: 30, insuredMonths: 12 };
  assert.throws(() => run({ ...base }));
  assert.throws(() => run({ ...base, leaveDate: "2026-3-2" }));
  assert.throws(() => run({ ...base, leaveDate: "2026-02-30" }));
  assert.throws(() => run({ ...base, leaveDate: new Date() }));
});

t("나이·가입기간을 조용히 0 으로 뭉개지 않는다", () => {
  const base = { leaveDate: "2026-03-02", monthlyWage: 3_000_000 };
  assert.throws(() => run({ ...base, insuredMonths: 12 }), /나이/);
  assert.throws(() => run({ ...base, age: 30 }), /가입기간/);
  assert.throws(() => run({ ...base, age: -1, insuredMonths: 12 }), /이상/);
  assert.throws(() => run({ ...base, age: 30.5, insuredMonths: 12 }), /정수/);
  assert.throws(() => run({ ...base, age: 200, insuredMonths: 12 }), /범위/);
  assert.throws(() => run({ ...base, age: 30, insuredMonths: -1 }), /이상/);
  assert.throws(() => run({ ...base, age: 30, insuredMonths: 9999 }), /범위/);
  assert.throws(() => run({ ...base, age: "서른", insuredMonths: 12 }), /숫자/);
  assert.throws(() => run({ ...base, age: true, insuredMonths: 12 }), /숫자/);
});

t("1일 소정근로시간이 8시간을 넘으면 거부한다 (근로기준법 제50조제2항)", () => {
  const base = { leaveDate: "2026-03-02", monthlyWage: 3_000_000, age: 30, insuredMonths: 12 };
  assert.throws(() => run({ ...base, dailyWorkHours: 9 }), /범위/);
  assert.throws(() => run({ ...base, dailyWorkHours: 0 }), /0보다/);
  assert.throws(() => run({ ...base, dailyWorkHours: -1 }), /이상/);
  assert.strictEqual(run({ ...base, dailyWorkHours: 8 }).dailyWorkHours, 8);
  assert.strictEqual(run({ ...base }).dailyWorkHours, 8, "기본값 8시간");
});

t("임금을 아예 안 넣거나 0 이면 던진다", () => {
  const base = { leaveDate: "2026-03-02", age: 30, insuredMonths: 12 };
  assert.throws(() => run({ ...base }), /월평균임금|평균임금일액/);
  assert.throws(() => run({ ...base, monthlyWage: 0 }), /0원/);
  assert.throws(() => run({ ...base, monthlyWage: 20 }), /0원/, "floor(20/30)=0");
  assert.throws(() => run({ ...base, monthlyWage: -1 }), /이상/);
  assert.throws(() => run({ ...base, monthlyWage: Infinity }), /숫자/);
  assert.throws(() => run({ ...base, monthlyWage: 1e12 }), /범위/);
});

t("원장을 안 넘기면 조용히 계산하지 않는다", () => {
  assert.throws(() => calcUnemploymentBenefit(
    { leaveDate: "2026-03-02", monthlyWage: 3e6, age: 30, insuredMonths: 12 }, null), /원장/);
  assert.throws(() => calcUnemploymentBenefit(
    { leaveDate: "2026-03-02", monthlyWage: 3e6, age: 30, insuredMonths: 12 }, {}), /원장/);
});

// ── 11. 원장 정합성 ────────────────────────────────────────────
t("원장의 최저임금이 요율 원장(rates-*.json)과 일치한다", () => {
  const c2026 = DATA.cohorts.find((c) => c.id === "2026");
  assert.strictEqual(c2026.minWageHourly, RATES.minimumWage.hourly,
    `unemployment 원장 ${c2026.minWageHourly} ≠ rates 원장 ${RATES.minimumWage.hourly}. ` +
    `두 파일이 어긋나면 하한액이 조용히 틀린다.`);
});

t("2025 코호트의 최저임금이 이력 원장과 일치한다", () => {
  const c2025 = DATA.cohorts.find((c) => c.id === "2025");
  assert.strictEqual(c2025.minWageHourly, HISTORY.minimumWageHourly["2025"]);
});

t("원장의 파생값($derivedCheck)이 정본값에서 실제로 유도된다", () => {
  for (const c of DATA.cohorts) {
    const d = c.$derivedCheck;
    assert.strictEqual(d.maxDaily, c.maxBaseDaily * DATA.rates.daily, `${c.id} maxDaily`);
    assert.strictEqual(d.minBaseDaily8h, c.minWageHourly * 8, `${c.id} minBaseDaily8h`);
    assert.strictEqual(d.minDaily8h, Math.round(c.minWageHourly * 8 * DATA.rates.dailyMin), `${c.id} minDaily8h`);
    assert.strictEqual(d.inversionMargin, d.maxDaily - d.minDaily8h, `${c.id} 역전 여유`);
    assert.ok(d.inversionMargin > 0, `${c.id} 코호트가 이미 역전 상태다 — 즉시 확인 필요`);
  }
});

t("엔진이 계산한 상·하한이 원장 파생값과 같다", () => {
  for (const c of DATA.cohorts) {
    const r = run({ leaveDate: c.leaveDateFrom, averageDailyWage: 100_000, age: 30, insuredMonths: 12, dailyWorkHours: 8 });
    assert.strictEqual(r.maxDaily, c.$derivedCheck.maxDaily, `${c.id} 상한`);
    assert.strictEqual(r.minDaily, c.$derivedCheck.minDaily8h, `${c.id} 하한`);
    assert.strictEqual(r.minBaseDaily, c.$derivedCheck.minBaseDaily8h, `${c.id} 최저기초일액`);
  }
});

t("원장 연도가 현역 요율 원장과 같다", () => {
  assert.strictEqual(DATA.year, L.year, `실업급여 원장 ${DATA.year}년 ≠ 요율 원장 ${L.year}년`);
});

t("원장에 미결 과제가 근거와 함께 남아 있다", () => {
  const keys = Object.keys(DATA.$openIssues);
  assert.ok(keys.includes("rounding"), "단수처리 미결");
  assert.ok(keys.includes("inversion2027Risk"), "2027년 역전 재발 위험");
  assert.ok(keys.includes("inversionInterpretation"), "역전 해석의 한계");
  for (const k of keys) assert.ok(DATA.$openIssues[k].length > 30, `$openIssues.${k} 설명이 너무 짧다`);
});

t("원장이 다루지 않는 제도를 명시적으로 적어 두었다", () => {
  for (const k of ["selfEmployed", "artistAndWorker", "extendedBenefits", "eligibilityJudgement"])
    assert.ok(DATA.notCovered[k], `notCovered.${k} 누락`);
});


/* ── ★회귀★ 미래 이직일 조용한 오적용 (적대적 검증 critical) ──────────
   2026 코호트의 leaveDateTo 가 9999-12-31 로 열려 있어 2027년 이직일에
   2026년 최저임금·상한이 경고 없이 적용됐다. 2027년 최저임금(10,700원)은
   이미 2026-08-05 고시됐으므로 명백히 틀린 금액이었고, 270일 기준 656,640원을
   과소 표시했다. 게다가 경고 문구가 "2026년 구간을 적용했습니다"라고 단정해
   오류를 확인해 주는 형태였다. 과거 방향은 거부하면서 미래만 통과시킨 비대칭이었다. */

const REG = { monthlyWage: 3000000, age: 52, insuredMonths: 130, dailyWorkHours: 8 };

t("★회귀★ 코호트 종료일이 미래로 열려 있지 않다", () => {
  for (const c of DATA.cohorts) {
    assert.ok(c.leaveDateTo < "2100-01-01", `${c.id} 코호트가 ${c.leaveDateTo} 까지 열려 있다`);
  }
});

t("★회귀★ 지원 범위를 넘는 미래 이직일은 조용히 계산하지 않고 거부한다", () => {
  const latest = DATA.cohorts.map((c) => c.leaveDateTo).sort().pop();
  for (const ld of ["2027-01-01", "2027-06-01", "2030-01-01", "2099-01-01"]) {
    assert.ok(ld > latest, "테스트 전제");
    assert.throws(
      () => calcUnemploymentBenefit({ ...REG, leaveDate: ld }, DATA, RATES),
      /아직 계산할 수 없습니다/,
      `${ld} 가 거부되지 않았다`
    );
  }
});

t("★회귀★ 미래 거부 메시지가 이유를 설명한다", () => {
  try {
    calcUnemploymentBenefit({ ...REG, leaveDate: "2027-03-01" }, DATA, RATES);
    assert.fail("거부되지 않았다");
  } catch (e) {
    assert.ok(e.message.includes("상한액"), "상한 미확정이 사유임을 밝혀야 한다");
    assert.ok(!/9999/.test(e.message));
  }
});

t("지원 범위 마지막 날은 정상 계산된다 (경계)", () => {
  const latest = DATA.cohorts.map((c) => c.leaveDateTo).sort().pop();
  const r = calcUnemploymentBenefit({ ...REG, leaveDate: latest }, DATA, RATES);
  assert.ok(r.dailyAmount > 0);
  assert.strictEqual(r.days, 270);
});

t("★회귀★ 2027년 역전이 미래형이 아니라 확정 사실로 기록돼 있다", () => {
  // 원장이 이걸 '조건부 위험'으로만 적어두면 다음 사람이 놓친다.
  const note = DATA.$openIssues.inversion2027Risk;
  assert.ok(note.includes("10,700"), "2027년 최저임금이 명시돼야 한다");
  assert.ok(note.includes("68,480"), "역전된 하한액이 명시돼야 한다");
  assert.ok(note.includes("10,640.63"), "정정된 임계 시급이 명시돼야 한다");
});

t("★회귀★ 화면 날짜 입력이 원장 지원 범위로 제한돼 있다", () => {
  const html = fs.readFileSync(path.join(ROOT, "web", "unemployment", "index.html"), "utf8");
  const m = html.match(/<input id="uiLeave"[^>]*>/);
  assert.ok(m, "uiLeave 입력을 찾을 수 없다");
  const lo = DATA.cohorts.map((c) => c.leaveDateFrom).sort()[0];
  const hi = DATA.cohorts.map((c) => c.leaveDateTo).sort().pop();
  assert.ok(m[0].includes(`min="${lo}"`), `min 이 ${lo} 여야 한다: ${m[0]}`);
  assert.ok(m[0].includes(`max="${hi}"`), `max 가 ${hi} 여야 한다: ${m[0]}`);
});


/* ── ★회귀★ 빈 입력이 0 으로 뭉개지던 결함 (적대적 검증 major) ──────
   페이지 계층이 Number("")→0 으로 바꿔 넘기는 바람에 엔진의 필수값 검사가
   무력화됐다. 가입기간을 비우면 '1년 미만'으로 조용히 계산돼 틀린 금액이
   큰 글씨로 표시됐다. 엔진 쪽 방어가 실제로 작동하는지 못박는다. */

t("★회귀★ 필수 입력이 없으면 0 으로 계산하지 않고 거부한다", () => {
  const base = { leaveDate: "2026-03-02", monthlyWage: 3_000_000, age: 30, insuredMonths: 24, dailyWorkHours: 8 };
  for (const k of ["age", "insuredMonths"]) {
    assert.throws(
      () => calcUnemploymentBenefit({ ...base, [k]: undefined }, DATA, RATES),
      /입력해 주세요/,
      `${k} 가 비었는데 계산됐다`
    );
  }
  // 1일 소정근로시간은 법정 기본값 8시간이 있으므로 비어도 된다.
  // 다만 0 으로 뭉개지지 않고 8 이 쓰여야 한다.
  const noHours = calcUnemploymentBenefit({ ...base, dailyWorkHours: undefined }, DATA, RATES);
  assert.strictEqual(noHours.dailyWorkHours, 8);
});

t("★회귀★ 날짜 오류 메시지가 '이직일'을 가리킨다", () => {
  // 예전에는 이 페이지에 없는 '급여 지급일'을 고치라는 안내가 떴다.
  try {
    calcUnemploymentBenefit(
      { leaveDate: "", monthlyWage: 3_000_000, age: 30, insuredMonths: 24, dailyWorkHours: 8 },
      DATA, RATES
    );
    assert.fail("거부되지 않았다");
  } catch (e) {
    assert.ok(e.message.includes("이직일"), `메시지: ${e.message}`);
    assert.ok(!e.message.includes("payDate"), "내부 변수명이 노출됐다");
    assert.ok(!e.message.includes("국민연금"), "이 페이지와 무관한 안내가 섞였다");
  }
});

t("★회귀★ 페이지 계층이 빈 칸을 0 으로 바꾸지 않는다", () => {
  const src = fs.readFileSync(path.join(ROOT, "web", "assets", "calc-page.js"), "utf8");
  for (const id of ["uiAge", "uiMonths", "uiHours"]) {
    assert.ok(
      !new RegExp(`Number\(g\("${id}"\)\.value\)`).test(src),
      `${id} 를 Number() 로 직접 감싸면 빈 칸이 0 이 된다`
    );
  }
  assert.ok(src.includes("blankToUndefined"), "빈 칸 처리 헬퍼가 없다");
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
