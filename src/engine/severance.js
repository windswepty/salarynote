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

const path = require("path");
const { normalizePayDate } = require(path.join(__dirname, "insurance.js"));

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
