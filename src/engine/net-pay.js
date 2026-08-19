/**
 * 실수령액 통합 계산 엔진
 *
 * 4대보험(insurance.js) + 근로소득세/지방소득세(income-tax.js) 를 묶어
 * "총지급액 → 실수령액" 한 줄을 만든다.
 *
 * ★ 이 파일에서 가장 중요한 판단: 부과기준의 동일성 ★
 * ─────────────────────────────────────────────────────────────────────
 * 비과세소득은 소득세 과세표준과 4대보험 보수월액(기준소득월액) 양쪽에서
 * "동일하게" 차감된다. 세 법령이 모두 부과기준을 아래와 같이 정의하기 때문이다.
 *
 *   국민연금   : 기준소득월액 = 근로소득 - 비과세근로소득  (국민연금법 시행령 제3조)
 *   건강/장기요양: 보수월액   = 근로소득 - 비과세근로소득  (국민건강보험법 시행령 제33조제1항제3호)
 *   고용보험   : 보수         = 근로소득 - 비과세근로소득  (고용산재보험료징수법 제2조제3호)
 *
 * 따라서 '과세대상급여' 라는 값 하나를 만들어 두 엔진에 똑같이 먹인다.
 * 비과세를 소득세에만 반영하고 4대보험에는 총액을 쓰는 것이 실무에서 가장 잦은 오류다.
 * 그렇게 하면 전체가 틀린다.
 *
 * 실수령액 = 총지급액 - 4대보험 - 소득세 - 지방소득세
 * 비과세분은 공제 대상이 아닐 뿐 실제로 지급되는 돈이므로 총지급액에 그대로 남는다.
 * (총지급액에서 비과세를 빼면 안 된다.)
 *
 * [알려진 예외 — v1 미구현, 국내 근무자에게는 발생하지 않음]
 * 국민건강보험법 시행령 제33조제1항제3호 단서는 소득세법 제12조제3호 차목·파목·거목
 * (외국정부·국제기관 근무자 급여, 국외근로소득 등)의 비과세소득을 보수에서 빼지 않는다.
 * 즉 국외근로소득 월 100만원은 소득세는 비과세인데 건강보험료는 부과된다.
 * 국내 근무 직장인 대상 계산기에서는 이 경로가 발생하지 않아 구현하지 않았다.
 * 국외근로 항목을 UI 에 추가하는 순간 이 분기를 반드시 만들어야 한다.
 */

const path = require("path");
const { calcSocialInsurance, normalizePayDate } = require(path.join(
  __dirname,
  "insurance.js"
));
const {
  calcIncomeTax,
  calcLocalIncomeTax,
} = require(path.join(__dirname, "income-tax.js"));

const won = (n) => Math.round(n).toLocaleString("ko-KR");

/**
 * 금액 입력을 검증하고 원 단위 정수로 정규화한다.
 *
 * ★Math.floor 의 강제변환에 기대면 안 된다.★ 이 함수가 없을 때 실제로 통과하던 값들:
 *   Math.floor('')        === 0          빈 입력창이 그대로 넘어오면 총지급액 0원
 *   Math.floor(true)      === 1          불리언이 1원짜리 급여가 된다
 *   Math.floor([3000000]) === 3000000    배열이 통과한다
 * 그래서 typeof 로 타입부터 본 뒤 유한성·부호·상한을 확인한다.
 *
 * 정규화(Math.floor)까지 여기서 하는 이유: 소수점 비과세액(200000.7)이 그대로
 * insurance 엔진에 들어가면 보수월액이 2,999,999.3 이 되어 건강보험료가 10원 틀리고
 * basis 문자열에도 소수점 보수월액이 찍힌다.
 */
function requireMoney(value, label, limits) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `${label}은(는) 유한한 숫자여야 합니다. 받은 값: ${JSON.stringify(
        value
      )} (${typeof value})`
    );
  }
  if (value < 0) {
    throw new Error(`${label}은(는) 음수일 수 없습니다: ${value}`);
  }
  const max = limits && limits.maxMonthlySalary;
  if (typeof max === "number" && value > max) {
    throw new Error(
      `${label}이(가) 계산 가능 범위를 벗어났습니다: ${value} > ${max}. ` +
        `(data/rates-*.json 의 inputLimits.maxMonthlySalary — 법정 상한이 아니라 오버플로 방어값입니다.)`
    );
  }
  return Math.floor(value);
}

/**
 * 연봉을 월급으로 환산한다.
 *
 * - 퇴직금 별도(원칙): 연봉 / 12. 퇴직금은 근로자퇴직급여보장법상 퇴직 시 별도로 발생한다.
 * - 퇴직금 포함: 연봉 / 13 이 업계 관행이지만 ★법적 근거가 없다★.
 *   퇴직금을 매월 분할지급하는 약정 자체가 무효다
 *   (대법원 2010.5.20. 2007다90760 전합, 2012.3.29. 2010다91046).
 *   그래서 divisor 13 을 쓰면 결과에 warnings 를 실어 보낸다. UI 는 이 경고를 반드시 띄울 것.
 *   ÷13 외에 '÷12 후 그중 1/13을 퇴직금으로 본다'는 변형 관행도 병존하며
 *   업계 통일 방식이 없다. 어느 쪽을 기본값으로 할지는 제품 결정 사항이다.
 *
 * 1원 미만은 절사한다. 급여 실무 관행이며 법령 명문 근거는 확인하지 못했다. [추론]
 */
function annualToMonthly(annualSalary, divisor) {
  return Math.floor(annualSalary / divisor);
}

/**
 * @param {object} input
 * @param {number} [input.annualSalary]   연봉(원). monthlySalary 와 택일.
 * @param {number} [input.monthlySalary]  월 총지급액(원). annualSalary 와 택일.
 * @param {number} [input.monthsPerYear=12] 연봉 -> 월급 환산 제수. 퇴직금 포함 계약이면 13(관행).
 * @param {number} [input.nonTaxable=0]   월 비과세액 합계(원).
 *        ★한도 검증은 이 엔진이 하지 않는다.★ 식대 20만/자가운전 20만/보육수당 자녀당 20만 등
 *        항목별 한도 적용은 별도 calcNonTaxable + data/nontaxable-*.json 의 몫이다.
 *        여기에는 '이미 한도가 적용된 비과세 합계'를 넣어야 한다.
 * @param {number} [input.tuition=0]      학자금(원). 아래 주석 참고. 기본 0.
 * @param {number} input.dependents       공제대상가족 수(본인 포함). 1 이상.
 * @param {number} [input.children=0]     자녀 공제 대상 수. ★미확정으로 기본 0 고정, UI 미노출★
 * @param {string} input.payDate          급여 지급일 'YYYY-MM-DD'. 국민연금 상·하한 구간 선택에 쓰인다.
 * @param {number} [input.withholdingRatio=1.0] 80/100/120% 선택.
 */
function calcNetPay(input, rates, taxTable) {
  const {
    annualSalary,
    monthlySalary,
    monthsPerYear = 12,
    nonTaxable = 0,
    tuition = 0,
    dependents,
    children = 0,
    payDate,
    withholdingRatio,
  } = input;

  if ((annualSalary == null) === (monthlySalary == null)) {
    throw new Error("annualSalary 와 monthlySalary 중 정확히 하나만 지정해야 합니다.");
  }
  if (!payDate) throw new Error("payDate('YYYY-MM-DD')는 필수입니다. 국민연금 상·하한 구간이 7월 1일에 바뀝니다.");

  const limits = rates.inputLimits;

  // 지급일은 국민연금 상·하한 구간 선택에 쓰이고, 구간 판정이 문자열 사전순 비교라
  // 형식이 흔들리면(예: '2026-1-15') 조용히 잘못된 구간이 선택된다.
  // insurance.js 안쪽에서도 검증하지만, 진입부에서 먼저 걸러 4대보험 계산에
  // 도달하기 전에 멈춘다.
  normalizePayDate(payDate);

  // 비과세·학자금은 검증 후 원 단위 정수로 정규화한다.
  // 정규화된 값을 이후 계산과 반환 객체 양쪽에 쓴다 — 입력 타입이 그대로
  // 결과 객체에 실려 나가면 UI 가 gross - result.nonTaxable 을 할 때 문자열 연결이 난다.
  const nonTaxableWon = requireMoney(nonTaxable, "비과세액", limits);
  const tuitionWon = requireMoney(tuition, "학자금", limits);

  const warnings = [];
  const basis = [];

  // ── STEP 0. 총지급액(월) ────────────────────────────────────────
  let gross;
  if (monthlySalary != null) {
    gross = requireMoney(monthlySalary, "월 총지급액", limits);
    basis.push(`월 총지급액 ${won(gross)}원`);
  } else {
    // 연봉 환산 제수는 법정 3종이 아니라 관행이므로 화이트리스트로 제한한다.
    // 검증이 없을 때: monthsPerYear -12 는 월급 -3,000,000 을 만들고,
    // 0.5 는 72,000,000 을 만들며, 0 은 Infinity 를 만들어 엉뚱한 곳에서 터졌다.
    const choices = (limits && limits.monthsPerYearChoices) || [12, 13];
    if (!choices.includes(monthsPerYear)) {
      throw new Error(
        `연봉 환산 제수(monthsPerYear)는 ${choices.join(
          " 또는 "
        )} 만 가능합니다: ${JSON.stringify(monthsPerYear)} (${typeof monthsPerYear}). ` +
          `12 = 퇴직금 별도(원칙), 13 = 퇴직금 포함 관행.`
      );
    }
    const annualWon = requireMoney(
      annualSalary,
      "연봉",
      limits && { maxMonthlySalary: limits.maxMonthlySalary * choices[0] }
    );
    gross = annualToMonthly(annualWon, monthsPerYear);
    basis.push(
      `연봉 ${won(annualWon)}원 ÷ ${monthsPerYear} = 월 총지급액 ${won(gross)}원 (1원 미만 절사)`
    );
    // 엄격비교로 남겨둔다. monthsPerYear 는 위에서 화이트리스트 검증을 통과했으므로
    // 이 시점에 문자열 '12' 는 존재할 수 없다. (검증 전에는 '12' !== 12 때문에
    // 아무 잘못 없는 사용자에게 퇴직금 무효 판례 경고가 떴다.)
    if (monthsPerYear !== 12) {
      warnings.push(
        "퇴직금 포함 연봉을 " +
          monthsPerYear +
          "로 나누는 것은 업계 관행일 뿐 법적 근거가 없습니다. 퇴직금을 매월 분할지급하는 약정은 대법원 판례상 무효이며(2007다90760 전원합의체), 퇴직 시 별도로 퇴직금을 청구할 수 있습니다."
      );
    }
  }

  // 비과세·학자금은 총지급액의 '일부' 다. 합이 총지급액을 넘는 입력은 성립하지 않는다.
  // 검증이 없을 때는 Math.max(0, ...) 가 조용히 0으로 눌러버려서,
  // 비과세 자리에 총급여를 잘못 넣는 흔한 UI 오류가 '그럴듯한 결과' 로 삼켜졌다.
  if (nonTaxableWon + tuitionWon > gross) {
    throw new Error(
      `비과세액(${won(nonTaxableWon)}원) + 학자금(${won(tuitionWon)}원) = ${won(
        nonTaxableWon + tuitionWon
      )}원 이 월 총지급액 ${won(gross)}원을 초과합니다. ` +
        `비과세와 학자금은 총지급액에 포함된 일부 항목이므로 총지급액보다 클 수 없습니다. 입력값을 확인하십시오.`
    );
  }

  // ── STEP 1. 과세대상급여 ─────────────────────────────────────────
  //
  // 4대보험 보수월액과 소득세 월급여액은 원칙적으로 같은 값이다(파일 상단 주석 참조).
  // 다만 '학자금' 은 다르게 다룬다. 보수적 구현이며 근거는 다음과 같다.
  //
  //   별표2 비고 5호: 간이세액표는 학자금을 제외한 월급여액 기준으로 계산할 수 있다.
  //   → 이 규정이 존재한다는 것은 여기서 말하는 학자금이 '과세 근로소득' 임을 뜻한다.
  //     (비과세라면 이미 빠져 있어 따로 규정할 이유가 없다.)
  //   → 과세 근로소득이라면 4대보험 보수에는 포함된다.
  //
  // 그래서 학자금은 소득세 과세표준에서만 빼고 4대보험 보수에서는 빼지 않는다.
  // 이는 [추론]이며 보수적(=보험료를 덜 계산하지 않는) 방향의 선택이다.
  // 학자금이 비과세 요건(소득세법 시행령 제11조)을 충족하는 사내 학자금이라면
  // tuition 이 아니라 nonTaxable 에 합산해서 넣어야 양쪽에서 모두 빠진다.
  // 기본값이 0 이므로 일반적인 경우 두 부과기준은 완전히 동일한 값이 된다.
  // 위에서 nonTaxableWon + tuitionWon <= gross 를 검증했으므로 두 값 모두 음수가 아니다.
  // Math.max(0, ...) 는 방어적으로 남겨둔다.
  const insuranceBase = Math.max(0, gross - nonTaxableWon);
  const taxBase = Math.max(0, gross - nonTaxableWon - tuitionWon);

  basis.push(
    `과세대상급여(4대보험 보수월액) = ${won(gross)} - 비과세 ${won(nonTaxableWon)} = ${won(insuranceBase)}원`
  );
  if (tuitionWon > 0) {
    basis.push(
      `소득세 월급여액 = ${won(gross)} - 비과세 ${won(nonTaxableWon)} - 학자금 ${won(tuitionWon)} = ${won(taxBase)}원 (별표2 비고 5호)`
    );
    warnings.push(
      "학자금은 소득세 계산에서만 제외했고 4대보험 보수에는 포함했습니다(별표2 비고 5호에 근거한 보수적 처리). 비과세 요건을 충족하는 학자금이라면 비과세액에 합산해 입력하십시오."
    );
  } else {
    basis.push("소득세 월급여액 = 4대보험 보수월액과 동일 (비과세는 양쪽에서 똑같이 차감된다)");
  }

  // ── STEP 2. 4대보험 (근로자 부담분) ──────────────────────────────
  // 국민연금 기준소득월액의 상·하한 clamp 도 총지급액이 아니라 이 과세대상급여에 적용된다.
  const insurance = calcSocialInsurance(insuranceBase, rates, payDate);
  basis.push(`국민연금 ${won(insurance.pension.amount)}원 — ${insurance.pension.basis.산식}`);
  basis.push(`건강보험 ${won(insurance.health.amount)}원 — ${insurance.health.basis.산식}`);
  basis.push(`장기요양 ${won(insurance.care.amount)}원 — ${insurance.care.basis.산식}`);
  basis.push(`고용보험 ${won(insurance.employment.amount)}원 — ${insurance.employment.basis.산식}`);

  // ── STEP 3. 소득세 / 지방소득세 ──────────────────────────────────
  const incomeTax = calcIncomeTax(
    {
      monthlyIncome: taxBase,
      dependents,
      children,
      withholdingRatio,
    },
    taxTable,
    rates
  );
  incomeTax.basis.forEach((b) => basis.push(`소득세: ${b}`));

  const localIncomeTax = calcLocalIncomeTax(incomeTax.amount, rates);
  basis.push(`지방소득세: ${localIncomeTax.basis.산식}`);

  // ── STEP 4. 합계 ────────────────────────────────────────────────
  const totalDeduction =
    insurance.total + incomeTax.amount + localIncomeTax.amount;
  const netPay = gross - totalDeduction;

  basis.push(
    `공제 합계 = 4대보험 ${won(insurance.total)} + 소득세 ${won(incomeTax.amount)} + 지방소득세 ${won(localIncomeTax.amount)} = ${won(totalDeduction)}원`
  );
  basis.push(`실수령액 = 총지급액 ${won(gross)} - 공제 합계 ${won(totalDeduction)} = ${won(netPay)}원`);

  // ── STEP 5. 비정상 결과 고지 ─────────────────────────────────────
  //
  // 총지급액을 0 이상으로 검증해도 음수 실수령액은 여전히 나올 수 있다.
  // 국민연금 기준소득월액에 하한(41만원)이 있어서, 보수가 그보다 훨씬 적어도
  // 하한 기준 보험료 19,470원이 부과되기 때문이다.
  // 손익분기점은 총지급액 약 22,000원이며 그 이하면 항상 음수가 된다.
  // 이 경우 결과 자체는 산식대로지만 정상적인 급여 입력이 아니므로 반드시 알린다.
  // (throw 하지 않는 이유: 무급휴직 등 보수 0원인 달이 실재하고, 그 달에 하한
  //  보험료가 부과되는지는 자격 유지 여부에 달린 별도 판단 사항이다.)
  if (insuranceBase === 0) {
    warnings.push(
      "과세대상급여(4대보험 보수월액)가 0원입니다. 그럼에도 국민연금은 기준소득월액 하한이 적용되어 보험료가 부과된 것으로 계산되었습니다. 무급휴직 등 실제로 보수가 0원인 달에 하한 보험료가 부과되는지는 가입자 자격 유지 여부에 따라 달라지므로, 이 결과를 그대로 신뢰하지 마십시오."
    );
  }
  if (netPay < 0) {
    warnings.push(
      `공제 합계(${won(totalDeduction)}원)가 총지급액(${won(
        gross
      )}원)을 초과해 실수령액이 음수(${won(
        netPay
      )}원)로 계산되었습니다. 국민연금 기준소득월액 하한 때문에 발생하는 현상이며 정상적인 급여 입력이 아닙니다. 입력값을 확인하십시오.`
    );
  }

  // 계산기의 구조적 한계. 화면에 반드시 고지한다.
  warnings.push(
    "본 계산은 당월 급여 기준 추정치입니다. 국민연금 기준소득월액은 전년도 소득을 기준으로 매년 7월에 정기결정되어 다음해 6월까지 고정되고, 건강보험은 다음해 4월 연말정산으로 정산되므로 실제 고지액과 다를 수 있습니다. 고용보험만 당월 보수 기준으로 거의 정확합니다."
  );
  warnings.push(
    "소득세는 간이세액표에 따른 원천징수 추정액이며, 실제 연간 세부담은 연말정산으로 확정됩니다."
  );

  return {
    gross,                 // 월 총지급액 (비과세 포함)
    nonTaxable: nonTaxableWon, // 비과세 합계 (검증·정규화된 정수)
    tuition: tuitionWon,       // 학자금 (검증·정규화된 정수)
    insuranceBase,         // 4대보험 보수월액 / 기준소득월액 산정 대상
    taxBase,               // 소득세 월급여액
    insurance: {
      pension: insurance.pension.amount,
      health: insurance.health.amount,
      care: insurance.care.amount,
      employment: insurance.employment.amount,
      total: insurance.total,
      detail: insurance,
    },
    incomeTax: incomeTax.amount,
    localIncomeTax: localIncomeTax.amount,
    totalDeduction,
    netPay,
    detail: {
      insurance,
      incomeTax,
      localIncomeTax,
    },
    warnings,
    basis,
  };
}

module.exports = { calcNetPay, annualToMonthly };
