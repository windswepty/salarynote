/* 샐러리노트 공통 UI 로직. 계산은 전부 engine.js(검증된 엔진)에 위임한다. */
(function () {
  "use strict";
  const SN = window.SalaryNote;

  /**
   * 지급일은 반드시 0 패딩된 YYYY-MM-DD 여야 한다.
   * 엔진이 '2026-1-5' 같은 값을 거부하기 때문이다(과거 이 형식이 국민연금 상한을
   * 반년치 틀리게 고르는 버그를 냈고, 지금은 조용히 틀리는 대신 throw 한다).
   */
  function todayISO() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  const won = (n) => Math.round(n).toLocaleString("ko-KR");
  const $ = (sel) => document.querySelector(sel);

  /** 입력창의 콤마·공백을 걷어내고 숫자로. 빈 값은 null 을 돌려 호출부가 판단하게 한다. */
  function parseNum(el) {
    if (!el) return null;
    const raw = String(el.value).replace(/[,\s원]/g, "").trim();
    if (raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : NaN;
  }

  /** 입력 중에도 천단위 콤마를 유지한다. 커서는 끝으로 보내지 않고 자릿수 변화만큼만 보정. */
  function attachComma(el) {
    el.addEventListener("input", () => {
      const before = el.value.length;
      const pos = el.selectionStart;
      // 13자리를 넘기면 오타일 가능성이 압도적이다. 애초에 못 넣게 막는다.
      const digits = el.value.replace(/[^\d]/g, "").slice(0, 13);
      el.value = digits === "" ? "" : Number(digits).toLocaleString("ko-KR");
      const delta = el.value.length - before;
      const next = Math.max(0, (pos || 0) + delta);
      try { el.setSelectionRange(next, next); } catch (_) {}
    });
  }

  /**
   * 간이세액표는 구간표라 총급여가 조금 올랐는데 실수령이 줄어드는 지점이 실제로 있다.
   * 별표2 정본 그대로라 고칠 수 없는 법정 계단이므로, 숨기지 않고 안내한다.
   * 지금 입력값이 그 구간에 걸렸는지 실제로 계산해서 확인한다.
   */
  function detectReversal(input, rates, table) {
    try {
      const base = SN.calcNetPay(input, rates, table);
      const key = input.annualSalary != null ? "annualSalary" : "monthlySalary";
      const step = key === "annualSalary" ? 120000 : 10000;
      const bumped = SN.calcNetPay({ ...input, [key]: input[key] + step }, rates, table);
      if (bumped.netPay < base.netPay) {
        return { drop: base.netPay - bumped.netPay, step };
      }
    } catch (_) {}
    return null;
  }

  function renderNotices(list, container) {
    container.innerHTML = "";
    for (const n of list) {
      const d = document.createElement("div");
      d.className = "notice" + (n.kind === "err" ? " err" : "");
      d.innerHTML = n.title ? `<b>${n.title}</b>${n.body}` : n.body;
      container.appendChild(d);
    }
  }

  /** 계산 근거를 사람이 읽을 수 있는 목록으로. 이게 이 사이트의 차별점이라 항상 노출한다. */
  function renderBasis(result) {
    const items = [];
    const ins = result.detail.insurance;
    for (const k of ["pension", "health", "care", "employment"]) {
      const b = ins[k] && ins[k].basis;
      if (b && b["산식"]) items.push(b["산식"]);
    }
    const t = result.detail.incomeTax && result.detail.incomeTax.basis;
    if (t) {
      for (const key of Object.keys(t)) {
        const v = t[key];
        if (typeof v === "string" && (key === "산식" || key === "적용구간")) items.push(`${key}: ${v}`);
      }
    }
    const l = result.detail.localIncomeTax && result.detail.localIncomeTax.basis;
    if (l && l["산식"]) items.push(`지방소득세: ${l["산식"]}`);
    return items;
  }


  /**
   * 엔진 예외를 사용자용 문구로 옮긴다.
   *
   * 엔진 메시지는 개발자를 위한 것이라 파일 경로나 내부 변수명이 들어 있다
   * (예: "data/rates-*.json 의 inputLimits.maxMonthlySalary").
   * 그걸 화면에 그대로 띄우면 사용자는 자기가 뭘 잘못했는지 알 수 없다.
   * 원문은 콘솔로만 보내 디버깅 가능성을 남긴다.
   */
  function friendlyError(e) {
    const raw = String((e && e.message) || e || "");
    try { console.warn("[샐러리노트] 계산 예외:", raw); } catch (_) {}

    const rules = [
      [/범위를 벗어|maxMonthly|너무 큰|초과했습니다/, "금액이 너무 큽니다. 자릿수를 확인해 주세요."],
      [/비과세|학자금/,                                "비과세액이 급여보다 많습니다. 다시 확인해 주세요."],
      [/지급일|payDate|YYYY-MM-DD|날짜/,               "급여 지급일을 올바른 날짜로 선택해 주세요."],
      [/가족|dependents/,                              "부양가족 수는 1명 이상의 정수로 입력해 주세요."],
      [/개월|monthsPerYear|divisor/,                   "연봉을 나눌 개월 수를 다시 선택해 주세요."],
      [/음수|0보다|양의 정수|양수/,                    "금액은 0보다 큰 값이어야 합니다."],
      [/숫자|유한|NaN|정수/,                           "숫자만 입력해 주세요."],
    ];
    for (const [re, msg] of rules) if (re.test(raw)) return msg;
    return "입력값을 다시 확인해 주세요.";
  }

  window.SN_UI = { todayISO, won, $, parseNum, attachComma, detectReversal, renderNotices, renderBasis, friendlyError };
})();
