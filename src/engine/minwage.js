/**
 * 최저임금 위반 확인 엔진
 *
 * 근거 (최저임금법, 법제처 원문 확인)
 *  - 제6조③ 최저임금액에 미치지 못하는 부분은 무효이며, 최저임금액과 같은 임금을
 *    지급하기로 한 것으로 본다. 즉 미달분은 청구할 수 있다.
 *  - 제6조④ 최저임금에 산입하는 임금은 '매월 1회 이상 정기적으로 지급하는 임금'.
 *    다만 각 호는 산입에서 제외한다.
 *      1호 소정근로시간 외 근로에 대한 임금(연장·야간·휴일수당 등)
 *      2호 상여금 중 월 환산액의 일정 비율
 *      3호 복리후생비(식대·교통비 등) 중 일정 비율
 *
 * ★본문의 비율을 그대로 쓰면 틀린다★
 *  제6조④2호 본문은 "100분의 25", 3호 나목은 "100분의 7"로 적혀 있으나,
 *  법률 제15666호 부칙 제2조가 연도별 비율을 따로 정한다.
 *      2020년 20%/5% · 2021년 15%/3% · 2022년 10%/2% · 2023년 5%/1%
 *      ★2024년부터는 둘 다 100분의 0★
 *  즉 2024년 이후에는 상여금과 복리후생비가 전액 산입된다.
 *  본문만 읽고 25%를 빼면 위반 여부 판정이 뒤집힌다.
 *  (국민연금법 본문 13% vs 부칙 연도별 요율과 같은 구조의 함정이다.)
 *
 * 주휴수당도 함께 본다. 월급을 시급으로 환산할 때 주휴시간을 포함한
 * 월 소정근로시간으로 나누는 것이 고용노동부의 계산 방식이다.
 */

const LEGAL = {
  // 부칙 제2조의 연도별 미산입 비율. 2024년부터 0이다.
  exclusionRateByYear: {
    2019: { bonus: 0.25, welfare: 0.07 },
    2020: { bonus: 0.20, welfare: 0.05 },
    2021: { bonus: 0.15, welfare: 0.03 },
    2022: { bonus: 0.10, welfare: 0.02 },
    2023: { bonus: 0.05, welfare: 0.01 },
  },
  exclusionRateFrom2024: { bonus: 0, welfare: 0 },
  probationDiscountRate: 0.9,      // 제5조② 수습 감액 (최저임금의 90%)
  probationMaxMonths: 3,
  probationMinContractMonths: 12,  // 1년 이상 계약이어야 감액 가능
};

const won = (n) => Math.round(n).toLocaleString("ko-KR");

function num(v, label, { min = 0, max = 1e11, required = false } = {}) {
  if (v === undefined || v === null || v === "") {
    if (required) throw new Error(`${label}을(를) 입력해 주세요.`);
    return 0;
  }
  if (typeof v === "boolean" || Array.isArray(v)) throw new Error(`${label}: 숫자만 입력할 수 있습니다.`);
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${label}: 숫자만 입력할 수 있습니다.`);
  if (n < min) throw new Error(`${label}은(는) ${min} 이상이어야 합니다.`);
  if (n > max) throw new Error(`${label}이(가) 계산 가능 범위를 벗어났습니다.`);
  return n;
}

/** 해당 연도의 미산입 비율. 2024년 이후는 전액 산입(0). */
function exclusionRates(year) {
  return LEGAL.exclusionRateByYear[year] || LEGAL.exclusionRateFrom2024;
}

/**
 * @param {object} input
 * @param {number} input.monthlyBasePay   매월 정기 지급하는 기본급·고정수당 합계(원)
 * @param {number} [input.monthlyBonus=0] 매월 지급하는 상여금(원)
 * @param {number} [input.monthlyWelfare=0] 식대·교통비 등 복리후생비(원)
 * @param {number} [input.overtimePay=0]  연장·야간·휴일수당(원). 산입되지 않는다.
 * @param {number} [input.weeklyHours=40] 1주 소정근로시간
 * @param {boolean} [input.probation=false] 수습 중인지
 * @param {number} [input.contractMonths=12] 근로계약 기간(개월)
 * @param {boolean} [input.simpleLabor=false] 단순노무업무 종사자인지
 */
function checkMinimumWage(input, rates) {
  const year = rates.year;
  const minHourly = rates.minimumWage.hourly;

  const base = num(input.monthlyBasePay, "기본급", { required: true });
  const bonus = num(input.monthlyBonus, "상여금");
  const welfare = num(input.monthlyWelfare, "복리후생비");
  const overtime = num(input.overtimePay, "연장·야간·휴일수당");
  const weekly = num(input.weeklyHours === undefined ? 40 : input.weeklyHours,
    "1주 소정근로시간", { min: 1, max: 68 });

  // ── 월 소정근로시간 (주휴시간 포함) ─────────────────────────
  const holidayHours = weekly >= 15 ? Math.min(weekly, 40) / 5 : 0;
  const monthlyHours = Math.round(((weekly + holidayHours) * (365 / 7)) / 12);

  // ── 산입 임금 ────────────────────────────────────────────────
  const rate = exclusionRates(year);
  const minMonthly = minHourly * monthlyHours;              // 최저임금 월 환산액
  const bonusExcluded = Math.floor(minMonthly * rate.bonus);
  const welfareExcluded = Math.floor(minMonthly * rate.welfare);

  const bonusIncluded = Math.max(bonus - bonusExcluded, 0);
  const welfareIncluded = Math.max(welfare - welfareExcluded, 0);
  const included = base + bonusIncluded + welfareIncluded;   // overtime 은 제외(제6조④1호)

  // ── 수습 감액 ────────────────────────────────────────────────
  const contractMonths = num(input.contractMonths === undefined ? 12 : input.contractMonths,
    "근로계약 기간", { min: 0, max: 600 });
  const probationEligible =
    !!input.probation && !input.simpleLabor && contractMonths >= LEGAL.probationMinContractMonths;
  const appliedMinHourly = probationEligible
    ? Math.floor(minHourly * LEGAL.probationDiscountRate)
    : minHourly;

  // ── 판정 ─────────────────────────────────────────────────────
  const effectiveHourly = included / monthlyHours;
  const violation = effectiveHourly < appliedMinHourly;
  const requiredMonthly = appliedMinHourly * monthlyHours;
  const shortfall = violation ? Math.ceil(requiredMonthly - included) : 0;

  const warnings = [];
  if (rate.bonus === 0 && rate.welfare === 0) {
    warnings.push(
      `${year}년 기준으로 상여금과 복리후생비는 ★전액 산입★됩니다. ` +
      `최저임금법 제6조제4항 본문은 25%·7%를 빼도록 적혀 있지만, ` +
      `법률 제15666호 부칙 제2조가 2024년부터 그 비율을 0으로 정했습니다. ` +
      `본문만 보고 계산하면 위반 여부가 뒤집힙니다.`
    );
  }
  if (overtime > 0) {
    warnings.push(
      `연장·야간·휴일수당 ${won(overtime)}원은 최저임금 계산에 넣지 않았습니다. ` +
      `소정근로시간 외 근로에 대한 임금이라 산입 대상이 아닙니다(제6조제4항제1호).`
    );
  }
  if (input.probation && !probationEligible) {
    warnings.push(
      input.simpleLabor
        ? "단순노무업무 종사자는 수습이어도 최저임금을 감액할 수 없습니다."
        : `근로계약 기간이 ${contractMonths}개월로 1년 미만이라 수습 감액이 불가능합니다. ` +
          `계약기간이 1년 이상일 때만 수습 3개월 이내에 90%까지 감액할 수 있습니다.`
    );
  } else if (probationEligible) {
    warnings.push(
      `수습 감액을 적용해 시간급 ${won(appliedMinHourly)}원(최저임금의 90%)을 기준으로 판정했습니다. ` +
      `수습 시작일부터 3개월까지만 가능합니다.`
    );
  }
  if (violation) {
    warnings.push(
      `최저임금에 미달하는 부분은 무효이며, 그 부분은 최저임금액과 같은 임금을 ` +
      `지급하기로 한 것으로 봅니다(제6조제3항). 차액을 청구할 수 있고 임금채권 시효는 3년입니다.`
    );
  }
  warnings.push(
    "주휴수당은 월 소정근로시간에 포함해 계산했습니다. 주휴수당을 빼고 시급을 따지면 " +
    "실제보다 높게 나와 위반을 놓칠 수 있습니다."
  );

  return {
    year, monthlyHours, weeklyHours: weekly, holidayHoursPerWeek: holidayHours,
    minHourly, appliedMinHourly, probationApplied: probationEligible,
    basePay: base, bonus, welfare, overtime,
    bonusExcluded, welfareExcluded, includedWage: included,
    effectiveHourly: Math.floor(effectiveHourly),
    requiredMonthly, violation, shortfall,
    warnings,
    basis: {
      "월 소정근로시간": `(주 ${weekly} + 주휴 ${holidayHours}) × 52.1429주 ÷ 12 = ${monthlyHours}시간`,
      "산입 임금": `기본급 ${won(base)}` +
        (bonus ? ` + 상여금 ${won(bonus)}` + (bonusExcluded ? `(미산입 ${won(bonusExcluded)} 차감)` : "(전액 산입)") : "") +
        (welfare ? ` + 복리후생비 ${won(welfare)}` + (welfareExcluded ? `(미산입 ${won(welfareExcluded)} 차감)` : "(전액 산입)") : "") +
        ` = ${won(included)}원`,
      "환산 시급": `${won(included)} ÷ ${monthlyHours}시간 = ${won(effectiveHourly)}원`,
      "비교 기준": probationEligible
        ? `${won(minHourly)} × 90% = ${won(appliedMinHourly)}원 (수습 감액)`
        : `${year}년 최저임금 ${won(minHourly)}원`,
      "판정": violation
        ? `${won(effectiveHourly)} < ${won(appliedMinHourly)} → 위반. 월 ${won(shortfall)}원 부족`
        : `${won(effectiveHourly)} ≥ ${won(appliedMinHourly)} → 위반 아님`,
    },
  };
}

module.exports = { checkMinimumWage, exclusionRates, LEGAL };
