/**
 * 4대보험 계산 엔진
 *
 * 설계 원칙
 *  1. 숫자를 여기에 쓰지 않는다. 전부 data/rates-*.json 에서 주입받는다.
 *  2. 순수 함수로 유지한다. 같은 입력이면 항상 같은 출력이라 테스트가 쉽다.
 *  3. 모든 결과는 계산 근거(basis)를 함께 반환한다. 화면에 그대로 노출해 신뢰를 만든다.
 */

/**
 * 단수 처리에 쓰는 엡실론.
 * 3,000,000 x 0.009 처럼 딱 떨어져야 할 계산도 부동소수점에서는
 * 26999.999999... 로 나올 수 있고, 그대로 절사하면 보험료가 10원 적어진다.
 * 입력이 원 단위 정수이고 요율이 소수점 5자리 이하이므로
 * 실제 값의 소수부는 최소 1e-5 단위다. 1e-6 은 그보다 작아 안전하다.
 */
const EPS = 1e-6;

/** 10원 미만 절사. 4대보험료 산정의 기본 단수 처리. */
const floorTo10 = (n) => Math.floor((n + EPS) / 10) * 10;

/** 1,000원 미만 절사. 국민연금 기준소득월액 산정에 쓰인다. */
const floorTo1000 = (n) => Math.floor((n + EPS) / 1000) * 1000;

/**
 * 지급일을 'YYYY-MM-DD' 로 정규화하고 달력상 실재하는 날짜인지 검증한다.
 *
 * ★이 검증이 없으면 구간 선택이 조용히 틀린다.★
 * 구간 판정(b.from <= d <= b.to)은 문자열 사전순 비교인데, 사전순 비교가
 * 날짜 순서와 일치하는 것은 오직 '0 패딩된 고정폭 ISO 형식'일 때뿐이다.
 * 예: '2026-1-15'(0 패딩 누락, 흔한 입력 흔들림)는 5번째 문자에서 '1' > '0' 이므로
 *     '2026-07-01' 보다 크다고 판정되어, 1월 급여인데 7월 이후 상한액(659만)이
 *     적용된다. 월 900만원 기준 국민연금이 302,570 대신 313,020 으로 10,450원 틀린다.
 * 또 '2026-13-45' / '2026-02-31' 같은 실재하지 않는 날짜도 그대로 통과했다.
 *
 * 그래서 형식(정규식)과 실재성(Date 재직렬화 일치) 두 가지를 모두 확인한 뒤에만
 * 사전순 비교로 넘긴다. 통과하지 못하면 조용히 틀리는 대신 멈춘다.
 */
function normalizePayDate(payDate) {
  if (typeof payDate !== "string") {
    throw new Error(
      `payDate 는 'YYYY-MM-DD' 형식의 문자열이어야 합니다. 받은 값: ${JSON.stringify(
        payDate
      )} (${typeof payDate}). Date 객체나 숫자가 아니라 문자열로 넘기십시오.`
    );
  }
  const d = payDate.slice(0, 10); // 'YYYY-MM-DDTHH:mm:ss' 같은 ISO 문자열도 허용
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    throw new Error(
      `payDate 형식이 올바르지 않습니다: '${payDate}'. 월·일을 두 자리로 0 패딩한 'YYYY-MM-DD' 여야 합니다(예: 2026-01-15). 0 패딩이 없으면 국민연금 상·하한 구간이 조용히 잘못 선택됩니다.`
    );
  }
  const [y, m, day] = d.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, day));
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new Error(
      `payDate 가 달력에 존재하지 않는 날짜입니다: '${d}'.`
    );
  }
  return d;
}

/**
 * 국민연금 기준소득월액 상·하한액은 매년 7월 1일에 갱신된다.
 * 1월 기준으로 잡으면 하반기 계산이 통째로 틀리므로 지급일로 구간을 고른다.
 */
function resolveBaseIncomeBracket(brackets, payDate) {
  const d = normalizePayDate(payDate);
  const hit = brackets.find((b) => d >= b.from && d <= b.to);
  if (!hit) {
    throw new Error(
      `국민연금 기준소득월액 구간을 찾을 수 없습니다: ${d}. data/rates-*.json 의 baseIncomeBrackets 갱신이 필요합니다.`
    );
  }
  return hit;
}

/** 국민연금 (근로자 부담분) */
function calcNationalPension(monthlyIncome, rates, payDate) {
  const np = rates.nationalPension;
  const bracket = resolveBaseIncomeBracket(np.baseIncomeBrackets, payDate);

  const rawBase = floorTo1000(monthlyIncome);
  const base = Math.min(Math.max(rawBase, bracket.min), bracket.max);
  const amount = floorTo10(base * np.employeeRate);

  return {
    amount,
    basis: {
      기준소득월액: base,
      상한적용: rawBase > bracket.max,
      하한적용: rawBase < bracket.min,
      적용상한: bracket.max,
      적용하한: bracket.min,
      적용기간: `${bracket.from} ~ ${bracket.to}`,
      근로자요율: np.employeeRate,
      산식: `${base.toLocaleString()} × ${(np.employeeRate * 100).toFixed(3)}% = ${amount.toLocaleString()}원`,
    },
  };
}

/** 건강보험 (근로자 부담분) */
function calcHealthInsurance(monthlyIncome, rates) {
  const hi = rates.healthInsurance;
  const b = hi.premiumBounds;

  // ★상·하한은 보수월액이 아니라 '월별 보험료액'에 건다.★
  // 고시 문언(제2조·제3조)이 보험료액 기준이므로 보수월액을 clamp 한 뒤
  // 요율을 곱하면 안 된다. 노사 합산 보험료를 먼저 구해 clamp 하고 절반을 취한다.
  //
  // 일반 급여 구간에서는 어느 쪽도 구속되지 않아 결과가 이전과 동일하다.
  // 하한은 보수월액 약 280,389원 미만에서 실제로 발동한다(아르바이트·단시간 구간).
  const rawTotal = monthlyIncome * hi.totalRate;
  let total = rawTotal;
  let capped = false;
  let floored = false;

  if (b) {
    if (total > b.totalMax) { total = b.totalMax; capped = true; }
    else if (total < b.totalMin) { total = b.totalMin; floored = true; }
  }

  const amount = floorTo10(total / 2);

  return {
    amount,
    basis: {
      보수월액: monthlyIncome,
      총요율: hi.totalRate,
      근로자요율: hi.employeeRate,
      상한적용: capped,
      하한적용: floored,
      ...(b ? { 적용상한: b.totalMax, 적용하한: b.totalMin } : {}),
      산식: capped
        ? `노사합산 ${Math.round(rawTotal).toLocaleString()}원이 상한 ${b.totalMax.toLocaleString()}원을 넘어 상한 적용 → 근로자 ${amount.toLocaleString()}원`
        : floored
        ? `노사합산 ${Math.round(rawTotal).toLocaleString()}원이 하한 ${b.totalMin.toLocaleString()}원에 미달해 하한 적용 → 근로자 ${amount.toLocaleString()}원`
        : `${monthlyIncome.toLocaleString()} × ${(hi.employeeRate * 100).toFixed(3)}% = ${amount.toLocaleString()}원`,
    },
  };
}

/**
 * 장기요양보험 (근로자 부담분)
 * 소득이 아니라 "건강보험료"에 요율을 곱한다는 점이 핵심.
 */
function calcLongTermCare(healthPremium, rates) {
  const ltc = rates.longTermCare;
  const amount = floorTo10(healthPremium * ltc.rateOfHealthPremium);
  return {
    amount,
    basis: {
      건강보험료: healthPremium,
      요율: ltc.rateOfHealthPremium,
      산식: `${healthPremium.toLocaleString()} × ${(ltc.rateOfHealthPremium * 100).toFixed(2)}% = ${amount.toLocaleString()}원`,
    },
  };
}

/** 고용보험 (근로자 부담분 = 실업급여 계정만) */
function calcEmploymentInsurance(monthlyIncome, rates) {
  const ei = rates.employmentInsurance;
  const amount = floorTo10(monthlyIncome * ei.employeeRate);
  return {
    amount,
    basis: {
      보수월액: monthlyIncome,
      근로자요율: ei.employeeRate,
      비고: "고용안정·직업능력개발사업 보험료는 사업주가 전액 부담하므로 제외",
      산식: `${monthlyIncome.toLocaleString()} × ${(ei.employeeRate * 100).toFixed(1)}% = ${amount.toLocaleString()}원`,
    },
  };
}

/**
 * 4대보험 근로자 부담분 합계
 * @param {number} monthlyIncome 월 보수액(비과세 제외 후)
 * @param {object} rates rates-*.json
 * @param {string} payDate 급여 지급일 'YYYY-MM-DD'
 */
function calcSocialInsurance(monthlyIncome, rates, payDate) {
  const pension = calcNationalPension(monthlyIncome, rates, payDate);
  const health = calcHealthInsurance(monthlyIncome, rates);
  const care = calcLongTermCare(health.amount, rates);
  const employment = calcEmploymentInsurance(monthlyIncome, rates);

  const total =
    pension.amount + health.amount + care.amount + employment.amount;

  return { pension, health, care, employment, total };
}

module.exports = {
  calcSocialInsurance,
  calcNationalPension,
  normalizePayDate,
  calcHealthInsurance,
  calcLongTermCare,
  calcEmploymentInsurance,
  floorTo10,
  floorTo1000,
};
