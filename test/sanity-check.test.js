/**
 * 위생 검사 자체의 테스트.
 *
 * ★이 파일의 목적은 '정상 데이터가 통과한다' 가 아니라
 *   '조작된 오염 값이 실제로 차단된다' 를 증명하는 것이다.★
 * 검증기가 조용히 통과시키면 그 순간 파이프라인 전체가 무의미해진다.
 *
 * 순수 node + assert. npm 의존성 없음(기존 test/*.test.js 관례).
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const L = require(path.join(__dirname, "..", "tools", "lib", "resolve-ledger.js")).resolve();
const ROOT = path.join(__dirname, "..");
const sanity = require(path.join(ROOT, "tools", "sanity-check.js"));
const { buildCandidate, FACT_MAP } = require(path.join(ROOT, "tools", "update-rates.js"));

const RULES = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "sanity-rules.json"), "utf8"));
const BASE = JSON.parse(fs.readFileSync(L.ledgerPath, "utf8"));
const TAX = JSON.parse(fs.readFileSync(L.taxTablePath, "utf8"));
const TODAY = "2026-08-19";

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

const clone = (o) => JSON.parse(JSON.stringify(o));

/** BASE 를 복제하고 경로들을 오염시킨다. */
function poison(mutations) {
  const c = clone(BASE);
  for (const [p, v] of Object.entries(mutations)) {
    const keys = p.split(".");
    let cur = c;
    for (let i = 0; i < keys.length - 1; i++) cur = cur[keys[i]];
    if (v === "__DELETE__") delete cur[keys[keys.length - 1]];
    else cur[keys[keys.length - 1]] = v;
  }
  return c;
}

function run(candidate, opt) {
  return sanity.validate({
    candidate,
    current: opt && "current" in opt ? opt.current : BASE,
    rules: (opt && opt.rules) || RULES,
    taxTable: (opt && opt.taxTable) || TAX,
    today: (opt && opt.today) || TODAY,
  });
}

const codes = (res, level) => res[level].map((i) => i.code);
function hasCode(res, level, code) {
  return res[level].some((i) => i.code === code);
}
function msgOf(res, code) {
  const i = res.issues.find((x) => x.code === code);
  return i ? i.message : "";
}

/** 지정한 코드로 FATAL 이 나야 한다. */
function expectFatal(res, code, extra) {
  assert.ok(
    hasCode(res, "fatal", code),
    `${code} FATAL 을 기대했으나 나오지 않았습니다. FATAL=${JSON.stringify(codes(res, "fatal"))} BLOCK=${JSON.stringify(codes(res, "block"))}`
  );
  assert.strictEqual(res.ok, false, "ok 가 false 여야 합니다");
  if (extra) assert.ok(msgOf(res, code).includes(extra), `메시지에 '${extra}' 가 포함돼야 합니다: ${msgOf(res, code)}`);
}

function expectBlock(res, code) {
  assert.ok(
    hasCode(res, "block", code),
    `${code} BLOCK 을 기대했으나 나오지 않았습니다. FATAL=${JSON.stringify(codes(res, "fatal"))} BLOCK=${JSON.stringify(codes(res, "block"))}`
  );
  assert.strictEqual(res.autoMergeable, false, "autoMergeable 이 false 여야 합니다");
}

console.log("\n[요율 원장 위생 검사]\n");

// ══════════════ 0. 기준선 ══════════════
t("현 원장은 자기 규칙을 통과한다", () => {
  const res = run(BASE);
  assert.deepStrictEqual(codes(res, "fatal"), [], "FATAL 이 없어야 함");
  assert.deepStrictEqual(codes(res, "block"), [], "BLOCK 이 없어야 함");
  assert.strictEqual(res.autoMergeable, true);
});

t("현 원장은 current 없이도 통과한다(형식·정합성만 검사)", () => {
  const res = run(BASE, { current: null });
  assert.deepStrictEqual(codes(res, "fatal"), []);
});

t("간이세액표 원본이 표 규칙을 통과한다", () => {
  const res = sanity.validateTaxTable(TAX, RULES, null);
  assert.deepStrictEqual(codes(res, "fatal"), []);
  assert.deepStrictEqual(codes(res, "block"), []);
});

// ══════════════ 1. 자릿수·형식 오염 ══════════════
t("요율 70% (0.70) 는 FATAL 로 차단된다", () => {
  const res = run(poison({ "healthInsurance.totalRate": 0.7, "healthInsurance.employeeRate": 0.35 }));
  expectFatal(res, "FRACTION_TOO_LARGE");
});

t("건강보험료율 0.09(9%) 는 법정 상한 8% 초과로 FATAL", () => {
  const res = run(poison({ "healthInsurance.totalRate": 0.09, "healthInsurance.employeeRate": 0.045 }));
  expectFatal(res, "RANGE_HIGH");
});

t("퍼센트/소수 혼동(7.19)은 원인을 지목하며 차단된다", () => {
  const res = run(poison({ "healthInsurance.totalRate": 7.19, "healthInsurance.employeeRate": 3.595 }));
  expectFatal(res, "FRACTION_TOO_LARGE", "퍼센트/소수 혼동 의심");
  // ★일반적인 '범위 초과' 메시지만 주면 사람이 임계값을 넓혀서 '고치는' 2차 사고가 난다.
  assert.ok(msgOf(res, "FRACTION_TOO_LARGE").includes("0.0719"), "정상값 후보(0.0719)를 제시해야 함");
});

t("음수 요율은 FATAL 로 차단된다", () => {
  const res = run(poison({ "employmentInsurance.unemploymentTotalRate": -0.018, "employmentInsurance.employeeRate": -0.009 }));
  expectFatal(res, "RANGE_LOW", "음수");
});

t("문자열 요율 \"0.0719\" 는 타입 검사에서 차단된다", () => {
  const res = run(poison({ "healthInsurance.totalRate": "0.0719" }));
  expectFatal(res, "TYPE");
});

t("NaN 은 차단된다", () => {
  const c = clone(BASE);
  c.healthInsurance.totalRate = NaN;
  const res = run(c);
  // JSON 왕복이 아닌 직접 주입 경로(손편집·스크립트 버그)를 가정한다.
  assert.ok(hasCode(res, "fatal", "NOT_FINITE") || hasCode(res, "fatal", "RANGE_LOW"), `FATAL=${JSON.stringify(codes(res, "fatal"))}`);
});

t("필수 필드 삭제는 FATAL", () => {
  const res = run(poison({ "healthInsurance.totalRate": "__DELETE__" }));
  assert.ok(hasCode(res, "fatal", "MISSING_FIELD") || hasCode(res, "fatal", "KEY_REMOVED"));
});

t("분모 사다리 위반(0.0718666 — 엉뚱한 셀 파싱)은 FATAL", () => {
  const res = run(poison({ "healthInsurance.totalRate": 0.0718666, "healthInsurance.employeeRate": 0.0359333 }));
  expectFatal(res, "DENOMINATOR");
});

t("자릿수 밀림(0.07193)은 분모 검사에서 걸린다", () => {
  const res = run(poison({ "healthInsurance.totalRate": 0.07193, "healthInsurance.employeeRate": 0.035965 }));
  expectFatal(res, "DENOMINATOR");
});

t("최저임금이 정수가 아니면 FATAL", () => {
  const res = run(poison({ "minimumWage.hourly": 10320.5 }));
  expectFatal(res, "NOT_INTEGER");
});

t("최저임금이 10원 배수가 아니면 FATAL", () => {
  const res = run(poison({ "minimumWage.hourly": 10323, "minimumWage.monthly209h": 10323 * 209 }));
  expectFatal(res, "MULTIPLE_OF");
});

t("콤마 유실(기준소득월액 상한 6,590,000 → 6)은 원인을 지목하며 차단된다", () => {
  const c = clone(BASE);
  c.nationalPension.baseIncomeBrackets[1].max = 6;
  const res = run(c);
  expectFatal(res, "BRACKET_RANGE");
  assert.ok(/자릿수 유실|콤마/.test(msgOf(res, "BRACKET_RANGE")), `원인 지목이 없습니다: ${msgOf(res, "BRACKET_RANGE")}`);
});

// ══════════════ 2. 국민연금 법정 스케줄 ══════════════
t("★2026년에 13%(본문 제88조제3항)를 넣으면 FATAL 이고 부칙을 읽으라고 알린다★", () => {
  const res = run(poison({ "nationalPension.totalRate": 0.13, "nationalPension.employeeRate": 0.065 }));
  expectFatal(res, "PENSION_SCHEDULE", "부칙 제4조제1항");
  assert.ok(msgOf(res, "PENSION_SCHEDULE").includes("본문"), "본문/부칙 혼동을 명시해야 함");
});

t("2026년에 9.0%(전년값 잔류)를 넣으면 FATAL", () => {
  const res = run(poison({ "nationalPension.totalRate": 0.09, "nationalPension.employeeRate": 0.045 }));
  expectFatal(res, "PENSION_SCHEDULE");
});

t("2027년 원장에 10.0% 를 넣으면 스케줄 검사를 통과한다", () => {
  const c = clone(BASE);
  c.year = 2027;
  c.lastVerified = "2027-01-05";
  c.nationalPension.totalRate = 0.1;
  c.nationalPension.employeeRate = 0.05;
  c.nationalPension.effectiveFrom = "2027-01-01";
  c.healthInsurance.effectiveFrom = "2027-01-01";
  c.longTermCare.effectiveFrom = "2027-01-01";
  c.employmentInsurance.effectiveFrom = "2027-01-01";
  c.minimumWage.hourly = 10700;
  c.minimumWage.monthly209h = 10700 * 209;
  c.minimumWage.effectiveFrom = "2027-01-01";
  c.minimumWage.effectiveTo = "2027-12-31";
  c.nationalPension.baseIncomeBrackets.push({ from: "2027-07-01", to: "2028-06-30", min: 420000, max: 6800000 });
  const res = run(c, { today: "2027-01-05" });
  assert.deepStrictEqual(codes(res, "fatal"), [], "정상 연도 전환은 FATAL 이 없어야 한다");
  // 구간 추가는 키 추가이므로 사람 확인(BLOCK)이 맞다.
  assert.ok(hasCode(res, "block", "KEY_ADDED"), "새 구간 추가는 BLOCK 이어야 한다");
});

// ══════════════ 3. 교차 정합성 ══════════════
t("근로자 부담률 자리에 총요율을 넣으면 FATAL(1/2 검사)", () => {
  const res = run(poison({ "healthInsurance.employeeRate": 0.0719 }));
  expectFatal(res, "HALF_OF");
});

t("★장기요양-건강보험 정합성 위반: 건보료율만 갱신하고 장기요양을 안 고치면 FATAL★", () => {
  // 건강보험료율만 7.19% → 7.29% 로 바꾸고 longTermCare 는 그대로 둔 상태.
  // rateOfIncome(0.009448) 이 round6(0.0729 × 0.1314)=0.009579 와 어긋난다.
  const res = run(poison({ "healthInsurance.totalRate": 0.0729, "healthInsurance.employeeRate": 0.03645 }));
  expectFatal(res, "LTC_DERIVATION");
  assert.ok(msgOf(res, "LTC_DERIVATION").includes("0.009448"), "원장의 현재 값을 인용해야 함");
});

t("장기요양 rateOfIncome 만 조작해도 FATAL", () => {
  const res = run(poison({ "longTermCare.rateOfIncome": 0.009182 }));
  expectFatal(res, "LTC_DERIVATION");
});

t("최저임금 209시간 환산이 어긋나면 FATAL", () => {
  const res = run(poison({ "minimumWage.monthly209h": 2156000 }));
  expectFatal(res, "EQUALS");
});

t("요율 서열이 뒤바뀌면 FATAL (연금 자리에 고용보험 값)", () => {
  const res = run(poison({ "nationalPension.totalRate": 0.018, "nationalPension.employeeRate": 0.009 }));
  assert.ok(hasCode(res, "fatal", "RATE_ORDER") || hasCode(res, "fatal", "PENSION_SCHEDULE"));
});

t("최저임금 월환산액이 기준소득월액 상한을 넘으면 FATAL(상식 부등호)", () => {
  const res = run(poison({ "minimumWage.hourly": 40000, "minimumWage.monthly209h": 40000 * 209 }));
  assert.ok(hasCode(res, "fatal", "SANITY_ORDER_MW"), `FATAL=${JSON.stringify(codes(res, "fatal"))}`);
});

t("자녀공제 서열(1명 < 2명)이 깨지면 FATAL", () => {
  const res = run(poison({ "childTaxCredit.one": 50000 }));
  assert.ok(hasCode(res, "fatal", "CHILD_ORDER"));
});

t("3명 이상 기본액 ≠ 2명 공제액이면 FATAL", () => {
  const res = run(poison({ "childTaxCredit.threePlusBase": 45840 }));
  expectFatal(res, "EQUALS");
});

// ══════════════ 4. 변동폭 ══════════════
t("건강보험료율 +0.20%p 는 BLOCK(역대 최대 근처, 사람 확인)", () => {
  const res = run(
    poison({
      "healthInsurance.totalRate": 0.0739,
      "healthInsurance.employeeRate": 0.03695,
      "longTermCare.rateOfIncome": Math.round(0.0739 * 0.1314 * 1e6) / 1e6,
    })
  );
  assert.deepStrictEqual(codes(res, "fatal"), [], `FATAL 이 없어야 함: ${JSON.stringify(res.fatal.map((f) => f.code + " " + f.message))}`);
  expectBlock(res, "DELTA_UNUSUAL");
});

t("건강보험료율 +0.30%p 는 역대 최대 초과로 FATAL", () => {
  const res = run(
    poison({
      "healthInsurance.totalRate": 0.0749,
      "healthInsurance.employeeRate": 0.03745,
      "longTermCare.rateOfIncome": Math.round(0.0749 * 0.1314 * 1e6) / 1e6,
    })
  );
  expectFatal(res, "DELTA_TOO_LARGE");
});

t("건강보험료율 인하는 BLOCK (법적으로 가능하지만 전례 없음)", () => {
  const res = run(
    poison({
      "healthInsurance.totalRate": 0.0709,
      "healthInsurance.employeeRate": 0.03545,
      "longTermCare.rateOfIncome": Math.round(0.0709 * 0.1314 * 1e6) / 1e6,
    })
  );
  assert.deepStrictEqual(codes(res, "fatal"), []);
  expectBlock(res, "DECREASE");
});

t("장기요양비율 인하는 FATAL", () => {
  const res = run(
    poison({
      "longTermCare.rateOfHealthPremium": 0.1295,
      "longTermCare.rateOfIncome": Math.round(0.0719 * 0.1295 * 1e6) / 1e6,
    })
  );
  expectFatal(res, "DECREASE");
});

t("최저임금 인하는 FATAL (1988년 이후 전례 0회)", () => {
  const res = run(poison({ "minimumWage.hourly": 10000, "minimumWage.monthly209h": 10000 * 209 }));
  expectFatal(res, "DECREASE");
});

t("최저임금 +30% 는 FATAL (역대 최대 +16.4%)", () => {
  const res = run(poison({ "minimumWage.hourly": 13420, "minimumWage.monthly209h": 13420 * 209 }));
  expectFatal(res, "DELTA_PCT_TOO_LARGE");
});

t("최저임금 +15% 는 BLOCK (통상 밴드 밖이지만 전례 있음)", () => {
  const res = run(poison({ "minimumWage.hourly": 11870, "minimumWage.monthly209h": 11870 * 209 }));
  assert.deepStrictEqual(codes(res, "fatal"), []);
  expectBlock(res, "DELTA_PCT_OUTSIDE_BAND");
});

t("★고용보험 요율은 어떤 변동도 BLOCK★ (13년간 변경 2회)", () => {
  const res = run(poison({ "employmentInsurance.unemploymentTotalRate": 0.02, "employmentInsurance.employeeRate": 0.01 }));
  assert.deepStrictEqual(codes(res, "fatal"), [], `FATAL=${JSON.stringify(res.fatal.map((f) => f.code))}`);
  expectBlock(res, "ANY_CHANGE");
});

t("★자녀공제액은 어떤 변동도 BLOCK★ (프로덕션 오류를 낸 유일한 필드)", () => {
  const res = run(poison({ "childTaxCredit.one": 20840 }));
  assert.deepStrictEqual(codes(res, "fatal"), []);
  expectBlock(res, "ANY_CHANGE");
});

t("자녀공제액을 2024판(12,500)으로 되돌리면 BLOCK 으로 잡힌다", () => {
  const res = run(
    poison({
      "childTaxCredit.one": 12500,
      "childTaxCredit.two": 29160,
      "childTaxCredit.threePlusBase": 29160,
      "childTaxCredit.threePlusPerExtra": 25000,
    })
  );
  assert.ok(res.block.filter((b) => b.code === "ANY_CHANGE").length >= 4, "네 필드 모두 BLOCK 되어야 함");
  assert.strictEqual(res.autoMergeable, false);
});

// ══════════════ 5. 집계 지표 ══════════════
t("근로자 부담 합계가 비상식적으로 뛰면 FATAL", () => {
  // 개별 항목은 범위 안이지만 조합이 이상한 경우를 강제한다.
  const rules = clone(RULES);
  rules.aggregate.deltaFatalPp = 0.0001;
  const res = run(
    poison({
      "healthInsurance.totalRate": 0.0729,
      "healthInsurance.employeeRate": 0.03645,
      "longTermCare.rateOfIncome": Math.round(0.0729 * 0.1314 * 1e6) / 1e6,
    }),
    { rules }
  );
  expectFatal(res, "BURDEN_DELTA");
});

t("근로자 부담 합계 계산이 실제 값과 맞다", () => {
  const v = sanity.employeeBurden(BASE);
  const expect = 0.0475 + 0.03595 + 0.03595 * 0.1314 + 0.009;
  assert.ok(Math.abs(v - expect) < 1e-12, `${v} vs ${expect}`);
});

// ══════════════ 6. 기준소득월액 구간 ══════════════
t("구간에 틈이 있으면 FATAL", () => {
  const c = clone(BASE);
  c.nationalPension.baseIncomeBrackets[1].from = "2026-07-02";
  const res = run(c);
  expectFatal(res, "BRACKET_GAP");
});

t("0 패딩 없는 날짜('2026-7-01')는 FATAL", () => {
  const c = clone(BASE);
  c.nationalPension.baseIncomeBrackets[1].from = "2026-7-01";
  const res = run(c);
  expectFatal(res, "BRACKET_DATE");
});

t("달력에 없는 날짜('2026-02-31')는 FATAL", () => {
  const c = clone(BASE);
  c.nationalPension.baseIncomeBrackets[1].from = "2026-02-31";
  const res = run(c);
  expectFatal(res, "BRACKET_DATE");
});

t("연말을 덮지 못하면 FATAL(커버리지)", () => {
  const c = clone(BASE);
  c.nationalPension.baseIncomeBrackets = [c.nationalPension.baseIncomeBrackets[0]];
  const res = run(c);
  expectFatal(res, "BRACKET_COVERAGE");
});

t("상·하한이 뒤바뀌면 FATAL", () => {
  const c = clone(BASE);
  const b = c.nationalPension.baseIncomeBrackets[1];
  [b.min, b.max] = [b.max, b.min];
  const res = run(c);
  assert.ok(hasCode(res, "fatal", "BRACKET_INVERTED") || hasCode(res, "fatal", "BRACKET_RANGE"));
});

t("기준소득월액 상한이 급등하면 FATAL", () => {
  const c = clone(BASE);
  c.nationalPension.baseIncomeBrackets[1].max = 8000000;
  const res = run(c);
  expectFatal(res, "BRACKET_GROWTH");
});

// ══════════════ 7. diff 화이트리스트 ══════════════
t("★보호 경로($comment) 수정은 FATAL★", () => {
  const res = run(poison({ $comment: "요율 원장" }));
  expectFatal(res, "PROTECTED_MODIFIED");
});

t("미해결 이슈 주석 삭제는 FATAL", () => {
  // premiumBoundsOpenIssue 는 고시 원문 확보로 해소되어 premiumBounds 로 대체됐다.
  // 아직 남아 있는 미결 주석으로 같은 불변식을 지킨다.
  const res = run(poison({ "childTaxCredit.$ageRangeOpenIssue": "__DELETE__" }));
  expectFatal(res, "KEY_REMOVED");
});

t("법정 상·하한(premiumBounds) 삭제는 FATAL", () => {
  // 보건복지부고시로 확보한 값이다. 조용히 사라지면 저소득 구간이 다시 틀린다.
  const res = run(poison({ "healthInsurance.premiumBounds.totalMin": "__DELETE__" }));
  expectFatal(res, "KEY_REMOVED");
});

t("입력 방어값(inputLimits) 수정은 FATAL", () => {
  const res = run(poison({ "inputLimits.maxMonthlySalary": 1000 }));
  expectFatal(res, "PROTECTED_MODIFIED");
});

t("지방소득세율 수정은 FATAL", () => {
  const res = run(poison({ "localIncomeTaxRate.rate": 0.15 }));
  assert.ok(hasCode(res, "fatal", "PROTECTED_MODIFIED") || hasCode(res, "fatal", "RANGE_HIGH"));
});

t("화이트리스트에 없는 경로 변경은 BLOCK", () => {
  const res = run(poison({ "minimumWage.note": "임의로 고침" }));
  expectBlock(res, "UNLISTED_CHANGE");
});

t("새 키 추가는 BLOCK", () => {
  const c = clone(BASE);
  c.healthInsurance.premiumBounds = { max: 9183480, min: 20160 };
  const res = run(c);
  expectBlock(res, "KEY_ADDED");
});

// ══════════════ 8. lastVerified ══════════════
t("lastVerified 가 미래면 FATAL", () => {
  const res = run(poison({ lastVerified: "2027-01-01" }));
  expectFatal(res, "LAST_VERIFIED_FUTURE");
});

t("lastVerified 가 400일 넘게 낡으면 FATAL", () => {
  const res = run(poison({ lastVerified: "2025-01-01" }), { current: null });
  expectFatal(res, "LAST_VERIFIED_STALE");
});

t("lastVerified 가 45일 넘게 낡으면 WARN", () => {
  const res = run(poison({ lastVerified: "2026-05-01" }), { current: null });
  assert.ok(hasCode(res, "warn", "LAST_VERIFIED_AGING"));
  assert.deepStrictEqual(codes(res, "fatal"), []);
});

t("lastVerified 형식이 깨지면 FATAL", () => {
  const res = run(poison({ lastVerified: "2026-8-19" }));
  expectFatal(res, "LAST_VERIFIED_FORMAT");
});

// ══════════════ 9. 간이세액표 ══════════════
t("간이세액표 행 수가 645 면 FATAL", () => {
  const bad = clone(TAX);
  bad.rows = bad.rows.slice(0, 645);
  const res = sanity.validateTaxTable(bad, RULES, null);
  assert.ok(hasCode(res, "fatal", "TAX_ROW_COUNT"));
});

t("간이세액표 구간 연속성이 깨지면 FATAL", () => {
  const bad = clone(TAX);
  bad.rows[100][0] = bad.rows[100][0] + 5;
  const res = sanity.validateTaxTable(bad, RULES, null);
  assert.ok(hasCode(res, "fatal", "TAX_CONTINUITY"));
});

t("부양가족이 늘었는데 세액이 늘면(셀 밀림) FATAL", () => {
  const bad = clone(TAX);
  const i = bad.rows.findIndex((r) => r[2] > 0);
  bad.rows[i][4] = bad.rows[i][3] + 1000;
  const res = sanity.validateTaxTable(bad, RULES, null);
  assert.ok(hasCode(res, "fatal", "TAX_DEPENDENT_MONOTONIC") || hasCode(res, "fatal", "TAX_INCOME_MONOTONIC"));
});

t("급여가 올랐는데 세액이 줄면 FATAL", () => {
  const bad = clone(TAX);
  const i = bad.rows.findIndex((r) => r[2] > 100000);
  bad.rows[i][2] = 10;
  const res = sanity.validateTaxTable(bad, RULES, null);
  assert.ok(hasCode(res, "fatal", "TAX_INCOME_MONOTONIC"));
});

t("세액이 월급여의 45%를 넘으면 FATAL(셀 밀림)", () => {
  const bad = clone(TAX);
  bad.rows[600][2] = Math.round(bad.rows[600][0] * 1000 * 0.6);
  const res = sanity.validateTaxTable(bad, RULES, null);
  assert.ok(hasCode(res, "fatal", "TAX_RATIO") || hasCode(res, "fatal", "TAX_MULTIPLE"));
});

t("음수 세액은 FATAL", () => {
  const bad = clone(TAX);
  bad.rows[300][5] = -10;
  const res = sanity.validateTaxTable(bad, RULES, null);
  assert.ok(hasCode(res, "fatal", "TAX_CELL_TYPE"));
});

t("★본표가 한 셀이라도 바뀌면 BLOCK★ (2024판과 2026판의 646행이 동일했다)", () => {
  const next = clone(TAX);
  next.rows[500][5] = next.rows[500][5] + 10;
  const res = sanity.validateTaxTable(next, RULES, TAX);
  assert.ok(hasCode(res, "block", "TAX_TABLE_CHANGED"));
});

// ══════════════ 10. 실수령액 회귀 ══════════════
t("실수령액이 임계 이상 흔들리면 차단된다", () => {
  const rules = clone(RULES);
  rules.netPayRegression.fatalPctOfGross = 0.0001; // 0.01%p
  rules.netPayRegression.blockPctOfGross = 0.00005;
  const res = run(
    poison({
      "healthInsurance.totalRate": 0.0729,
      "healthInsurance.employeeRate": 0.03645,
      "longTermCare.rateOfIncome": Math.round(0.0729 * 0.1314 * 1e6) / 1e6,
    }),
    { rules }
  );
  expectFatal(res, "REGRESSION_DELTA");
});

t("변경이 없으면 실수령액 회귀 델타가 0 이다", () => {
  const res = run(BASE);
  assert.ok(res.regression.length > 0, "바스켓이 실행돼야 함");
  for (const r of res.regression) assert.strictEqual(r.delta, 0, `${JSON.stringify(r.input)} 델타가 0 이 아님`);
});

// ══════════════ 11. 낡음(staleness) 감시 ══════════════
t("7월이 지났는데 당해 7-01 구간이 없으면 FATAL", () => {
  const c = clone(BASE);
  c.nationalPension.baseIncomeBrackets = [{ from: "2025-07-01", to: "2026-12-31", min: 400000, max: 6370000 }];
  const res = sanity.checkStaleness(c, RULES, "2026-07-02");
  assert.ok(hasCode(res, "fatal", "STALE_BASE_INCOME"));
});

t("원장 연도가 과거면 FATAL", () => {
  const res = sanity.checkStaleness(BASE, RULES, "2027-01-02");
  assert.ok(hasCode(res, "fatal", "LEDGER_YEAR_PAST"));
});

t("8월 20일 이후에는 다음 연도 최저임금 확인 WARN 이 뜬다", () => {
  const res = sanity.checkStaleness(BASE, RULES, "2026-08-21");
  assert.ok(hasCode(res, "warn", "STALE_NEXT_MW"));
});

t("정상 시점에는 낡음 경보가 없다", () => {
  const res = sanity.checkStaleness(BASE, RULES, "2026-08-19");
  assert.deepStrictEqual(codes(res, "fatal"), []);
  assert.deepStrictEqual(codes(res, "warn"), []);
});

// ══════════════ 12. 교차검증 게이트 (update-rates) ══════════════
function obsOf(facts, extra) {
  return {
    schema: "salarynote/observations@1",
    fetchedAt: "2026-08-19T00:00:00.000Z",
    targetYear: 2026,
    facts,
    failures: [],
    notes: [],
    ...(extra || {}),
  };
}
function fact(value, sourceIds, agree) {
  const ok = agree !== false;
  return {
    value,
    valueFrom: sourceIds[0],
    agree: ok,
    independentSources: sourceIds.length,
    singleSource: sourceIds.length < 2,
    autoMerge: ok && sourceIds.length >= 2,
    disagreement: ok ? null : [value, "다른값"],
    observations: sourceIds.map((s, i) => ({ sourceId: s, tier: i === 0 ? "primary" : "secondary", value, url: `https://example.invalid/${s}`, quote: "" })),
  };
}

t("★독립 출처 2개가 일치하면 후보에 반영된다★", () => {
  const obs = obsOf({ "minimumWage.hourly": fact(10500, ["law.go.kr", "minimumwage.go.kr"]) });
  const b = buildCandidate(BASE, obs, "2026-08-19");
  assert.strictEqual(b.candidate.minimumWage.hourly, 10500);
  assert.strictEqual(b.deferred.length, 0);
});

t("★출처가 1개뿐이면 반영하지 않고 사람에게 넘긴다★", () => {
  const obs = obsOf({ "minimumWage.hourly": fact(10500, ["minimumwage.go.kr"]) });
  const b = buildCandidate(BASE, obs, "2026-08-19");
  assert.strictEqual(b.candidate.minimumWage.hourly, 10320, "원장 값이 유지돼야 한다");
  assert.strictEqual(b.deferred.length, 1);
  assert.ok(b.deferred[0].reasons.join(" ").includes("독립 출처가 1개"));
});

t("★출처가 불일치하면 반영하지 않는다★", () => {
  const obs = obsOf({ "healthInsurance.totalRate": fact(0.0729, ["law.go.kr", "4insure"], false) });
  const b = buildCandidate(BASE, obs, "2026-08-19");
  assert.strictEqual(b.candidate.healthInsurance.totalRate, 0.0719);
  assert.ok(b.deferred[0].reasons.join(" ").includes("출처 불일치"));
});

t("★회귀★ 값이 원장과 같아도 출처가 불일치하면 조용히 넘어가지 않는다", () => {
  // 원장은 10320. 1차 출처도 10320 이라 '값 변경 없음' 으로 보이지만,
  // 2차 출처가 다른 값을 말하는 중이면 그 항목은 사실상 단일 출처로 떨어진 것이다.
  // 이전 구현은 same(before, value) 조기 반환 때문에 이 상태를 '재확인 완료' 로 삼켜
  // 리포트에 '전 항목 통과' 를 찍고 종료 코드 0 을 냈다. 값이 아니라 검증이 무너진 케이스라
  // 더 오래 안 들킨다.
  const obs = obsOf({ "minimumWage.hourly": fact(10320, ["law.go.kr", "minimumwage.go.kr"], false) });
  const b = buildCandidate(BASE, obs, "2026-08-19");
  assert.strictEqual(b.candidate.minimumWage.hourly, 10320, "원장 값은 그대로여야 한다");
  assert.strictEqual(b.conflicts.length, 1, "출처 불일치가 conflicts 로 보고돼야 한다");
  assert.strictEqual(b.conflicts[0].path, "minimumWage.hourly");
  assert.ok(b.applied.find((a) => a.path === "minimumWage.hourly").conflicted, "재확인 항목에 conflicted 표시");
});

t("값이 같고 출처도 일치하면 conflicts 가 비어 있다", () => {
  const obs = obsOf({ "minimumWage.hourly": fact(10320, ["law.go.kr", "minimumwage.go.kr"]) });
  const b = buildCandidate(BASE, obs, "2026-08-19");
  assert.strictEqual(b.conflicts.length, 0);
});

t("★자녀공제액은 2출처가 일치해도 반영하지 않는다★", () => {
  const obs = obsOf({ "childTaxCredit.one": fact(25000, ["law.go.kr", "somewhere"]) });
  const b = buildCandidate(BASE, obs, "2026-08-19");
  assert.strictEqual(b.candidate.childTaxCredit.one, 20830);
  assert.ok(b.deferred[0].reasons.join(" ").includes("항상 사람이 확인"));
});

t("건강보험료율이 바뀌면 장기요양 파생값도 함께 맞춰진다", () => {
  const obs = obsOf({
    "healthInsurance.totalRate": fact(0.0729, ["law.go.kr", "4insure"]),
    "healthInsurance.employeeRate": fact(0.03645, ["law.go.kr", "4insure"]),
    "longTermCare.rateOfIncome": fact(0.009579, ["law.go.kr", "4insure"]),
  });
  const b = buildCandidate(BASE, obs, "2026-08-19");
  assert.strictEqual(b.candidate.healthInsurance.totalRate, 0.0729);
  assert.strictEqual(b.candidate.longTermCare.rateOfIncome, 0.009579);
  // round4(0.009579 / 0.0729) = 0.1314, round6(0.0729 x 0.1314) = 0.009579 -> 왕복 성립
  assert.strictEqual(b.candidate.longTermCare.rateOfHealthPremium, 0.1314);
  const res = run(b.candidate);
  assert.ok(!hasCode(res, "fatal", "LTC_DERIVATION"), "파생 정합성 FATAL 이 없어야 함");
});

t("파생값이 왕복하지 않으면 반영하지 않고 사람에게 넘긴다", () => {
  // rateOfIncome 만 어긋나게 주어 round4/round6 왕복을 깨뜨린다.
  const obs = obsOf({ "longTermCare.rateOfIncome": fact(0.0095, ["law.go.kr", "4insure"]) });
  const b = buildCandidate(BASE, obs, "2026-08-19");
  const d = b.deferred.find((x) => x.path === "longTermCare.rateOfHealthPremium");
  assert.ok(d, `파생값 보류가 있어야 함: ${JSON.stringify(b.deferred.map((x) => x.path))}`);
  assert.ok(d.reasons.join(" ").includes("왕복"));
});

/** FACT_MAP 전 필드를 '관측했고 값은 그대로'인 상태로 만든다. */
function allObserved(extra = {}) {
  // 전 필드를 '2개 출처가 일치했고 값은 원장 그대로'인 상태로 관측한 것처럼 만든다.
  // 값을 비워두면 전 필드가 deferred 로 빠져 하트비트 조건이 성립하지 않는다.
  const facts = {};
  for (const k of Object.keys(FACT_MAP)) {
    const cur = k.split(".").reduce((o, part) => (o == null ? o : o[part]), BASE);
    facts[k] = fact(cur, ["law.go.kr", "4insure.or.kr"]);
  }
  return obsOf({ ...facts, ...extra });
}

t("전 항목을 확인했고 값 변경이 없으면 lastVerified 가 갱신된다(하트비트)", () => {
  // 하트비트의 의미는 '실행했다'가 아니라 '전부 확인했고 그대로였다'이다.
  // 부분 관측으로도 도장이 찍히면 신선도 게이트가 거짓으로 리셋된다.
  const b = buildCandidate(BASE, allObserved(), "2026-09-01");
  assert.strictEqual(b.missing.length, 0, "전 필드가 관측돼야 한다");
  assert.strictEqual(b.deferred.length, 0, "보류된 필드가 없어야 한다");
  assert.strictEqual(b.conflicts.length, 0, "출처 충돌이 없어야 한다");
  assert.strictEqual(b.candidate.lastVerified, "2026-09-01");
  // 하트비트의 조건은 '변경 0건'이다. applied 는 '확인된 필드 수'라서 0이 아니다.
  const before = JSON.parse(JSON.stringify(BASE));
  const after = JSON.parse(JSON.stringify(b.candidate));
  before.lastVerified = after.lastVerified = "-";
  assert.deepStrictEqual(after, before, "값이 하나도 바뀌지 않아야 한다");
});

/* ── 완전성 게이트 회귀 (적대적 검증 critical) ──────────────────
   수집기가 팩트를 조용히 누락해도 '전 항목 통과'가 찍히던 결함.
   lastVerified 가 갱신되면 신선도 게이트·하트비트·healthchecks 세 감시가
   전부 리셋되어, 아무것도 검증하지 못한 실행이 침묵 감지 장치를 만족시킨다. */

t("관측이 누락되면 lastVerified 를 찍지 않는다", () => {
  const obs = allObserved();
  delete obs.facts["minimumWage.hourly"];
  delete obs.facts["minimumWage.monthly209h"];
  const b = buildCandidate(BASE, obs, "2026-09-01");
  assert.strictEqual(b.missing.length, 2);
  assert.strictEqual(b.lastVerifiedStamped, false, "누락이 있는데 하트비트가 찍혔다");
  assert.notStrictEqual(b.candidate.lastVerified, "2026-09-01");
});

t("팩트가 하나도 없으면 전 필드가 누락으로 잡힌다", () => {
  const b = buildCandidate(BASE, obsOf({}), "2026-09-01");
  assert.strictEqual(b.missing.length, Object.keys(FACT_MAP).length);
  assert.strictEqual(b.lastVerifiedStamped, false);
});

t("팩트 키 오타 한 글자도 누락으로 잡힌다", () => {
  const k = Object.keys(FACT_MAP)[0];
  const obs = allObserved();
  const moved = obs.facts[k];
  delete obs.facts[k];
  obs.facts[k + "X"] = moved;
  const b = buildCandidate(BASE, obs, "2026-09-01");
  assert.ok(b.missing.includes(k), "오타로 빠진 필드가 누락 목록에 없다");
  assert.strictEqual(b.lastVerifiedStamped, false);
});

t("값이 바뀐 섹션만 출처 URL 이 갱신된다", () => {
  const obs = obsOf({ "minimumWage.hourly": fact(10500, ["law.go.kr", "minimumwage.go.kr"]) });
  const b = buildCandidate(BASE, obs, "2026-08-19");
  assert.strictEqual(b.candidate.minimumWage.source, "https://example.invalid/law.go.kr");
  assert.strictEqual(b.candidate.healthInsurance.source, BASE.healthInsurance.source, "변경 없는 섹션의 URL 은 그대로여야 한다");
});

t("기준소득월액 새 구간은 자동 추가되지 않는다", () => {
  const obs = obsOf({
    "nationalPension.baseIncome.min": fact(420000, ["law.go.kr", "4insure", "nps.or.kr"]),
    "nationalPension.baseIncome.max": fact(6800000, ["law.go.kr", "4insure", "nps.or.kr"]),
    "nationalPension.baseIncome.from": fact("2027-07-01", ["law.go.kr"]),
    "nationalPension.baseIncome.to": fact("2028-06-30", ["law.go.kr"]),
  });
  const b = buildCandidate(BASE, obs, "2026-08-19");
  assert.strictEqual(b.candidate.nationalPension.baseIncomeBrackets.length, 2, "구간이 추가되면 안 된다");
  assert.ok(b.deferred.some((d) => d.path === "nationalPension.baseIncomeBrackets[+]"));
});

t("기존 구간의 금액 변경은 2출처 일치 시 반영된다", () => {
  const obs = obsOf({
    "nationalPension.baseIncome.min": fact(420000, ["law.go.kr", "4insure"]),
    "nationalPension.baseIncome.max": fact(6800000, ["law.go.kr", "4insure"]),
    "nationalPension.baseIncome.from": fact("2026-07-01", ["law.go.kr"]),
    "nationalPension.baseIncome.to": fact("2027-06-30", ["law.go.kr"]),
  });
  const b = buildCandidate(BASE, obs, "2026-08-19");
  assert.deepStrictEqual(b.candidate.nationalPension.baseIncomeBrackets[1], {
    from: "2026-07-01",
    to: "2027-06-30",
    min: 420000,
    max: 6800000,
  });
});

t("자동 갱신은 건강보험 상·하한을 건드리지 못한다", () => {
  // FACT_MAP 에 없는 경로라 수집돼도 보고만 되고 원장에는 쓰이지 않는다.
  // 이 값은 고시 원문을 사람이 확인해 넣은 것이므로 자동으로 바뀌면 안 된다.
  const obs = obsOf({
    "healthInsurance.premiumBounds.totalMax": fact(1, ["law.go.kr"]),
    "healthInsurance.premiumBounds.totalMin": fact(2, ["law.go.kr"]),
  });
  const b = buildCandidate(BASE, obs, "2026-08-19");
  assert.deepStrictEqual(
    b.candidate.healthInsurance.premiumBounds,
    BASE.healthInsurance.premiumBounds,
    "자동 갱신이 법정 상·하한을 덮어썼다"
  );
  assert.strictEqual(b.reportOnly.length, 2);
});

// ══════════════ 결과 ══════════════
console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
