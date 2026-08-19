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
