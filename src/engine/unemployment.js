/**
 * 실업급여(구직급여) 계산 엔진
 *
 * 정본은 법제처 원문이다. 고용노동부 안내 페이지·블로그는 구버전일 수 있다.
 * 모든 숫자는 data/unemployment-2026.json 에서 읽는다. 여기에 금액을 쓰지 말 것.
 *
 * 계산 순서 (고용보험법 제45조·제46조·별표1)
 *  1) 평균임금일액(기초일액_raw)                       제45조제1항
 *  2) 최저기초일액 = 이직일 당시 최저임금 시급 × 1일 소정근로시간   제45조제4항
 *  3) 상한(대통령령) = 시행령 제68조제1항                제45조제5항
 *  4) 기초일액 = clamp(raw, 최저기초일액, 상한)
 *  5) 최저기초일액이 적용된 경우 ×80%, 그 외 ×60%       제46조제1항 제2호/제1호
 *  6) 구직급여일액 = max(위 값, 최저구직급여일액)        제46조제2항
 *  7) 소정급여일수 = 별표1[이직일 현재 연령][피보험기간]
 *  8) 총 예상 수령액 = 구직급여일액 × 소정급여일수      (대기기간 7일은 차감하지 않는다)
 *
 * ★상·하한 역전★
 * 하한은 최저임금에 자동 연동되고 상한은 시행령 고정값이라, 최저임금이 오르면
 * 하한이 상한을 넘어설 수 있다. 실제로 2026년에 그 상황이 벌어질 뻔했고
 * 정부가 상한을 110,000 → 113,500(구직급여일액 66,000 → 68,100)으로 올려 해소했다.
 * 그래도 로직은 역전을 견뎌야 한다. 제46조제2항이 "제1항제1호에 따라 산정된
 * 구직급여일액이 최저구직급여일액보다 낮은 경우에는 최저구직급여일액을 그
 * 수급자격자의 구직급여일액으로 한다"고 무조건적으로 정하고, 최저구직급여일액에는
 * 어떤 상한 단서도 붙어 있지 않다. 따라서 ★역전 시 하한이 이긴다.★
 * 6단계의 max() 가 그 규칙이며, 결과에 inverted 플래그와 근거를 함께 실어 보낸다.
 *
 * ★이직일 분기★
 * 대통령령 제35934호 부칙 제4조는 "이 영 시행 전에 이직한 사람"에게 종전 규정을
 * 적용한다. 기준은 신청일·수급일이 아니라 이직일이다. 이직일을 받지 않고 2026년
 * 값만 쓰면 2025년 이직자에게 1일 최대 2,100원을 과다 표시한다(270일이면 567,000원).
 */

const path = require("path");
const { normalizePayDate } = require(path.join(__dirname, "insurance.js"));

const won = (n) => Math.round(n).toLocaleString("ko-KR");

/** 소수 첫째 자리까지 살린다. 공식 계산기가 일액의 소수를 그대로 끌고 가기 때문이다. */
const r2 = (n) => Math.round(n * 100) / 100;

/** 소수가 있으면 보여주고 없으면 정수로. 66048.6 -> "66,048.6", 66048 -> "66,048" */
function amt(n) {
  const rounded = r2(n);
  if (Number.isInteger(rounded)) return rounded.toLocaleString("ko-KR");
  const whole = Math.trunc(rounded);
  const frac = Math.abs(rounded - whole).toFixed(2).replace(/0+$/, "").slice(1);
  return whole.toLocaleString("ko-KR") + frac;
}

const pad = (n) => String(n).padStart(2, "0");

/** 이직일 + N년. 2/29 처럼 다음 해에 없는 날은 그 달의 마지막 날로 당긴다. */
function addYearsClamped(dateStr, years) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const ty = y + years;
  const lastDay = new Date(Date.UTC(ty, m, 0)).getUTCDate();
  return `${ty}-${pad(m)}-${pad(Math.min(d, lastDay))}`;
}

/** 숫자 입력 검증. 조용히 0 으로 뭉개지 않는다. */
function num(v, label, { min, max, required = false, integer = false } = {}) {
  if (v === undefined || v === null || v === "") {
    if (required) throw new Error(`${label}을(를) 입력해 주세요.`);
    return null;
  }
  if (typeof v === "boolean" || Array.isArray(v)) throw new Error(`${label}: 숫자만 입력할 수 있습니다.`);
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${label}: 숫자만 입력할 수 있습니다.`);
  if (integer && !Number.isInteger(n)) throw new Error(`${label}은(는) 정수여야 합니다.`);
  if (min !== undefined && n < min) throw new Error(`${label}은(는) ${min} 이상이어야 합니다.`);
  if (max !== undefined && n > max) throw new Error(`${label}이(가) 계산 가능 범위를 벗어났습니다(최대 ${max}).`);
  return n;
}

/**
 * 이직일로 코호트를 고른다. 못 찾으면 조용히 최신 값을 쓰지 않고 던진다.
 * 조용한 폴백이 바로 '2025년 이직자에게 2026년 상한을 먹이는' 사고다.
 */
function resolveCohort(data, leaveDate) {
  const hit = (data.cohorts || []).find(
    (c) => leaveDate >= c.leaveDateFrom && leaveDate <= c.leaveDateTo
  );
  if (!hit) {
    const froms = (data.cohorts || []).map((c) => c.leaveDateFrom).sort();
    const tos = (data.cohorts || []).map((c) => c.leaveDateTo).sort();
    const earliest = froms[0];
    const latest = tos[tos.length - 1];

    // ★미래 방향도 과거와 똑같이 거부한다.★
    // 예전에는 2026 구간이 9999-12-31 까지 열려 있어서 2027년 이직일에
    // 2026년 최저임금·상한이 조용히 적용됐다. 2027년 최저임금(10,700원)은
    // 이미 고시됐으므로 그 값은 명백히 틀린 금액이었고, 경고조차 없었다.
    if (leaveDate > latest) {
      throw new Error(
        `이직일 ${leaveDate} 는 아직 계산할 수 없습니다. ` +
        `${latest.slice(0, 4)}년 이후 이직에 적용될 구직급여 상한액은 시행령 개정으로 정해지는데 ` +
        `아직 확정되지 않았습니다. 추정값으로 계산하는 대신 거부합니다. ` +
        `이 계산기는 현재 ${earliest} ~ ${latest} 사이 이직만 지원합니다.`
      );
    }
    throw new Error(
      `이직일 ${leaveDate} 에 적용할 상·하한 기준을 원장에서 찾을 수 없습니다. ` +
      `이 계산기는 ${earliest} ~ ${latest} 사이 이직만 지원합니다. ` +
      `해당 연도의 시간급 최저임금과 당시 시행령 상한액을 법령 원문으로 확정하지 못했기 때문이며, ` +
      `확인하지 못한 값으로 계산하는 대신 거부합니다.`
    );
  }
  return hit;
}

/** 별표1 축 조회. 경계는 전부 '이상/미만' 이라 >= 로 위쪽 구간에 넣는다. */
function resolveAgeBracket(table, age, disabled) {
  if (disabled) return table.disabilityRule.treatAsBracket;
  const brackets = table.ageAxis.brackets;
  const hit = brackets.find(
    (b) => (b.minAge === null || age >= b.minAge) && (b.maxAgeExclusive === null || age < b.maxAgeExclusive)
  );
  if (!hit) throw new Error(`별표1 연령 구간을 찾을 수 없습니다: ${age}세`);
  return hit.id;
}

function resolvePeriodBracket(table, months) {
  const hit = table.insuredPeriodAxis.find(
    (b) => months >= b.minMonths && (b.maxMonthsExclusive === null || months < b.maxMonthsExclusive)
  );
  if (!hit) throw new Error(`별표1 피보험기간 구간을 찾을 수 없습니다: ${months}개월`);
  return hit;
}

/**
 * @param {object} input
 * @param {string} input.leaveDate           이직일 'YYYY-MM-DD' (★상·하한 분기 기준★)
 * @param {number} [input.monthlyWage]       이직 전 3개월 월평균임금(원)
 * @param {number} [input.averageDailyWage]  평균임금일액을 직접 아는 경우 (있으면 이쪽이 우선)
 * @param {number} input.age                 이직일 현재 만 나이
 * @param {number} input.insuredMonths       고용보험 총 가입기간(개월)
 * @param {number} [input.dailyWorkHours=8]  이직 전 1일 소정근로시간
 * @param {boolean} [input.disabled=false]   장애인고용촉진법 제2조제1호 장애인 여부
 * @param {object} data                      data/unemployment-<연도>.json
 */
function calcUnemploymentBenefit(input, data) {
  if (!data || !data.cohorts || !data.durationTable || !data.rates) {
    throw new Error("실업급여 원장(data/unemployment-*.json)이 전달되지 않았습니다.");
  }
  const lim = data.inputLimits;
  const R = data.rates;
  const table = data.durationTable;

  // ── 이직일과 코호트 ──────────────────────────────────────────
  const leaveDate = normalizePayDate(input.leaveDate, "이직일");
  const cohort = resolveCohort(data, leaveDate);

  // ── 입력 ─────────────────────────────────────────────────────
  const age = num(input.age, "이직일 현재 만 나이", { min: 0, max: lim.maxAge, required: true, integer: true });
  const insuredMonths = num(input.insuredMonths, "고용보험 총 가입기간(개월)", {
    min: 0, max: lim.maxInsuredMonths, required: true,
  });
  const hours = input.dailyWorkHours === undefined || input.dailyWorkHours === null || input.dailyWorkHours === ""
    ? 8
    : num(input.dailyWorkHours, "1일 소정근로시간", { min: 0, max: lim.maxDailyWorkHours });
  if (hours <= 0) throw new Error("1일 소정근로시간은 0보다 커야 합니다.");
  const disabled = input.disabled === true;

  const givenDaily = num(input.averageDailyWage, "평균임금일액", { min: 0, max: lim.maxMonthlyWage });
  const monthlyWage = num(input.monthlyWage, "월평균임금", { min: 0, max: lim.maxMonthlyWage });
  if (givenDaily === null && monthlyWage === null) {
    throw new Error("이직 전 3개월 월평균임금 또는 평균임금일액을 입력해 주세요.");
  }

  // 평균임금일액 환산. 공식 간편계산기는 floor(월평균임금 / 30) 을 쓴다.
  // 근로기준법 제2조제1항제6호의 정본 산식(3개월 임금총액 ÷ 총일수)과 다르므로 근거에 밝힌다.
  const usedRule = givenDaily !== null ? "actual" : data.averageWageRule.default;
  const rawBaseDaily = givenDaily !== null ? Math.floor(givenDaily) : Math.floor(monthlyWage / 30);
  if (rawBaseDaily <= 0) throw new Error("임금이 0원이면 구직급여를 계산할 수 없습니다.");

  // ── 기초일액 (제45조 제4항·제5항) ─────────────────────────────
  const minWageHourly = cohort.minWageHourly;
  const minBaseDaily = r2(minWageHourly * hours);   // 최저기초일액, 제45조제4항
  const maxBaseDaily = cohort.maxBaseDaily;          // 상한, 제45조제5항 + 시행령 제68조제1항

  const floorAppliedAtBase = rawBaseDaily < minBaseDaily;
  const capAppliedAtBase = rawBaseDaily > maxBaseDaily;
  // 하한을 먼저 본다. 역전 시에도 6단계 max() 가 하한을 되살리므로 결과는 같지만,
  // 조문 순서(제45조제4항 → 제5항)와 표시 근거를 일치시킨다.
  const baseDaily = floorAppliedAtBase ? minBaseDaily : (capAppliedAtBase ? maxBaseDaily : rawBaseDaily);

  // ── 구직급여일액 (제46조) ────────────────────────────────────
  const minDaily = r2(minBaseDaily * R.dailyMin);   // 최저구직급여일액, 제46조제1항제2호
  const maxDaily = r2(maxBaseDaily * R.daily);      // 상한이 구속했을 때의 일액 (파생값)
  const inverted = minDaily > maxDaily;             // ★상·하한 역전★

  const beforeFloor = floorAppliedAtBase
    ? r2(baseDaily * R.dailyMin)   // 제46조제1항제2호
    : r2(baseDaily * R.daily);     // 제46조제1항제1호

  // 제46조제2항 — 최종 단계에서 하한이 무조건 덮어쓴다. 역전 시 하한이 이기는 지점이다.
  const floorOverrode = beforeFloor < minDaily;
  const dailyAmount = r2(Math.max(beforeFloor, minDaily));

  const floorBinding = floorAppliedAtBase || floorOverrode || dailyAmount === minDaily;
  const capBinding = !floorBinding && capAppliedAtBase;
  const bound = floorBinding ? "하한" : capBinding ? "상한" : "없음";

  // ── 소정급여일수 (제50조제1항, 별표1) ────────────────────────
  const ageBracketId = resolveAgeBracket(table, age, disabled);
  const periodBracket = resolvePeriodBracket(table, insuredMonths);
  const days = table.days[ageBracketId][periodBracket.id];
  if (typeof days !== "number") {
    throw new Error(`별표1에 해당 칸이 없습니다: ${ageBracketId} / ${periodBracket.id}`);
  }
  const ageBracketLabel = disabled
    ? "장애인 (별표1 비고에 따라 50세 이상 적용)"
    : table.ageAxis.brackets.find((b) => b.id === ageBracketId).label;

  // ── 총액 ─────────────────────────────────────────────────────
  // 대기기간 7일은 차감하지 않는다. 제50조제1항이 소정급여일수를 대기기간이
  // 끝난 다음 날부터 기산하기 때문이다(공식 모의계산기 실측도 동일).
  const totalAmount = Math.round(days * dailyAmount);

  // ── 수급기간 (제48조제1항) ───────────────────────────────────
  // 이직일 다음 날부터 12개월. 민법 제157조·제160조에 따라 만료일은 이직일 + 1년.
  const benefitWindowEnd = addYearsClamped(leaveDate, 1);

  // ── 경고 ─────────────────────────────────────────────────────
  const warnings = [];

  if (inverted) {
    warnings.push(
      `이 조건에서는 최저구직급여일액(${amt(minDaily)}원)이 상한이 구속했을 때의 일액(${amt(maxDaily)}원)보다 큽니다. ` +
      `고용보험법 제46조제2항이 최종 단계에서 최저구직급여일액을 무조건 적용하도록 정하고 있어 하한이 우선합니다. ` +
      `다만 이 해석은 조문 구조에 근거한 것이며 판례·행정해석으로 확인된 것은 아닙니다.`
    );
  }

  warnings.push(
    `상·하한 기준은 ★이직일★ 로 갈립니다(대통령령 제35934호 부칙 제4조). ` +
    `이직일 ${leaveDate} 기준으로 ${cohort.label} 구간을 적용했습니다. 신청일·수급일이 아닙니다.`
  );

  if (hours !== 8) {
    warnings.push(
      `하한액은 1일 소정근로시간에 비례합니다(고용보험법 제45조제4항). ` +
      `${hours}시간 기준 하한은 ${amt(minDaily)}원이며, 흔히 인용되는 8시간 기준 금액과 다릅니다. ` +
      `1일 소정근로시간 산정 방법은 고용보험법 시행규칙 제91조의2에 따릅니다(주 40시간 통상 근로자는 8시간).`
    );
  }

  if (!Number.isInteger(dailyAmount)) {
    warnings.push(
      `구직급여일액의 원 단위 단수처리(절사/반올림)를 정한 규정이 법령에 없습니다. ` +
      `고용24 공식 모의계산기와 동일하게 소수를 그대로 두었습니다. 실제 지급액과 원 단위에서 다를 수 있습니다.`
    );
  }

  warnings.push(
    `소정급여일수는 '고용보험 총 가입기간'으로 정해집니다. 현재 직장 재직기간이 아닙니다. ` +
    `종전 직장 상실일부터 3년 이내에 재취업했다면 종전 피보험기간을 합산합니다(제50조제4항제1호). ` +
    `다만 그 상실로 구직급여를 받은 적이 있으면 그 기간은 제외됩니다.`
  );

  warnings.push(
    `이 금액은 수급자격이 인정된 경우의 상한선입니다. ` +
    `기준기간(이직일 이전 18개월) 동안 피보험 단위기간이 합산 ${data.periods.insuredUnitDaysMin}일 이상이어야 합니다(제40조제1항제1호). ` +
    `피보험 단위기간은 재직일수가 아니라 '보수 지급의 기초가 된 날'의 합이므로(제41조제1항), ` +
    `정확한 일수는 이직확인서나 고용보험 홈페이지에서 확인하세요.`
  );

  if (insuredMonths < 7) {
    warnings.push(
      `가입기간이 ${insuredMonths}개월이면 피보험 단위기간 ${data.periods.insuredUnitDaysMin}일 요건을 채우지 못했을 가능성이 큽니다. ` +
      `요건 미달이면 소정급여일수와 무관하게 구직급여가 지급되지 않습니다.`
    );
  }

  warnings.push(
    `이직 사유가 수급자격 제한 사유(제58조)에 해당하는지는 이 계산기가 판정하지 않습니다. ` +
    `제58조 본문이 판정 주체를 '직업안정기관의 장'으로 명시하고 있습니다. 최종 판단은 관할 고용센터가 합니다.`
  );

  warnings.push(
    `수급기간은 이직일 다음 날부터 12개월입니다(제48조제1항). 이 건의 만료일은 ${benefitWindowEnd} 입니다. ` +
    `소정급여일수가 남아 있어도 이 날짜가 지나면 지급이 끝나므로, 이직 후 지체 없이 신고해야 합니다. ` +
    `대기기간 ${data.periods.waitingDays}일은 실업 신고일부터 기산하며(제49조제1항) 총액에서 차감하지 않습니다.`
  );

  if (age >= 65) {
    warnings.push(
      `65세 이후에 새로 고용된 사람에게는 실업급여(제4장)가 적용되지 않습니다(제10조제2항). ` +
      `다만 65세 전부터 피보험자격을 유지하다가 계속 고용된 경우는 제외되므로 적용 대상입니다.`
    );
  }

  if (usedRule === "divide30") {
    warnings.push(
      `평균임금일액을 월평균임금 ÷ 30 으로 환산했습니다(고용24 공식 간편계산기와 동일한 규칙). ` +
      `근로기준법 제2조제1항제6호의 정본 산식은 '이직 전 3개월 임금총액 ÷ 그 기간의 총일수(89~92일)' 이므로 실제 값과 다를 수 있습니다.`
    );
  }

  warnings.push(
    `자영업자·일용근로자·예술인·노무제공자는 산정 체계가 달라 이 계산기의 범위가 아닙니다. ` +
    `연장급여(훈련·개별·특별)도 지급 요건이 재량 사항이라 포함하지 않았습니다.`
  );

  return {
    cohortId: cohort.id,
    cohortLabel: cohort.label,
    leaveDate,
    dailyWorkHours: hours,

    averageWageRule: usedRule,
    rawBaseDaily,
    minBaseDaily,
    maxBaseDaily,
    baseDaily,

    minDaily,
    maxDaily,
    dailyAmount,
    dailyAmountIsFractional: !Number.isInteger(dailyAmount),
    bound,
    floorBinding,
    capBinding,
    inverted,

    ageBracket: ageBracketId,
    ageBracketLabel,
    periodBracket: periodBracket.id,
    periodBracketLabel: periodBracket.label,
    days,
    totalAmount,

    benefitWindowEnd,
    waitingDays: data.periods.waitingDays,

    warnings,
    basis: {
      "적용 기준(이직일)": `${leaveDate} → ${cohort.label}. 근거: ${cohort.maxBaseDailyDecree}. ` +
        `분기 기준은 신청일이 아니라 이직일이다(대통령령 제35934호 부칙 제4조).`,
      "평균임금일액": usedRule === "divide30"
        ? `월평균임금 ${won(monthlyWage)}원 ÷ 30 = ${won(rawBaseDaily)}원 (${data.averageWageRule.official.note})`
        : `직접 입력 ${won(rawBaseDaily)}원 (${data.averageWageRule.statutory.basis})`,
      "최저기초일액": `최저임금 시급 ${won(minWageHourly)}원 × 1일 소정근로시간 ${hours}시간 = ${amt(minBaseDaily)}원 ` +
        `(고용보험법 제45조제4항, 이직일 당시 최저임금 기준)`,
      "기초일액 상한": `${won(maxBaseDaily)}원 (${cohort.maxBaseDailyBasis})`,
      "기초일액": floorAppliedAtBase
        ? `${won(rawBaseDaily)}원 < 최저기초일액 ${amt(minBaseDaily)}원 → 최저기초일액 적용 (제45조제4항)`
        : capAppliedAtBase
          ? `${won(rawBaseDaily)}원 > 상한 ${won(maxBaseDaily)}원 → 상한 적용 (제45조제5항)`
          : `${won(rawBaseDaily)}원 (상·하한 사이라 그대로 적용)`,
      "구직급여일액": floorAppliedAtBase
        ? `${amt(baseDaily)} × ${R.dailyMin * 100}% = ${amt(beforeFloor)}원 (제46조제1항제2호, 최저구직급여일액)`
        : `${amt(baseDaily)} × ${R.daily * 100}% = ${amt(beforeFloor)}원 (제46조제1항제1호)`,
      "하한 비교(제46조제2항)": floorOverrode
        ? `${amt(beforeFloor)}원 < 최저구직급여일액 ${amt(minDaily)}원 → 최저구직급여일액을 적용한다.`
        : `${amt(beforeFloor)}원 ≥ 최저구직급여일액 ${amt(minDaily)}원 → 그대로 적용한다.`,
      "상·하한 역전 여부": inverted
        ? `★역전★ 하한 ${amt(minDaily)}원 > 상한 ${amt(maxDaily)}원. ` +
          `제46조제2항에는 상한 단서가 없어 하한이 우선한다. 적용 일액 ${amt(dailyAmount)}원.`
        : `역전 없음. 상한 ${amt(maxDaily)}원 > 하한 ${amt(minDaily)}원 (여유 ${amt(r2(maxDaily - minDaily))}원). ` +
          `하한은 최저임금에 연동되고 상한은 시행령 고정값이라, 최저임금이 오르면 다시 좁아진다.`,
      "적용 구속": bound === "하한"
        ? `하한 구속 — 구직급여일액이 최저구직급여일액 ${amt(minDaily)}원으로 결정됐다.`
        : bound === "상한"
          ? `상한 구속 — 기초일액 상한 ${won(maxBaseDaily)}원이 적용되어 일액이 ${amt(maxDaily)}원으로 묶였다.`
          : `구속 없음 — 상·하한 사이 구간이다.`,
      "소정급여일수": `${ageBracketLabel} × ${periodBracket.label}(가입 ${insuredMonths}개월) = ${days}일 ` +
        `(${table.basis})`,
      "총 예상 수령액": `${amt(dailyAmount)}원 × ${days}일 = ${won(totalAmount)}원 ` +
        `(대기기간 ${data.periods.waitingDays}일은 차감하지 않는다 — 제50조제1항)`,
      "수급기간 만료일": `${benefitWindowEnd} (이직일 다음 날부터 12개월, 제48조제1항)`,
    },
  };
}

/** 별표1 전체를 화면에 그대로 보여줄 때 쓴다. 숫자를 HTML 에 손으로 적지 않기 위한 통로다. */
function benefitDaysTable(data) {
  const t = data.durationTable;
  return {
    title: t.title,
    basis: t.basis,
    remark: t.remark,
    columns: t.insuredPeriodAxis.map((b) => b.label),
    rows: t.ageAxis.brackets.map((a) => ({
      label: a.label,
      days: t.insuredPeriodAxis.map((b) => t.days[a.id][b.id]),
    })),
  };
}

module.exports = { calcUnemploymentBenefit, benefitDaysTable, resolveCohort };
