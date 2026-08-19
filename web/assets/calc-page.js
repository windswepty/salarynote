/* 계산기 페이지 공통 컨트롤러. mode 로 연봉/월급/4대보험을 구분한다. */
(function () {
  "use strict";
  const U = window.SN_UI, SN = window.SalaryNote;
  const ROW = (label, value, cls) =>
    `<tr class="${cls || ""}"><th>${label}</th><td class="num">${value}</td></tr>`;

  window.SN_PAGE = function (opts) {
    const mode = opts.mode; // "annual" | "monthly" | "insurance"
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
