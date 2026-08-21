/**
 * 육아휴직 급여 계산 엔진
 *
 * 근거 (법제처 원문 확인)
 *  - 고용보험법 제70조: 지급 요건(육아휴직 30일 이상 + 피보험 단위기간 180일 이상)
 *  - 시행령 제95조제1항: 기간별 급여율과 상·하한
 *      1~3개월  통상임금 100%, 상한 250만원
 *      4~6개월  통상임금 100%, 상한 200만원
 *      7개월~   통상임금  80%, 상한 160만원
 *      전 구간 하한 70만원
 *  - 시행령 제95조의3제3항: 한부모는 1~3개월 상한 300만원
 *  - 시행령 제95조제3항: 1개월을 채우지 못하면 휴직 일수에 비례
 *
 * ★적용 범위를 2025-01-01 이후 시작한 휴직으로 제한한다★
 *  대통령령 제35100호 부칙 제3조·제7조에 따라 적용 기준이 '휴직 시작일'이 아니라
 *  '급여가 귀속하는 달'이다. 2024년에 시작한 건은 한 건 안에서 새 규정과 종전 규정이
 *  섞이는데, 종전 규정 값을 원문으로 확정하지 않았다. 추정으로 계산하는 대신 거부한다.
 *
 * ★하한 70만원은 최저임금과 연동되지 않는다★
 *  조문에 최저임금 언급이 없는 고정 정액이다. 구직급여 하한이 최저임금 연동인 것과 다르다.
 */

const path = require("path");
const { normalizePayDate } = require(path.join(__dirname, "insurance.js"));

const won = (n) => Math.round(n).toLocaleString("ko-KR");

function num(v, label, { min = 0, max = 1e11, required = false, integer = false } = {}) {
  if (v === undefined || v === null || v === "") {
    if (required) throw new Error(`${label}을(를) 입력해 주세요.`);
    return 0;
  }
  if (typeof v === "boolean" || Array.isArray(v)) throw new Error(`${label}: 숫자만 입력할 수 있습니다.`);
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${label}: 숫자만 입력할 수 있습니다.`);
  if (n < min) throw new Error(`${label}은(는) ${min} 이상이어야 합니다.`);
  if (n > max) throw new Error(`${label}이(가) 계산 가능 범위를 벗어났습니다.`);
  if (integer && !Number.isInteger(n)) throw new Error(`${label}은(는) 정수여야 합니다.`);
  return n;
}

/** 해당 개월차에 적용할 구간을 고른다. 경계는 '이상 ~ 이하'다. */
function resolveTier(tiers, monthIndex) {
  const hit = tiers.find(
    (t) => monthIndex >= t.fromMonth && (t.toMonth === null || monthIndex <= t.toMonth)
  );
  if (!hit) throw new Error(`${monthIndex}개월차에 적용할 급여 구간을 찾을 수 없습니다.`);
  return hit;
}

/**
 * @param {object} input
 * @param {number} input.monthlyOrdinaryWage 육아휴직 시작일 기준 월 통상임금(원)
 * @param {string} input.leaveStartDate      육아휴직 시작일 'YYYY-MM-DD'
 * @param {number} input.months              사용할 육아휴직 개월 수
 * @param {boolean} [input.singleParent=false] 한부모 여부
 * @param {object} data data/parental-leave-2026.json
 */
function calcParentalLeave(input, data) {
  const wage = num(input.monthlyOrdinaryWage, "월 통상임금", { max: 1e9, required: true });
  const months = num(input.months, "육아휴직 개월 수", { min: 1, max: 18, required: true, integer: true });
  const start = normalizePayDate(input.leaveStartDate, "육아휴직 시작일");

  // ── 적용 범위 검사 ───────────────────────────────────────────
  const from = data.$supportedRange.leaveStartFrom;
  if (start < from) {
    throw new Error(
      `${from} 이전에 시작한 육아휴직은 계산하지 않습니다. ` +
      `2025년 1월 1일을 기준으로 급여 체계가 바뀌었는데, 그 전에 시작한 경우 한 건 안에서 ` +
      `새 규정과 종전 규정이 섞입니다. 종전 규정 값을 확정하지 못해 추정으로 계산하는 대신 거부합니다. ` +
      `고용센터나 고용보험 누리집에서 확인해 주세요.`
    );
  }

  const singleParent = !!input.singleParent;
  const tiers = singleParent ? data.singleParent.tiers : data.tiers;
  const floor = data.floorMonthly;

  // ── 월별 지급액 ──────────────────────────────────────────────
  const monthly = [];
  for (let m = 1; m <= months; m++) {
    const tier = resolveTier(tiers, m);
    const raw = wage * tier.rate;
    let amount = Math.floor(raw);
    let bound = null;
    if (amount > tier.capMonthly) { amount = tier.capMonthly; bound = "상한"; }
    else if (amount < floor) { amount = floor; bound = "하한"; }
    monthly.push({
      month: m,
      rate: tier.rate,
      cap: tier.capMonthly,
      raw: Math.floor(raw),
      amount,
      bound,
    });
  }

  const total = monthly.reduce((s, x) => s + x.amount, 0);
  const capBoundCount = monthly.filter((x) => x.bound === "상한").length;
  const floorBoundCount = monthly.filter((x) => x.bound === "하한").length;

  // 구간별 요약 (화면 표시용)
  const bySegment = [];
  for (const t of tiers) {
    const rows = monthly.filter(
      (x) => x.month >= t.fromMonth && (t.toMonth === null || x.month <= t.toMonth)
    );
    if (!rows.length) continue;
    bySegment.push({
      label: t.toMonth === null ? `${t.fromMonth}개월차~` : `${t.fromMonth}~${t.toMonth}개월차`,
      months: rows.length,
      rate: t.rate,
      cap: t.capMonthly,
      perMonth: rows[0].amount,
      subtotal: rows.reduce((s, x) => s + x.amount, 0),
      uniform: rows.every((x) => x.amount === rows[0].amount),
    });
  }

  // ── 경고 ─────────────────────────────────────────────────────
  const warnings = [];

  warnings.push(
    `이 금액은 수급 요건을 갖춘 경우의 계산 결과입니다. 육아휴직을 ${data.eligibility.minLeaveDays}일 이상 ` +
    `부여받고, 시작일 이전 피보험 단위기간이 합산 ${data.eligibility.insuredUnitDays}일 이상이어야 합니다` +
    `(고용보험법 제70조제1항). 요건 충족 여부는 고용센터가 판단합니다.`
  );

  if (capBoundCount > 0) {
    warnings.push(
      `${capBoundCount}개월분이 상한에 걸렸습니다. 통상임금이 높아도 상한을 넘는 금액은 지급되지 않습니다.`
    );
  }
  if (floorBoundCount > 0) {
    warnings.push(
      `${floorBoundCount}개월분이 하한 ${won(floor)}원에 걸렸습니다. ` +
      `이 하한은 최저임금과 연동되지 않는 고정 금액입니다.`
    );
  }

  if (months > data.leaveDuration.maxMonths) {
    warnings.push(
      `육아휴직은 원칙적으로 ${data.leaveDuration.maxMonths}개월 이내입니다. ` +
      `${data.leaveDuration.maxMonths}개월을 넘겨 쓰려면 부모가 각각 3개월 이상 사용했거나, ` +
      `한부모이거나, 장애아동의 부 또는 모여야 합니다(남녀고용평등법 제19조제2항). ` +
      `해당하지 않으면 ${data.leaveDuration.maxMonths}개월까지만 가능합니다.`
    );
  }

  warnings.push(
    "사후지급금 제도는 폐지됐습니다. 예전에는 급여의 25%를 복직 6개월 후에 지급했지만, " +
    "2025년 1월 1일 이후 기간분은 전액 매월 지급됩니다(시행령 제95조제4항 삭제). " +
    "아직 옛 정보를 안내하는 곳이 있으니 주의하세요."
  );

  warnings.push(
    "부모가 모두 육아휴직을 하면 첫 6개월 상한이 최대 450만원까지 올라가는 특례가 있습니다" +
    "(시행령 제95조의3제1항). 배우자의 사용 개월수와 자녀 출생 후 18개월 요건이 얽혀 있어 " +
    "이 계산기는 금액을 계산하지 않습니다. 해당한다면 고용센터에서 확인하세요."
  );

  warnings.push(
    "육아휴직 중 취업하면 그 기간은 지급되지 않습니다. 1주 소정근로시간 15시간 이상이거나 " +
    "월 150만원 이상 소득이 있으면 취업으로 봅니다(시행규칙 제116조제3항). " +
    "사업주에게서 육아휴직을 이유로 금품을 받은 경우에도 감액될 수 있습니다(시행령 제98조)."
  );

  return {
    monthlyOrdinaryWage: wage,
    leaveStartDate: start,
    months,
    singleParent,
    floorMonthly: floor,
    monthly,
    bySegment,
    total,
    capBoundCount,
    floorBoundCount,
    warnings,
    basis: {
      "적용 기준": singleParent
        ? "한부모 특례 (시행령 제95조의3제3항)"
        : "일반 규정 (시행령 제95조제1항)",
      "월 통상임금": `${won(wage)}원 (육아휴직 시작일 기준, 매월 재산정하지 않음)`,
      "구간별 지급액": bySegment
        .map((s) => `${s.label} ${s.months}개월 × ${won(s.perMonth)}원 = ${won(s.subtotal)}원`)
        .join(" / "),
      "상·하한": `상한은 구간별로 다르고 하한은 전 구간 ${won(floor)}원. 급여율을 곱한 뒤의 금액에 적용한다.`,
      "총 예상액": `${won(total)}원 (${months}개월 합계)`,
    },
  };
}

module.exports = { calcParentalLeave, resolveTier };
