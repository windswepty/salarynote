/* 샐러리노트 계산 엔진 번들 — build/bundle.js 가 생성. 직접 고치지 말 것. */
(function (global) {
  "use strict";
  const __mod = {};
  function __req(name) {
    if (!__mod[name]) throw new Error("모듈 로드 순서 오류: " + name);
    return __mod[name];
  }

  __mod["insurance.js"] = (function () {
    const module = { exports: {} };
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
  const amount = floorTo10(monthlyIncome * hi.employeeRate);
  return {
    amount,
    basis: {
      보수월액: monthlyIncome,
      근로자요율: hi.employeeRate,
      산식: `${monthlyIncome.toLocaleString()} × ${(hi.employeeRate * 100).toFixed(3)}% = ${amount.toLocaleString()}원`,
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

    return module.exports;
  })();

  __mod["income-tax.js"] = (function () {
    const module = { exports: {} };
    /**
 * 근로소득세 원천징수 계산 엔진 (근로소득 간이세액표)
 *
 * 설계 원칙 — insurance.js 와 동일하다.
 *  1. 숫자를 여기에 쓰지 않는다. 전부 data/*.json 에서 주입받는다.
 *     (간이세액표 값·초과구간 상수/백분율 = simplified-tax-table-2026.json,
 *      단수 단위·선택비율·지방소득세율 = rates-2026.json)
 *  2. 순수 함수로 유지한다.
 *  3. 모든 결과에 계산 근거(basis)를 함께 반환한다. 화면에 그대로 노출한다.
 *
 * 법령 근거
 *  - 소득세법 시행령 [별표 2] <개정 2026. 2. 27.> (제189조제1항 관련) 근로소득 간이세액표
 *  - 소득세법 시행령 제194조 제1항 단서 (80/100/120% 선택)
 *  - 지방세법 제103조의13 제1항 (지방소득세 = 소득세의 10%)
 *  - 국고금 관리법 제47조 제1항 (10원 미만 끝수 절사)
 *
 * 이 엔진이 반환하는 소득세에는 지방소득세가 포함되어 있지 않다. 별도 함수로 산출한다.
 */

/**
 * 단수 처리용 엡실론. insurance.js 와 같은 이유·같은 값이다.
 * 초과구간 산식은 98% x 35% 처럼 소수 곱이 겹쳐서 정확히 떨어져야 할 값이
 * ...9999 로 나올 수 있고, 그대로 절사하면 10원이 사라진다.
 */
const EPS = 1e-6;

/** 지정 단위 미만 절사. 단위는 반드시 JSON 의 rounding 블록에서 받는다. */
function floorToUnit(n, unit) {
  return Math.floor((n + EPS) / unit) * unit;
}

const won = (n) => Math.round(n).toLocaleString("ko-KR");

/** rounding 블록 검증. method 가 floor 가 아니면 조용히 틀리지 않고 멈춘다. */
function requireFloorRounding(rounding, what) {
  if (!rounding || typeof rounding.unit !== "number") {
    throw new Error(
      `${what} 의 rounding 설정을 찾을 수 없습니다. data/rates-*.json 에 rounding.unit 을 정의해야 합니다.`
    );
  }
  if (rounding.method !== "floor") {
    throw new Error(
      `${what} 의 rounding.method 가 '${rounding.method}' 입니다. 이 엔진은 절사(floor)만 구현되어 있습니다. 반올림 규칙이 확정되면 여기서 분기하십시오.`
    );
  }
  return rounding;
}

/* ------------------------------------------------------------------ *
 * 1) 간이세액표 조회 — 가족수 n(1~11)명의 표상 세액
 * ------------------------------------------------------------------ */

/**
 * @param {number} incomeWon 월급여액(원). 비과세 및 학자금을 제외한 금액.
 * @param {number} n 공제대상가족 수 1~11
 * @param {object} table simplified-tax-table-2026.json
 * @returns {{amount:number, basis:object}}
 */
function lookupTableTax(incomeWon, n, table) {
  const rows = table.rows;
  const maxCols = table.exactCapRow.values.length; // 11

  // ── 입력 검증 ────────────────────────────────────────────────────
  //
  // ★이 가드는 calcIncomeTax 에 이미 같은 검증이 있어도 반드시 여기에 또 있어야 한다.★
  // lookupTableTax 는 module.exports 로 공개된 API 다. UI 가 '간이세액표 조회값
  // 미리보기' 같은 용도로 calcIncomeTax 를 거치지 않고 직접 호출할 수 있다.
  //
  // 가드가 없을 때 실제로 일어나던 일:
  //   rows 의 각 행은 [하한천원, 상한천원, 값1..값11] 구조라
  //   n <= 0 이면 row[2 + (n-1)] 이 값 영역을 벗어나 '천원 경계값'을 집는다.
  //     lookupTableTax(3000000, 0)  -> 3020  (행의 '미만' 경계 3,020천원)
  //     lookupTableTax(3000000, -1) -> 3000  (행의 '이상' 경계 3,000천원)
  //   n >= 12 이면 undefined / NaN 이 조용히 흘러나간다.
  //     lookupTableTax(12000000, 12) -> NaN  (cap 이 undefined 라 산식 전체가 NaN)
  //   그런데 basis.산식 은 '간이세액표 [3,000 ~ 3,020천원] x 가족 0명 = 3,020원'
  //   처럼 멀쩡한 형식으로 나와서, 화면에 뜨면 오류를 알아챌 방법이 없다.
  //
  // 이 엔진의 명시 원칙과 같은 기조다 — 존재하지 않는 세액을 화면에 띄우는 것보다
  // 멈추는 게 낫다.
  if (!Number.isFinite(incomeWon) || incomeWon < 0) {
    throw new Error(
      `월급여액이 올바르지 않습니다: ${incomeWon}. 0 이상의 유한한 숫자여야 합니다.`
    );
  }
  if (!Number.isInteger(n) || n < 1 || n > maxCols) {
    throw new Error(
      `공제대상가족 수는 1 이상 ${maxCols} 이하의 정수여야 합니다: ${n}. ` +
        `${maxCols}명 초과는 별표2 비고 4호(차감 규칙)를 적용해야 하므로 lookupTableTax 가 아니라 calcIncomeTax 를 사용하십시오.`
    );
  }

  // 원 단위 미만 절사. 연봉÷12 같은 경로에서 소수가 들어올 수 있는데,
  // 표 구간 조회는 소수에 영향받지 않지만 10,000천원 초과 산식에 그대로 들어가면
  // 1,532,400.0000000345 처럼 비정수 세액이 만들어진다.
  // 세액의 단위는 원이므로 조회 입력 단계에서 원 단위로 확정한다.
  const income = Math.floor(incomeWon);

  const cap = table.exactCapRow.values[n - 1];
  const capIncomeWon = table.exactCapRow.monthlyIncomeKRW1000 * 1000;
  const tableMinWon = rows[0][0] * 1000;

  // (a) 표 하한 미만 — 표에 행 자체가 없다. 세액 0원.
  //     ★[추론]★ 별표2 6호 표의 첫 행은 770~775천원이고 그 아래 구간은 행 자체가
  //     존재하지 않는다. '행이 없으면 0원'은 원문에 명시된 규정이 아니라 해석이다.
  //     독립 재구현 차등 테스트에서도 양쪽이 같은 가정을 써서 상호 확인되지 않았다.
  //     다만 표의 첫 행부터 1,000천원대까지 전 열이 '-'(0원)이고 2026년 최저임금
  //     월 환산액(2,156,880원)이 이보다 훨씬 높아 실무 영향은 없다.
  if (income < tableMinWon) {
    return {
      amount: 0,
      basis: {
        구분: "표 하한 미만",
        적용: `월급여액 ${won(income)}원 < 간이세액표 최저구간 ${won(tableMinWon)}원`,
        산식: "간이세액표에 해당 구간이 없어 원천징수세액 0원",
        비고: "표에 행이 없는 구간이며 0원 처리는 원문 명시가 아닌 해석이다 [추론]",
      },
    };
  }

  // (b) 표 구간 [770, 10000)천원 — '이상 ~ 미만'. 10,000천원은 여기 포함되지 않는다.
  if (income < capIncomeWon) {
    const row = rows.find(
      (r) => r[0] * 1000 <= income && income < r[1] * 1000
    );
    if (!row) {
      // rows 는 gap 0 으로 연속이므로 여기 오면 데이터가 깨진 것이다.
      throw new Error(
        `간이세액표 구간을 찾을 수 없습니다: 월급여액 ${income}원. data/simplified-tax-table-2026.json 의 rows 연속성을 확인하십시오.`
      );
    }
    const amount = row[2 + (n - 1)];
    // 데이터 열 결손 방어. 원장이 깨져도 undefined 가 세액으로 흘러나가지 않는다.
    if (!Number.isFinite(amount)) {
      throw new Error(
        `간이세액표 데이터가 결손되었습니다: 구간 [${row[0]} ~ ${row[1]}천원] 의 가족 ${n}명 열이 숫자가 아닙니다(${amount}). data/simplified-tax-table-2026.json 을 확인하십시오.`
      );
    }
    return {
      amount,
      basis: {
        구분: "간이세액표 조회",
        적용구간: `${won(row[0])}천원 이상 ~ ${won(row[1])}천원 미만`,
        공제대상가족수: `${n}명`,
        조회값: amount,
        산식: `간이세액표 [${won(row[0])} ~ ${won(row[1])}천원] x 가족 ${n}명 = ${won(amount)}원`,
      },
    };
  }

  // (c) 정확히 10,000천원 — 표와 산식 사이의 별도 행
  if (income === capIncomeWon) {
    return {
      amount: cap,
      basis: {
        구분: "상한 정확값(별도 행)",
        적용구간: `월급여액이 정확히 ${won(capIncomeWon / 1000)}천원`,
        공제대상가족수: `${n}명`,
        조회값: cap,
        산식: `exactCapRow x 가족 ${n}명 = ${won(cap)}원`,
      },
    };
  }

  // (d) 10,000천원 초과 — 6개 구간 산식
  //
  // 주의 1: 98%는 앞 3개 구간(→14,000 / →28,000 / →30,000)에만 있고
  //         뒤 3개 구간에는 없다. 법문 그대로이며 경계 상수 역산으로 증명된 사실이다.
  //         뒤 구간에 98%를 끼워 넣으면 구간 경계값이 어긋난다.
  // 주의 2: '98%를 곱한 금액의 35% 상당액'은 (E x 0.98) x 0.35 이며
  //         중간 반올림 규정이 없으므로 E x 0.343 과 수학적으로 동일하다.
  //         중간 단계에서 절대 반올림하지 말 것. 단수 처리는 맨 끝에서 한 번만 한다.
  // 주의 3: 10,000천원 지점의 25,000원 계단(1,507,400 → 1,532,400)은
  //         전사 오류가 아니라 법문상 의도된 불연속이다. 없애지 말 것.
  const seg = table.overflowFormulas.find(
    (s) =>
      income > s.fromKRW1000 * 1000 &&
      (s.toKRW1000 === null || income <= s.toKRW1000 * 1000)
  );
  if (!seg) {
    throw new Error(
      `10,000천원 초과 구간 산식을 찾을 수 없습니다: 월급여액 ${income}원.`
    );
  }
  if (
    typeof seg.constant !== "number" ||
    typeof seg.pct !== "number" ||
    typeof seg.hasNinetyEight !== "boolean"
  ) {
    throw new Error(
      "overflowFormulas 에 기계 판독형 필드(constant / hasNinetyEight / pct)가 없습니다. data/simplified-tax-table-2026.json 을 확인하십시오."
    );
  }

  const excess = income - seg.fromKRW1000 * 1000; // 해당 구간 하한 초과액(원)
  // 정수 곱을 먼저 하고 마지막에 나눠 부동소수점 오차를 최소화한다.
  const variable = seg.hasNinetyEight
    ? (excess * 98 * seg.pct) / 10000
    : (excess * seg.pct) / 100;
  const amount = cap + seg.constant + variable;

  const rateText = seg.hasNinetyEight
    ? `x 98% x ${seg.pct}%`
    : `x ${seg.pct}%`;
  return {
    amount,
    basis: {
      구분: "상한 초과 산식",
      적용구간:
        seg.toKRW1000 === null
          ? `${won(seg.fromKRW1000)}천원 초과`
          : `${won(seg.fromKRW1000)}천원 초과 ~ ${won(seg.toKRW1000)}천원 이하`,
      공제대상가족수: `${n}명`,
      상한세액: cap,
      구간상수: seg.constant,
      초과액: excess,
      "98%적용": seg.hasNinetyEight,
      백분율: `${seg.pct}%`,
      원문: seg.sourceText || seg.expr,
      산식:
        `${won(cap)}(10,000천원 세액) + ${won(seg.constant)}(구간상수) + ` +
        `${won(excess)}(초과액) ${rateText} = ${won(amount)}원`,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 2) 근로소득세 원천징수액
 * ------------------------------------------------------------------ */

/**
 * @param {object} input
 * @param {number} input.monthlyIncome  월급여액(원). 비과세 및 학자금 제외 후 금액.
 * @param {number} input.dependents     공제대상가족 수(본인·배우자 각 1명 포함). 1 이상 정수.
 * @param {number} [input.children=0]   자녀 공제 대상 자녀 수. ★기본값 0 고정 — 아래 주석 참고.
 * @param {number} [input.withholdingRatio=1.0] 80/100/120% 선택. 0.8 / 1.0 / 1.2 만 허용.
 * @param {object} table simplified-tax-table-2026.json
 * @param {object} rates rates-2026.json
 * @returns {{amount:number, beforeRounding:number, basis:string[], detail:object}}
 */
function calcIncomeTax(input, table, rates) {
  const {
    monthlyIncome,
    dependents,
    children = 0,
    withholdingRatio = rates.incomeTax.defaultWithholdingRatio,
  } = input;

  if (!Number.isFinite(monthlyIncome) || monthlyIncome < 0) {
    throw new Error(`월급여액이 올바르지 않습니다: ${monthlyIncome}`);
  }
  // 오버플로 방어. Number.MAX_VALUE 는 유한수라 위 검사를 통과하지만,
  // 초과구간 산식을 태우면 결과가 Infinity 로 오버플로해 -Infinity 실수령액이
  // 조용히 반환된다. 한계값은 rates JSON 의 inputLimits 에서 읽는다(법정 수치 아님).
  const maxIncome = rates.inputLimits && rates.inputLimits.maxMonthlySalary;
  if (typeof maxIncome === "number" && monthlyIncome > maxIncome) {
    throw new Error(
      `월급여액이 계산 가능 범위를 벗어났습니다: ${monthlyIncome} > ${maxIncome}. ` +
        `(data/rates-*.json 의 inputLimits.maxMonthlySalary — 법정 상한이 아니라 오버플로 방어값입니다.)`
    );
  }
  if (!Number.isInteger(dependents) || dependents < 1) {
    throw new Error(
      `공제대상가족 수는 1 이상의 정수여야 합니다(본인 포함): ${dependents}`
    );
  }
  if (!Number.isInteger(children) || children < 0) {
    throw new Error(`자녀 수는 0 이상의 정수여야 합니다: ${children}`);
  }

  // 선택 비율은 법정 3종만 허용한다. 0.9 같은 값을 조용히 받아들이면
  // 법적으로 존재하지 않는 세액을 화면에 띄우게 된다.
  const choices = rates.incomeTax.withholdingRatioChoices;
  if (!choices.some((c) => Math.abs(c - withholdingRatio) < 1e-9)) {
    throw new Error(
      `원천징수 선택비율은 ${choices
        .map((c) => `${c * 100}%`)
        .join(" / ")} 만 가능합니다(소득세법 시행령 제194조 제1항 단서): ${withholdingRatio}`
    );
  }

  const basis = [];
  const detail = {};

  // ── STEP 1. 가족수 기준 표상 세액 ────────────────────────────────
  let tax;
  const maxCols = table.exactCapRow.values.length; // 11
  if (dependents <= maxCols) {
    const r = lookupTableTax(monthlyIncome, dependents, table);
    tax = r.amount;
    detail.조회 = r.basis;
    basis.push(r.basis.산식);
  } else {
    // 별표2 비고 4호: (11명 세액) - (10명 세액 - 11명 세액) x (11명 초과 가족수)
    const rMax = lookupTableTax(monthlyIncome, maxCols, table);
    const rPrev = lookupTableTax(monthlyIncome, maxCols - 1, table);
    const step = rPrev.amount - rMax.amount;
    const over = dependents - maxCols;
    tax = rMax.amount - step * over;
    detail.조회 = rMax.basis;
    detail.가족수초과 = {
      규칙: table.rules.dependentsOver11,
      "11명세액": rMax.amount,
      "10명세액": rPrev.amount,
      차감단위: step,
      초과인원: over,
    };
    basis.push(rMax.basis.산식);
    basis.push(
      `공제대상가족 ${dependents}명(11명 초과): ${won(rMax.amount)} - (${won(
        rPrev.amount
      )} - ${won(rMax.amount)}) x ${over}명 = ${won(tax)}원`
    );
  }

  // ★[추론]★ 비고 4호에는 비고 3호(자녀공제)와 달리 음수 단서가 없다.
  // 비고 3호에는 '다만, 공제한 금액이 음수인 경우의 세액은 0원으로 한다'가 명시되어
  // 있지만 비고 4호에는 같은 단서가 없어, 원문을 축자 해석하면 음수 세액이 나온다.
  // 원천징수세액이 음수일 수 없다는 성질상 0으로 클램프하며 이는 추론이다.
  //
  // 클램프가 실제로 구속되는 범위는 좁다: 독립 재구현 차등 테스트에서
  // 4,422,090건 중 2,886건, 전부 가족 12명 & 월급여 2,890~3,160천원 및
  // 가족 13명 & 2,890~3,320천원 구간이었다.
  // 예) 월급여 3,000,000원 / 가족 13명 → 표상 10명 3,600원, 11명 0원이므로
  //     0 - (3,600 - 0) x 2 = -7,200원. 클램프를 제거하면 이 값이 화면에 뜬다.
  if (tax < 0) {
    basis.push("세액이 음수가 되어 0원으로 조정");
    tax = 0;
  }

  // ── STEP 2. 자녀 공제 (별표2 비고 3호) ──────────────────────────
  //
  // ★★ 미확정 항목 — 기본값 0 을 유지하고 UI 에 노출하지 말 것 ★★
  // 시행령 별표2(2026.2.27) 비고 3호 원문은 '8세 이상 20세 이하 자녀' 이고
  // 공제액은 1명 20,830 / 2명 45,830 / 3명 이상 45,830 + 초과 1명당 33,330 이다.
  // 다만 이후 법률 제21548호(2026.4.21)가 소득세법 제59조의2 자녀세액공제 연령을
  // '13세 이상'으로 상향했다는 미확인 정보가 있어, 시행령 별표2 가 이를 반영하지 못한
  // 상태일 가능성이 남아 있다(rates-2026.json 의 $ageRangeOpenIssue 참조).
  // → 연령 기준이 확정될 때까지 이 파라미터는 기본값 0 으로 두고 UI 미노출.
  //   금액 자체는 원문 확인이 끝났으므로 로직은 구현해 둔다.
  //
  // 또 하나 미확정: 이 공제가 10,000천원 초과 산식 구간에도 적용되는지 명시 문언이 없다.
  // 비고 1호가 '해당 세액'을 비고 6호 표 전체로 정의하고 초과구간 산식도 그 표에 포함되므로
  // 적용된다고 보는 것이 자연스럽지만 이는 추론이다. 현재 구현은 구간 구분 없이 적용한다.
  if (children > 0) {
    const c = rates.childTaxCredit;
    let deduct;
    if (children === 1) deduct = c.one;
    else if (children === 2) deduct = c.two;
    else deduct = c.threePlusBase + c.threePlusPerExtra * (children - 2);

    const before = tax;
    tax = Math.max(0, tax - deduct); // 비고 3호 단서: 음수면 0원
    detail.자녀공제 = {
      자녀수: children,
      연령기준: c.ageRange,
      공제액: deduct,
      공제전: before,
      공제후: tax,
      주의: "연령 기준 미확정으로 UI 미노출 상태. 기본값 0.",
    };
    basis.push(
      `자녀 ${children}명 공제 ${won(deduct)}원 차감(음수 시 0원): ${won(
        before
      )} - ${won(deduct)} = ${won(tax)}원`
    );
  }

  // ── STEP 3. 80/100/120% 선택 (소득세법 시행령 제194조 제1항 단서) ──
  const beforeRatio = tax;
  if (Math.abs(withholdingRatio - 1) > 1e-9) {
    // 부동소수점을 피해 정수비로 계산한다. 0.8 -> x80/100, 1.2 -> x120/100.
    const pct = Math.round(withholdingRatio * 100);
    tax = (tax * pct) / 100;
    basis.push(
      `원천징수세액 ${pct}% 선택 적용: ${won(beforeRatio)} x ${pct}% = ${won(tax)}원`
    );
  }
  detail.선택비율 = {
    비율: withholdingRatio,
    표기: `${Math.round(withholdingRatio * 100)}%`,
    적용전: beforeRatio,
    근거: rates.incomeTax.withholdingRatioSource,
  };

  // ── STEP 4. 단수 처리 ────────────────────────────────────────────
  // 별표2 자체에는 절사 규정이 없다. 절사 근거는 국고금 관리법 제47조 제1항이며
  // 단위(10원)는 rates JSON 의 rounding 블록에서 읽는다.
  // 간이세액표 100% 값은 이미 10원 단위라 여기서 값이 바뀌지 않는다.
  // 80/120% 선택 시에만 단수가 발생한다.
  const rounding = requireFloorRounding(rates.incomeTax.rounding, "근로소득세");
  const beforeRounding = tax;
  const amount = floorToUnit(tax, rounding.unit);
  if (amount !== beforeRounding) {
    basis.push(
      `${rounding.unit}원 미만 절사: ${won(beforeRounding)} → ${won(amount)}원 (${rounding.basis})`
    );
  }
  detail.단수처리 = {
    단위: rounding.unit,
    방식: rounding.method,
    절사전: beforeRounding,
    절사후: amount,
    근거: rounding.basis,
    근거등급: rounding.grade,
  };

  return { amount, beforeRounding, basis, detail };
}

/* ------------------------------------------------------------------ *
 * 3) 지방소득세 (개인지방소득세 특별징수분)
 * ------------------------------------------------------------------ */

/**
 * 지방세법 제103조의13 제1항: 원천징수하는 소득세의 100분의 10.
 * 단수 처리 근거는 rates JSON 의 rounding 블록에 기록해 두었다(준용 사슬이라 실무 표준 등급).
 *
 * @param {number} incomeTaxAmount 원천징수 소득세액(절사 후)
 */
function calcLocalIncomeTax(incomeTaxAmount, rates) {
  const cfg = rates.localIncomeTaxRate;
  const rounding = requireFloorRounding(cfg.rounding, "지방소득세");
  const raw = incomeTaxAmount * cfg.rate;
  const amount = floorToUnit(raw, rounding.unit);

  return {
    amount,
    basis: {
      소득세액: incomeTaxAmount,
      세율: cfg.rate,
      절사전: raw,
      단수처리: `${rounding.unit}원 미만 ${rounding.method === "floor" ? "절사" : rounding.method}`,
      근거: cfg.basis,
      단수근거: rounding.basis,
      근거등급: rounding.grade,
      산식: `${won(incomeTaxAmount)} x ${cfg.rate * 100}% = ${won(raw)} → ${won(amount)}원`,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 4) 소득세 + 지방소득세 한 번에
 * ------------------------------------------------------------------ */

function calcWithholding(input, table, rates) {
  const income = calcIncomeTax(input, table, rates);
  const local = calcLocalIncomeTax(income.amount, rates);
  return {
    incomeTax: income,
    localIncomeTax: local,
    total: income.amount + local.amount,
  };
}

module.exports = {
  calcIncomeTax,
  calcLocalIncomeTax,
  calcWithholding,
  lookupTableTax,
  floorToUnit,
};

    return module.exports;
  })();

  __mod["net-pay.js"] = (function () {
    const module = { exports: {} };
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

const { calcSocialInsurance, normalizePayDate } = __req("insurance.js");
const {
  calcIncomeTax,
  calcLocalIncomeTax,
} = __req("income-tax.js");

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

    return module.exports;
  })();

  __mod["severance.js"] = (function () {
    const module = { exports: {} };
    /**
 * 퇴직금 계산 엔진
 *
 * 근거
 *  - 근로자퇴직급여 보장법 제8조: 계속근로기간 1년에 대해 30일분 이상의 평균임금
 *  - 근로기준법 제2조 제1항 제6호: 평균임금 = 산정사유 발생일 이전 3개월간 지급된
 *    임금 총액 / 그 기간의 총일수
 *  - 근로기준법 제2조 제2항: **평균임금이 통상임금보다 적으면 통상임금을 평균임금으로 한다.**
 *    이 하한 규정을 빠뜨린 계산기가 많다. 저임금·장기결근 구간에서 결과가 갈린다.
 *
 * 상여금·연차수당은 3개월분만 산입한다(연간 지급액 x 3/12). 대법원 판례와
 * 고용노동부 계산기가 쓰는 방식이다.
 */

const { normalizePayDate } = __req("insurance.js");

const won = (n) => Math.round(n).toLocaleString("ko-KR");

/** 'YYYY-MM-DD' -> UTC 자정 Date. 시간대에 따라 하루가 밀리는 것을 막는다. */
function toUTC(dateStr, label) {
  const s = normalizePayDate(dateStr, label);
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

const DAY = 86400000;
const diffDays = (a, b) => Math.round((b - a) / DAY);

/** 금액 입력 검증. 조용히 0으로 뭉개지 않는다. */
function money(v, label) {
  if (v === undefined || v === null || v === "") return 0;
  if (typeof v === "boolean" || Array.isArray(v)) throw new Error(`${label}: 숫자만 입력할 수 있습니다.`);
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${label}: 숫자만 입력할 수 있습니다.`);
  if (n < 0) throw new Error(`${label}은(는) 0보다 작을 수 없습니다.`);
  if (n > 1e12) throw new Error(`${label}이(가) 계산 가능 범위를 벗어났습니다.`);
  return Math.floor(n);
}

/**
 * @param {object} input
 * @param {string} input.hireDate   입사일 'YYYY-MM-DD'
 * @param {string} input.leaveDate  퇴사일(마지막 근무일의 다음날) 'YYYY-MM-DD'
 * @param {number} [input.base3m]   퇴직 전 3개월 기본급 합계
 * @param {number} [input.extra3m]  퇴직 전 3개월 기타수당 합계
 * @param {number} [input.annualBonus]  연간 상여금 총액(퇴직 전 12개월)
 * @param {number} [input.annualLeaveAllowance] 연차수당(퇴직 전 12개월분)
 * @param {number} [input.ordinaryDailyWage] 1일 통상임금. 넣으면 하한 비교를 수행한다.
 * @param {number} [input.excludedDays=0] 평균임금 산정에서 제외하는 기간(수습·육아휴직 등)
 */
function calcSeverance(input) {
  const hire = toUTC(input.hireDate, "입사일");
  const leave = toUTC(input.leaveDate, "퇴사일");

  if (leave <= hire) throw new Error("퇴사일이 입사일보다 뒤여야 합니다.");

  // 계속근로일수: 입사일부터 퇴사일 전날까지. 퇴사일 당일은 근로일이 아니다.
  const serviceDays = diffDays(hire, leave);

  const base3m = money(input.base3m, "기본급");
  const extra3m = money(input.extra3m, "기타수당");
  const annualBonus = money(input.annualBonus, "연간 상여금");
  const annualLeave = money(input.annualLeaveAllowance, "연차수당");
  const excludedDays = money(input.excludedDays, "제외기간");

  // 평균임금 산정기간: 퇴사일 직전 3개월(달력 기준). 실제 일수는 89~92일로 달마다 다르다.
  const periodStart = new Date(Date.UTC(
    leave.getUTCFullYear(), leave.getUTCMonth() - 3, leave.getUTCDate()
  ));
  const rawPeriodDays = diffDays(periodStart, leave);
  const periodDays = rawPeriodDays - excludedDays;
  if (periodDays <= 0) throw new Error("제외기간이 산정기간 전체보다 길 수 없습니다.");

  // 상여금·연차수당은 연간액의 3/12 만 산입한다.
  const bonusPortion = Math.floor((annualBonus * 3) / 12);
  const leavePortion = Math.floor((annualLeave * 3) / 12);
  const totalWage = base3m + extra3m + bonusPortion + leavePortion;

  const rawAverageDaily = totalWage / periodDays;

  // 근로기준법 제2조 제2항 — 통상임금이 하한이다.
  const ordinary = money(input.ordinaryDailyWage, "1일 통상임금");
  const ordinaryApplied = ordinary > 0 && ordinary > rawAverageDaily;
  const appliedDaily = ordinaryApplied ? ordinary : rawAverageDaily;

  const eligible = serviceDays >= 365;
  const amount = eligible ? Math.floor((appliedDaily * 30 * serviceDays) / 365) : 0;

  const warnings = [];
  if (!eligible) {
    warnings.push(
      `계속근로기간이 ${serviceDays}일로 1년(365일) 미만입니다. ` +
      `근로자퇴직급여 보장법상 퇴직금 지급 대상이 아닙니다.`
    );
  }
  if (ordinaryApplied) {
    warnings.push(
      `평균임금(${won(rawAverageDaily)}원)이 통상임금(${won(ordinary)}원)보다 적어 ` +
      `통상임금을 적용했습니다. 근로기준법 제2조 제2항에 따른 하한 규정입니다.`
    );
  }
  if (ordinary === 0) {
    warnings.push(
      "1일 통상임금을 입력하지 않아 하한 비교를 건너뛰었습니다. " +
      "평균임금이 통상임금보다 적으면 법상 통상임금으로 계산해야 하므로, " +
      "실제 금액과 달라질 수 있습니다."
    );
  }
  warnings.push(
    "주 소정근로시간이 4주 평균 15시간 미만이면 지급 대상에서 제외됩니다. " +
    "또한 퇴직으로 비로소 발생한 연차미사용수당은 평균임금에 넣지 않습니다."
  );

  return {
    eligible,
    serviceDays,
    serviceYears: (serviceDays / 365).toFixed(2),
    periodDays,
    totalWage,
    bonusPortion,
    leavePortion,
    averageDaily: Math.round(rawAverageDaily),
    ordinaryDaily: ordinary,
    ordinaryApplied,
    appliedDaily: Math.round(appliedDaily),
    amount,
    warnings,
    basis: {
      "계속근로기간": `${input.hireDate} ~ ${input.leaveDate} = ${serviceDays}일 (${(serviceDays / 365).toFixed(2)}년)`,
      "평균임금 산정기간": `${periodStart.toISOString().slice(0, 10)} ~ ${input.leaveDate}, ${rawPeriodDays}일` +
        (excludedDays ? ` - 제외 ${excludedDays}일 = ${periodDays}일` : ""),
      "임금총액": `기본급 ${won(base3m)} + 기타수당 ${won(extra3m)}` +
        (bonusPortion ? ` + 상여금 ${won(annualBonus)}x3/12 = ${won(bonusPortion)}` : "") +
        (leavePortion ? ` + 연차수당 ${won(annualLeave)}x3/12 = ${won(leavePortion)}` : "") +
        ` = ${won(totalWage)}원`,
      "1일 평균임금": `${won(totalWage)} ÷ ${periodDays}일 = ${won(rawAverageDaily)}원`,
      "적용 임금": ordinaryApplied
        ? `통상임금 ${won(ordinary)}원 (평균임금보다 커서 하한 적용)`
        : `평균임금 ${won(rawAverageDaily)}원`,
      "퇴직금": eligible
        ? `${won(appliedDaily)} × 30일 × ${serviceDays}일 ÷ 365 = ${won(amount)}원`
        : "계속근로기간 1년 미만으로 지급 대상 아님",
    },
  };
}

module.exports = { calcSeverance };

    return module.exports;
  })();

  __mod["work-allowance.js"] = (function () {
    const module = { exports: {} };
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

    return module.exports;
  })();

  global.SalaryNote = {
    rates: {
  "$comment": "샐러리노트 요율 원장. 이 파일 외의 곳에 숫자를 하드코딩하지 말 것. 자동 갱신 파이프라인이 수정하는 유일한 파일이다.",
  "year": 2026,
  "lastVerified": "2026-08-18",

  "nationalPension": {
    "label": "국민연금",
    "totalRate": 0.095,
    "employeeRate": 0.0475,
    "effectiveFrom": "2026-01-01",
    "note": "2025년 연금개혁으로 1998년 이후 첫 인상. 2026년 9.5%부터 매년 0.5%p씩 올라 2033년 13% 도달.",
    "source": "https://www.korea.kr/news/policyNewsView.do?newsId=148957270",
    "sourceAlt": "https://www.mohw.go.kr/board.es?mid=a10503000000&bid=0027&list_no=1488390&act=view",

    "$comment_base": "기준소득월액 상·하한액은 1월이 아니라 매년 7월 1일에 갱신된다. 반드시 급여 지급일 기준으로 구간을 골라야 한다.",
    "baseIncomeBrackets": [
      { "from": "2025-07-01", "to": "2026-06-30", "min": 400000, "max": 6370000 },
      { "from": "2026-07-01", "to": "2027-06-30", "min": 410000, "max": 6590000 }
    ],
    "baseIncomeSource": "https://www.nps.or.kr/pnsgdnc/newgdnc/getOHAE0001M1.do?pstId=ZZ202600000000000147"
  },

  "healthInsurance": {
    "label": "건강보험",
    "totalRate": 0.0719,
    "employeeRate": 0.03595,
    "effectiveFrom": "2026-01-01",
    "note": "2025년 7.09% 대비 0.1%p 인상.",
    "source": "https://mohw.go.kr/board.es?act=view&bid=0027&list_no=1487279&mid=a10503010100&nPage=1&tag=",

    "$premiumBoundsOpenIssue": "★미해결 — 의도적 미구현★ 국민건강보험법 제69조제6항 및 보건복지부고시(월별 건강보험료액의 상한과 하한)에 따라 보수월액보험료에는 상·하한이 있으나 이 엔진은 clamp 를 구현하지 않았다. 국민연금은 baseIncomeBrackets 로 clamp 되는데 건강보험만 없어 비대칭 상태다. 검증 과정에서 상한 노사합산 9,183,480원 / 하한 노사합산 20,160원(보건복지부고시 제2025-222호)이라는 수치가 나왔으나 웹 검색 요약이 출처이고 고시 원문(law.go.kr 미렌더링) 대조에 실패해 원장에 넣지 않았다. 검증되지 않은 숫자를 원장에 넣는 것보다 미구현이 낫다는 판단이다. 구속 지점은 보수월액 약 280,389원 미만 / 127,725,730원 초과로 추정되며, 현재 대상(연봉 3,000만~2억, 최저임금 월환산 2,156,880원)에서는 어느 쪽도 구속되지 않아 실사용 영향이 없다. ★단시간·일용·아르바이트 계산기 페이지를 추가하는 순간 하한이 실제로 발동하므로 그 전에 반드시 고시 원문을 확보해 premiumBounds 를 신설하고 calcHealthInsurance 에 clamp 를 넣을 것.★ clamp 대상이 '보수월액'인지 '보험료액'인지도 고시 문언으로 확정해야 한다(고시 제목상 보험료액 기준으로 보인다)."
  },

  "longTermCare": {
    "label": "장기요양보험",
    "rateOfHealthPremium": 0.1314,
    "rateOfIncome": 0.009448,
    "effectiveFrom": "2026-01-01",
    "note": "건강보험료에 13.14%를 곱해 산출. 소득 대비로 환산하면 0.9448%. 2025년 0.9182% 대비 2.90% 인상.",
    "source": "https://www.mohw.go.kr/board.es?mid=a10503010100&bid=0027&act=view&list_no=1487817&tag=&nPage=1"
  },

  "employmentInsurance": {
    "label": "고용보험",
    "unemploymentTotalRate": 0.018,
    "employeeRate": 0.009,
    "effectiveFrom": "2026-01-01",
    "note": "실업급여 계정 1.8%를 노사가 절반씩. 고용안정·직업능력개발(0.25~0.85%)은 사업주 전액 부담이라 근로자 실수령액과 무관.",
    "source": "https://www.comwel.or.kr/comwel/paym/paym/tari.jsp"
  },

  "minimumWage": {
    "label": "최저임금",
    "hourly": 10320,
    "monthly209h": 2156880,
    "effectiveFrom": "2026-01-01",
    "effectiveTo": "2026-12-31",
    "note": "고용노동부 고시 제2025-47호(2025.08.05). 2025년 대비 290원(2.9%) 인상.",
    "source": "https://www.moel.go.kr/info/lawinfo/instruction/view.do?bbs_seq=20250800121"
  },

  "inputLimits": {
    "label": "입력 방어 한계값",
    "$comment": "★법정 수치가 아니다.★ 세액·보험료 산출에 직접 쓰이지 않으며, 오입력과 부동소수점 오버플로를 막기 위한 공학적 방어값이다. Number.MAX_VALUE 같은 입력이 Number.isFinite 검사를 통과한 뒤 결과가 Infinity 로 오버플로해 -Infinity 실수령액을 조용히 반환하는 것을 차단한다.",
    "maxMonthlySalary": 10000000000,
    "maxMonthlySalaryNote": "월 100억원. 현실의 어떤 근로소득보다 크고, 이 값에서도 모든 중간 계산이 배정도 정수 안전범위(2^53)에 여유 있게 들어간다.",
    "monthsPerYearChoices": [12, 13],
    "monthsPerYearNote": "12 = 퇴직금 별도(원칙). 13 = 퇴직금 포함 관행(법적 근거 없음, 대법원 2007다90760 전합상 매월 분할지급 약정은 무효). 이 두 가지 외의 제수는 근거가 없으므로 거부한다.",
    "grade": "공학적 방어값(법령 근거 없음)"
  },

  "childTaxCredit": {
    "label": "간이세액표 자녀 공제액(월)",
    "$comment": "간이세액표에서 산출된 세액에서 차감한다. 차감 결과가 음수면 0원.",
    "one": 20830,
    "two": 45830,
    "threePlusBase": 45830,
    "threePlusPerExtra": 33330,
    "source": "소득세법 시행령 [별표 2] <개정 2026. 2. 27.> 비고 제3호 원문",
    "sourcePdf": "data/sources/소득세법시행령_별표2_20260227.pdf",

    "$correction": "이전 커밋에서 12,500 / 29,160 / +25,000 으로 잘못 기재했다. 그 값은 2024.2.29판이다. 국세청 안내 웹페이지가 아직 구버전을 노출 중이어서 발생한 오류이며, 법령 원문 확인으로 정정했다. 국세청 웹페이지를 요율 근거로 삼지 말 것.",

    "ageRange": "8세 이상 20세 이하",
    "$ageRangeOpenIssue": "미해결. 별표2(2026.2.27)는 '8세 이상'으로 규정하나, 이후 법률 제21548호(2026.4.21 공포·시행)가 소득세법 제59조의2 자녀세액공제 대상 연령을 '8세 이상'에서 '13세 이상'으로 상향했다. 시행령 별표2가 아직 이를 반영하지 못한 상태일 수 있다. 어느 기준이 현재 원천징수에 적용되는지 확정 전까지 자녀 공제 UI를 노출하지 말 것."
  },

  "incomeTax": {
    "label": "근로소득세 원천징수",
    "$comment": "간이세액표 자체의 금액은 data/simplified-tax-table-2026.json 에 있다. 여기에는 표에 없는 주변 규칙(선택비율·단수처리)만 둔다.",

    "withholdingRatioChoices": [0.8, 1.0, 1.2],
    "defaultWithholdingRatio": 1.0,
    "withholdingRatioSource": "소득세법 시행령 제194조 제1항 단서. 근로자가 80/100/120% 중 선택하며 미선택 시 100%.",

    "rounding": {
      "unit": 10,
      "method": "floor",
      "basis": "국고금 관리법 제47조 제1항: 국고금의 수입 또는 지출에서 10원 미만의 끝수는 계산하지 아니한다.",
      "grade": "법률(단, 제47조 제1항은 문언상 '수입 또는 지출' 단계 규정이라 계산 단계 절사를 직접 명령하지는 않는다. 급여계산기 표시 기준으로는 10원 절사가 실무 표준)",
      "$openIssue": "간이세액표 100% 값은 이미 10원 단위라 절사가 무영향이다. 80%/120% 선택 시에만 단수가 생기는데, 그 경우의 절사를 명시한 국세청 문서는 확보하지 못했다. 홈택스 간이세액표 조회에서 80% 선택 출력값 대조 필요(예: 월급여 4,000천원/가족1명 -> 100% 195,960, 80% 예상 156,760)."
    }
  },

  "localIncomeTaxRate": {
    "label": "지방소득세",
    "rate": 0.1,
    "note": "소득세액의 10%.",
    "basis": "지방세법 제103조의13 제1항: 원천징수하는 소득세의 100분의 10을 개인지방소득세로 특별징수한다.",

    "rounding": {
      "unit": 10,
      "method": "floor",
      "basis": "지방세법 제103조의13 제6항(소득세법 원천징수 규정 준용) -> 국고금 관리법 제47조 제3항(지방자치단체 준용) -> 같은 조 제1항(10원 미만 절사).",
      "grade": "실무 표준. 준용 사슬의 마지막 고리인 국고금관리법 제47조 제3항이 '준용할 수 있다'는 임의 규정이라 법령으로 100% 확정된 것은 아니다. 반올림도 1원 미만 절사도 아니며 10원 미만 절사가 급여 실무의 사실상 예외 없는 표준이다.",
      "$openIssue": "지방소득세는 절사 전 소득세 기준인지 절사 후 소득세 기준인지 명시 문서 미확보. 현재 엔진은 '절사 후 소득세 x 10% -> 절사'로 구현했다. 간이세액표 값이 이미 10원 단위라 100% 선택 시에는 두 방식의 결과가 같고, 80/120% 선택 시에만 차이가 날 수 있다."
    }
  }
}
,
    taxTable: {
 "$comment": "근로소득 간이세액표 원본. 소득세법 시행령 [별표 2]에서 기계 파싱한 데이터이며 손으로 고치지 말 것.",
 "source": {
  "law": "소득세법 시행령 [별표 2] <개정 2026. 2. 27.> (제189조제1항 관련)",
  "decree": "대통령령 제36129호",
  "promulgated": "2026-02-27",
  "effectiveFrom": "2026-03-01",
  "effectiveFromDisputed": "공포일 2026-02-27. 시행일에 대해 조사 출처가 엇갈림(law.go.kr DRF API는 20260301, 개정이유 페이지는 20260227). 국세청 안내는 '2026년 3월 1일 이후 지급분부터 적용'. 오늘(2026-08) 기준 계산에는 영향 없으나 확정 필요.",
  "pdf": "https://www.law.go.kr/LSW/flDownload.do?flSeq=164357181&bylClsCd=110201",
  "localCopy": "data/sources/소득세법시행령_별표2_20260227.pdf",
  "verification": "2026.2.27판 PDF 파싱본과 2024.2.29판 HWPX 파싱본의 646행 x 11열을 전수 대조한 결과 셀 차이 0건. 2026 개정은 자녀 공제액만 변경."
 },
 "unit": "원",
 "amountKind": "소득세만. 지방소득세(10%)는 포함되지 않음.",
 "incomeUnit": "천원. 월급여액은 비과세 및 학자금을 제외한 금액.",
 "columns": [
  "monthlyIncomeFromKRW1000",
  "monthlyIncomeToKRW1000",
  "dependents1..11"
 ],
 "dependentsNote": "공제대상가족의 수. 본인과 배우자도 각각 1명으로 산정하므로 '1명'은 본인 단독을 뜻한다.",
 "rowCount": 646,
 "rows": [
  [
   770,
   775,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   775,
   780,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   780,
   785,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   785,
   790,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   790,
   795,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   795,
   800,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   800,
   805,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   805,
   810,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   810,
   815,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   815,
   820,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   820,
   825,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   825,
   830,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   830,
   835,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   835,
   840,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   840,
   845,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   845,
   850,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   850,
   855,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   855,
   860,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   860,
   865,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   865,
   870,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   870,
   875,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   875,
   880,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   880,
   885,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   885,
   890,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   890,
   895,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   895,
   900,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   900,
   905,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   905,
   910,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   910,
   915,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   915,
   920,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   920,
   925,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   925,
   930,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   930,
   935,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   935,
   940,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   940,
   945,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   945,
   950,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   950,
   955,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   955,
   960,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   960,
   965,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   965,
   970,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   970,
   975,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   975,
   980,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   980,
   985,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   985,
   990,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   990,
   995,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   995,
   1000,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1000,
   1005,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1005,
   1010,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1010,
   1015,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1015,
   1020,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1020,
   1025,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1025,
   1030,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1030,
   1035,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1035,
   1040,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1040,
   1045,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1045,
   1050,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1050,
   1055,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1055,
   1060,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1060,
   1065,
   1040,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1065,
   1070,
   1110,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1070,
   1075,
   1180,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1075,
   1080,
   1250,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1080,
   1085,
   1320,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1085,
   1090,
   1390,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1090,
   1095,
   1460,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1095,
   1100,
   1530,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1100,
   1105,
   1600,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1105,
   1110,
   1670,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1110,
   1115,
   1740,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1115,
   1120,
   1810,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1120,
   1125,
   1880,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1125,
   1130,
   1950,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1130,
   1135,
   2020,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1135,
   1140,
   2090,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1140,
   1145,
   2160,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1145,
   1150,
   2230,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1150,
   1155,
   2300,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1155,
   1160,
   2370,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1160,
   1165,
   2440,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1165,
   1170,
   2500,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1170,
   1175,
   2570,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1175,
   1180,
   2640,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1180,
   1185,
   2710,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1185,
   1190,
   2780,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1190,
   1195,
   2850,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1195,
   1200,
   2920,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1200,
   1205,
   2990,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1205,
   1210,
   3060,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1210,
   1215,
   3130,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1215,
   1220,
   3200,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1220,
   1225,
   3270,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1225,
   1230,
   3340,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1230,
   1235,
   3410,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1235,
   1240,
   3480,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1240,
   1245,
   3550,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1245,
   1250,
   3620,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1250,
   1255,
   3700,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1255,
   1260,
   3810,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1260,
   1265,
   3910,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1265,
   1270,
   4010,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1270,
   1275,
   4120,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1275,
   1280,
   4220,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1280,
   1285,
   4320,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1285,
   1290,
   4430,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1290,
   1295,
   4530,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1295,
   1300,
   4630,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1300,
   1305,
   4740,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1305,
   1310,
   4840,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1310,
   1315,
   4940,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1315,
   1320,
   5050,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1320,
   1325,
   5150,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1325,
   1330,
   5250,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1330,
   1335,
   5360,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1335,
   1340,
   5460,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1340,
   1345,
   5560,
   1060,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1345,
   1350,
   5670,
   1170,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1350,
   1355,
   5770,
   1270,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1355,
   1360,
   5870,
   1370,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1360,
   1365,
   5980,
   1480,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1365,
   1370,
   6080,
   1580,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1370,
   1375,
   6180,
   1680,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1375,
   1380,
   6290,
   1790,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1380,
   1385,
   6390,
   1890,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1385,
   1390,
   6490,
   1990,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1390,
   1395,
   6600,
   2100,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1395,
   1400,
   6700,
   2200,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1400,
   1405,
   6800,
   2300,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1405,
   1410,
   6910,
   2410,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1410,
   1415,
   7010,
   2510,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1415,
   1420,
   7110,
   2610,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1420,
   1425,
   7210,
   2710,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1425,
   1430,
   7320,
   2820,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1430,
   1435,
   7420,
   2920,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1435,
   1440,
   7520,
   3020,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1440,
   1445,
   7630,
   3130,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1445,
   1450,
   7730,
   3230,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1450,
   1455,
   7830,
   3330,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1455,
   1460,
   7940,
   3440,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1460,
   1465,
   8040,
   3540,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1465,
   1470,
   8140,
   3640,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1470,
   1475,
   8250,
   3750,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1475,
   1480,
   8350,
   3850,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1480,
   1485,
   8450,
   3950,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1485,
   1490,
   8560,
   4060,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1490,
   1495,
   8660,
   4160,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1495,
   1500,
   8760,
   4260,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1500,
   1510,
   8920,
   4420,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1510,
   1520,
   9120,
   4620,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1520,
   1530,
   9330,
   4830,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1530,
   1540,
   9540,
   5040,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1540,
   1550,
   9740,
   5240,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1550,
   1560,
   9950,
   5450,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1560,
   1570,
   10160,
   5660,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1570,
   1580,
   10360,
   5860,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1580,
   1590,
   10570,
   6070,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1590,
   1600,
   10780,
   6280,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1600,
   1610,
   10980,
   6480,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1610,
   1620,
   11190,
   6690,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1620,
   1630,
   11400,
   6900,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1630,
   1640,
   11600,
   7100,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1640,
   1650,
   11810,
   7310,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1650,
   1660,
   12020,
   7520,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1660,
   1670,
   12220,
   7720,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1670,
   1680,
   12430,
   7930,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1680,
   1690,
   12640,
   8140,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1690,
   1700,
   12840,
   8340,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1700,
   1710,
   13050,
   8550,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1710,
   1720,
   13260,
   8760,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1720,
   1730,
   13460,
   8960,
   1040,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1730,
   1740,
   13670,
   9170,
   1240,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1740,
   1750,
   13880,
   9380,
   1440,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1750,
   1760,
   14080,
   9580,
   1640,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1760,
   1770,
   14290,
   9790,
   1830,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1770,
   1780,
   14500,
   10000,
   2030,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1780,
   1790,
   14700,
   10200,
   2230,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1790,
   1800,
   14910,
   10410,
   2430,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1800,
   1810,
   15110,
   10610,
   2630,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1810,
   1820,
   15320,
   10820,
   2830,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1820,
   1830,
   15530,
   11030,
   3020,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1830,
   1840,
   15730,
   11230,
   3220,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1840,
   1850,
   15940,
   11440,
   3420,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1850,
   1860,
   16150,
   11650,
   3620,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1860,
   1870,
   16350,
   11850,
   3820,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1870,
   1880,
   16560,
   12060,
   4020,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1880,
   1890,
   16770,
   12270,
   4220,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1890,
   1900,
   16970,
   12470,
   4410,
   1040,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1900,
   1910,
   17180,
   12680,
   4610,
   1240,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1910,
   1920,
   17390,
   12890,
   4810,
   1440,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1920,
   1930,
   17590,
   13090,
   5010,
   1630,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1930,
   1940,
   17800,
   13300,
   5210,
   1830,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1940,
   1950,
   18010,
   13510,
   5410,
   2030,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1950,
   1960,
   18210,
   13710,
   5600,
   2230,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1960,
   1970,
   18420,
   13920,
   5800,
   2430,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1970,
   1980,
   18630,
   14130,
   6000,
   2630,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1980,
   1990,
   18880,
   14330,
   6200,
   2820,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   1990,
   2000,
   19200,
   14540,
   6400,
   3020,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2000,
   2010,
   19520,
   14750,
   6600,
   3220,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2010,
   2020,
   19850,
   14950,
   6800,
   3420,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2020,
   2030,
   20170,
   15160,
   6990,
   3620,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2030,
   2040,
   20490,
   15370,
   7190,
   3820,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2040,
   2050,
   20810,
   15570,
   7390,
   4020,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2050,
   2060,
   21130,
   15780,
   7590,
   4210,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2060,
   2070,
   21450,
   15990,
   7790,
   4410,
   1040,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2070,
   2080,
   21770,
   16190,
   7990,
   4610,
   1240,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2080,
   2090,
   22090,
   16400,
   8180,
   4810,
   1430,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2090,
   2100,
   22420,
   16600,
   8380,
   5010,
   1630,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2100,
   2110,
   22740,
   16810,
   8580,
   5210,
   1830,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2110,
   2120,
   23060,
   17020,
   8780,
   5400,
   2030,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2120,
   2130,
   23380,
   17220,
   8980,
   5600,
   2230,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2130,
   2140,
   23700,
   17430,
   9180,
   5800,
   2430,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2140,
   2150,
   24020,
   17640,
   9380,
   6000,
   2630,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2150,
   2160,
   24340,
   17840,
   9570,
   6200,
   2820,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2160,
   2170,
   24660,
   18050,
   9770,
   6400,
   3020,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2170,
   2180,
   24990,
   18260,
   9970,
   6600,
   3220,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2180,
   2190,
   25310,
   18460,
   10170,
   6790,
   3420,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2190,
   2200,
   25630,
   18670,
   10370,
   6990,
   3620,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2200,
   2210,
   25950,
   18950,
   10570,
   7190,
   3820,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2210,
   2220,
   26270,
   19270,
   10760,
   7390,
   4010,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2220,
   2230,
   26590,
   19590,
   10960,
   7590,
   4210,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2230,
   2240,
   26910,
   19910,
   11160,
   7790,
   4410,
   1040,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2240,
   2250,
   27240,
   20240,
   11360,
   7980,
   4610,
   1230,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2250,
   2260,
   27560,
   20560,
   11560,
   8180,
   4810,
   1430,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2260,
   2270,
   27880,
   20880,
   11760,
   8380,
   5010,
   1630,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2270,
   2280,
   28200,
   21200,
   11960,
   8580,
   5210,
   1830,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2280,
   2290,
   28520,
   21520,
   12150,
   8780,
   5400,
   2030,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2290,
   2300,
   28840,
   21840,
   12350,
   8980,
   5600,
   2230,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2300,
   2310,
   29160,
   22160,
   12550,
   9180,
   5800,
   2430,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2310,
   2320,
   29480,
   22480,
   12750,
   9370,
   6000,
   2620,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2320,
   2330,
   29810,
   22810,
   12950,
   9570,
   6200,
   2820,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2330,
   2340,
   30130,
   23130,
   13150,
   9770,
   6400,
   3020,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2340,
   2350,
   30450,
   23450,
   13340,
   9970,
   6590,
   3220,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2350,
   2360,
   30770,
   23770,
   13540,
   10170,
   6790,
   3420,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2360,
   2370,
   31090,
   24090,
   13740,
   10370,
   6990,
   3620,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2370,
   2380,
   31410,
   24410,
   13940,
   10560,
   7190,
   3810,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2380,
   2390,
   31730,
   24730,
   14140,
   10760,
   7390,
   4010,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2390,
   2400,
   32050,
   25050,
   14340,
   10960,
   7590,
   4210,
   0,
   0,
   0,
   0,
   0
  ],
  [
   2400,
   2410,
   32380,
   25380,
   14530,
   11160,
   7780,
   4410,
   1030,
   0,
   0,
   0,
   0
  ],
  [
   2410,
   2420,
   32700,
   25700,
   14730,
   11360,
   7980,
   4610,
   1230,
   0,
   0,
   0,
   0
  ],
  [
   2420,
   2430,
   33020,
   26020,
   14930,
   11560,
   8180,
   4810,
   1430,
   0,
   0,
   0,
   0
  ],
  [
   2430,
   2440,
   33340,
   26340,
   15130,
   11760,
   8380,
   5010,
   1630,
   0,
   0,
   0,
   0
  ],
  [
   2440,
   2450,
   33660,
   26660,
   15330,
   11950,
   8580,
   5200,
   1830,
   0,
   0,
   0,
   0
  ],
  [
   2450,
   2460,
   33980,
   26980,
   15530,
   12150,
   8780,
   5400,
   2030,
   0,
   0,
   0,
   0
  ],
  [
   2460,
   2470,
   34300,
   27300,
   15730,
   12350,
   8980,
   5600,
   2230,
   0,
   0,
   0,
   0
  ],
  [
   2470,
   2480,
   34630,
   27630,
   15920,
   12550,
   9170,
   5800,
   2420,
   0,
   0,
   0,
   0
  ],
  [
   2480,
   2490,
   34950,
   27950,
   16120,
   12750,
   9370,
   6000,
   2620,
   0,
   0,
   0,
   0
  ],
  [
   2490,
   2500,
   35270,
   28270,
   16320,
   12950,
   9570,
   6200,
   2820,
   0,
   0,
   0,
   0
  ],
  [
   2500,
   2510,
   35600,
   28600,
   16530,
   13150,
   9780,
   6400,
   3030,
   0,
   0,
   0,
   0
  ],
  [
   2510,
   2520,
   35940,
   28940,
   16740,
   13360,
   9990,
   6610,
   3240,
   0,
   0,
   0,
   0
  ],
  [
   2520,
   2530,
   36280,
   29280,
   16950,
   13580,
   10200,
   6830,
   3450,
   0,
   0,
   0,
   0
  ],
  [
   2530,
   2540,
   36630,
   29630,
   17160,
   13790,
   10410,
   7040,
   3660,
   0,
   0,
   0,
   0
  ],
  [
   2540,
   2550,
   36970,
   29970,
   17370,
   14000,
   10620,
   7250,
   3870,
   0,
   0,
   0,
   0
  ],
  [
   2550,
   2560,
   37310,
   30310,
   17590,
   14210,
   10840,
   7460,
   4090,
   0,
   0,
   0,
   0
  ],
  [
   2560,
   2570,
   37650,
   30650,
   17800,
   14420,
   11050,
   7670,
   4300,
   0,
   0,
   0,
   0
  ],
  [
   2570,
   2580,
   38000,
   31000,
   18010,
   14630,
   11260,
   7880,
   4510,
   1130,
   0,
   0,
   0
  ],
  [
   2580,
   2590,
   38340,
   31340,
   18220,
   14850,
   11470,
   8100,
   4720,
   1350,
   0,
   0,
   0
  ],
  [
   2590,
   2600,
   38830,
   31680,
   18430,
   15060,
   11680,
   8310,
   4930,
   1560,
   0,
   0,
   0
  ],
  [
   2600,
   2610,
   39690,
   32020,
   18650,
   15270,
   11900,
   8520,
   5150,
   1770,
   0,
   0,
   0
  ],
  [
   2610,
   2620,
   40540,
   32360,
   18920,
   15480,
   12110,
   8730,
   5360,
   1980,
   0,
   0,
   0
  ],
  [
   2620,
   2630,
   41400,
   32710,
   19250,
   15690,
   12320,
   8940,
   5570,
   2190,
   0,
   0,
   0
  ],
  [
   2630,
   2640,
   42260,
   33050,
   19580,
   15910,
   12530,
   9160,
   5780,
   2410,
   0,
   0,
   0
  ],
  [
   2640,
   2650,
   43110,
   33390,
   19910,
   16120,
   12740,
   9370,
   5990,
   2620,
   0,
   0,
   0
  ],
  [
   2650,
   2660,
   43970,
   33730,
   20240,
   16330,
   12960,
   9580,
   6210,
   2830,
   0,
   0,
   0
  ],
  [
   2660,
   2670,
   44820,
   34080,
   20570,
   16540,
   13170,
   9790,
   6420,
   3040,
   0,
   0,
   0
  ],
  [
   2670,
   2680,
   45680,
   34420,
   20900,
   16750,
   13380,
   10000,
   6630,
   3250,
   0,
   0,
   0
  ],
  [
   2680,
   2690,
   46540,
   34760,
   21230,
   16970,
   13590,
   10220,
   6840,
   3470,
   0,
   0,
   0
  ],
  [
   2690,
   2700,
   47390,
   35100,
   21560,
   17180,
   13800,
   10430,
   7050,
   3680,
   0,
   0,
   0
  ],
  [
   2700,
   2710,
   48250,
   35450,
   21890,
   17390,
   14020,
   10640,
   7270,
   3890,
   0,
   0,
   0
  ],
  [
   2710,
   2720,
   49100,
   35790,
   22220,
   17600,
   14230,
   10850,
   7480,
   4100,
   0,
   0,
   0
  ],
  [
   2720,
   2730,
   49960,
   36130,
   22550,
   17810,
   14440,
   11060,
   7690,
   4310,
   0,
   0,
   0
  ],
  [
   2730,
   2740,
   50810,
   36470,
   22880,
   18030,
   14650,
   11280,
   7900,
   4530,
   1150,
   0,
   0
  ],
  [
   2740,
   2750,
   51670,
   36810,
   23210,
   18240,
   14860,
   11490,
   8110,
   4740,
   1360,
   0,
   0
  ],
  [
   2750,
   2760,
   52530,
   37160,
   23540,
   18450,
   15070,
   11700,
   8320,
   4950,
   1570,
   0,
   0
  ],
  [
   2760,
   2770,
   53380,
   37500,
   23870,
   18660,
   15290,
   11910,
   8540,
   5160,
   1790,
   0,
   0
  ],
  [
   2770,
   2780,
   54240,
   37840,
   24200,
   18950,
   15500,
   12120,
   8750,
   5370,
   2000,
   0,
   0
  ],
  [
   2780,
   2790,
   55090,
   38180,
   24520,
   19270,
   15710,
   12340,
   8960,
   5590,
   2210,
   0,
   0
  ],
  [
   2790,
   2800,
   55950,
   38530,
   24850,
   19600,
   15920,
   12550,
   9170,
   5800,
   2420,
   0,
   0
  ],
  [
   2800,
   2810,
   56800,
   39300,
   25180,
   19930,
   16130,
   12760,
   9380,
   6010,
   2630,
   0,
   0
  ],
  [
   2810,
   2820,
   57660,
   40160,
   25510,
   20260,
   16350,
   12970,
   9600,
   6220,
   2850,
   0,
   0
  ],
  [
   2820,
   2830,
   58520,
   41020,
   25840,
   20590,
   16560,
   13180,
   9810,
   6430,
   3060,
   0,
   0
  ],
  [
   2830,
   2840,
   59370,
   41870,
   26170,
   20920,
   16770,
   13400,
   10020,
   6650,
   3270,
   0,
   0
  ],
  [
   2840,
   2850,
   60230,
   42730,
   26500,
   21250,
   16980,
   13610,
   10230,
   6860,
   3480,
   0,
   0
  ],
  [
   2850,
   2860,
   61080,
   43580,
   26830,
   21580,
   17190,
   13820,
   10440,
   7070,
   3690,
   0,
   0
  ],
  [
   2860,
   2870,
   61940,
   44440,
   27160,
   21910,
   17410,
   14030,
   10660,
   7280,
   3910,
   0,
   0
  ],
  [
   2870,
   2880,
   62790,
   45290,
   27490,
   22240,
   17620,
   14240,
   10870,
   7490,
   4120,
   0,
   0
  ],
  [
   2880,
   2890,
   63650,
   46150,
   27820,
   22570,
   17830,
   14460,
   11080,
   7710,
   4330,
   0,
   0
  ],
  [
   2890,
   2900,
   64510,
   47010,
   28150,
   22900,
   18040,
   14670,
   11290,
   7920,
   4540,
   1170,
   0
  ],
  [
   2900,
   2910,
   65360,
   47860,
   28480,
   23230,
   18250,
   14880,
   11500,
   8130,
   4750,
   1380,
   0
  ],
  [
   2910,
   2920,
   66220,
   48720,
   28810,
   23560,
   18470,
   15090,
   11720,
   8340,
   4970,
   1590,
   0
  ],
  [
   2920,
   2930,
   67070,
   49570,
   29140,
   23890,
   18680,
   15300,
   11930,
   8550,
   5180,
   1800,
   0
  ],
  [
   2930,
   2940,
   67930,
   50430,
   29470,
   24220,
   18970,
   15510,
   12140,
   8760,
   5390,
   2010,
   0
  ],
  [
   2940,
   2950,
   68780,
   51280,
   29800,
   24550,
   19300,
   15730,
   12350,
   8980,
   5600,
   2230,
   0
  ],
  [
   2950,
   2960,
   69640,
   52140,
   30130,
   24880,
   19630,
   15940,
   12560,
   9190,
   5810,
   2440,
   0
  ],
  [
   2960,
   2970,
   70500,
   53000,
   30460,
   25210,
   19960,
   16150,
   12780,
   9400,
   6030,
   2650,
   0
  ],
  [
   2970,
   2980,
   71350,
   53850,
   30790,
   25540,
   20290,
   16360,
   12990,
   9610,
   6240,
   2860,
   0
  ],
  [
   2980,
   2990,
   72210,
   54710,
   31120,
   25870,
   20620,
   16570,
   13200,
   9820,
   6450,
   3070,
   0
  ],
  [
   2990,
   3000,
   73060,
   55560,
   31450,
   26200,
   20950,
   16790,
   13410,
   10040,
   6660,
   3290,
   0
  ],
  [
   3000,
   3020,
   74350,
   56850,
   31940,
   26690,
   21440,
   17100,
   13730,
   10350,
   6980,
   3600,
   0
  ],
  [
   3020,
   3040,
   76060,
   58560,
   32600,
   27350,
   22100,
   17530,
   14150,
   10780,
   7400,
   4030,
   0
  ],
  [
   3040,
   3060,
   77770,
   60270,
   33260,
   28010,
   22760,
   17950,
   14580,
   11200,
   7830,
   4450,
   1080
  ],
  [
   3060,
   3080,
   79480,
   61980,
   33920,
   28670,
   23420,
   18380,
   15000,
   11630,
   8250,
   4880,
   1500
  ],
  [
   3080,
   3100,
   81190,
   63690,
   34580,
   29330,
   24080,
   18830,
   15430,
   12050,
   8680,
   5300,
   1930
  ],
  [
   3100,
   3120,
   82900,
   65400,
   35240,
   29990,
   24740,
   19490,
   15850,
   12470,
   9100,
   5720,
   2350
  ],
  [
   3120,
   3140,
   84620,
   67120,
   35900,
   30650,
   25400,
   20150,
   16270,
   12900,
   9520,
   6150,
   2770
  ],
  [
   3140,
   3160,
   86330,
   68830,
   36560,
   31310,
   26060,
   20810,
   16700,
   13320,
   9950,
   6570,
   3200
  ],
  [
   3160,
   3180,
   88040,
   70540,
   37220,
   31970,
   26720,
   21470,
   17120,
   13750,
   10370,
   7000,
   3620
  ],
  [
   3180,
   3200,
   89750,
   72250,
   37880,
   32630,
   27380,
   22130,
   17540,
   14170,
   10790,
   7420,
   4040
  ],
  [
   3200,
   3220,
   91460,
   73960,
   38540,
   33290,
   28040,
   22790,
   17970,
   14590,
   11220,
   7840,
   4470
  ],
  [
   3220,
   3240,
   93170,
   75670,
   40120,
   33950,
   28700,
   23450,
   18390,
   15020,
   11640,
   8270,
   4890
  ],
  [
   3240,
   3260,
   95430,
   77380,
   41770,
   34610,
   29360,
   24110,
   18860,
   15440,
   12070,
   8690,
   5320
  ],
  [
   3260,
   3280,
   97880,
   79100,
   43420,
   35270,
   30020,
   24770,
   19520,
   15870,
   12490,
   9120,
   5740
  ],
  [
   3280,
   3300,
   100320,
   80810,
   45070,
   35920,
   30670,
   25420,
   20170,
   16290,
   12910,
   9540,
   6160
  ],
  [
   3300,
   3320,
   102770,
   82520,
   46720,
   36580,
   31330,
   26080,
   20830,
   16710,
   13340,
   9960,
   6590
  ],
  [
   3320,
   3340,
   105210,
   84230,
   48370,
   37240,
   31990,
   26740,
   21490,
   17140,
   13760,
   10390,
   7010
  ],
  [
   3340,
   3360,
   107660,
   85940,
   49940,
   37870,
   32620,
   27370,
   22120,
   17540,
   14170,
   10790,
   7420
  ],
  [
   3360,
   3380,
   110100,
   87650,
   51510,
   38500,
   33250,
   28000,
   22750,
   17950,
   14570,
   11200,
   7820
  ],
  [
   3380,
   3400,
   112550,
   89370,
   53070,
   39950,
   33880,
   28630,
   23380,
   18350,
   14970,
   11600,
   8220
  ],
  [
   3400,
   3420,
   114990,
   91080,
   54640,
   41510,
   34500,
   29250,
   24000,
   18750,
   15370,
   12000,
   8620
  ],
  [
   3420,
   3440,
   117440,
   92790,
   56200,
   43080,
   35130,
   29880,
   24630,
   19380,
   15780,
   12400,
   9030
  ],
  [
   3440,
   3460,
   119880,
   94880,
   57770,
   44640,
   35750,
   30500,
   25250,
   20000,
   16180,
   12800,
   9430
  ],
  [
   3460,
   3480,
   122330,
   97330,
   59330,
   46210,
   36380,
   31130,
   25880,
   20630,
   16580,
   13210,
   9830
  ],
  [
   3480,
   3500,
   124770,
   99770,
   60900,
   47770,
   37010,
   31760,
   26510,
   21260,
   16980,
   13610,
   10230
  ],
  [
   3500,
   3520,
   127220,
   102220,
   62460,
   49340,
   37630,
   32380,
   27130,
   21880,
   17390,
   14010,
   10640
  ],
  [
   3520,
   3540,
   129660,
   104660,
   64030,
   50900,
   38260,
   33010,
   27760,
   22510,
   17790,
   14410,
   11040
  ],
  [
   3540,
   3560,
   132110,
   107110,
   65590,
   52460,
   39340,
   33630,
   28380,
   23130,
   18190,
   14820,
   11440
  ],
  [
   3560,
   3580,
   134550,
   109550,
   67150,
   54030,
   40900,
   34260,
   29010,
   23760,
   18590,
   15220,
   11840
  ],
  [
   3580,
   3600,
   137000,
   112000,
   68720,
   55590,
   42470,
   34880,
   29630,
   24380,
   19130,
   15620,
   12250
  ],
  [
   3600,
   3620,
   139440,
   114440,
   70280,
   57160,
   44030,
   35510,
   30260,
   25010,
   19760,
   16020,
   12650
  ],
  [
   3620,
   3640,
   141890,
   116890,
   71850,
   58720,
   45600,
   36140,
   30890,
   25640,
   20390,
   16420,
   13050
  ],
  [
   3640,
   3660,
   144330,
   119330,
   73410,
   60290,
   47160,
   36760,
   31510,
   26260,
   21010,
   16830,
   13450
  ],
  [
   3660,
   3680,
   146780,
   121780,
   74980,
   61850,
   48730,
   37390,
   32140,
   26890,
   21640,
   17230,
   13850
  ],
  [
   3680,
   3700,
   149220,
   124220,
   76540,
   63420,
   50290,
   38010,
   32760,
   27510,
   22260,
   17630,
   14260
  ],
  [
   3700,
   3720,
   151670,
   126670,
   78110,
   64980,
   51860,
   38730,
   33390,
   28140,
   22890,
   18030,
   14660
  ],
  [
   3720,
   3740,
   154110,
   129110,
   79670,
   66550,
   53420,
   40300,
   34020,
   28770,
   23520,
   18440,
   15060
  ],
  [
   3740,
   3760,
   156560,
   131560,
   81230,
   68110,
   54980,
   41860,
   34640,
   29390,
   24140,
   18890,
   15460
  ],
  [
   3760,
   3780,
   163920,
   136090,
   84260,
   71130,
   58010,
   44880,
   35850,
   30600,
   25350,
   20100,
   16240
  ],
  [
   3780,
   3800,
   166590,
   138740,
   85970,
   72850,
   59720,
   46600,
   36540,
   31290,
   26040,
   20790,
   16680
  ],
  [
   3800,
   3820,
   169260,
   141400,
   87680,
   74560,
   61430,
   48310,
   37220,
   31970,
   26720,
   21470,
   17120
  ],
  [
   3820,
   3840,
   171930,
   144050,
   89390,
   76270,
   63140,
   50020,
   37900,
   32650,
   27400,
   22150,
   17560
  ],
  [
   3840,
   3860,
   174600,
   146710,
   91100,
   77980,
   64850,
   51730,
   38600,
   33340,
   28090,
   22840,
   18000
  ],
  [
   3860,
   3880,
   177270,
   149360,
   92820,
   79690,
   66570,
   53440,
   40320,
   34020,
   28770,
   23520,
   18440
  ],
  [
   3880,
   3900,
   179940,
   152020,
   94920,
   81400,
   68280,
   55150,
   42030,
   34710,
   29460,
   24210,
   18960
  ],
  [
   3900,
   3920,
   182610,
   154670,
   97370,
   83110,
   69990,
   56860,
   43740,
   35390,
   30140,
   24890,
   19640
  ],
  [
   3920,
   3940,
   185280,
   157330,
   99810,
   84830,
   71700,
   58580,
   45450,
   36080,
   30830,
   25580,
   20330
  ],
  [
   3940,
   3960,
   187950,
   159980,
   102260,
   86540,
   73410,
   60290,
   47160,
   36760,
   31510,
   26260,
   21010
  ],
  [
   3960,
   3980,
   190620,
   162640,
   104700,
   88250,
   75120,
   62000,
   48870,
   37450,
   32200,
   26950,
   21700
  ],
  [
   3980,
   4000,
   193290,
   165290,
   107150,
   89960,
   76840,
   63710,
   50590,
   38130,
   32880,
   27630,
   22380
  ],
  [
   4000,
   4020,
   195960,
   167950,
   109590,
   91670,
   78550,
   65420,
   52300,
   39170,
   33570,
   28320,
   23070
  ],
  [
   4020,
   4040,
   198630,
   170600,
   112040,
   93380,
   80260,
   67130,
   54010,
   40880,
   34250,
   29000,
   23750
  ],
  [
   4040,
   4060,
   201300,
   173260,
   114480,
   95730,
   81970,
   68840,
   55720,
   42590,
   34930,
   29680,
   24430
  ],
  [
   4060,
   4080,
   203970,
   175910,
   116930,
   98180,
   83680,
   70560,
   57430,
   44310,
   35620,
   30370,
   25120
  ],
  [
   4080,
   4100,
   206640,
   178570,
   119370,
   100620,
   85390,
   72270,
   59140,
   46020,
   36300,
   31050,
   25800
  ],
  [
   4100,
   4120,
   209310,
   181220,
   121820,
   103070,
   87100,
   73980,
   60850,
   47730,
   36990,
   31740,
   26490
  ],
  [
   4120,
   4140,
   211980,
   183880,
   124260,
   105510,
   88820,
   75690,
   62570,
   49440,
   37670,
   32420,
   27170
  ],
  [
   4140,
   4160,
   214650,
   186530,
   126710,
   107960,
   90530,
   77400,
   64280,
   51150,
   38360,
   33110,
   27860
  ],
  [
   4160,
   4180,
   217320,
   189190,
   129150,
   110400,
   92240,
   79110,
   65990,
   52860,
   39740,
   33790,
   28540
  ],
  [
   4180,
   4200,
   219990,
   191840,
   131600,
   112850,
   94100,
   80830,
   67700,
   54580,
   41450,
   34480,
   29230
  ],
  [
   4200,
   4220,
   222660,
   194500,
   134040,
   115290,
   96540,
   82540,
   69410,
   56290,
   43160,
   35160,
   29910
  ],
  [
   4220,
   4240,
   225330,
   197150,
   136490,
   117740,
   98990,
   84250,
   71120,
   58000,
   44870,
   35850,
   30600
  ],
  [
   4240,
   4260,
   228000,
   199810,
   138930,
   120180,
   101430,
   85960,
   72830,
   59710,
   46580,
   36530,
   31280
  ],
  [
   4260,
   4280,
   230670,
   202460,
   141380,
   122630,
   103880,
   87670,
   74550,
   61420,
   48300,
   37220,
   31970
  ],
  [
   4280,
   4300,
   233340,
   205120,
   143820,
   125070,
   106320,
   89380,
   76260,
   63130,
   50010,
   37900,
   32650
  ],
  [
   4300,
   4320,
   236010,
   207770,
   146270,
   127520,
   108770,
   91090,
   77970,
   64840,
   51720,
   38590,
   33330
  ],
  [
   4320,
   4340,
   238680,
   210430,
   148710,
   129960,
   111210,
   92810,
   79680,
   66560,
   53430,
   40310,
   34020
  ],
  [
   4340,
   4360,
   241350,
   213080,
   151160,
   132410,
   113660,
   94910,
   81390,
   68270,
   55140,
   42020,
   34700
  ],
  [
   4360,
   4380,
   244020,
   215740,
   153600,
   134850,
   116100,
   97350,
   83100,
   69980,
   56850,
   43730,
   35390
  ],
  [
   4380,
   4400,
   246690,
   218390,
   156050,
   137300,
   118550,
   99800,
   84820,
   71690,
   58570,
   45440,
   36070
  ],
  [
   4400,
   4420,
   249360,
   221050,
   158490,
   139740,
   120990,
   102240,
   86530,
   73400,
   60280,
   47150,
   36760
  ],
  [
   4420,
   4440,
   252030,
   223700,
   160940,
   142190,
   123440,
   104690,
   88240,
   75110,
   61990,
   48860,
   37440
  ],
  [
   4440,
   4460,
   254700,
   226360,
   163380,
   144630,
   125880,
   107130,
   89950,
   76820,
   63700,
   50570,
   38130
  ],
  [
   4460,
   4480,
   257370,
   229010,
   165830,
   147080,
   128330,
   109580,
   91660,
   78540,
   65410,
   52290,
   39160
  ],
  [
   4480,
   4500,
   260040,
   231670,
   168270,
   149520,
   130770,
   112020,
   93370,
   80250,
   67120,
   54000,
   40870
  ],
  [
   4500,
   4520,
   262840,
   234460,
   170850,
   152100,
   133350,
   114600,
   95850,
   82050,
   68930,
   55800,
   42680
  ],
  [
   4520,
   4540,
   265650,
   237250,
   173430,
   154680,
   135930,
   117180,
   98430,
   83860,
   70730,
   57610,
   44480
  ],
  [
   4540,
   4560,
   268450,
   240040,
   176010,
   157260,
   138510,
   119760,
   101010,
   85670,
   72540,
   59420,
   46290
  ],
  [
   4560,
   4580,
   271260,
   242830,
   178590,
   159840,
   141090,
   122340,
   103590,
   87470,
   74350,
   61220,
   48100
  ],
  [
   4580,
   4600,
   276560,
   248120,
   183670,
   164920,
   146170,
   127420,
   108670,
   89920,
   76150,
   63030,
   49900
  ],
  [
   4600,
   4620,
   279370,
   250910,
   186250,
   167500,
   148750,
   130000,
   111250,
   92500,
   77960,
   64830,
   51710
  ],
  [
   4620,
   4640,
   282170,
   253700,
   188830,
   170080,
   151330,
   132580,
   113830,
   95080,
   79760,
   66640,
   53510
  ],
  [
   4640,
   4660,
   284980,
   256490,
   191410,
   172660,
   153910,
   135160,
   116410,
   97660,
   81570,
   68450,
   55320
  ],
  [
   4660,
   4680,
   287780,
   259280,
   193990,
   175240,
   156490,
   137740,
   118990,
   100240,
   83380,
   70250,
   57130
  ],
  [
   4680,
   4700,
   290590,
   262070,
   196570,
   177820,
   159070,
   140320,
   121570,
   102820,
   85180,
   72060,
   58930
  ],
  [
   4700,
   4720,
   293390,
   264860,
   199150,
   180400,
   161650,
   142900,
   124150,
   105400,
   86990,
   73860,
   60740
  ],
  [
   4720,
   4740,
   296200,
   267650,
   201730,
   182980,
   164230,
   145480,
   126730,
   107980,
   89230,
   75670,
   62540
  ],
  [
   4740,
   4760,
   299000,
   270440,
   204310,
   185560,
   166810,
   148060,
   129310,
   110560,
   91810,
   77480,
   64350
  ],
  [
   4760,
   4780,
   301810,
   273230,
   206890,
   188140,
   169390,
   150640,
   131890,
   113140,
   94390,
   79280,
   66160
  ],
  [
   4780,
   4800,
   304610,
   276020,
   209470,
   190720,
   171970,
   153220,
   134470,
   115720,
   96970,
   81090,
   67960
  ],
  [
   4800,
   4820,
   307420,
   278810,
   212050,
   193300,
   174550,
   155800,
   137050,
   118300,
   99550,
   82890,
   69770
  ],
  [
   4820,
   4840,
   310220,
   281600,
   214630,
   195880,
   177130,
   158380,
   139630,
   120880,
   102130,
   84700,
   71570
  ],
  [
   4840,
   4860,
   313030,
   284390,
   217210,
   198460,
   179710,
   160960,
   142210,
   123460,
   104710,
   86510,
   73380
  ],
  [
   4860,
   4880,
   315830,
   287180,
   219790,
   201040,
   182290,
   163540,
   144790,
   126040,
   107290,
   88540,
   75190
  ],
  [
   4880,
   4900,
   318640,
   289970,
   222370,
   203620,
   184870,
   166120,
   147370,
   128620,
   109870,
   91120,
   76990
  ],
  [
   4900,
   4920,
   321440,
   292760,
   224950,
   206200,
   187450,
   168700,
   149950,
   131200,
   112450,
   93700,
   78800
  ],
  [
   4920,
   4940,
   324250,
   295550,
   227530,
   208780,
   190030,
   171280,
   152530,
   133780,
   115030,
   96280,
   80600
  ],
  [
   4940,
   4960,
   327050,
   298340,
   230110,
   211360,
   192610,
   173860,
   155110,
   136360,
   117610,
   98860,
   82410
  ],
  [
   4960,
   4980,
   329860,
   301130,
   232690,
   213940,
   195190,
   176440,
   157690,
   138940,
   120190,
   101440,
   84220
  ],
  [
   4980,
   5000,
   332660,
   303920,
   235270,
   216520,
   197770,
   179020,
   160270,
   141520,
   122770,
   104020,
   86020
  ],
  [
   5000,
   5020,
   335470,
   306710,
   237850,
   219100,
   200350,
   181600,
   162850,
   144100,
   125350,
   106600,
   87850
  ],
  [
   5020,
   5040,
   338270,
   309500,
   240430,
   221680,
   202930,
   184180,
   165430,
   146680,
   127930,
   109180,
   90430
  ],
  [
   5040,
   5060,
   341080,
   312290,
   243010,
   224260,
   205510,
   186760,
   168010,
   149260,
   130510,
   111760,
   93010
  ],
  [
   5060,
   5080,
   343880,
   315080,
   245590,
   226840,
   208090,
   189340,
   170590,
   151840,
   133090,
   114340,
   95590
  ],
  [
   5080,
   5100,
   346690,
   317870,
   248170,
   229420,
   210670,
   191920,
   173170,
   154420,
   135670,
   116920,
   98170
  ],
  [
   5100,
   5120,
   349490,
   320660,
   250750,
   232000,
   213250,
   194500,
   175750,
   157000,
   138250,
   119500,
   100750
  ],
  [
   5120,
   5140,
   352300,
   323450,
   253330,
   234580,
   215830,
   197080,
   178330,
   159580,
   140830,
   122080,
   103330
  ],
  [
   5140,
   5160,
   355100,
   326240,
   255910,
   237160,
   218410,
   199660,
   180910,
   162160,
   143410,
   124660,
   105910
  ],
  [
   5160,
   5180,
   357910,
   329030,
   258490,
   239740,
   220990,
   202240,
   183490,
   164740,
   145990,
   127240,
   108490
  ],
  [
   5180,
   5200,
   360710,
   331820,
   261070,
   242320,
   223570,
   204820,
   186070,
   167320,
   148570,
   129820,
   111070
  ],
  [
   5200,
   5220,
   363520,
   334610,
   263650,
   244900,
   226150,
   207400,
   188650,
   169900,
   151150,
   132400,
   113650
  ],
  [
   5220,
   5240,
   366320,
   337400,
   266230,
   247480,
   228730,
   209980,
   191230,
   172480,
   153730,
   134980,
   116230
  ],
  [
   5240,
   5260,
   369130,
   340190,
   268810,
   250060,
   231310,
   212560,
   193810,
   175060,
   156310,
   137560,
   118810
  ],
  [
   5260,
   5280,
   371930,
   342980,
   271390,
   252640,
   233890,
   215140,
   196390,
   177640,
   158890,
   140140,
   121390
  ],
  [
   5280,
   5300,
   374740,
   345770,
   273970,
   255220,
   236470,
   217720,
   198970,
   180220,
   161470,
   142720,
   123970
  ],
  [
   5300,
   5320,
   377540,
   348560,
   276550,
   257800,
   239050,
   220300,
   201550,
   182800,
   164050,
   145300,
   126550
  ],
  [
   5320,
   5340,
   380350,
   351350,
   279130,
   260380,
   241630,
   222880,
   204130,
   185380,
   166630,
   147880,
   129130
  ],
  [
   5340,
   5360,
   383150,
   354140,
   281710,
   262960,
   244210,
   225460,
   206710,
   187960,
   169210,
   150460,
   131710
  ],
  [
   5360,
   5380,
   385960,
   356930,
   284290,
   265540,
   246790,
   228040,
   209290,
   190540,
   171790,
   153040,
   134290
  ],
  [
   5380,
   5400,
   388760,
   359720,
   286870,
   268120,
   249370,
   230620,
   211870,
   193120,
   174370,
   155620,
   136870
  ],
  [
   5400,
   5420,
   391570,
   362510,
   289450,
   270700,
   251950,
   233200,
   214450,
   195700,
   176950,
   158200,
   139450
  ],
  [
   5420,
   5440,
   394370,
   365300,
   292030,
   273280,
   254530,
   235780,
   217030,
   198280,
   179530,
   160780,
   142030
  ],
  [
   5440,
   5460,
   397180,
   368090,
   294610,
   275860,
   257110,
   238360,
   219610,
   200860,
   182110,
   163360,
   144610
  ],
  [
   5460,
   5480,
   399980,
   370880,
   297190,
   278440,
   259690,
   240940,
   222190,
   203440,
   184690,
   165940,
   147190
  ],
  [
   5480,
   5500,
   402790,
   373670,
   299770,
   281020,
   262270,
   243520,
   224770,
   206020,
   187270,
   168520,
   149770
  ],
  [
   5500,
   5520,
   405590,
   376460,
   302350,
   283600,
   264850,
   246100,
   227350,
   208600,
   189850,
   171100,
   152350
  ],
  [
   5520,
   5540,
   408400,
   379250,
   304930,
   286180,
   267430,
   248680,
   229930,
   211180,
   192430,
   173680,
   154930
  ],
  [
   5540,
   5560,
   411200,
   382040,
   307510,
   288760,
   270010,
   251260,
   232510,
   213760,
   195010,
   176260,
   157510
  ],
  [
   5560,
   5580,
   414010,
   384830,
   310090,
   291340,
   272590,
   253840,
   235090,
   216340,
   197590,
   178840,
   160090
  ],
  [
   5580,
   5600,
   416810,
   387620,
   312670,
   293920,
   275170,
   256420,
   237670,
   218920,
   200170,
   181420,
   162670
  ],
  [
   5600,
   5620,
   419620,
   390410,
   315250,
   296500,
   277750,
   259000,
   240250,
   221500,
   202750,
   184000,
   165250
  ],
  [
   5620,
   5640,
   422420,
   393200,
   317830,
   299080,
   280330,
   261580,
   242830,
   224080,
   205330,
   186580,
   167830
  ],
  [
   5640,
   5660,
   425230,
   395990,
   320410,
   301660,
   282910,
   264160,
   245410,
   226660,
   207910,
   189160,
   170410
  ],
  [
   5660,
   5680,
   428030,
   398780,
   322990,
   304240,
   285490,
   266740,
   247990,
   229240,
   210490,
   191740,
   172990
  ],
  [
   5680,
   5700,
   430840,
   401570,
   325570,
   306820,
   288070,
   269320,
   250570,
   231820,
   213070,
   194320,
   175570
  ],
  [
   5700,
   5720,
   433640,
   404360,
   328150,
   309400,
   290650,
   271900,
   253150,
   234400,
   215650,
   196900,
   178150
  ],
  [
   5720,
   5740,
   436450,
   407150,
   330730,
   311980,
   293230,
   274480,
   255730,
   236980,
   218230,
   199480,
   180730
  ],
  [
   5740,
   5760,
   439250,
   409940,
   333310,
   314560,
   295810,
   277060,
   258310,
   239560,
   220810,
   202060,
   183310
  ],
  [
   5760,
   5780,
   442060,
   412730,
   335890,
   317140,
   298390,
   279640,
   260890,
   242140,
   223390,
   204640,
   185890
  ],
  [
   5780,
   5800,
   444860,
   415520,
   338470,
   319720,
   300970,
   282220,
   263470,
   244720,
   225970,
   207220,
   188470
  ],
  [
   5800,
   5820,
   447670,
   418310,
   341050,
   322300,
   303550,
   284800,
   266050,
   247300,
   228550,
   209800,
   191050
  ],
  [
   5820,
   5840,
   450470,
   421100,
   343630,
   324880,
   306130,
   287380,
   268630,
   249880,
   231130,
   212380,
   193630
  ],
  [
   5840,
   5860,
   470380,
   441000,
   372100,
   353350,
   334600,
   315850,
   297100,
   278350,
   259600,
   240850,
   222100
  ],
  [
   5860,
   5880,
   475720,
   446320,
   377240,
   358490,
   339740,
   320990,
   302240,
   283490,
   264740,
   245990,
   227240
  ],
  [
   5880,
   5900,
   478690,
   449140,
   379880,
   361130,
   342380,
   323630,
   304880,
   286130,
   267380,
   248630,
   229880
  ],
  [
   5900,
   5920,
   483220,
   451960,
   382520,
   363770,
   345020,
   326270,
   307520,
   288770,
   270020,
   251270,
   232520
  ],
  [
   5920,
   5940,
   487760,
   454780,
   385160,
   366410,
   347660,
   328910,
   310160,
   291410,
   272660,
   253910,
   235160
  ],
  [
   5940,
   5960,
   492300,
   457600,
   387800,
   369050,
   350300,
   331550,
   312800,
   294050,
   275300,
   256550,
   237800
  ],
  [
   5960,
   5980,
   496830,
   460420,
   390440,
   371690,
   352940,
   334190,
   315440,
   296690,
   277940,
   259190,
   240440
  ],
  [
   5980,
   6000,
   501370,
   463240,
   393080,
   374330,
   355580,
   336830,
   318080,
   299330,
   280580,
   261830,
   243080
  ],
  [
   6000,
   6020,
   505900,
   466060,
   395720,
   376970,
   358220,
   339470,
   320720,
   301970,
   283220,
   264470,
   245720
  ],
  [
   6020,
   6040,
   510440,
   468880,
   398360,
   379610,
   360860,
   342110,
   323360,
   304610,
   285860,
   267110,
   248360
  ],
  [
   6040,
   6060,
   514980,
   471700,
   401000,
   382250,
   363500,
   344750,
   326000,
   307250,
   288500,
   269750,
   251000
  ],
  [
   6060,
   6080,
   519510,
   474520,
   403640,
   384890,
   366140,
   347390,
   328640,
   309890,
   291140,
   272390,
   253640
  ],
  [
   6080,
   6100,
   524050,
   477340,
   406280,
   387530,
   368780,
   350030,
   331280,
   312530,
   293780,
   275030,
   256280
  ],
  [
   6100,
   6120,
   528580,
   481250,
   408920,
   390170,
   371420,
   352670,
   333920,
   315170,
   296420,
   277670,
   258920
  ],
  [
   6120,
   6140,
   533120,
   485760,
   411560,
   392810,
   374060,
   355310,
   336560,
   317810,
   299060,
   280310,
   261560
  ],
  [
   6140,
   6160,
   537660,
   490280,
   414200,
   395450,
   376700,
   357950,
   339200,
   320450,
   301700,
   282950,
   264200
  ],
  [
   6160,
   6180,
   542190,
   494790,
   416840,
   398090,
   379340,
   360590,
   341840,
   323090,
   304340,
   285590,
   266840
  ],
  [
   6180,
   6200,
   546730,
   499300,
   419480,
   400730,
   381980,
   363230,
   344480,
   325730,
   306980,
   288230,
   269480
  ],
  [
   6200,
   6220,
   551260,
   503810,
   422120,
   403370,
   384620,
   365870,
   347120,
   328370,
   309620,
   290870,
   272120
  ],
  [
   6220,
   6240,
   555800,
   508320,
   424760,
   406010,
   387260,
   368510,
   349760,
   331010,
   312260,
   293510,
   274760
  ],
  [
   6240,
   6260,
   560340,
   512840,
   427400,
   408650,
   389900,
   371150,
   352400,
   333650,
   314900,
   296150,
   277400
  ],
  [
   6260,
   6280,
   564870,
   517350,
   430040,
   411290,
   392540,
   373790,
   355040,
   336290,
   317540,
   298790,
   280040
  ],
  [
   6280,
   6300,
   569410,
   521860,
   432680,
   413930,
   395180,
   376430,
   357680,
   338930,
   320180,
   301430,
   282680
  ],
  [
   6300,
   6320,
   573940,
   526370,
   435320,
   416570,
   397820,
   379070,
   360320,
   341570,
   322820,
   304070,
   285320
  ],
  [
   6320,
   6340,
   578480,
   530880,
   437960,
   419210,
   400460,
   381710,
   362960,
   344210,
   325460,
   306710,
   287960
  ],
  [
   6340,
   6360,
   583020,
   535400,
   440600,
   421850,
   403100,
   384350,
   365600,
   346850,
   328100,
   309350,
   290600
  ],
  [
   6360,
   6380,
   587550,
   539910,
   443240,
   424490,
   405740,
   386990,
   368240,
   349490,
   330740,
   311990,
   293240
  ],
  [
   6380,
   6400,
   592090,
   544420,
   445880,
   427130,
   408380,
   389630,
   370880,
   352130,
   333380,
   314630,
   295880
  ],
  [
   6400,
   6420,
   596620,
   548930,
   448520,
   429770,
   411020,
   392270,
   373520,
   354770,
   336020,
   317270,
   298520
  ],
  [
   6420,
   6440,
   601160,
   553440,
   451160,
   432410,
   413660,
   394910,
   376160,
   357410,
   338660,
   319910,
   301160
  ],
  [
   6440,
   6460,
   605700,
   557960,
   453800,
   435050,
   416300,
   397550,
   378800,
   360050,
   341300,
   322550,
   303800
  ],
  [
   6460,
   6480,
   610230,
   562470,
   456440,
   437690,
   418940,
   400190,
   381440,
   362690,
   343940,
   325190,
   306440
  ],
  [
   6480,
   6500,
   614770,
   566980,
   459080,
   440330,
   421580,
   402830,
   384080,
   365330,
   346580,
   327830,
   309080
  ],
  [
   6500,
   6520,
   619300,
   571490,
   461720,
   442970,
   424220,
   405470,
   386720,
   367970,
   349220,
   330470,
   311720
  ],
  [
   6520,
   6540,
   623840,
   576000,
   464360,
   445610,
   426860,
   408110,
   389360,
   370610,
   351860,
   333110,
   314360
  ],
  [
   6540,
   6560,
   628380,
   580520,
   467000,
   448250,
   429500,
   410750,
   392000,
   373250,
   354500,
   335750,
   317000
  ],
  [
   6560,
   6580,
   632910,
   585030,
   469640,
   450890,
   432140,
   413390,
   394640,
   375890,
   357140,
   338390,
   319640
  ],
  [
   6580,
   6600,
   637450,
   589540,
   472280,
   453530,
   434780,
   416030,
   397280,
   378530,
   359780,
   341030,
   322280
  ],
  [
   6600,
   6620,
   641980,
   594050,
   474920,
   456170,
   437420,
   418670,
   399920,
   381170,
   362420,
   343670,
   324920
  ],
  [
   6620,
   6640,
   646520,
   598560,
   477560,
   458810,
   440060,
   421310,
   402560,
   383810,
   365060,
   346310,
   327560
  ],
  [
   6640,
   6660,
   651060,
   603080,
   481320,
   461450,
   442700,
   423950,
   405200,
   386450,
   367700,
   348950,
   330200
  ],
  [
   6660,
   6680,
   655590,
   607590,
   485540,
   464090,
   445340,
   426590,
   407840,
   389090,
   370340,
   351590,
   332840
  ],
  [
   6680,
   6700,
   660130,
   612100,
   489760,
   466730,
   447980,
   429230,
   410480,
   391730,
   372980,
   354230,
   335480
  ],
  [
   6700,
   6720,
   664660,
   616610,
   493990,
   469370,
   450620,
   431870,
   413120,
   394370,
   375620,
   356870,
   338120
  ],
  [
   6720,
   6740,
   669200,
   621120,
   498210,
   472010,
   453260,
   434510,
   415760,
   397010,
   378260,
   359510,
   340760
  ],
  [
   6740,
   6760,
   673740,
   625640,
   502440,
   474650,
   455900,
   437150,
   418400,
   399650,
   380900,
   362150,
   343400
  ],
  [
   6760,
   6780,
   678270,
   630150,
   506660,
   477290,
   458540,
   439790,
   421040,
   402290,
   383540,
   364790,
   346040
  ],
  [
   6780,
   6800,
   682810,
   634660,
   510880,
   480880,
   461180,
   442430,
   423680,
   404930,
   386180,
   367430,
   348680
  ],
  [
   6800,
   6820,
   687340,
   639170,
   515110,
   485110,
   463820,
   445070,
   426320,
   407570,
   388820,
   370070,
   351320
  ],
  [
   6820,
   6840,
   691880,
   643680,
   519330,
   489330,
   466460,
   447710,
   428960,
   410210,
   391460,
   372710,
   353960
  ],
  [
   6840,
   6860,
   696420,
   648200,
   523560,
   493560,
   469100,
   450350,
   431600,
   412850,
   394100,
   375350,
   356600
  ],
  [
   6860,
   6880,
   700950,
   652710,
   527780,
   497780,
   471740,
   452990,
   434240,
   415490,
   396740,
   377990,
   359240
  ],
  [
   6880,
   6900,
   705490,
   657220,
   532000,
   502000,
   474380,
   455630,
   436880,
   418130,
   399380,
   380630,
   361880
  ],
  [
   6900,
   6920,
   710020,
   661730,
   536230,
   506230,
   477020,
   458270,
   439520,
   420770,
   402020,
   383270,
   364520
  ],
  [
   6920,
   6940,
   714560,
   666240,
   540450,
   510450,
   480450,
   460910,
   442160,
   423410,
   404660,
   385910,
   367160
  ],
  [
   6940,
   6960,
   719100,
   670760,
   544680,
   514680,
   484680,
   463550,
   444800,
   426050,
   407300,
   388550,
   369800
  ],
  [
   6960,
   6980,
   723630,
   675270,
   548900,
   518900,
   488900,
   466190,
   447440,
   428690,
   409940,
   391190,
   372440
  ],
  [
   6980,
   7000,
   728170,
   679780,
   553120,
   523120,
   493120,
   468830,
   450080,
   431330,
   412580,
   393830,
   375080
  ],
  [
   7000,
   7020,
   732700,
   684290,
   557350,
   527350,
   497350,
   471470,
   452720,
   433970,
   415220,
   396470,
   377720
  ],
  [
   7020,
   7040,
   737240,
   688800,
   561570,
   531570,
   501570,
   474110,
   455360,
   436610,
   417860,
   399110,
   380360
  ],
  [
   7040,
   7060,
   741780,
   693320,
   565800,
   535800,
   505800,
   476750,
   458000,
   439250,
   420500,
   401750,
   383000
  ],
  [
   7060,
   7080,
   746310,
   697830,
   570020,
   540020,
   510020,
   480020,
   460640,
   441890,
   423140,
   404390,
   385640
  ],
  [
   7080,
   7100,
   750850,
   702340,
   574240,
   544240,
   514240,
   484240,
   463280,
   444530,
   425780,
   407030,
   388280
  ],
  [
   7100,
   7120,
   755380,
   706850,
   578470,
   548470,
   518470,
   488470,
   465920,
   447170,
   428420,
   409670,
   390920
  ],
  [
   7120,
   7140,
   759920,
   711360,
   582690,
   552690,
   522690,
   492690,
   468560,
   449810,
   431060,
   412310,
   393560
  ],
  [
   7140,
   7160,
   764460,
   715880,
   586920,
   556920,
   526920,
   496920,
   471200,
   452450,
   433700,
   414950,
   396200
  ],
  [
   7160,
   7180,
   768990,
   720390,
   591140,
   561140,
   531140,
   501140,
   473840,
   455090,
   436340,
   417590,
   398840
  ],
  [
   7180,
   7200,
   773530,
   724900,
   595360,
   565360,
   535360,
   505360,
   476480,
   457730,
   438980,
   420230,
   401480
  ],
  [
   7200,
   7220,
   778060,
   729410,
   599590,
   569590,
   539590,
   509590,
   479590,
   460370,
   441620,
   422870,
   404120
  ],
  [
   7220,
   7240,
   782600,
   733920,
   603810,
   573810,
   543810,
   513810,
   483810,
   463010,
   444260,
   425510,
   406760
  ],
  [
   7240,
   7260,
   787140,
   738440,
   608040,
   578040,
   548040,
   518040,
   488040,
   465650,
   446900,
   428150,
   409400
  ],
  [
   7260,
   7280,
   791670,
   742950,
   612260,
   582260,
   552260,
   522260,
   492260,
   468290,
   449540,
   430790,
   412040
  ],
  [
   7280,
   7300,
   796210,
   747460,
   616480,
   586480,
   556480,
   526480,
   496480,
   470930,
   452180,
   433430,
   414680
  ],
  [
   7300,
   7320,
   800740,
   751970,
   620710,
   590710,
   560710,
   530710,
   500710,
   473570,
   454820,
   436070,
   417320
  ],
  [
   7320,
   7340,
   805280,
   756480,
   624930,
   594930,
   564930,
   534930,
   504930,
   476210,
   457460,
   438710,
   419960
  ],
  [
   7340,
   7360,
   809820,
   761000,
   629160,
   599160,
   569160,
   539160,
   509160,
   479160,
   460100,
   441350,
   422600
  ],
  [
   7360,
   7380,
   814350,
   765510,
   633380,
   603380,
   573380,
   543380,
   513380,
   483380,
   462740,
   443990,
   425240
  ],
  [
   7380,
   7400,
   818890,
   770020,
   637600,
   607600,
   577600,
   547600,
   517600,
   487600,
   465380,
   446630,
   427880
  ],
  [
   7400,
   7420,
   823420,
   774530,
   641830,
   611830,
   581830,
   551830,
   521830,
   491830,
   468020,
   449270,
   430520
  ],
  [
   7420,
   7440,
   827960,
   779040,
   646050,
   616050,
   586050,
   556050,
   526050,
   496050,
   470660,
   451910,
   433160
  ],
  [
   7440,
   7460,
   832500,
   783560,
   650280,
   620280,
   590280,
   560280,
   530280,
   500280,
   473300,
   454550,
   435800
  ],
  [
   7460,
   7480,
   837030,
   788070,
   654500,
   624500,
   594500,
   564500,
   534500,
   504500,
   475940,
   457190,
   438440
  ],
  [
   7480,
   7500,
   841570,
   792580,
   658720,
   628720,
   598720,
   568720,
   538720,
   508720,
   478720,
   459830,
   441080
  ],
  [
   7500,
   7520,
   846100,
   797090,
   662950,
   632950,
   602950,
   572950,
   542950,
   512950,
   482950,
   462470,
   443720
  ],
  [
   7520,
   7540,
   850640,
   801600,
   667170,
   637170,
   607170,
   577170,
   547170,
   517170,
   487170,
   465110,
   446360
  ],
  [
   7540,
   7560,
   855180,
   806120,
   671400,
   641400,
   611400,
   581400,
   551400,
   521400,
   491400,
   467750,
   449000
  ],
  [
   7560,
   7580,
   859710,
   810630,
   675620,
   645620,
   615620,
   585620,
   555620,
   525620,
   495620,
   470390,
   451640
  ],
  [
   7580,
   7600,
   864250,
   815140,
   679840,
   649840,
   619840,
   589840,
   559840,
   529840,
   499840,
   473030,
   454280
  ],
  [
   7600,
   7620,
   868780,
   819650,
   684070,
   654070,
   624070,
   594070,
   564070,
   534070,
   504070,
   475670,
   456920
  ],
  [
   7620,
   7640,
   873320,
   824160,
   688290,
   658290,
   628290,
   598290,
   568290,
   538290,
   508290,
   478310,
   459560
  ],
  [
   7640,
   7660,
   877860,
   828680,
   692520,
   662520,
   632520,
   602520,
   572520,
   542520,
   512520,
   482520,
   462200
  ],
  [
   7660,
   7680,
   882390,
   833190,
   696740,
   666740,
   636740,
   606740,
   576740,
   546740,
   516740,
   486740,
   464840
  ],
  [
   7680,
   7700,
   886930,
   837700,
   700960,
   670960,
   640960,
   610960,
   580960,
   550960,
   520960,
   490960,
   467480
  ],
  [
   7700,
   7720,
   891460,
   842210,
   705190,
   675190,
   645190,
   615190,
   585190,
   555190,
   525190,
   495190,
   470120
  ],
  [
   7720,
   7740,
   896000,
   846720,
   709410,
   679410,
   649410,
   619410,
   589410,
   559410,
   529410,
   499410,
   472760
  ],
  [
   7740,
   7760,
   900540,
   851240,
   713640,
   683640,
   653640,
   623640,
   593640,
   563640,
   533640,
   503640,
   475400
  ],
  [
   7760,
   7780,
   905070,
   855750,
   717860,
   687860,
   657860,
   627860,
   597860,
   567860,
   537860,
   507860,
   478040
  ],
  [
   7780,
   7800,
   909610,
   860260,
   722080,
   692080,
   662080,
   632080,
   602080,
   572080,
   542080,
   512080,
   482080
  ],
  [
   7800,
   7820,
   914140,
   864770,
   726310,
   696310,
   666310,
   636310,
   606310,
   576310,
   546310,
   516310,
   486310
  ],
  [
   7820,
   7840,
   918680,
   869280,
   730530,
   700530,
   670530,
   640530,
   610530,
   580530,
   550530,
   520530,
   490530
  ],
  [
   7840,
   7860,
   923220,
   873800,
   734760,
   704760,
   674760,
   644760,
   614760,
   584760,
   554760,
   524760,
   494760
  ],
  [
   7860,
   7880,
   927750,
   878310,
   738980,
   708980,
   678980,
   648980,
   618980,
   588980,
   558980,
   528980,
   498980
  ],
  [
   7880,
   7900,
   932290,
   882820,
   743200,
   713200,
   683200,
   653200,
   623200,
   593200,
   563200,
   533200,
   503200
  ],
  [
   7900,
   7920,
   936820,
   887330,
   747430,
   717430,
   687430,
   657430,
   627430,
   597430,
   567430,
   537430,
   507430
  ],
  [
   7920,
   7940,
   941360,
   891840,
   751650,
   721650,
   691650,
   661650,
   631650,
   601650,
   571650,
   541650,
   511650
  ],
  [
   7940,
   7960,
   945900,
   896360,
   755880,
   725880,
   695880,
   665880,
   635880,
   605880,
   575880,
   545880,
   515880
  ],
  [
   7960,
   7980,
   950430,
   900870,
   760100,
   730100,
   700100,
   670100,
   640100,
   610100,
   580100,
   550100,
   520100
  ],
  [
   7980,
   8000,
   954970,
   905380,
   764320,
   734320,
   704320,
   674320,
   644320,
   614320,
   584320,
   554320,
   524320
  ],
  [
   8000,
   8020,
   959500,
   909890,
   768550,
   738550,
   708550,
   678550,
   648550,
   618550,
   588550,
   558550,
   528550
  ],
  [
   8020,
   8040,
   964040,
   914400,
   772770,
   742770,
   712770,
   682770,
   652770,
   622770,
   592770,
   562770,
   532770
  ],
  [
   8040,
   8060,
   968580,
   918920,
   777000,
   747000,
   717000,
   687000,
   657000,
   627000,
   597000,
   567000,
   537000
  ],
  [
   8060,
   8080,
   973110,
   923430,
   781220,
   751220,
   721220,
   691220,
   661220,
   631220,
   601220,
   571220,
   541220
  ],
  [
   8080,
   8100,
   977650,
   927940,
   785440,
   755440,
   725440,
   695440,
   665440,
   635440,
   605440,
   575440,
   545440
  ],
  [
   8100,
   8120,
   982180,
   932450,
   789670,
   759670,
   729670,
   699670,
   669670,
   639670,
   609670,
   579670,
   549670
  ],
  [
   8120,
   8140,
   986720,
   936960,
   793890,
   763890,
   733890,
   703890,
   673890,
   643890,
   613890,
   583890,
   553890
  ],
  [
   8140,
   8160,
   991260,
   941480,
   798120,
   768120,
   738120,
   708120,
   678120,
   648120,
   618120,
   588120,
   558120
  ],
  [
   8160,
   8180,
   995790,
   945990,
   802340,
   772340,
   742340,
   712340,
   682340,
   652340,
   622340,
   592340,
   562340
  ],
  [
   8180,
   8200,
   1000330,
   950500,
   806560,
   776560,
   746560,
   716560,
   686560,
   656560,
   626560,
   596560,
   566560
  ],
  [
   8200,
   8220,
   1004860,
   955010,
   810790,
   780790,
   750790,
   720790,
   690790,
   660790,
   630790,
   600790,
   570790
  ],
  [
   8220,
   8240,
   1009400,
   959520,
   815010,
   785010,
   755010,
   725010,
   695010,
   665010,
   635010,
   605010,
   575010
  ],
  [
   8240,
   8260,
   1013940,
   964040,
   819240,
   789240,
   759240,
   729240,
   699240,
   669240,
   639240,
   609240,
   579240
  ],
  [
   8260,
   8280,
   1018470,
   968550,
   823460,
   793460,
   763460,
   733460,
   703460,
   673460,
   643460,
   613460,
   583460
  ],
  [
   8280,
   8300,
   1023010,
   973060,
   827680,
   797680,
   767680,
   737680,
   707680,
   677680,
   647680,
   617680,
   587680
  ],
  [
   8300,
   8320,
   1027540,
   977570,
   831910,
   801910,
   771910,
   741910,
   711910,
   681910,
   651910,
   621910,
   591910
  ],
  [
   8320,
   8340,
   1032080,
   982080,
   836130,
   806130,
   776130,
   746130,
   716130,
   686130,
   656130,
   626130,
   596130
  ],
  [
   8340,
   8360,
   1036740,
   986720,
   840480,
   810480,
   780480,
   750480,
   720480,
   690480,
   660480,
   630480,
   600480
  ],
  [
   8360,
   8380,
   1041420,
   991370,
   844840,
   814840,
   784840,
   754840,
   724840,
   694840,
   664840,
   634840,
   604840
  ],
  [
   8380,
   8400,
   1046100,
   996030,
   849210,
   819210,
   789210,
   759210,
   729210,
   699210,
   669210,
   639210,
   609210
  ],
  [
   8400,
   8420,
   1050780,
   1000680,
   853580,
   823580,
   793580,
   763580,
   733580,
   703580,
   673580,
   643580,
   613580
  ],
  [
   8420,
   8440,
   1055460,
   1005340,
   857950,
   827950,
   797950,
   767950,
   737950,
   707950,
   677950,
   647950,
   617950
  ],
  [
   8440,
   8460,
   1060140,
   1010000,
   862320,
   832320,
   802320,
   772320,
   742320,
   712320,
   682320,
   652320,
   622320
  ],
  [
   8460,
   8480,
   1064820,
   1014650,
   866680,
   836680,
   806680,
   776680,
   746680,
   716680,
   686680,
   656680,
   626680
  ],
  [
   8480,
   8500,
   1069500,
   1019310,
   871050,
   841050,
   811050,
   781050,
   751050,
   721050,
   691050,
   661050,
   631050
  ],
  [
   8500,
   8520,
   1074180,
   1023960,
   875420,
   845420,
   815420,
   785420,
   755420,
   725420,
   695420,
   665420,
   635420
  ],
  [
   8520,
   8540,
   1078860,
   1028620,
   879790,
   849790,
   819790,
   789790,
   759790,
   729790,
   699790,
   669790,
   639790
  ],
  [
   8540,
   8560,
   1083540,
   1033280,
   884160,
   854160,
   824160,
   794160,
   764160,
   734160,
   704160,
   674160,
   644160
  ],
  [
   8560,
   8580,
   1088220,
   1037930,
   888520,
   858520,
   828520,
   798520,
   768520,
   738520,
   708520,
   678520,
   648520
  ],
  [
   8580,
   8600,
   1092900,
   1042590,
   892890,
   862890,
   832890,
   802890,
   772890,
   742890,
   712890,
   682890,
   652890
  ],
  [
   8600,
   8620,
   1097580,
   1047240,
   897260,
   867260,
   837260,
   807260,
   777260,
   747260,
   717260,
   687260,
   657260
  ],
  [
   8620,
   8640,
   1102260,
   1051900,
   901630,
   871630,
   841630,
   811630,
   781630,
   751630,
   721630,
   691630,
   661630
  ],
  [
   8640,
   8660,
   1106940,
   1056560,
   906000,
   876000,
   846000,
   816000,
   786000,
   756000,
   726000,
   696000,
   666000
  ],
  [
   8660,
   8680,
   1111620,
   1061210,
   910360,
   880360,
   850360,
   820360,
   790360,
   760360,
   730360,
   700360,
   670360
  ],
  [
   8680,
   8700,
   1116300,
   1065870,
   914730,
   884730,
   854730,
   824730,
   794730,
   764730,
   734730,
   704730,
   674730
  ],
  [
   8700,
   8720,
   1120980,
   1070520,
   919100,
   889100,
   859100,
   829100,
   799100,
   769100,
   739100,
   709100,
   679100
  ],
  [
   8720,
   8740,
   1125660,
   1075180,
   923470,
   893470,
   863470,
   833470,
   803470,
   773470,
   743470,
   713470,
   683470
  ],
  [
   8740,
   8760,
   1130340,
   1079840,
   927840,
   897840,
   867840,
   837840,
   807840,
   777840,
   747840,
   717840,
   687840
  ],
  [
   8760,
   8780,
   1135020,
   1084490,
   932200,
   902200,
   872200,
   842200,
   812200,
   782200,
   752200,
   722200,
   692200
  ],
  [
   8780,
   8800,
   1139700,
   1089150,
   936570,
   906570,
   876570,
   846570,
   816570,
   786570,
   756570,
   726570,
   696570
  ],
  [
   8800,
   8820,
   1144380,
   1093800,
   940940,
   910940,
   880940,
   850940,
   820940,
   790940,
   760940,
   730940,
   700940
  ],
  [
   8820,
   8840,
   1149060,
   1098460,
   945310,
   915310,
   885310,
   855310,
   825310,
   795310,
   765310,
   735310,
   705310
  ],
  [
   8840,
   8860,
   1153740,
   1103120,
   949680,
   919680,
   889680,
   859680,
   829680,
   799680,
   769680,
   739680,
   709680
  ],
  [
   8860,
   8880,
   1158420,
   1107770,
   954040,
   924040,
   894040,
   864040,
   834040,
   804040,
   774040,
   744040,
   714040
  ],
  [
   8880,
   8900,
   1163100,
   1112430,
   958410,
   928410,
   898410,
   868410,
   838410,
   808410,
   778410,
   748410,
   718410
  ],
  [
   8900,
   8920,
   1167780,
   1117080,
   962780,
   932780,
   902780,
   872780,
   842780,
   812780,
   782780,
   752780,
   722780
  ],
  [
   8920,
   8940,
   1172460,
   1121740,
   967150,
   937150,
   907150,
   877150,
   847150,
   817150,
   787150,
   757150,
   727150
  ],
  [
   8940,
   8960,
   1177140,
   1126400,
   971520,
   941520,
   911520,
   881520,
   851520,
   821520,
   791520,
   761520,
   731520
  ],
  [
   8960,
   8980,
   1181820,
   1131050,
   975880,
   945880,
   915880,
   885880,
   855880,
   825880,
   795880,
   765880,
   735880
  ],
  [
   8980,
   9000,
   1186500,
   1135710,
   980250,
   950250,
   920250,
   890250,
   860250,
   830250,
   800250,
   770250,
   740250
  ],
  [
   9000,
   9020,
   1191180,
   1140360,
   984620,
   954620,
   924620,
   894620,
   864620,
   834620,
   804620,
   774620,
   744620
  ],
  [
   9020,
   9040,
   1195860,
   1145020,
   988990,
   958990,
   928990,
   898990,
   868990,
   838990,
   808990,
   778990,
   748990
  ],
  [
   9040,
   9060,
   1200540,
   1149680,
   993360,
   963360,
   933360,
   903360,
   873360,
   843360,
   813360,
   783360,
   753360
  ],
  [
   9060,
   9080,
   1205220,
   1154330,
   997720,
   967720,
   937720,
   907720,
   877720,
   847720,
   817720,
   787720,
   757720
  ],
  [
   9080,
   9100,
   1209900,
   1158990,
   1002090,
   972090,
   942090,
   912090,
   882090,
   852090,
   822090,
   792090,
   762090
  ],
  [
   9100,
   9120,
   1214580,
   1163640,
   1006460,
   976460,
   946460,
   916460,
   886460,
   856460,
   826460,
   796460,
   766460
  ],
  [
   9120,
   9140,
   1219260,
   1168300,
   1010830,
   980830,
   950830,
   920830,
   890830,
   860830,
   830830,
   800830,
   770830
  ],
  [
   9140,
   9160,
   1223940,
   1172960,
   1015200,
   985200,
   955200,
   925200,
   895200,
   865200,
   835200,
   805200,
   775200
  ],
  [
   9160,
   9180,
   1228620,
   1177610,
   1019560,
   989560,
   959560,
   929560,
   899560,
   869560,
   839560,
   809560,
   779560
  ],
  [
   9180,
   9200,
   1233300,
   1182270,
   1023930,
   993930,
   963930,
   933930,
   903930,
   873930,
   843930,
   813930,
   783930
  ],
  [
   9200,
   9220,
   1237980,
   1186920,
   1028300,
   998300,
   968300,
   938300,
   908300,
   878300,
   848300,
   818300,
   788300
  ],
  [
   9220,
   9240,
   1244640,
   1191580,
   1032670,
   1002670,
   972670,
   942670,
   912670,
   882670,
   852670,
   822670,
   792670
  ],
  [
   9240,
   9260,
   1251470,
   1196240,
   1037040,
   1007040,
   977040,
   947040,
   917040,
   887040,
   857040,
   827040,
   797040
  ],
  [
   9260,
   9280,
   1258290,
   1200890,
   1041400,
   1011400,
   981400,
   951400,
   921400,
   891400,
   861400,
   831400,
   801400
  ],
  [
   9280,
   9300,
   1265120,
   1205550,
   1045770,
   1015770,
   985770,
   955770,
   925770,
   895770,
   865770,
   835770,
   805770
  ],
  [
   9300,
   9320,
   1271940,
   1210200,
   1050140,
   1020140,
   990140,
   960140,
   930140,
   900140,
   870140,
   840140,
   810140
  ],
  [
   9320,
   9340,
   1278770,
   1214860,
   1054510,
   1024510,
   994510,
   964510,
   934510,
   904510,
   874510,
   844510,
   814510
  ],
  [
   9340,
   9360,
   1285590,
   1219520,
   1058880,
   1028880,
   998880,
   968880,
   938880,
   908880,
   878880,
   848880,
   818880
  ],
  [
   9360,
   9380,
   1292420,
   1224170,
   1063240,
   1033240,
   1003240,
   973240,
   943240,
   913240,
   883240,
   853240,
   823240
  ],
  [
   9380,
   9400,
   1299240,
   1228830,
   1067610,
   1037610,
   1007610,
   977610,
   947610,
   917610,
   887610,
   857610,
   827610
  ],
  [
   9400,
   9420,
   1306070,
   1233480,
   1071980,
   1041980,
   1011980,
   981980,
   951980,
   921980,
   891980,
   861980,
   831980
  ],
  [
   9420,
   9440,
   1312890,
   1238140,
   1076350,
   1046350,
   1016350,
   986350,
   956350,
   926350,
   896350,
   866350,
   836350
  ],
  [
   9440,
   9460,
   1319720,
   1244840,
   1080720,
   1050720,
   1020720,
   990720,
   960720,
   930720,
   900720,
   870720,
   840720
  ],
  [
   9460,
   9480,
   1326540,
   1251630,
   1085080,
   1055080,
   1025080,
   995080,
   965080,
   935080,
   905080,
   875080,
   845080
  ],
  [
   9480,
   9500,
   1333370,
   1258420,
   1089450,
   1059450,
   1029450,
   999450,
   969450,
   939450,
   909450,
   879450,
   849450
  ],
  [
   9500,
   9520,
   1340190,
   1265210,
   1093820,
   1063820,
   1033820,
   1003820,
   973820,
   943820,
   913820,
   883820,
   853820
  ],
  [
   9520,
   9540,
   1347020,
   1272000,
   1098190,
   1068190,
   1038190,
   1008190,
   978190,
   948190,
   918190,
   888190,
   858190
  ],
  [
   9540,
   9560,
   1353840,
   1278790,
   1102560,
   1072560,
   1042560,
   1012560,
   982560,
   952560,
   922560,
   892560,
   862560
  ],
  [
   9560,
   9580,
   1360670,
   1285580,
   1106920,
   1076920,
   1046920,
   1016920,
   986920,
   956920,
   926920,
   896920,
   866920
  ],
  [
   9580,
   9600,
   1367490,
   1292370,
   1111290,
   1081290,
   1051290,
   1021290,
   991290,
   961290,
   931290,
   901290,
   871290
  ],
  [
   9600,
   9620,
   1374320,
   1299160,
   1115660,
   1085660,
   1055660,
   1025660,
   995660,
   965660,
   935660,
   905660,
   875660
  ],
  [
   9620,
   9640,
   1381140,
   1305950,
   1120030,
   1090030,
   1060030,
   1030030,
   1000030,
   970030,
   940030,
   910030,
   880030
  ],
  [
   9640,
   9660,
   1387970,
   1312740,
   1124400,
   1094400,
   1064400,
   1034400,
   1004400,
   974400,
   944400,
   914400,
   884400
  ],
  [
   9660,
   9680,
   1394790,
   1319530,
   1128760,
   1098760,
   1068760,
   1038760,
   1008760,
   978760,
   948760,
   918760,
   888760
  ],
  [
   9680,
   9700,
   1401620,
   1326320,
   1133130,
   1103130,
   1073130,
   1043130,
   1013130,
   983130,
   953130,
   923130,
   893130
  ],
  [
   9700,
   9720,
   1408440,
   1333110,
   1137500,
   1107500,
   1077500,
   1047500,
   1017500,
   987500,
   957500,
   927500,
   897500
  ],
  [
   9720,
   9740,
   1415270,
   1339900,
   1141870,
   1111870,
   1081870,
   1051870,
   1021870,
   991870,
   961870,
   931870,
   901870
  ],
  [
   9740,
   9760,
   1422090,
   1346690,
   1146240,
   1116240,
   1086240,
   1056240,
   1026240,
   996240,
   966240,
   936240,
   906240
  ],
  [
   9760,
   9780,
   1428920,
   1353480,
   1150600,
   1120600,
   1090600,
   1060600,
   1030600,
   1000600,
   970600,
   940600,
   910600
  ],
  [
   9780,
   9800,
   1435740,
   1360270,
   1154970,
   1124970,
   1094970,
   1064970,
   1034970,
   1004970,
   974970,
   944970,
   914970
  ],
  [
   9800,
   9820,
   1442570,
   1367060,
   1159340,
   1129340,
   1099340,
   1069340,
   1039340,
   1009340,
   979340,
   949340,
   919340
  ],
  [
   9820,
   9840,
   1449390,
   1373850,
   1163710,
   1133710,
   1103710,
   1073710,
   1043710,
   1013710,
   983710,
   953710,
   923710
  ],
  [
   9840,
   9860,
   1456220,
   1380640,
   1168080,
   1138080,
   1108080,
   1078080,
   1048080,
   1018080,
   988080,
   958080,
   928080
  ],
  [
   9860,
   9880,
   1463040,
   1387430,
   1172440,
   1142440,
   1112440,
   1082440,
   1052440,
   1022440,
   992440,
   962440,
   932440
  ],
  [
   9880,
   9900,
   1469870,
   1394220,
   1176810,
   1146810,
   1116810,
   1086810,
   1056810,
   1026810,
   996810,
   966810,
   936810
  ],
  [
   9900,
   9920,
   1476690,
   1401010,
   1181180,
   1151180,
   1121180,
   1091180,
   1061180,
   1031180,
   1001180,
   971180,
   941180
  ],
  [
   9920,
   9940,
   1483520,
   1407800,
   1185550,
   1155550,
   1125550,
   1095550,
   1065550,
   1035550,
   1005550,
   975550,
   945550
  ],
  [
   9940,
   9960,
   1490340,
   1414590,
   1189920,
   1159920,
   1129920,
   1099920,
   1069920,
   1039920,
   1009920,
   979920,
   949920
  ],
  [
   9960,
   9980,
   1497170,
   1421380,
   1194280,
   1164280,
   1134280,
   1104280,
   1074280,
   1044280,
   1014280,
   984280,
   954280
  ],
  [
   9980,
   10000,
   1503990,
   1428170,
   1198650,
   1168650,
   1138650,
   1108650,
   1078650,
   1048650,
   1018650,
   988650,
   958650
  ]
 ],
 "exactCapRow": {
  "monthlyIncomeKRW1000": 10000,
  "values": [
   1507400,
   1431570,
   1200840,
   1170840,
   1140840,
   1110840,
   1080840,
   1050840,
   1020840,
   990840,
   960840
  ],
  "note": "월급여액이 정확히 10,000천원인 경우의 별도 행. 아래 초과 구간 산식에서 '10,000천원인 경우의 해당 세액'으로도 사용된다."
 },
 "$overflowFormulasMachineReadable": "expr 문자열은 사람이 읽는 원문 요약이라 코드가 못 읽는다. 엔진이 숫자를 하드코딩하지 않도록 constant/hasNinetyEight/pct 3개 필드를 덧붙였다. expr 과 sourceText 는 원문 보존용이며 계산에 쓰지 않는다. 이 3개 필드는 PDF 27p 표 셀 단위 재파싱(pdfplumber extract_tables)으로 확정했고, 5개 경계 상수를 직전 구간 산식으로 역산해 11개 가족수 열 전부에서 오차 0으로 일치함을 확인했다. 원문은 25,000원을 1번 구간 맨 뒤에 쓰지만 덧셈이라 위치가 무관하므로 constant 자리에 넣어 6개 구간을 'cap + constant + 초과액 x rate' 로 균일화했다.",
 "overflowFormulas": [
  {
   "fromKRW1000": 10000,
   "toKRW1000": 14000,
   "constant": 25000,
   "hasNinetyEight": true,
   "pct": 35,
   "expr": "cap + (초과액 x 98%)의 35% + 25000",
   "sourceText": "(10,000천원인 경우의 해당 세액) + (10,000천원을 초과하는 금액에 98%를 곱한 금액의 35% 상당액) + (25,000원)"
  },
  {
   "fromKRW1000": 14000,
   "toKRW1000": 28000,
   "constant": 1397000,
   "hasNinetyEight": true,
   "pct": 38,
   "expr": "cap + 1397000 + (14,000천원 초과액 x 98%)의 38%",
   "sourceText": "(10,000천원인 경우의 해당 세액) + (1,397,000원) + (14,000천원을 초과하는 금액에 98%를 곱한 금액의 38% 상당액)"
  },
  {
   "fromKRW1000": 28000,
   "toKRW1000": 30000,
   "constant": 6610600,
   "hasNinetyEight": true,
   "pct": 40,
   "expr": "cap + 6610600 + (28,000천원 초과액 x 98%)의 40%",
   "sourceText": "(10,000천원인 경우의 해당 세액) + (6,610,600원) + (28,000천원을 초과하는 금액에 98%를 곱한 금액의 40% 상당액)"
  },
  {
   "fromKRW1000": 30000,
   "toKRW1000": 45000,
   "constant": 7394600,
   "hasNinetyEight": false,
   "pct": 40,
   "expr": "cap + 7394600 + (30,000천원 초과액)의 40%",
   "sourceText": "(10,000천원인 경우의 해당 세액) + (7,394,600원) + (30,000천원을 초과하는 금액의 40% 상당액)"
  },
  {
   "fromKRW1000": 45000,
   "toKRW1000": 87000,
   "constant": 13394600,
   "hasNinetyEight": false,
   "pct": 42,
   "expr": "cap + 13394600 + (45,000천원 초과액)의 42%",
   "sourceText": "(10,000천원인 경우의 해당 세액) + (13,394,600원) + (45,000천원을 초과하는 금액의 42% 상당액)"
  },
  {
   "fromKRW1000": 87000,
   "toKRW1000": null,
   "constant": 31034600,
   "hasNinetyEight": false,
   "pct": 45,
   "expr": "cap + 31034600 + (87,000천원 초과액)의 45%",
   "sourceText": "(10,000천원인 경우의 해당 세액) + (31,034,600원) + (87,000천원을 초과하는 금액의 45% 상당액)"
  }
 ],
 "overflowNote": "cap = 공제대상가족수별 exactCapRow 값. 98%는 앞 3개 구간에만 있고 뒤 3개 구간에는 없다(법문 그대로이며 경계 상수 역산으로 증명됨 - 뒤 구간에 98%를 끼워 넣으면 경계가 어긋난다). 98%를 곱한 뒤 pct%를 곱하는 순차 적용이며 중간 반올림 규정이 없으므로 E x 0.98 x 0.35 = E x 0.343 과 동일하다. 중간 단계에서 절대 반올림하지 말 것.",
 "overflowSeamNote": "월급여 10,000천원 지점에서 exactCapRow(1,507,400원, 가족1명)와 초과 산식의 극한값(1,532,400원) 사이에 25,000원 계단이 생긴다. 이는 전사 오류가 아니라 법문상 의도된 불연속이다. 2번 구간 상수 1,397,000 = 4,000천원 x 98% x 35% + 25,000 으로 25,000원이 그대로 이월되어 있는 것이 결정적 증거다. 이 계단을 버그로 보고 없애지 말 것.",
 "$overflowVerification": "10,000천원 초과 영역 내부는 5개 경계 전부(11개 가족수 열 x 5개 = 55개 조합) 완전 연속임을 정밀 연산으로 확인했다. 다만 이 구간 계산 결과를 대조할 외부 정답지는 아직 없다. 근거는 원문 문언 + 상수 역산이라는 내부 정합성뿐이므로, 홈택스 간이세액표 자동조회로 1건이라도 실측 대조가 필요하다.",
 "rules": {
  "dependentsOver11": "(11명 세액) - (10명 세액 - 11명 세액) x (11명 초과 가족수)",
  "withholdingRatioChoice": "근로자는 80% / 100% / 120% 중 선택 가능(소득세법 시행령 제194조 제1항 단서). 미선택 시 100%.",
  "zeroCells": "원문에서 '-'로 표기된 칸은 세액 0원."
 }
},
    calcNetPay: __mod["net-pay.js"].calcNetPay,
    annualToMonthly: __mod["net-pay.js"].annualToMonthly,
    calcSocialInsurance: __mod["insurance.js"].calcSocialInsurance,
    calcIncomeTax: __mod["income-tax.js"].calcIncomeTax,
    lookupTableTax: __mod["income-tax.js"].lookupTableTax,
    calcSeverance: __mod["severance.js"].calcSeverance,
    calcWeeklyHolidayPay: __mod["work-allowance.js"].calcWeeklyHolidayPay,
    calcAnnualLeave: __mod["work-allowance.js"].calcAnnualLeave,
    convertWage: __mod["work-allowance.js"].convertWage,
  };
})(typeof window !== "undefined" ? window : globalThis);
