/**
 * 아르바이트·단시간 근로자 급여 계산 엔진
 *
 * 이 계산기의 핵심은 금액이 아니라 **4대보험 가입 여부 판정**이다.
 * 대부분의 알바 계산기는 시급 x 시간만 계산하고 보험 적용을 무시하는데,
 * 실제로는 주 15시간 / 월 60시간 경계에서 실수령액이 크게 갈린다.
 *
 * 근거
 *  - 국민연금법 시행령 제2조제4호: 1개월 소정근로시간 60시간 미만 단시간근로자는
 *    '근로자'에서 제외된다(= 사업장가입 대상 아님).
 *  - 국민건강보험법 시행령 제9조: 1개월 소정근로시간 60시간 미만 단시간근로자는
 *    직장가입자에서 제외된다.
 *  - 고용보험법 시행령 제3조: 1개월 소정근로시간 60시간 미만(주 15시간 미만 포함)은
 *    적용 제외. 다만 3개월 이상 계속 근로하는 사람과 일용근로자는 적용된다.
 *  - 근로기준법 제55조 및 시행령 제30조: 주휴수당은 주 15시간 이상일 때 발생.
 *  - 산재보험은 사업주 전액 부담이라 근로자 공제액에 나타나지 않는다.
 */

const path = require("path");
const { calcSocialInsurance, normalizePayDate } = require(path.join(__dirname, "insurance.js"));
const { calcIncomeTax, calcLocalIncomeTax } = require(path.join(__dirname, "income-tax.js"));

/** 법정 경계값. 시행령에 직접 규정된 숫자라 여기 둔다. */
const THRESHOLD = {
  monthlyHoursForInsurance: 60,   // 국민연금·건강보험·고용보험 공통
  weeklyHoursForHoliday: 15,      // 주휴수당 및 고용보험
  monthsForEmploymentInsurance: 3, // 3개월 이상 계속 근로 시 고용보험 적용
  weeksPerYear: 365 / 7,
  workDaysPerWeek: 5,
};

const won = (n) => Math.round(n).toLocaleString("ko-KR");

function num(v, label, { min = 0, max = 1e9 } = {}) {
  if (v === undefined || v === null || v === "") return 0;
  if (typeof v === "boolean" || Array.isArray(v)) throw new Error(`${label}: 숫자만 입력할 수 있습니다.`);
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${label}: 숫자만 입력할 수 있습니다.`);
  if (n < min) throw new Error(`${label}은(는) ${min} 이상이어야 합니다.`);
  if (n > max) throw new Error(`${label}이(가) 계산 가능 범위를 벗어났습니다.`);
  return n;
}

/**
 * @param {object} input
 * @param {number} input.hourlyWage    시급(원)
 * @param {number} input.weeklyHours   1주 소정근로시간
 * @param {number} [input.monthsEmployed=1] 계속근로 개월 수 (고용보험 3개월 규칙)
 * @param {string} input.payDate       급여 지급일 'YYYY-MM-DD'
 */
function calcPartTimePay(input, rates, taxTable) {
  const wage = num(input.hourlyWage, "시급", { max: 1e8 });
  const weekly = num(input.weeklyHours, "1주 소정근로시간", { max: 68 });
  const months = num(input.monthsEmployed === undefined ? 1 : input.monthsEmployed, "계속근로 개월", { max: 600 });
  const payDate = normalizePayDate(input.payDate, "급여 지급일");

  // ── 근로시간과 급여 ──────────────────────────────────────────
  // 월 환산 시간은 시간 단위로 반올림한다. 고용노동부 고시가 주 40시간을
  // 208.57시간이 아니라 209시간으로 환산하는 관행을 따른 것이고,
  // 사이트 내 시급 환산 계산기와도 같은 규칙이어야 결과가 어긋나지 않는다.
  const rawMonthlyWorkHours = (weekly * THRESHOLD.weeksPerYear) / 12;
  const monthlyWorkHours = Math.round(rawMonthlyWorkHours);

  const eligibleHoliday = weekly >= THRESHOLD.weeklyHoursForHoliday;
  const weeklyHolidayHours = eligibleHoliday ? Math.min(weekly, 40) / THRESHOLD.workDaysPerWeek : 0;
  const monthlyHolidayHours = Math.round((weeklyHolidayHours * THRESHOLD.weeksPerYear) / 12);

  const basePay = Math.floor(monthlyWorkHours * wage);
  const holidayPay = Math.floor(monthlyHolidayHours * wage);
  const gross = basePay + holidayPay;

  // ── 4대보험 적용 판정 ────────────────────────────────────────
  // 판정 기준은 '소정근로시간'이지 급여액이 아니다.
  const meetsHours = rawMonthlyWorkHours >= THRESHOLD.monthlyHoursForInsurance;
  const meetsWeekly = weekly >= THRESHOLD.weeklyHoursForHoliday;
  const longTerm = months >= THRESHOLD.monthsForEmploymentInsurance;

  const coverage = {
    pension: meetsHours,
    health: meetsHours,
    // 3개월 이상 계속 근로하면 단시간이어도 고용보험이 적용된다.
    employment: (meetsHours && meetsWeekly) || longTerm,
  };

  // ── 공제 ─────────────────────────────────────────────────────
  const full = calcSocialInsurance(gross, rates, payDate);
  const insurance = {
    pension: coverage.pension ? full.pension.amount : 0,
    health: coverage.health ? full.health.amount : 0,
    care: coverage.health ? full.care.amount : 0, // 장기요양은 건강보험에 딸린다
    employment: coverage.employment ? full.employment.amount : 0,
  };
  insurance.total = insurance.pension + insurance.health + insurance.care + insurance.employment;

  const tax = calcIncomeTax({ monthlyIncome: gross, dependents: 1 }, taxTable, rates);
  const localTax = calcLocalIncomeTax(tax.amount, rates);

  const totalDeduction = insurance.total + tax.amount + localTax.amount;
  const netPay = gross - totalDeduction;

  // ── 경고 ─────────────────────────────────────────────────────
  const warnings = [];
  const minWage = rates.minimumWage && rates.minimumWage.hourly;
  if (minWage && wage > 0 && wage < minWage) {
    warnings.push(
      `시급 ${won(wage)}원이 ${rates.year}년 최저임금 ${won(minWage)}원보다 낮습니다. ` +
      `최저임금 미만 지급은 위법이며 실제로는 최저임금 기준으로 계산해야 합니다.`
    );
  }
  if (!eligibleHoliday) {
    warnings.push(
      `주 ${weekly}시간으로 15시간 미만이라 주휴수당이 발생하지 않습니다(초단시간근로자). ` +
      `퇴직금과 연차도 대상에서 제외됩니다.`
    );
  }
  if (!meetsHours) {
    warnings.push(
      `월 소정근로시간이 ${monthlyWorkHours}시간으로 60시간 미만이라 ` +
      `국민연금·건강보험 가입 대상이 아닙니다(국민연금법 시행령 제2조제4호 등).`
    );
  }
  if (!coverage.employment) {
    warnings.push(
      `고용보험도 적용되지 않습니다. 다만 ${THRESHOLD.monthsForEmploymentInsurance}개월 이상 계속 근로하면 ` +
      `단시간이어도 적용 대상이 되므로, 근무가 길어지면 다시 계산해 보세요.`
    );
  } else if (!meetsHours && longTerm) {
    warnings.push(
      `월 60시간 미만이지만 ${months}개월째 계속 근로 중이라 고용보험만 적용됩니다.`
    );
  }
  warnings.push(
    "일용근로자(1개월 미만 고용)나 둘 이상 사업장에서 일하는 경우는 판정 기준이 달라집니다. " +
    "또한 1개월 소득이 보건복지부장관 고시 금액 이상이면 시간과 무관하게 국민연금 대상이 될 수 있습니다."
  );
  warnings.push("산재보험은 사업주가 전액 부담하므로 공제액에 없습니다.");

  return {
    gross, basePay, holidayPay,
    monthlyWorkHours,
    rawMonthlyWorkHours: Math.round(rawMonthlyWorkHours * 10) / 10,
    monthlyHolidayHours,
    coverage, insurance,
    incomeTax: tax.amount,
    localIncomeTax: localTax.amount,
    totalDeduction, netPay,
    warnings,
    basis: {
      "월 근로시간": `주 ${weekly}시간 × ${THRESHOLD.weeksPerYear.toFixed(4)}주 ÷ 12 = ${monthlyWorkHours}시간`,
      "기본급": `${monthlyWorkHours}시간 × ${won(wage)}원 = ${won(basePay)}원`,
      "주휴수당": eligibleHoliday
        ? `주휴 ${weeklyHolidayHours}시간 → 월 ${monthlyHolidayHours}시간 × ${won(wage)}원 = ${won(holidayPay)}원`
        : "주 15시간 미만이라 미발생",
      "4대보험 판정": `월 ${rawMonthlyWorkHours.toFixed(1)}시간 ${meetsHours ? "≥" : "<"} 60시간 → ` +
        `국민연금 ${coverage.pension ? "적용" : "제외"} / 건강보험 ${coverage.health ? "적용" : "제외"} / ` +
        `고용보험 ${coverage.employment ? "적용" : "제외"}`,
      "실수령액": `${won(gross)} - ${won(totalDeduction)} = ${won(netPay)}원`,
    },
  };
}

module.exports = { calcPartTimePay, THRESHOLD };
