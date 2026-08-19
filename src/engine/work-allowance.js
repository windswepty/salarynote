/**
 * 주휴수당 · 연차 · 시급/연봉 환산 엔진
 *
 * 근거
 *  - 근로기준법 제55조, 시행령 제30조: 주휴일. 4주 평균 1주 15시간 이상 + 1주 개근.
 *  - 근로기준법 시행령 별표2: 단시간근로자의 1일 소정근로시간 =
 *    4주 소정근로시간 / 통상근로자의 4주 총 소정근로일수(20일). 곧 '주 소정근로시간 / 5'.
 *  - 근로기준법 제60조: 연차 15일. 3년 이상부터 매 2년에 1일 가산, 총 25일 한도.
 *    1년 미만은 1개월 개근당 1일(최대 11일).
 */

/** 법정 기준 근로시간. 이 값들은 법에서 오는 상수라 여기 둔다. */
const LEGAL = {
  weeklyStandardHours: 40,   // 근로기준법 제50조
  dailyStandardHours: 8,     // 주휴수당 상한의 근거
  minWeeklyHoursForHoliday: 15, // 제55조 적용 하한
  workDaysPerWeek: 5,        // 통상근로자 4주 소정근로일수 20일 / 4주
  weeksPerYear: 365 / 7,
};

function num(v, label, { min = 0, max = 1e9 } = {}) {
  if (v === undefined || v === null || v === "") return 0;
  if (typeof v === "boolean" || Array.isArray(v)) throw new Error(`${label}: 숫자만 입력할 수 있습니다.`);
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${label}: 숫자만 입력할 수 있습니다.`);
  if (n < min) throw new Error(`${label}은(는) ${min} 이상이어야 합니다.`);
  if (n > max) throw new Error(`${label}이(가) 계산 가능 범위를 벗어났습니다.`);
  return n;
}

const won = (n) => Math.round(n).toLocaleString("ko-KR");

/**
 * 1주 소정근로시간에 대응하는 주휴시간.
 * 주 40시간을 넘겨 일해도 주휴는 8시간분이 상한이다(초과분은 연장근로수당 영역).
 */
function holidayHours(weeklyHours) {
  const capped = Math.min(weeklyHours, LEGAL.weeklyStandardHours);
  return capped / LEGAL.workDaysPerWeek;
}

/**
 * 주휴수당
 * @param {number} weeklyHours 1주 소정근로시간
 * @param {number} hourlyWage  시급(원)
 * @param {object} rates       rates-*.json (최저임금 비교에 사용)
 */
function calcWeeklyHolidayPay(weeklyHours, hourlyWage, rates) {
  const h = num(weeklyHours, "1주 소정근로시간", { max: 168 });
  const wage = num(hourlyWage, "시급", { max: 1e8 });

  const eligible = h >= LEGAL.minWeeklyHoursForHoliday;
  const hours = eligible ? holidayHours(h) : 0;
  const amount = eligible ? Math.floor(hours * wage) : 0;

  const warnings = [];
  if (!eligible) {
    warnings.push(
      `1주 소정근로시간이 ${h}시간으로 15시간 미만입니다. ` +
      `근로기준법 제55조가 적용되지 않아 주휴수당이 발생하지 않습니다(초단시간근로자).`
    );
  }
  const minWage = rates && rates.minimumWage ? rates.minimumWage.hourly : 0;
  if (minWage && wage > 0 && wage < minWage) {
    warnings.push(
      `입력한 시급 ${won(wage)}원이 ${rates.year}년 최저임금 ${won(minWage)}원보다 낮습니다. ` +
      `최저임금 미만 지급은 위법이며, 실제로는 최저임금 기준으로 계산해야 합니다.`
    );
  }
  if (eligible) {
    warnings.push("1주 소정근로일을 개근한 경우에만 발생합니다. 결근이 있으면 지급되지 않습니다.");
  }

  return {
    eligible, weeklyHours: h, holidayHours: hours, hourlyWage: wage, amount,
    monthlyAmount: Math.floor(amount * LEGAL.weeksPerYear / 12),
    warnings,
    basis: {
      "적용 여부": eligible ? `주 ${h}시간 ≥ 15시간, 지급 대상` : `주 ${h}시간 < 15시간, 대상 아님`,
      "주휴시간": eligible
        ? `min(${h}, 40) ÷ 5 = ${hours}시간` + (h > 40 ? " (주 40시간 초과분은 주휴 상한 8시간에 걸림)" : "")
        : "-",
      "주휴수당": eligible ? `${hours}시간 × ${won(wage)}원 = ${won(amount)}원` : "0원",
      "월 환산": eligible ? `${won(amount)} × ${LEGAL.weeksPerYear.toFixed(4)}주 ÷ 12 = ${won(amount * LEGAL.weeksPerYear / 12)}원` : "-",
    },
  };
}

/**
 * 연차 일수와 미사용 수당
 * @param {number} serviceYears 계속근로연수(년). 1 미만이면 월 단위 규정 적용.
 * @param {number} unusedDays   미사용 연차 일수
 * @param {number} dailyOrdinaryWage 1일 통상임금(원)
 * @param {number} [monthsWorked] 1년 미만일 때 개근한 개월 수
 */
function calcAnnualLeave(serviceYears, unusedDays, dailyOrdinaryWage, monthsWorked) {
  const years = num(serviceYears, "계속근로연수", { max: 60 });
  const daily = num(dailyOrdinaryWage, "1일 통상임금", { max: 1e8 });

  let entitled, rule;
  if (years < 1) {
    // 12개월까지는 입력 실수로 볼 수 있어 11일로 맞춘다.
    // 그보다 크면 '1년 미만'과 모순되는 값이라 멈춘다(조용히 뭉개지 않는다).
    const raw = num(monthsWorked, "개근 개월 수", { max: 12 });
    const months = Math.min(Math.floor(raw), 11);
    entitled = months;
    rule = `계속근로 1년 미만: 1개월 개근당 1일 (최대 11일) → ${entitled}일`;
  } else {
    const bonus = Math.floor((Math.floor(years) - 1) / 2); // 3년 이상부터 매 2년 1일
    entitled = Math.min(15 + bonus, 25);
    rule = `기본 15일 + 가산 ${bonus}일 = ${15 + bonus}일` +
      (15 + bonus > 25 ? " → 법정 한도 25일 적용" : "");
  }

  const unused = Math.min(num(unusedDays, "미사용 연차", { max: 25 }), entitled);
  const amount = Math.floor(unused * daily);

  const warnings = [];
  if (unusedDays > entitled) {
    warnings.push(
      `입력한 미사용 일수(${unusedDays}일)가 발생 연차(${entitled}일)보다 많아 ${entitled}일로 계산했습니다.`
    );
  }
  warnings.push(
    "사용자가 적법한 연차사용촉진 절차를 거쳤다면 미사용 연차에 대한 수당 지급 의무가 면제될 수 있습니다."
  );

  return {
    entitledDays: entitled, unusedDays: unused, dailyOrdinaryWage: daily, amount, warnings,
    basis: {
      "발생 연차": rule,
      "미사용 일수": `${unused}일`,
      "연차수당": `${unused}일 × ${won(daily)}원 = ${won(amount)}원`,
    },
  };
}

/**
 * 시급 ↔ 월급 ↔ 연봉 환산
 * 월 소정근로시간 = (주 소정근로시간 + 주휴시간) × (365/7) ÷ 12
 * 주 40시간이면 (40+8) × 52.1429 ÷ 12 = 208.57 → 관행적으로 209시간
 */
function convertWage(input, rates) {
  const weekly = num(input.weeklyHours === undefined ? 40 : input.weeklyHours, "1주 소정근로시간", { min: 1, max: 168 });
  const hh = weekly >= LEGAL.minWeeklyHoursForHoliday ? holidayHours(weekly) : 0;
  const monthlyHoursRaw = (weekly + hh) * LEGAL.weeksPerYear / 12;
  const monthlyHours = Math.round(monthlyHoursRaw);

  let hourly;
  if (input.hourly != null && input.hourly !== "") hourly = num(input.hourly, "시급", { max: 1e8 });
  else if (input.monthly != null && input.monthly !== "") hourly = num(input.monthly, "월급", { max: 1e11 }) / monthlyHours;
  else if (input.annual != null && input.annual !== "") hourly = num(input.annual, "연봉", { max: 1e12 }) / 12 / monthlyHours;
  else throw new Error("시급, 월급, 연봉 중 하나를 입력해 주세요.");

  const monthly = Math.floor(hourly * monthlyHours);
  const annual = monthly * 12;

  const warnings = [];
  const minWage = rates && rates.minimumWage ? rates.minimumWage.hourly : 0;
  if (minWage && hourly < minWage) {
    warnings.push(
      `환산 시급 ${won(hourly)}원이 ${rates.year}년 최저임금 ${won(minWage)}원에 미달합니다. ` +
      `최저임금 기준 월급은 ${won(minWage * monthlyHours)}원입니다.`
    );
  }
  if (hh === 0) {
    warnings.push("주 15시간 미만이라 주휴시간을 빼고 환산했습니다. 주휴수당이 발생하지 않는 구간입니다.");
  }
  warnings.push("연장·야간·휴일근로수당과 상여금은 포함되지 않은 기본 환산값입니다.");

  return {
    hourly: Math.round(hourly), monthly, annual, monthlyHours, weeklyHours: weekly, holidayHours: hh,
    warnings,
    basis: {
      "월 소정근로시간": `(${weekly} + 주휴 ${hh}) × ${LEGAL.weeksPerYear.toFixed(4)}주 ÷ 12 = ${monthlyHoursRaw.toFixed(2)} → ${monthlyHours}시간`,
      "시급": `${won(hourly)}원`,
      "월급": `${won(hourly)} × ${monthlyHours}시간 = ${won(monthly)}원`,
      "연봉": `${won(monthly)} × 12 = ${won(annual)}원`,
    },
  };
}

module.exports = { calcWeeklyHolidayPay, calcAnnualLeave, convertWage, LEGAL };
