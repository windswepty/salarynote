/**
 * 본문의 '계산 예시' 를 계산 엔진으로 직접 만들어 써 넣는다.
 *
 *   node build/examples.js            다시 계산해 써 넣는다
 *   node build/examples.js --check    원장·엔진과 어긋나면 실패한다 (CI 용)
 *
 * ★왜 손으로 쓰지 않는가★
 * 애드센스가 '가치가 별로 없는 콘텐츠' 로 거절했다(2026-10). 계산기만 있고
 * 설명이 얇은 페이지는 흔한 계산기 사이트와 구별되지 않는다. 단계별로 풀어
 * 쓴 예시가 가장 확실한 고유 가치인데, 예시 숫자를 손으로 적으면 1월에 요율이
 * 바뀌는 순간 계산기와 본문이 서로 다른 답을 낸다. 그래서 예시는 계산기와
 * 똑같은 엔진이 만들고, 원장이 바뀌면 같이 바뀐다.
 *
 * 표식: <!--EXAMPLE:id--> … <!--/EXAMPLE-->
 * ★예시 안에 <div> 를 쓰지 않는다.★ faq.js 가 'card prose' 를 첫 </div> 까지만
 * 읽으므로, div 가 끼면 그 뒤의 질문들이 FAQ 구조화 데이터에서 사라진다.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "web");
const CHECK = process.argv.includes("--check");

const { resolve, assertCurrent } = require(path.join(ROOT, "tools", "lib", "resolve-ledger.js"));
const LEDGER = assertCurrent(resolve());
const rates = JSON.parse(fs.readFileSync(LEDGER.ledgerPath, "utf8"));
const taxTable = JSON.parse(fs.readFileSync(
  path.join(ROOT, "data", `simplified-tax-table-${LEDGER.year}.json`), "utf8"));
const parental = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "parental-leave-2026.json"), "utf8"));

const E = (n) => require(path.join(ROOT, "src", "engine", `${n}.js`));
const { calcWeeklyHolidayPay, calcAnnualLeave, convertWage } = E("work-allowance");
const { calcOvertimePay } = E("overtime");
const { calcSeverance } = E("severance");
const { calcSocialInsurance } = E("insurance");
const { calcNetPay } = E("net-pay");
const { calcPartTimePay } = E("parttime");
const { checkMinimumWage } = E("minwage");
const { calcParentalLeave } = E("parental-leave");

const won = (n) => Math.round(n).toLocaleString("ko-KR") + "원";
const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
const MIN = rates.minimumWage.hourly;
const Y = rates.year;

/** 국민연금 상·하한 구간 중 가장 나중 것. salary-table.js 와 같은 이유로 오늘 날짜를 쓰지 않는다. */
const PAY_DATE = rates.nationalPension.baseIncomeBrackets
  .reduce((a, b) => (a.from > b.from ? a : b)).from;

const basisRows = (r) => Object.entries(r.basis);

/**
 * id → { page, title, lead, rows, result }
 * lead·result 는 문장 하나. rows 는 [항목, 계산] 배열.
 */
const EXAMPLES = {
  "whp-20h": () => {
    const r = calcWeeklyHolidayPay(20, MIN, rates);
    return {
      page: "weekly-holiday-pay",
      title: "주 20시간 아르바이트",
      lead: `평일 4시간씩 주 5일, 시급은 ${Y}년 최저임금 ${won(MIN)}이고 그 주를 개근했습니다.`,
      rows: basisRows(r),
      result: `한 주에 ${won(r.amount)}, 한 달 평균 ${won(r.monthlyAmount)}의 주휴수당이 발생합니다.`,
    };
  },
  "whp-14h": () => {
    const r = calcWeeklyHolidayPay(14, MIN, rates);
    return {
      page: "weekly-holiday-pay",
      title: "주 14시간 아르바이트",
      lead: `주말 이틀 7시간씩, 시급은 같은 ${won(MIN)}입니다.`,
      rows: basisRows(r).filter(([k]) => k !== "월 환산"),
      result: `1주 소정근로시간이 15시간에 1시간 모자라 주휴수당은 ${won(r.amount)}입니다.`,
    };
  },
  "wc-annual": () => {
    const r = convertWage({ annual: 36_000_000, weeklyHours: 40 }, rates);
    return {
      page: "wage-converter",
      title: "연봉 3,600만원을 시급으로",
      lead: "주 40시간 근무, 연봉에 퇴직금이 포함되지 않은 일반적인 계약입니다.",
      rows: [
        ["월 소정근로시간", r.basis["월 소정근로시간"]],
        ["월급", `36,000,000 ÷ 12 = ${won(3_000_000)}`],
        ["시급", `3,000,000 ÷ ${r.monthlyHours}시간 = ${won(3_000_000 / r.monthlyHours)}`],
      ],
      result: `환산 시급은 약 ${won(r.hourly)}으로 ${Y}년 최저임금 ${won(MIN)}보다 ` +
        `${r.hourly >= MIN ? "높습니다" : "낮습니다"}.`,
    };
  },
  "wc-30h": () => {
    const r = convertWage({ hourly: MIN, weeklyHours: 30 }, rates);
    return {
      page: "wage-converter",
      title: "주 30시간, 최저임금 시급을 월급으로",
      lead: "하루 6시간씩 주 5일 일하는 단시간 근로자입니다. 주휴시간도 근로시간에 비례해 줄어듭니다.",
      rows: basisRows(r),
      result: `월 소정근로시간은 209시간이 아니라 ${r.monthlyHours}시간이고, 최저 월급은 ${won(r.monthly)}입니다.`,
    };
  },
  "al-table": () => {
    const years = [1, 2, 3, 5, 7, 9, 11, 15, 19, 21, 25];
    return {
      page: "annual-leave",
      title: "근속연수별 연차 일수",
      lead: "매년 출근율 80% 이상을 전제로, 그 해에 새로 생기는 연차입니다.",
      rows: years.map((y) => [`${y}년`, `${calcAnnualLeave(y, 0, 0).entitledDays}일`]),
      result: "21년 차에 25일이 되고 그 뒤로는 더 늘지 않습니다.",
    };
  },
  "al-5y": () => {
    const daily = MIN * 8;
    const r = calcAnnualLeave(5, 6, daily);
    return {
      page: "annual-leave",
      title: "근속 5년, 6일을 못 쓴 경우",
      lead: `하루 8시간 근무, 통상시급은 ${Y}년 최저임금 ${won(MIN)}입니다. 1일 통상임금은 ${won(MIN)} × 8시간 = ${won(daily)}입니다.`,
      rows: basisRows(r),
      result: `연차사용촉진 절차가 없었다면 ${won(r.amount)}을 연차수당으로 받습니다.`,
    };
  },
  "ot-5plus": () => {
    const r = calcOvertimePay({ employees: 10, monthlyOrdinaryWage: 3_000_000,
      overtimeHours: 12, nightHours: 4, holidayHours: 10 }, rates);
    return {
      page: "overtime-pay",
      title: "직원 10명 회사, 한 달 연장 12시간·야간 4시간·휴일 10시간",
      lead: "월 통상임금 300만원, 주 40시간 근무자입니다. 야간 4시간은 연장근로 12시간 중 밤 10시 이후에 걸친 시간입니다.",
      rows: basisRows(r),
      result: `이 달 가산수당을 포함한 추가 임금은 ${won(r.total)}입니다.`,
    };
  },
  "ot-under5": () => {
    const r = calcOvertimePay({ employees: 4, monthlyOrdinaryWage: 3_000_000,
      overtimeHours: 12, nightHours: 4, holidayHours: 10 }, rates);
    const big = calcOvertimePay({ employees: 10, monthlyOrdinaryWage: 3_000_000,
      overtimeHours: 12, nightHours: 4, holidayHours: 10 }, rates);
    return {
      page: "overtime-pay",
      title: "같은 근무, 직원 4명 회사라면",
      lead: "근무 내용은 위와 똑같고 상시 근로자 수만 다릅니다.",
      rows: basisRows(r),
      result: `가산 없이 일한 시간만큼만 받아 ${won(r.total)}입니다. 5인 이상 사업장보다 ${won(big.total - r.total)} 적습니다.`,
    };
  },
  "sev-3y": () => {
    const ordinaryDaily = Math.floor(3_000_000 / 209 * 8);
    const r = calcSeverance({ hireDate: "2023-04-03", leaveDate: "2026-04-03",
      base3m: 9_000_000, extra3m: 0, annualBonus: 3_000_000, annualLeaveAllowance: 0,
      ordinaryDailyWage: ordinaryDaily });
    return {
      page: "severance-pay",
      title: "월급 300만원, 3년 근무",
      lead: `2023년 4월 3일 입사, 2026년 4월 2일까지 근무했습니다(퇴사일 4월 3일). 매달 기본급 300만원, ` +
        `연간 상여금 300만원을 받았고 1일 통상임금은 ${won(ordinaryDaily)}입니다.`,
      rows: basisRows(r),
      result: `퇴직금은 ${won(r.amount)}입니다. 상여금이 없었다면 평균임금이 낮아져 금액이 줄어듭니다.`,
    };
  },
  "fi-300": () => {
    const r = calcSocialInsurance(3_000_000, rates, PAY_DATE);
    return {
      page: "four-insurance",
      title: "월 보수 300만원",
      lead: `식대 같은 비과세를 뺀 보수월액이 300만원인 직장인입니다(${Y}년 요율).`,
      rows: [
        ["국민연금", r.pension.basis["산식"]],
        ["건강보험", r.health.basis["산식"]],
        ["장기요양", r.care.basis["산식"]],
        ["고용보험", r.employment.basis["산식"]],
        ["합계", won(r.total)],
      ],
      result: `매달 급여에서 ${won(r.total)}이 빠지고, 회사도 거의 같은 금액에 고용보험 사업주 몫과 산재보험을 더해 따로 냅니다.`,
    };
  },
  "fi-table": () => {
    const levels = [2_000_000, 2_500_000, 3_000_000, 4_000_000, 5_000_000, 7_000_000];
    return {
      page: "four-insurance",
      title: "보수월액별 근로자 부담 합계",
      lead: `${Y}년 요율, 국민연금 상·하한은 ${PAY_DATE} 부터 적용되는 구간 기준입니다.`,
      rows: levels.map((m) => {
        const r = calcSocialInsurance(m, rates, PAY_DATE);
        return [won(m), `${won(r.total)} (연금 ${won(r.pension.amount)} · 건강 ${won(r.health.amount)} · ` +
          `요양 ${won(r.care.amount)} · 고용 ${won(r.employment.amount)})`];
      }),
      result: "보수월액이 국민연금 상한을 넘으면 연금은 더 늘지 않아 부담 비율이 조금씩 낮아집니다.",
    };
  },
  "pt-20h": () => {
    const r = calcPartTimePay({ hourlyWage: MIN, weeklyHours: 20, monthsEmployed: 4, payDate: PAY_DATE }, rates, taxTable);
    return {
      page: "part-time",
      title: "주 20시간, 4개월째 근무",
      lead: `시급 ${won(MIN)}, 평일 4시간씩 일하는 아르바이트입니다.`,
      rows: basisRows(r),
      result: `한 달 실수령액은 약 ${won(r.netPay)}입니다.`,
    };
  },
  "pt-14h": () => {
    const r = calcPartTimePay({ hourlyWage: MIN, weeklyHours: 14, monthsEmployed: 2, payDate: PAY_DATE }, rates, taxTable);
    return {
      page: "part-time",
      title: "주 14시간, 일한 지 2개월",
      lead: "같은 시급으로 주말에만 7시간씩 일합니다.",
      rows: basisRows(r),
      result: `주휴수당이 없고, 월 60시간은 넘어 국민연금·건강보험은 적용되지만 ` +
        `고용보험은 ${r.coverage.employment ? "적용됩니다" : "아직 적용되지 않습니다"}. 실수령액은 약 ${won(r.netPay)}입니다.`,
    };
  },
  "mw-meal": () => {
    const r = checkMinimumWage({ monthlyBasePay: 2_000_000, monthlyWelfare: 200_000, weeklyHours: 40 }, rates);
    return {
      page: "minimum-wage",
      title: "기본급 200만원 + 식대 20만원",
      lead: "주 40시간 근무, 상여금은 없습니다.",
      rows: basisRows(r),
      result: `식대까지 산입하면 시간당 ${won(r.effectiveHourly)}로 ` +
        (r.violation ? `최저임금에 월 ${won(r.shortfall)} 모자랍니다.` : `최저임금 기준을 충족합니다.`),
    };
  },
  "mw-probation": () => {
    const r = checkMinimumWage({ monthlyBasePay: 1_950_000, weeklyHours: 40, probation: true, contractMonths: 12 }, rates);
    return {
      page: "minimum-wage",
      title: "수습 2개월 차, 기본급 195만원",
      lead: "1년 계약이고 단순노무직이 아닙니다. 수습 시작 후 3개월 안입니다.",
      rows: basisRows(r),
      result: "수습 감액이 가능한 경우에도 최저임금의 90% 아래로는 내려갈 수 없습니다.",
    };
  },
  "pl-300": () => {
    const r = calcParentalLeave({ monthlyOrdinaryWage: 3_000_000, leaveStartDate: `${Y}-03-02`, months: 12 }, parental);
    return {
      page: "parental-leave",
      title: "월 통상임금 300만원, 12개월 사용",
      lead: `${Y}년 3월 2일부터 육아휴직을 시작하는 경우입니다.`,
      rows: basisRows(r),
      result: `12개월 동안 받는 육아휴직 급여는 모두 ${won(r.total)}입니다.`,
    };
  },
  "np-annual-4000": () => netPayExample("", "연봉 4,000만원",
    { annualSalary: 40_000_000 }, "연봉을 12로 나눠 매달 받는 계약입니다."),
  "np-monthly-300": () => netPayExample("monthly-salary", "월급 300만원",
    { monthlySalary: 3_000_000 }, "세전 월급 300만원 중 식대 20만원이 비과세입니다."),
};

function netPayExample(page, title, input, lead) {
  const r = calcNetPay({ ...input, nonTaxable: 200_000, dependents: 1, payDate: PAY_DATE }, rates, taxTable);
  const i = r.insurance;
  return {
    page, title,
    lead: `${lead} 부양가족은 본인 1명, 식대 비과세 월 20만원, ${Y}년 요율과 간이세액표 기준입니다.`,
    rows: [
      ["월 총지급액", won(r.gross)],
      ["과세대상 급여", `${won(r.gross)} - 비과세 ${won(r.nonTaxable)} = ${won(r.taxBase)}`],
      ["국민연금", won(i.pension)],
      ["건강보험", won(i.health)],
      ["장기요양", won(i.care)],
      ["고용보험", won(i.employment)],
      ["소득세", won(r.incomeTax)],
      ["지방소득세", won(r.localIncomeTax)],
      ["공제 합계", won(r.totalDeduction)],
      ["실수령액", won(r.netPay)],
    ],
    result: `매달 통장에 들어오는 금액은 ${won(r.netPay)}로, 총지급액의 ${(r.netPay / r.gross * 100).toFixed(1)}%입니다.`,
  };
}

function render(id, ex) {
  const rows = ex.rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("");
  return `<!--EXAMPLE:${id}--><figure class="ex"><figcaption>예시 · ${esc(ex.title)}</figcaption>` +
    `<p>${esc(ex.lead)}</p><table><tbody>${rows}</tbody></table>` +
    `<p class="ex-r">${esc(ex.result)}</p></figure><!--/EXAMPLE-->`;
}

function pageFile(page) {
  return path.join(WEB, page ? path.join(page, "index.html") : "index.html");
}

const built = {};
for (const [id, make] of Object.entries(EXAMPLES)) built[id] = make();

const byFile = {};
for (const [id, ex] of Object.entries(built)) (byFile[pageFile(ex.page)] ||= []).push(id);

let stale = [], missing = [], unknown = [];
for (const [file, ids] of Object.entries(byFile)) {
  const src = fs.readFileSync(file, "utf8");
  let next = src;
  for (const id of ids) {
    const re = new RegExp(`<!--EXAMPLE:${id}-->[\\s\\S]*?<!--/EXAMPLE-->`);
    if (!re.test(next)) { missing.push(`${id} (${path.relative(WEB, file)})`); continue; }
    next = next.replace(re, () => render(id, built[id]));
  }
  // 등록되지 않은 표식이 남아 있으면 지운 예시의 옛 숫자가 굳어 있는 것이다.
  for (const m of next.matchAll(/<!--EXAMPLE:([\w-]+)-->/g)) {
    if (!ids.includes(m[1])) unknown.push(`${m[1]} (${path.relative(WEB, file)})`);
  }
  if (next !== src) {
    stale.push(path.relative(WEB, file));
    if (!CHECK) fs.writeFileSync(file, next, "utf8");
  }
}

console.log(`계산 예시 ${Object.keys(built).length}개 · ${Object.keys(byFile).length}개 페이지`);
if (missing.length) { console.error(`\n★ 표식이 없는 예시: ${missing.join(", ")}`); process.exit(1); }
if (unknown.length) { console.error(`\n★ 등록되지 않은 예시 표식: ${unknown.join(", ")}`); process.exit(1); }
if (CHECK && stale.length) {
  console.error(`\n★ 계산 예시가 엔진과 어긋납니다: ${stale.join(", ")}\n  node build/examples.js 를 실행하세요.`);
  process.exit(1);
}
if (!CHECK) console.log(`갱신된 파일: ${stale.length}개`);

