/* 계산기 페이지 공통 컨트롤러. mode 로 연봉/월급/4대보험을 구분한다. */
(function () {
  "use strict";
  const U = window.SN_UI, SN = window.SalaryNote;
  const ROW = (label, value, cls) =>
    `<tr class="${cls || ""}"><th>${label}</th><td class="num">${value}</td></tr>`;

  /**
   * 퇴직금 모드. 입력 구성이 실수령액 계산기와 전혀 달라서 별도로 다룬다.
   * (급여 입력 하나가 아니라 날짜 2개 + 금액 4개 + 선택 항목 2개)
   */
  function initSeverance() {
    const g = (id) => document.getElementById(id);
    const el = {
      hire: g("hire"), leave: g("leave"),
      base3m: g("base3m"), extra3m: g("extra3m"), bonus: g("bonus"),
      leavepay: g("leavepay"), ordinary: g("ordinary"), excluded: g("excluded"),
      out: g("out"), side: g("side"), rows: g("breakdown"),
      basis: g("basis"), basisBox: g("basisBox"), notices: g("notices"),
    };
    for (const k of ["base3m", "extra3m", "bonus", "leavepay", "ordinary"])
      if (el[k]) U.attachComma(el[k]);

    // 기본값: 오늘 퇴사, 3년 전 입사. 빈 화면보다 예시가 이해를 돕는다.
    if (el.leave && !el.leave.value) el.leave.value = U.todayISO();
    if (el.hire && !el.hire.value) {
      const [y, m, d] = U.todayISO().split("-");
      el.hire.value = `${Number(y) - 3}-${m}-${d}`;
    }

    function calc() {
      const notices = [];
      let r;
      try {
        r = SN.calcSeverance({
          hireDate: el.hire.value,
          leaveDate: el.leave.value,
          base3m: U.parseNum(el.base3m) || 0,
          extra3m: U.parseNum(el.extra3m) || 0,
          annualBonus: U.parseNum(el.bonus) || 0,
          annualLeaveAllowance: U.parseNum(el.leavepay) || 0,
          ordinaryDailyWage: U.parseNum(el.ordinary) || 0,
          excludedDays: Number(el.excluded.value) || 0,
        });
      } catch (e) {
        el.out.textContent = "—";
        el.side.textContent = "";
        el.rows.innerHTML = "";
        el.basisBox.style.display = "none";
        U.renderNotices([{ kind: "err", title: "입력을 확인해 주세요", body: U.friendlyError(e) }], el.notices);
        return;
      }

      el.out.innerHTML = U.won(r.amount) + '<small>원</small>';
      el.side.textContent = `근속 ${r.serviceYears}년 (${r.serviceDays}일) · 1일 ${U.won(r.appliedDaily)}원 적용`;

      el.rows.innerHTML =
        ROW("계속근로일수", r.serviceDays.toLocaleString("ko-KR") + "일") +
        ROW("평균임금 산정기간", r.periodDays + "일") +
        ROW("임금총액 (3개월)", U.won(r.totalWage) + "원") +
        (r.bonusPortion ? ROW("└ 상여금 산입분", U.won(r.bonusPortion) + "원") : "") +
        (r.leavePortion ? ROW("└ 연차수당 산입분", U.won(r.leavePortion) + "원") : "") +
        ROW("1일 평균임금", U.won(r.averageDaily) + "원") +
        (r.ordinaryDaily ? ROW("1일 통상임금", U.won(r.ordinaryDaily) + "원") : "") +
        ROW("적용 1일 임금", U.won(r.appliedDaily) + "원" + (r.ordinaryApplied ? " (통상임금)" : " (평균임금)")) +
        ROW("예상 퇴직금", U.won(r.amount) + "원", "sum");

      const items = Object.keys(r.basis).map((k) => `${k}: ${r.basis[k]}`);
      el.basisBox.style.display = "";
      el.basis.innerHTML = items.map((s) => `<li>${s}</li>`).join("");

      for (const w of (r.warnings || [])) notices.push({ body: w });
      U.renderNotices(notices, el.notices);
    }

    for (const k of ["hire", "leave", "base3m", "extra3m", "bonus", "leavepay", "ordinary", "excluded"])
      if (el[k]) el[k].addEventListener("input", calc);
    calc();
  }

  /** 공통 렌더러. 세 계산기가 결과 표시 구조를 공유한다. */
  function simpleRender(el, mainValue, sideText, rows, basisObj, warnings) {
    el.out.innerHTML = U.won(mainValue) + '<small>원</small>';
    el.side.textContent = sideText;
    el.rows.innerHTML = rows.map(([k, v, c]) => ROW(k, v, c)).join("");
    const items = Object.keys(basisObj).map((k) => `${k}: ${basisObj[k]}`);
    el.basisBox.style.display = "";
    el.basis.innerHTML = items.map((s) => `<li>${s}</li>`).join("");
    U.renderNotices((warnings || []).map((w) => ({ body: w })), el.notices);
  }

  function bindAll(ids, fn) {
    for (const id of ids) {
      const e = document.getElementById(id);
      if (e) e.addEventListener("input", fn);
    }
  }

  /** 빈 입력은 0 이 아니라 '없음'이다. 엔진이 필수값 검사를 하도록 그대로 넘긴다. */
  function blankToUndefined(v) {
    const s = String(v == null ? "" : v).trim();
    return s === "" ? undefined : Number(s);
  }

  function shell() {
    const g = (id) => document.getElementById(id);
    return { out: g("out"), side: g("side"), rows: g("breakdown"),
             basis: g("basis"), basisBox: g("basisBox"), notices: g("notices") };
  }

  function fail(el, e) {
    el.out.textContent = "—"; el.side.textContent = ""; el.rows.innerHTML = "";
    el.basisBox.style.display = "none";
    U.renderNotices([{ kind: "err", title: "입력을 확인해 주세요", body: U.friendlyError(e) }], el.notices);
  }

  /** 주휴수당 */
  function initHoliday() {
    const el = shell();
    const wageEl = document.getElementById("wage");
    U.attachComma(wageEl);
    const calc = () => {
      try {
        const r = SN.calcWeeklyHolidayPay(
          Number(document.getElementById("weekly").value),
          U.parseNum(wageEl) || 0, SN.rates);
        simpleRender(el, r.amount,
          `주 ${r.weeklyHours}시간 · 주휴 ${r.holidayHours}시간 적용`,
          [["1주 소정근로시간", r.weeklyHours + "시간"],
           ["주휴시간", r.holidayHours + "시간"],
           ["시급", U.won(r.hourlyWage) + "원"],
           ["주휴수당 (1주)", U.won(r.amount) + "원", "sum"],
           ["월 환산액", U.won(r.monthlyAmount) + "원"]],
          r.basis, r.warnings);
      } catch (e) { fail(el, e); }
    };
    bindAll(["weekly", "wage"], calc); calc();
  }

  /** 연차수당 */
  function initLeave() {
    const el = shell();
    const dailyEl = document.getElementById("daily");
    U.attachComma(dailyEl);
    const calc = () => {
      try {
        const r = SN.calcAnnualLeave(
          Number(document.getElementById("years").value),
          Number(document.getElementById("unused").value),
          U.parseNum(dailyEl) || 0,
          Number(document.getElementById("months").value));
        simpleRender(el, r.amount,
          `발생 연차 ${r.entitledDays}일 중 ${r.unusedDays}일 미사용`,
          [["발생 연차", r.entitledDays + "일"],
           ["미사용 연차", r.unusedDays + "일"],
           ["1일 통상임금", U.won(r.dailyOrdinaryWage) + "원"],
           ["연차수당", U.won(r.amount) + "원", "sum"]],
          r.basis, r.warnings);
      } catch (e) { fail(el, e); }
    };
    bindAll(["years", "months", "unused", "daily"], calc); calc();
  }

  /** 시급/월급/연봉 환산 */
  function initConvert() {
    const el = shell();
    const ids = ["cwHourly", "cwMonthly", "cwAnnual"];
    for (const id of ids) U.attachComma(document.getElementById(id));
    const calc = () => {
      const h = document.getElementById("cwHourly"),
            m = document.getElementById("cwMonthly"),
            a = document.getElementById("cwAnnual");
      // 월급·연봉이 채워져 있으면 그쪽을 기준으로 삼는다.
      const input = { weeklyHours: Number(document.getElementById("cwWeekly").value) };
      if (U.parseNum(a)) input.annual = U.parseNum(a);
      else if (U.parseNum(m)) input.monthly = U.parseNum(m);
      else input.hourly = U.parseNum(h);
      try {
        const r = SN.convertWage(input, SN.rates);
        simpleRender(el, r.monthly,
          `시급 ${U.won(r.hourly)}원 · 월 ${r.monthlyHours}시간 기준`,
          [["시급", U.won(r.hourly) + "원"],
           ["월 소정근로시간", r.monthlyHours + "시간"],
           ["월급", U.won(r.monthly) + "원", "sum"],
           ["연봉", U.won(r.annual) + "원"]],
          r.basis, r.warnings);
        // 기준이 아닌 칸을 결과로 채워준다(입력 중인 칸은 건드리지 않는다).
        if (document.activeElement !== h) h.value = r.hourly.toLocaleString("ko-KR");
        if (document.activeElement !== m) m.value = r.monthly.toLocaleString("ko-KR");
        if (document.activeElement !== a) a.value = r.annual.toLocaleString("ko-KR");
      } catch (e) { fail(el, e); }
    };
    bindAll(["cwHourly", "cwMonthly", "cwAnnual", "cwWeekly"], calc); calc();
  }

  /** 아르바이트 — 4대보험 적용 판정을 표에 드러내는 것이 핵심이다. */
  function initPartTime() {
    const el = shell();
    const wageEl = document.getElementById("ptWage");
    U.attachComma(wageEl);
    const YN = (b) => (b ? "적용" : "미적용");
    const calc = () => {
      try {
        const r = SN.calcPartTimePay({
          hourlyWage: U.parseNum(wageEl) || 0,
          weeklyHours: Number(document.getElementById("ptWeekly").value),
          monthsEmployed: Number(document.getElementById("ptMonths").value),
          payDate: U.todayISO(),
        }, SN.rates, SN.taxTable);

        const covered = [r.coverage.pension, r.coverage.health, r.coverage.employment].filter(Boolean).length;
        simpleRender(el, r.netPay,
          `월 ${r.monthlyWorkHours + r.monthlyHolidayHours}시간 · 4대보험 ${covered}종 적용`,
          [["기본급", U.won(r.basePay) + "원"],
           ["주휴수당", r.holidayPay ? U.won(r.holidayPay) + "원" : "미발생 (주 15시간 미만)"],
           ["월 총지급액", U.won(r.gross) + "원"],
           ["국민연금", r.coverage.pension ? "-" + U.won(r.insurance.pension) + "원" : YN(false)],
           ["건강보험", r.coverage.health ? "-" + U.won(r.insurance.health) + "원" : YN(false)],
           ["장기요양보험", r.coverage.health ? "-" + U.won(r.insurance.care) + "원" : YN(false)],
           ["고용보험", r.coverage.employment ? "-" + U.won(r.insurance.employment) + "원" : YN(false)],
           ["소득세", "-" + U.won(r.incomeTax + r.localIncomeTax) + "원"],
           ["월 실수령액", U.won(r.netPay) + "원", "sum"]],
          r.basis, r.warnings);
      } catch (e) { fail(el, e); }
    };
    bindAll(["ptWage", "ptWeekly", "ptMonths"], calc); calc();
  }

  /**
   * 실업급여(구직급여).
   * 여기서만 다른 점이 두 가지 있다.
   *  1) 엔진 예외 메시지를 그대로 보여준다. 이 계산기의 거부 사유(지원하지 않는 이직일,
   *     8시간 초과 소정근로시간 등)는 그 자체가 사용자에게 필요한 정보라서
   *     "입력값을 다시 확인해 주세요"로 뭉개면 왜 막혔는지 알 수 없다.
   *  2) 별표1 표를 원장에서 꺼내 그린다. HTML 에 일수를 손으로 적지 않기 위해서다.
   */
  function initUnemployment() {
    const el = shell();
    const g = (id) => document.getElementById(id);
    const wageEl = g("uiWage");
    U.attachComma(wageEl);

    if (g("uiLeave") && !g("uiLeave").value) g("uiLeave").value = U.todayISO();

    // 별표1 전 칸을 원장에서 그린다.
    const tb = SN.benefitDaysTable(SN.unemployment);
    const head = "<tr><th>이직일 현재 연령</th>" +
      tb.columns.map((c) => `<td class="num">${c}</td>`).join("") + "</tr>";
    const body = tb.rows.map((r) =>
      `<tr><th>${r.label}</th>` + r.days.map((d) => `<td class="num">${d}일</td>`).join("") + "</tr>").join("");
    const tableBox = g("daysTable");
    if (tableBox) {
      tableBox.innerHTML =
        `<table><tbody>${head}${body}</tbody></table>` +
        `<p class="hint">${tb.remark}</p><p class="hint">근거: ${tb.basis}</p>`;
    }

    function failU(e) {
      const raw = String((e && e.message) || e || "");
      el.out.textContent = "—"; el.side.textContent = ""; el.rows.innerHTML = "";
      el.basisBox.style.display = "none";
      // payDate 는 엔진 내부 용어라 그대로 내보내지 않는다.
      const body = /payDate/.test(raw) ? U.friendlyError(e) : raw;
      U.renderNotices([{ kind: "err", title: "계산할 수 없습니다", body: body }], el.notices);
    }

    const calc = () => {
      let r;
      try {
        r = SN.calcUnemploymentBenefit({
          leaveDate: g("uiLeave").value,
          monthlyWage: U.parseNum(wageEl) || 0,
          // ★빈 칸을 0 으로 바꾸지 않는다.★ Number("") 는 0 이라 엔진의 필수값
          // 검사를 통과해 버리고, 가입기간을 비우면 '1년 미만'으로 조용히 계산돼
          // 틀린 금액이 큰 글씨로 표시됐다. 원시 문자열을 넘겨 엔진이 판단하게 한다.
          age: blankToUndefined(g("uiAge").value),
          insuredMonths: blankToUndefined(g("uiMonths").value),
          dailyWorkHours: blankToUndefined(g("uiHours").value),
          disabled: g("uiDisabled").value === "Y",
        }, SN.unemployment);
      } catch (e) { return failU(e); }

      const daily = r.dailyAmountIsFractional ? r.dailyAmount.toLocaleString("ko-KR") : U.won(r.dailyAmount);
      simpleRender(el, r.totalAmount,
        `1일 ${daily}원 × ${r.days}일 · ${r.bound === "없음" ? "상·하한 미구속" : r.bound + " 적용"}`,
        [["평균임금일액", U.won(r.rawBaseDaily) + "원"],
         ["최저기초일액 (하한)", U.won(r.minBaseDaily) + "원"],
         ["기초일액 상한", U.won(r.maxBaseDaily) + "원"],
         ["적용 기초일액", U.won(r.baseDaily) + "원"],
         ["구직급여일액", daily + "원" + (r.bound === "없음" ? "" : ` (${r.bound})`), "sum"],
         ["소정급여일수", `${r.days}일 (${r.ageBracketLabel} · ${r.periodBracketLabel})`],
         ["총 예상 수령액", U.won(r.totalAmount) + "원", "sum"],
         ["수급기간 만료일", r.benefitWindowEnd]],
        r.basis, r.warnings);
    };
    bindAll(["uiWage", "uiAge", "uiMonths", "uiHours", "uiLeave", "uiDisabled"], calc);
    for (const id of ["uiDisabled"]) {
      const e = document.getElementById(id);
      if (e) e.addEventListener("change", calc);
    }
    calc();
  }

  /** 연장·야간·휴일수당 — 5인 미만 판정을 표에 드러내는 것이 핵심이다. */
  function initOvertime() {
    const el = shell();
    const g = (id) => document.getElementById(id);
    for (const id of ["otHourly", "otMonthly"]) U.attachComma(g(id));

    const calc = () => {
      try {
        const r = SN.calcOvertimePay({
          hourlyOrdinaryWage: U.parseNum(g("otHourly")) || undefined,
          monthlyOrdinaryWage: U.parseNum(g("otMonthly")) || undefined,
          overtimeHours: blankToUndefined(g("otOver").value),
          nightHours: blankToUndefined(g("otNight").value),
          holidayHours: blankToUndefined(g("otHoliday").value),
          employees: blankToUndefined(g("otEmployees").value),
        }, SN.rates);

        simpleRender(el, r.total,
          "통상시급 " + U.won(r.hourlyOrdinaryWage) + "원 · " +
            (r.premiumApplies ? "5인 이상, 가산 적용" : "5인 미만, 가산 미적용"),
          [["연장근로", r.overtimeHours ? r.overtimeHours + "시간 → " + U.won(r.overtimePay) + "원" : "없음"],
           ["야간가산", r.nightHours ? r.nightHours + "시간 → " + U.won(r.nightPay) + "원" : "없음"],
           ["휴일근로", r.holidayHours
              ? r.holidayHours + "시간 (8시간 초과 " + r.holidayOver8 + "시간) → " + U.won(r.holidayPay) + "원"
              : "없음"],
           ["합계", U.won(r.total) + "원", "sum"]],
          r.basis, r.warnings);
      } catch (e) { fail(el, e); }
    };
    bindAll(["otHourly", "otMonthly", "otOver", "otNight", "otHoliday", "otEmployees"], calc);
    calc();
  }

  /** 최저임금 위반 확인 — 산입 범위와 주휴시간 포함 환산이 핵심이다. */
  function initMinWage() {
    const el = shell();
    const g = (id) => document.getElementById(id);
    for (const id of ["mwBase", "mwWelfare", "mwBonus", "mwOvertime"]) U.attachComma(g(id));

    const calc = () => {
      try {
        const r = SN.checkMinimumWage({
          monthlyBasePay: U.parseNum(g("mwBase")),
          monthlyWelfare: U.parseNum(g("mwWelfare")) || 0,
          monthlyBonus: U.parseNum(g("mwBonus")) || 0,
          overtimePay: U.parseNum(g("mwOvertime")) || 0,
          weeklyHours: blankToUndefined(g("mwWeekly").value),
          probation: g("mwProbation").value === "Y",
          contractMonths: blankToUndefined(g("mwContract").value),
          simpleLabor: g("mwSimple").value === "Y",
        }, SN.rates);

        simpleRender(el, r.effectiveHourly,
          r.violation
            ? "최저임금 미달 — 월 " + U.won(r.shortfall) + "원 부족"
            : "최저임금 이상 — 위반 아님",
          [["산입 임금", U.won(r.includedWage) + "원"],
           ["월 소정근로시간", r.monthlyHours + "시간 (주휴 포함)"],
           ["환산 시급", U.won(r.effectiveHourly) + "원"],
           ["비교 기준", U.won(r.appliedMinHourly) + "원" + (r.probationApplied ? " (수습 90%)" : "")],
           ["판정", r.violation ? "위반" : "위반 아님", "sum"],
           ["부족액 (월)", r.violation ? U.won(r.shortfall) + "원" : "없음"]],
          r.basis, r.warnings);
      } catch (e) { fail(el, e); }
    };
    bindAll(["mwBase", "mwWelfare", "mwBonus", "mwOvertime", "mwWeekly",
             "mwProbation", "mwContract", "mwSimple"], calc);
    g("mwProbation").addEventListener("change", calc);
    g("mwSimple").addEventListener("change", calc);
    calc();
  }

  window.SN_PAGE = function (opts) {
    const mode = opts.mode; // "annual" | "monthly" | "insurance" | "severance"
    if (mode === "severance") return initSeverance();
    if (mode === "unemployment") return initUnemployment();
    if (mode === "holiday") return initHoliday();
    if (mode === "leave") return initLeave();
    if (mode === "convert") return initConvert();
    if (mode === "parttime") return initPartTime();
    if (mode === "overtime") return initOvertime();
    if (mode === "minwage") return initMinWage();
    const el = {
      salary: U.$("#salary") || U.$("#base"),
      dep: U.$("#dep"), nt: U.$("#nt"), months: U.$("#months"), paydate: U.$("#paydate"),
      out: U.$("#net") || U.$("#total"), side: U.$("#side"),
      rows: U.$("#breakdown"), basis: U.$("#basis"), basisBox: U.$("#basisBox"),
      notices: U.$("#notices"),
    };

    U.attachComma(el.salary);
    if (el.nt) U.attachComma(el.nt);
    if (el.paydate) el.paydate.value = U.todayISO();

    // 공유 링크 복원
    const q = new URLSearchParams(location.search);
    if (q.get("v")) el.salary.value = Number(q.get("v")).toLocaleString("ko-KR");
    if (el.dep && q.get("dep")) el.dep.value = q.get("dep");
    if (el.nt && q.get("nt")) el.nt.value = Number(q.get("nt")).toLocaleString("ko-KR");

    function clear() {
      el.out.textContent = "—";
      if (el.side) el.side.textContent = "";
      el.rows.innerHTML = "";
      el.basisBox.style.display = "none";
    }

    function calc() {
      const v = U.parseNum(el.salary);
      if (v === null) { clear(); U.renderNotices([], el.notices); return; }

      const payDate = (el.paydate && el.paydate.value) || U.todayISO();
      const notices = [];

      if (mode === "insurance") {
        let r;
        try {
          r = SN.calcSocialInsurance(v, SN.rates, payDate);
        } catch (e) {
          clear();
          U.renderNotices([{ kind: "err", title: "입력을 확인해 주세요", body: U.friendlyError(e) }], el.notices);
          return;
        }
        el.out.innerHTML = U.won(r.total) + '<small>원</small>';
        if (el.side) el.side.textContent = `보수월액 ${U.won(v)}원 기준 · 부담률 ${(r.total / v * 100).toFixed(2)}%`;
        el.rows.innerHTML =
          ROW("국민연금", U.won(r.pension.amount) + "원") +
          ROW("건강보험", U.won(r.health.amount) + "원") +
          ROW("장기요양보험", U.won(r.care.amount) + "원") +
          ROW("고용보험", U.won(r.employment.amount) + "원") +
          ROW("근로자 부담 합계", U.won(r.total) + "원", "sum") +
          ROW("연간 부담액", U.won(r.total * 12) + "원");

        const items = [];
        for (const k of ["pension", "health", "care", "employment"])
          if (r[k].basis && r[k].basis["산식"]) items.push(`${SN.rates[k === "pension" ? "nationalPension" : k === "health" ? "healthInsurance" : k === "care" ? "longTermCare" : "employmentInsurance"].label}: ${r[k].basis["산식"]}`);
        if (r.pension.basis["상한적용"]) notices.push({ title: "국민연금 상한이 적용됐습니다", body: `기준소득월액 상한 ${U.won(r.pension.basis["적용상한"])}원이 적용되어, 소득이 더 늘어도 국민연금액은 변하지 않습니다. 적용기간 ${r.pension.basis["적용기간"]}.` });
        if (r.pension.basis["하한적용"]) notices.push({ title: "국민연금 하한이 적용됐습니다", body: `기준소득월액 하한 ${U.won(r.pension.basis["적용하한"])}원이 적용됐습니다.` });
        el.basisBox.style.display = items.length ? "" : "none";
        el.basis.innerHTML = items.map((s) => `<li>${s}</li>`).join("");
        U.renderNotices(notices, el.notices);
        history.replaceState(null, "", "?v=" + v);
        return;
      }

      // 실수령액 모드
      const input = {
        nonTaxable: (el.nt && U.parseNum(el.nt)) || 0,
        dependents: Number(el.dep.value),
        payDate,
      };
      if (mode === "annual") {
        input.annualSalary = v;
        input.monthsPerYear = el.months ? Number(el.months.value) : 12;
      } else {
        input.monthlySalary = v;
      }

      let r;
      try {
        r = SN.calcNetPay(input, SN.rates, SN.taxTable);
      } catch (e) {
        clear();
        U.renderNotices([{ kind: "err", title: "입력을 확인해 주세요", body: U.friendlyError(e) }], el.notices);
        return;
      }

      el.out.innerHTML = U.won(r.netPay) + '<small>원</small>';
      if (el.side) el.side.textContent = `세전 월 ${U.won(r.gross)}원 · 공제율 ${(r.totalDeduction / r.gross * 100).toFixed(1)}%`;
      el.rows.innerHTML =
        ROW("월 총지급액", U.won(r.gross) + "원") +
        ROW("국민연금", "-" + U.won(r.insurance.pension) + "원") +
        ROW("건강보험", "-" + U.won(r.insurance.health) + "원") +
        ROW("장기요양보험", "-" + U.won(r.insurance.care) + "원") +
        ROW("고용보험", "-" + U.won(r.insurance.employment) + "원") +
        ROW("소득세", "-" + U.won(r.incomeTax) + "원") +
        ROW("지방소득세", "-" + U.won(r.localIncomeTax) + "원") +
        ROW("공제 합계", "-" + U.won(r.totalDeduction) + "원") +
        ROW("월 실수령액", U.won(r.netPay) + "원", "sum") +
        ROW("연 실수령액", U.won(r.netPay * 12) + "원");

      const items = U.renderBasis(r);
      el.basisBox.style.display = items.length ? "" : "none";
      el.basis.innerHTML = items.map((s) => `<li>${s}</li>`).join("");

      for (const w of (r.warnings || [])) notices.push({ body: w });

      const rev = U.detectReversal(input, SN.rates, SN.taxTable);
      if (rev) {
        const unit = mode === "annual" ? "연봉을" : "월급을";
        notices.push({
          title: "이 구간은 급여가 올라도 실수령액이 줄어듭니다",
          body: `${unit} ${U.won(rev.step)}원 올리면 월 실수령액이 오히려 ${U.won(rev.drop)}원 줄어듭니다. ` +
                `오류가 아니라 국세청 간이세액표가 구간별 계단 구조라서 생기는 현상이며, 차액은 연말정산에서 정산됩니다.`,
        });
      }
      U.renderNotices(notices, el.notices);

      const nq = new URLSearchParams({ v: String(v), dep: String(input.dependents), nt: String(input.nonTaxable) });
      history.replaceState(null, "", "?" + nq.toString());
    }

    for (const k of ["salary", "dep", "nt", "months", "paydate"])
      if (el[k]) el[k].addEventListener("input", calc);
    if (el.months) el.months.addEventListener("change", calc);
    calc();
  };
})();
