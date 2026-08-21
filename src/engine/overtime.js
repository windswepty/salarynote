/**
 * 연장·야간·휴일근로수당 계산 엔진
 *
 * 근거 (근로기준법, 법제처 원문 확인)
 *  - 제56조① 연장근로: 통상임금의 100분의 50 이상 가산
 *  - 제56조② 휴일근로: 1호 8시간 이내 100분의 50, 2호 8시간 초과 100분의 100
 *  - 제56조③ 야간근로(오후 10시~다음 날 오전 6시): 통상임금의 100분의 50 이상 가산
 *
 * ★5인 미만 사업장★
 *  제11조①은 이 법을 상시 5명 이상 사업장에 적용한다고 정하고,
 *  4명 이하에 적용되는 규정은 시행령 별표1이 열거한다.
 *  그 별표의 제4장(근로시간과 휴식) 칸에는 제54조·제55조제1항·제63조만 있고
 *  **제56조는 없다.** 따라서 5인 미만 사업장은 가산수당 지급 의무가 없다.
 *  이 사실을 빠뜨리고 1.5배를 안내하는 계산기가 많아 별도로 판정한다.
 *
 * 야간은 '가산'이라 연장·휴일과 중복된다. 연장근로가 야간에 걸치면
 * 연장 50% + 야간 50% = 통상임금의 2배가 된다.
 */

const LEGAL = {
  minEmployeesForPremium: 5,   // 제11조① 및 시행령 별표1
  overtimeRate: 0.5,           // 제56조①
  nightRate: 0.5,              // 제56조③
  holidayWithin8Rate: 0.5,     // 제56조②1호
  holidayOver8Rate: 1.0,       // 제56조②2호
  holidayTierHours: 8,
  nightFrom: "22:00",
  nightTo: "06:00",
};

const won = (n) => Math.round(n).toLocaleString("ko-KR");

function num(v, label, { min = 0, max = 1e9, required = false } = {}) {
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

/**
 * @param {object} input
 * @param {number} [input.hourlyOrdinaryWage] 통상시급(원). 직접 알면 이 값을 쓴다.
 * @param {number} [input.monthlyOrdinaryWage] 월 통상임금(원). 시급 대신 넣을 수 있다.
 * @param {number} [input.monthlyHours=209]  월 소정근로시간(월 통상임금 환산용)
 * @param {number} [input.overtimeHours=0]   연장근로 시간
 * @param {number} [input.nightHours=0]      야간근로 시간(22~06시). 연장·휴일과 겹칠 수 있다.
 * @param {number} [input.holidayHours=0]    휴일근로 시간
 * @param {number} input.employees           상시 근로자 수
 */
function calcOvertimePay(input, rates) {
  const employees = num(input.employees, "상시 근로자 수", { min: 1, max: 1e6, required: true });

  // 통상시급 확보: 직접 입력 우선, 없으면 월 통상임금에서 환산
  let hourly;
  let hourlyFrom;
  if (input.hourlyOrdinaryWage !== undefined && input.hourlyOrdinaryWage !== null && input.hourlyOrdinaryWage !== "") {
    hourly = num(input.hourlyOrdinaryWage, "통상시급", { max: 1e8 });
    hourlyFrom = "직접 입력";
  } else {
    const monthly = num(input.monthlyOrdinaryWage, "월 통상임금", { max: 1e11, required: true });
    const mh = num(input.monthlyHours === undefined ? 209 : input.monthlyHours, "월 소정근로시간", { min: 1, max: 400 });
    hourly = monthly / mh;
    hourlyFrom = `월 통상임금 ${won(monthly)} ÷ ${mh}시간`;
  }
  if (hourly <= 0) throw new Error("통상시급을 입력해 주세요.");

  const ot = num(input.overtimeHours, "연장근로 시간", { max: 400 });
  const night = num(input.nightHours, "야간근로 시간", { max: 400 });
  const hol = num(input.holidayHours, "휴일근로 시간", { max: 400 });

  const premiumApplies = employees >= LEGAL.minEmployeesForPremium;

  // 5인 미만은 가산 없이 일한 시간만큼 통상임금을 받는다.
  const otMul = premiumApplies ? 1 + LEGAL.overtimeRate : 1;
  const nightMul = premiumApplies ? LEGAL.nightRate : 0;        // 가산분만
  const holWithinMul = premiumApplies ? 1 + LEGAL.holidayWithin8Rate : 1;
  const holOverMul = premiumApplies ? 1 + LEGAL.holidayOver8Rate : 1;

  const holWithin = Math.min(hol, LEGAL.holidayTierHours);
  const holOver = Math.max(hol - LEGAL.holidayTierHours, 0);

  const overtimePay = Math.floor(ot * hourly * otMul);
  const nightPay = Math.floor(night * hourly * nightMul);
  const holidayPay = Math.floor(holWithin * hourly * holWithinMul + holOver * hourly * holOverMul);
  const total = overtimePay + nightPay + holidayPay;

  const warnings = [];
  if (!premiumApplies) {
    warnings.push(
      `상시 근로자 ${employees}명으로 5인 미만 사업장입니다. 근로기준법 시행령 별표1이 ` +
      `4명 이하 사업장에 적용하는 제4장 규정으로 제54조·제55조제1항·제63조만 열거하고 있어 ` +
      `제56조(가산수당)가 적용되지 않습니다. 일한 시간만큼의 통상임금은 그대로 받아야 하며, ` +
      `가산분만 발생하지 않습니다.`
    );
  } else if (night > 0) {
    warnings.push(
      "야간근로는 '가산'이라 연장·휴일근로와 중복됩니다. 연장근로가 야간에 걸쳤다면 " +
      "연장 50% + 야간 50% 로 통상임금의 2배가 됩니다. 야간 시간은 겹치는 시간도 그대로 넣으세요."
    );
  }
  if (hol > LEGAL.holidayTierHours) {
    warnings.push(
      `휴일근로 ${hol}시간 중 8시간 초과분 ${holOver}시간은 100% 가산(2배)으로 계산했습니다(제56조②2호).`
    );
  }
  const minWage = rates && rates.minimumWage ? rates.minimumWage.hourly : 0;
  if (minWage && hourly < minWage) {
    warnings.push(
      `통상시급 ${won(hourly)}원이 ${rates.year}년 최저임금 ${won(minWage)}원보다 낮습니다. ` +
      `가산수당도 최저임금 이상을 기준으로 계산해야 합니다.`
    );
  }
  warnings.push(
    "통상임금에는 기본급과 정기적·일률적으로 지급되는 수당이 들어갑니다. " +
    "성과급처럼 변동하는 항목은 보통 제외되며, 무엇이 통상임금인지는 다툼의 여지가 있습니다."
  );

  return {
    employees, premiumApplies,
    hourlyOrdinaryWage: Math.round(hourly),
    overtimeHours: ot, nightHours: night,
    holidayHours: hol, holidayWithin8: holWithin, holidayOver8: holOver,
    overtimePay, nightPay, holidayPay, total,
    warnings,
    basis: {
      "통상시급": `${won(hourly)}원 (${hourlyFrom})`,
      "가산 적용": premiumApplies
        ? `상시 ${employees}명 → 5인 이상, 제56조 적용`
        : `상시 ${employees}명 → 5인 미만, 제56조 미적용(시행령 별표1)`,
      "연장근로": ot ? `${ot}시간 × ${won(hourly)} × ${otMul} = ${won(overtimePay)}원` : "없음",
      "야간가산": night ? `${night}시간 × ${won(hourly)} × ${nightMul} = ${won(nightPay)}원` : "없음",
      "휴일근로": hol
        ? `8시간 이내 ${holWithin}시간 × ${holWithinMul}` +
          (holOver ? ` + 초과 ${holOver}시간 × ${holOverMul}` : "") +
          ` = ${won(holidayPay)}원`
        : "없음",
      "합계": `${won(total)}원`,
    },
  };
}

module.exports = { calcOvertimePay, LEGAL };
