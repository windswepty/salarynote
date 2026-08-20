#!/usr/bin/env node
/**
 * 요율 원장 위생 검사.
 *
 * 이 파일에 숫자를 쓰지 않는다. 임계값은 전부 data/sanity-rules.json 에 있다.
 * 순수 함수 + CommonJS + 의존성 0. 세 곳에서 호출된다.
 *   1) tools/update-rates.js (스크래퍼 직후)
 *   2) test/sanity-check.test.js (오염 값이 실제로 차단되는지)
 *   3) build/bundle.js (파이프라인을 우회한 손편집 차단 — 마지막 방어선)
 *
 * 등급
 *   FATAL — 물리적·법적으로 불가능. 후보 폐기. 커밋 없음.
 *   BLOCK — 가능하지만 희귀. 자동 병합 금지, 사람 승인 필요.
 *   WARN  — 통과시키되 기록.
 *
 * ★설계 의도★ 에러 메시지에 원인을 특정해 넣는다.
 * "범위 초과" 라고만 하면 사람이 임계값을 넓혀서 '고치는' 2차 사고가 난다.
 * 퍼센트/소수 혼동, 콤마 유실 같은 전형적 원인은 이름을 붙여 지목한다.
 *
 * CLI:
 *   node tools/sanity-check.js [ledger.json] [--current data/rates-2026.json] [--json]
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DEFAULT_RULES = path.join(ROOT, "data", "sanity-rules.json");
const DEFAULT_HISTORY = path.join(ROOT, "data", "rates-history.json");

// ── 작은 유틸 ────────────────────────────────────────────────────
const round = (v, n) => Math.round(v * 10 ** n) / 10 ** n;
const pp = (v) => `${(v * 100).toFixed(4)}%`;

function getPath(obj, p) {
  return p.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** JSON 트리를 path -> 값(리프) 맵으로 평탄화. 배열은 인덱스를 경로로 쓴다. */
function flatten(obj, prefix = "", out = {}) {
  if (obj === null || typeof obj !== "object") {
    out[prefix] = obj;
    return out;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => flatten(v, prefix ? `${prefix}.${i}` : String(i), out));
    if (obj.length === 0) out[prefix] = "[]";
    return out;
  }
  const keys = Object.keys(obj);
  if (keys.length === 0) out[prefix] = "{}";
  for (const k of keys) flatten(obj[k], prefix ? `${prefix}.${k}` : k, out);
  return out;
}

// ── 결과 수집기 ──────────────────────────────────────────────────
function makeCollector() {
  const issues = [];
  const add = (level) => (code, pathStr, message, extra) =>
    issues.push({ level, code, path: pathStr, message, ...(extra || {}) });
  return {
    issues,
    fatal: add("FATAL"),
    block: add("BLOCK"),
    warn: add("WARN"),
    info: add("INFO"),
  };
}

// ── (c) 형식 검사 ────────────────────────────────────────────────
/**
 * 범위를 벗어났을 때 원인을 특정한다.
 * 이 함수가 없으면 "0.060~0.080 범위 초과: 7.19" 라는 메시지만 남고,
 * 사람이 임계값을 7.2 로 넓혀서 '고치는' 사고가 난다.
 */
function diagnoseRange(v, min, max, prev) {
  if (v / 100 >= min && v / 100 <= max) {
    return (
      `★퍼센트/소수 혼동 의심★ ${v} 를 100 으로 나누면 ${v / 100} 로 정상 범위에 들어옵니다. ` +
      `이 원장은 요율을 소수(0.0719)로 저장합니다. 퍼센트 표기(7.19)를 그대로 넣은 것으로 보입니다.`
    );
  }
  if (v * 100 >= min && v * 100 <= max) {
    return `★퍼센트/소수 혼동 의심(역방향)★ ${v} 에 100 을 곱하면 ${v * 100} 로 정상 범위입니다.`;
  }
  if (prev != null && prev > 0 && v > 0 && v < prev / 100) {
    return (
      `★자릿수 유실(콤마 파싱) 의심★ 직전 값 ${prev} 대비 1/100 미만입니다. ` +
      `'6,370,000' 이 '6' 으로 잘리는 유형의 사고입니다.`
    );
  }
  // 금액 필드(하한이 1000 이상)에서 자릿수만 밀린 경우를 직전 값 없이도 지목한다.
  if (min >= 1000 && v > 0) {
    for (const scale of [10, 100, 1000, 10000, 100000, 1000000]) {
      if (v * scale >= min && v * scale <= max) {
        return (
          `★자릿수 유실(콤마 파싱) 의심★ ${v} 에 ${scale.toLocaleString()} 을 곱하면 ${(v * scale).toLocaleString()} 로 정상 범위입니다. ` +
          `'6,590,000' 이 '6' 으로 잘리는 유형의 사고입니다.`
        );
      }
    }
  }
  if (v < 0) return `음수입니다. 요율·금액에 음수가 들어올 수 있는 경로는 없습니다.`;
  return `허용 범위 [${min}, ${max}] 밖입니다. ★임계값을 넓혀서 해결하지 마십시오★ — 값이 틀렸을 확률이 훨씬 높습니다.`;
}

function checkFieldFormat(C, ledger, current, rules) {
  for (const [p, r] of Object.entries(rules.fields)) {
    const v = getPath(ledger, p);
    const prev = current ? getPath(current, p) : undefined;

    if (v === undefined) {
      C.fatal("MISSING_FIELD", p, `필수 필드가 없습니다. 키 삭제는 조용한 오염의 전형입니다.`);
      continue;
    }
    if (typeof v !== "number") {
      C.fatal(
        "TYPE",
        p,
        `숫자여야 하는데 ${typeof v} 입니다: ${JSON.stringify(v)}. ` +
          `문자열 "0.0719" 나 "7.19%" 는 산술에서 조용히 NaN 또는 문자열 연결이 됩니다.`
      );
      continue;
    }
    if (!Number.isFinite(v)) {
      C.fatal("NOT_FINITE", p, `NaN 또는 Infinity 입니다: ${v}.`);
      continue;
    }

    // 퍼센트/소수 혼동 1차 방어 — fraction 필드는 0.5 를 넘을 수 없다.
    if (r.kind === "fraction" && v >= 0.5) {
      C.fatal("FRACTION_TOO_LARGE", p, `요율은 소수로 저장합니다. ${v} 는 0.5 이상입니다. ` + diagnoseRange(v, r.fatalMin, r.fatalMax, prev));
      continue;
    }

    if (r.fatalMin != null && v < r.fatalMin) {
      C.fatal("RANGE_LOW", p, `${v} < ${r.fatalMin}. ` + diagnoseRange(v, r.fatalMin, r.fatalMax, prev));
      continue;
    }
    if (r.fatalMax != null && v > r.fatalMax) {
      C.fatal("RANGE_HIGH", p, `${v} > ${r.fatalMax}. ` + diagnoseRange(v, r.fatalMin, r.fatalMax, prev));
      continue;
    }

    // 분모 사다리 — 법정 요율은 1천분율·1만분율·100만분율이다.
    // 0.0718666(엉뚱한 셀 파싱), 0.07193(자릿수 밀림)을 잡는다.
    if (r.denominator) {
      const scaled = v * r.denominator;
      if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
        C.fatal(
          "DENOMINATOR",
          p,
          `${v} 는 1/${r.denominator} 단위로 떨어지지 않습니다(${scaled}). ` +
            `법정 요율은 1천분율·1만분율·100만분율로만 규정됩니다. 엉뚱한 셀을 파싱했거나 자릿수가 밀렸습니다.`
        );
      }
    }

    if (r.kind === "money") {
      if (!Number.isInteger(v)) {
        C.fatal("NOT_INTEGER", p, `금액은 원 단위 정수여야 합니다: ${v}.`);
      } else if (r.multipleOf && v % r.multipleOf !== 0) {
        C.fatal("MULTIPLE_OF", p, `${v} 는 ${r.multipleOf}원 배수가 아닙니다. (${r.multipleOfBasis || ""})`);
      }
    }

    if (r.warnNearCeiling != null && v > r.warnNearCeiling) {
      C.warn(
        "NEAR_LEGAL_CEILING",
        p,
        `${pp(v)} 가 법정 상한(${pp(r.fatalMax)}, ${r.fatalMaxBasis || ""})에 근접했습니다. ` +
          `법 개정 없이는 더 오를 수 없습니다. 상한 도달 시 이 검사가 FATAL 을 내며 자동 갱신이 멈춥니다.`
      );
    }
  }
}

// ── (a) 국민연금 — 범위가 아니라 법정 스케줄 등호 검사 ────────────
function checkPensionSchedule(C, ledger, rules) {
  const s = rules.pensionSchedule;
  const year = ledger.year;
  const v = getPath(ledger, "nationalPension.totalRate");
  if (typeof v !== "number" || !Number.isFinite(v)) return; // 형식 검사에서 이미 잡혔다

  const expected = s.byYear[String(year)];
  if (expected == null) {
    if (year > s.terminalYear) {
      if (Math.abs(v - s.terminalRate) > 1e-12) {
        C.block(
          "PENSION_BEYOND_SCHEDULE",
          "nationalPension.totalRate",
          `${year}년은 부칙 스케줄(~${s.terminalYear}) 밖입니다. 본문 제88조제3항의 ${pp(s.terminalRate)} 를 기대했으나 ${pp(v)} 입니다. ` +
            `재개정 가능성이 있으므로 사람이 확인해야 합니다.`
        );
      }
    } else {
      C.block(
        "PENSION_NO_SCHEDULE",
        "nationalPension.totalRate",
        `${year}년의 법정 스케줄이 data/sanity-rules.json 에 없습니다. 스케줄 표부터 갱신하십시오.`
      );
    }
    return;
  }
  if (Math.abs(v - expected) > 1e-12) {
    const isTerminal = Math.abs(v - s.terminalRate) < 1e-12;
    C.fatal(
      "PENSION_SCHEDULE",
      "nationalPension.totalRate",
      `${year}년 법정 요율은 ${pp(expected)} 인데 ${pp(v)} 가 들어왔습니다 (${s.basis}). ` +
        (isTerminal
          ? `★국민연금법 '본문' 제88조제3항(1천분의 65 = 13%)을 읽었을 가능성이 매우 높습니다. 그것은 ${s.terminalYear}년 최종값입니다. 반드시 '부칙 제4조제1항' 의 연도별 표를 읽어야 합니다.★`
          : `법 개정이라면 스케줄 표부터 사람이 고쳐야 합니다.`)
    );
  }
}

// ── (b) 전년 대비 변동폭 ─────────────────────────────────────────
function checkDeltas(C, ledger, current, rules) {
  if (!current) return;
  for (const [p, r] of Object.entries(rules.fields)) {
    const v = getPath(ledger, p);
    const prev = getPath(current, p);
    if (typeof v !== "number" || typeof prev !== "number") continue;
    if (v === prev) continue;

    const d = v - prev;
    const dPct = prev !== 0 ? d / prev : Infinity;

    if (r.anyChangeLevel) {
      const lvl = r.anyChangeLevel === "FATAL" ? C.fatal : C.block;
      lvl(
        "ANY_CHANGE",
        p,
        `${prev} → ${v} 로 바뀌었습니다. 이 필드는 어떤 변동도 자동 병합하지 않습니다. ` +
          (r.anyChangeReason || "") +
          ` 출처 원문을 사람이 대조해야 합니다.`
      );
    }

    if (d < 0 && r.allowDecrease === false) {
      const lvl = r.decreaseLevel === "FATAL" ? C.fatal : C.block;
      lvl(
        "DECREASE",
        p,
        `인하가 감지됐습니다: ${prev} → ${v}. ${r.decreaseBasis || r.deltaBasis || ""} ` +
          `인하 전례가 없으므로 스크래퍼 오류일 확률이 높습니다.`
      );
    }

    if (r.deltaBlockPp != null && Math.abs(d) > r.deltaBlockPp + 1e-12) {
      C.fatal(
        "DELTA_TOO_LARGE",
        p,
        `전년 대비 ${(d * 100).toFixed(4)}%p 변동은 역대 최대를 넘습니다(BLOCK 상한 ${(r.deltaBlockPp * 100).toFixed(4)}%p). ${r.deltaBasis || ""}`
      );
    } else if (r.deltaOkPp != null && Math.abs(d) > r.deltaOkPp + 1e-12) {
      C.block(
        "DELTA_UNUSUAL",
        p,
        `전년 대비 ${(d * 100).toFixed(4)}%p 변동은 통상 범위(±${(r.deltaOkPp * 100).toFixed(4)}%p)를 넘습니다. ${r.deltaBasis || ""} 사람이 확인해야 합니다.`
      );
    } else if (r.deltaOkPct != null && Math.abs(dPct) > r.deltaOkPct + 1e-12) {
      C.block("DELTA_PCT_UNUSUAL", p, `전년 대비 ${(dPct * 100).toFixed(2)}% 변동이 통상 범위(${(r.deltaOkPct * 100).toFixed(2)}%)를 넘습니다.`);
    }

    if (r.deltaBlockPctMax != null && dPct > r.deltaBlockPctMax + 1e-12) {
      C.fatal("DELTA_PCT_TOO_LARGE", p, `전년 대비 +${(dPct * 100).toFixed(2)}% 는 FATAL 상한 ${(r.deltaBlockPctMax * 100).toFixed(0)}% 를 넘습니다. ${r.deltaBasis || ""}`);
    } else if (r.deltaOkPctMax != null && (dPct > r.deltaOkPctMax + 1e-12 || dPct < (r.deltaOkPctMin ?? -Infinity) - 1e-12)) {
      C.block(
        "DELTA_PCT_OUTSIDE_BAND",
        p,
        `전년 대비 ${(dPct * 100).toFixed(2)}% 는 통상 밴드 [${((r.deltaOkPctMin ?? 0) * 100).toFixed(1)}%, ${(r.deltaOkPctMax * 100).toFixed(1)}%] 밖입니다. ${r.deltaBasis || ""}`
      );
    }
  }
}

// ── (d) 교차 정합성 ──────────────────────────────────────────────
function checkCrossConsistency(C, ledger, rules) {
  // 1. 노사 1/2 부담
  for (const [p, r] of Object.entries(rules.fields)) {
    if (!r.halfOf) continue;
    const half = getPath(ledger, p);
    const total = getPath(ledger, r.halfOf);
    if (typeof half !== "number" || typeof total !== "number") continue;
    if (Math.abs(half - total / 2) > 1e-9) {
      C.fatal(
        "HALF_OF",
        p,
        `${p}(${half}) 가 ${r.halfOf}(${total}) 의 정확히 절반이 아닙니다. 기대 ${total / 2}. (${r.halfOfBasis || ""}) ` +
          `근로자 부담률 자리에 총요율을 넣었거나 그 반대일 가능성이 큽니다.`
      );
    }
  }

  // 2. 장기요양 파생값 — 건강보험료율과 장기요양비율을 서로의 감시자로 만든다.
  const nhi = getPath(ledger, "healthInsurance.totalRate");
  const ltcPct = getPath(ledger, "longTermCare.rateOfHealthPremium");
  const ltcInc = getPath(ledger, "longTermCare.rateOfIncome");
  if ([nhi, ltcPct, ltcInc].every((x) => typeof x === "number" && Number.isFinite(x))) {
    const derived = round(nhi * ltcPct, 6);
    const tol = rules.fields["longTermCare.rateOfIncome"].derivedTolerance ?? 5e-7;
    if (Math.abs(ltcInc - derived) > tol) {
      C.fatal(
        "LTC_DERIVATION",
        "longTermCare.rateOfIncome",
        `장기요양 소득대비 요율이 파생식과 어긋납니다. ` +
          `round6(건강보험료율 ${nhi} × 건보료대비 ${ltcPct}) = ${derived} 인데 원장에는 ${ltcInc} 입니다(오차 ${Math.abs(ltcInc - derived).toExponential(2)}). ` +
          `두 값 중 하나가 갱신되고 다른 하나가 안 된 상태이거나, 둘 중 하나를 잘못 파싱했습니다.`
      );
    }
  }

  // 3. equals 관계 (최저임금 209시간 환산, 자녀공제 3인 기본액)
  for (const [p, r] of Object.entries(rules.fields)) {
    if (!r.equals) continue;
    const v = getPath(ledger, p);
    if (typeof v !== "number") continue;
    const m = r.equals.match(/^([\w.]+)(?:\s*\*\s*(\d+))?$/);
    if (!m) continue;
    const base = getPath(ledger, m[1]);
    if (typeof base !== "number") continue;
    const expect = m[2] ? base * Number(m[2]) : base;
    if (v !== expect) {
      C.fatal("EQUALS", p, `${p}(${v}) 는 ${r.equals} = ${expect} 이어야 합니다. (${r.basis || r.equalsBasis || ""})`);
    }
  }

  // 4. 자녀공제 서열
  const c1 = getPath(ledger, "childTaxCredit.one");
  const c2 = getPath(ledger, "childTaxCredit.two");
  const cx = getPath(ledger, "childTaxCredit.threePlusPerExtra");
  if (typeof c1 === "number" && typeof c2 === "number" && !(c1 < c2)) {
    C.fatal("CHILD_ORDER", "childTaxCredit", `1명 공제(${c1}) 가 2명 공제(${c2}) 보다 작아야 합니다.`);
  }
  if (typeof cx === "number" && !(cx > 0)) {
    C.fatal("CHILD_EXTRA", "childTaxCredit.threePlusPerExtra", `2명 초과 1명당 공제액이 0 이하입니다: ${cx}.`);
  }

  // 5. 요율 서열 — 두 항목의 값이 뒤바뀌어 들어간 것을 잡는다.
  const np = getPath(ledger, "nationalPension.totalRate");
  const ei = getPath(ledger, "employmentInsurance.unemploymentTotalRate");
  const order = [
    ["nationalPension.totalRate", np],
    ["healthInsurance.totalRate", nhi],
    ["employmentInsurance.unemploymentTotalRate", ei],
    ["longTermCare.rateOfIncome", ltcInc],
  ];
  if (order.every(([, v]) => typeof v === "number" && Number.isFinite(v))) {
    for (let i = 1; i < order.length; i++) {
      if (!(order[i - 1][1] > order[i][1])) {
        C.fatal(
          "RATE_ORDER",
          order[i][0],
          `요율 서열이 깨졌습니다: ${order[i - 1][0]}(${order[i - 1][1]}) 가 ${order[i][0]}(${order[i][1]}) 보다 커야 합니다. ` +
            `2026~2033년 내내 유지되는 서열이므로, 깨졌다면 두 항목의 값이 뒤바뀌어 들어갔을 가능성이 높습니다.`
        );
        break;
      }
    }
  }

  // 6. 상식 부등호 — 하한 < 최저임금 월환산 < 상한
  const brackets = getPath(ledger, "nationalPension.baseIncomeBrackets");
  const mw = getPath(ledger, "minimumWage.monthly209h");
  if (Array.isArray(brackets) && brackets.length && typeof mw === "number") {
    const last = brackets[brackets.length - 1];
    if (!(last.min < mw && mw < last.max)) {
      C.fatal(
        "SANITY_ORDER_MW",
        "minimumWage.monthly209h",
        `최저임금 월환산액(${mw})이 국민연금 기준소득월액 구간 [${last.min}, ${last.max}] 안에 있어야 합니다. ` +
          `셋 중 하나의 자릿수가 틀렸습니다.`
      );
    }
  }
}

// ── 기준소득월액 구간 구조 ───────────────────────────────────────
const isIsoDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && realDate(s);
function realDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  const p = new Date(Date.UTC(y, m - 1, d));
  return p.getUTCFullYear() === y && p.getUTCMonth() === m - 1 && p.getUTCDate() === d;
}
const addDays = (s, n) => {
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
};

function checkBrackets(C, ledger, rules) {
  const R = rules.baseIncome;
  const bs = getPath(ledger, "nationalPension.baseIncomeBrackets");
  if (!Array.isArray(bs) || bs.length === 0) {
    C.fatal("BRACKETS_MISSING", "nationalPension.baseIncomeBrackets", "기준소득월액 구간이 없습니다.");
    return;
  }
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    const p = `nationalPension.baseIncomeBrackets.${i}`;
    for (const k of ["from", "to"]) {
      if (!isIsoDate(b[k])) {
        C.fatal(
          "BRACKET_DATE",
          `${p}.${k}`,
          `'${b[k]}' 는 달력상 실재하는 0 패딩 YYYY-MM-DD 가 아닙니다. ` +
            `구간 판정은 문자열 사전순 비교라 0 패딩이 없으면 조용히 잘못된 구간이 선택됩니다.`
        );
      }
    }
    if (isIsoDate(b.from) && b.from.slice(5) !== R.bracketMonthDay.from) {
      C.block("BRACKET_MONTHDAY", `${p}.from`, `구간 시작이 ${R.bracketMonthDay.from} 이 아닙니다: ${b.from}. 기준소득월액은 7월 1일에 갱신됩니다.`);
    }
    if (isIsoDate(b.to) && b.to.slice(5) !== R.bracketMonthDay.to) {
      C.block("BRACKET_MONTHDAY", `${p}.to`, `구간 종료가 ${R.bracketMonthDay.to} 이 아닙니다: ${b.to}.`);
    }
    for (const [k, lo, hi] of [
      ["min", R.minFatalMin, R.minFatalMax],
      ["max", R.maxFatalMin, R.maxFatalMax],
    ]) {
      const v = b[k];
      if (typeof v !== "number" || !Number.isInteger(v)) {
        C.fatal("BRACKET_TYPE", `${p}.${k}`, `정수여야 합니다: ${JSON.stringify(v)}.`);
      } else if (v < lo || v > hi) {
        C.fatal("BRACKET_RANGE", `${p}.${k}`, `${v} 가 [${lo}, ${hi}] 밖입니다. ` + diagnoseRange(v, lo, hi, null));
      } else if (R.multipleOf && v % R.multipleOf !== 0) {
        C.block("BRACKET_MULTIPLE", `${p}.${k}`, `${v} 가 ${R.multipleOf}원 배수가 아닙니다. 전 연도가 만원 배수였습니다.`);
      }
    }
    if (typeof b.min === "number" && typeof b.max === "number") {
      if (!(b.max > b.min)) {
        C.fatal("BRACKET_INVERTED", p, `상한(${b.max})이 하한(${b.min})보다 커야 합니다. 두 값이 뒤바뀌었을 수 있습니다.`);
      } else {
        const spread = b.max / b.min;
        if (spread < R.spreadFatalMin || spread > R.spreadFatalMax) {
          C.fatal("BRACKET_SPREAD", p, `상·하한 배율 ${spread.toFixed(2)} 가 [${R.spreadFatalMin}, ${R.spreadFatalMax}] 밖입니다(${R.spreadGrade}).`);
        }
      }
    }
    if (i > 0) {
      const prev = bs[i - 1];
      if (isIsoDate(prev.to) && isIsoDate(b.from) && addDays(prev.to, 1) !== b.from) {
        C.fatal("BRACKET_GAP", p, `구간에 틈 또는 중복이 있습니다: 이전 to=${prev.to}, 현재 from=${b.from}. 틈에 걸린 지급일은 구간을 못 찾습니다.`);
      }
      for (const k of ["min", "max"]) {
        if (typeof prev[k] === "number" && typeof b[k] === "number") {
          if (b[k] < prev[k]) {
            C.fatal("BRACKET_DECREASE", `${p}.${k}`, `${prev[k]} → ${b[k]} 로 감소했습니다. 기준소득월액 상·하한은 인하 전례가 없습니다.`);
          } else if (prev[k] > 0) {
            const g = b[k] / prev[k] - 1;
            if (g > R.growthFatalPctMax) {
              C.fatal("BRACKET_GROWTH", `${p}.${k}`, `전 구간 대비 +${(g * 100).toFixed(2)}% 는 FATAL 상한 ${(R.growthFatalPctMax * 100).toFixed(0)}% 를 넘습니다(${R.growthBasis}).`);
            } else if (g > 0 && (g < R.growthOkPctMin || g > R.growthOkPctMax)) {
              C.block("BRACKET_GROWTH_UNUSUAL", `${p}.${k}`, `전 구간 대비 ${(g * 100).toFixed(2)}% 변동이 통상 밴드 [${(R.growthOkPctMin * 100).toFixed(0)}%, ${(R.growthOkPctMax * 100).toFixed(0)}%] 밖입니다.`);
            }
          }
        }
      }
    }
  }

  // 커버리지 — 원장이 해당 연도 전체를 덮어야 한다.
  // 이걸 안 넣으면 7월 1일에 사이트가 조용히 구간 밖으로 나간다.
  const y = ledger.year;
  const first = bs[0];
  const last = bs[bs.length - 1];
  if (isIsoDate(first.from) && first.from > `${y}-01-01`) {
    C.fatal("BRACKET_COVERAGE", "nationalPension.baseIncomeBrackets", `${y}-01-01 을 덮는 구간이 없습니다(첫 구간 시작 ${first.from}). 연초 지급일이 구간을 못 찾습니다.`);
  }
  if (isIsoDate(last.to) && last.to < `${y}-12-31`) {
    C.fatal("BRACKET_COVERAGE", "nationalPension.baseIncomeBrackets", `${y}-12-31 을 덮는 구간이 없습니다(마지막 구간 종료 ${last.to}).`);
  }
}

// ── (b) 집계 지표 — 근로자 부담 합계 ─────────────────────────────
function employeeBurden(ledger) {
  const np = getPath(ledger, "nationalPension.employeeRate");
  const nhi = getPath(ledger, "healthInsurance.employeeRate");
  const ltc = getPath(ledger, "longTermCare.rateOfHealthPremium");
  const ei = getPath(ledger, "employmentInsurance.employeeRate");
  if ([np, nhi, ltc, ei].some((v) => typeof v !== "number" || !Number.isFinite(v))) return null;
  return np + nhi + nhi * ltc + ei;
}

function checkAggregate(C, ledger, current, rules) {
  const R = rules.aggregate;
  const v = employeeBurden(ledger);
  if (v == null) return;
  if (v < R.fatalMin || v > R.fatalMax) {
    C.fatal("BURDEN_RANGE", "$aggregate.employeeBurden", `근로자 부담 합계 ${pp(v)} 가 [${pp(R.fatalMin)}, ${pp(R.fatalMax)}] 밖입니다. 개별 항목은 통과했으나 조합이 비상식적입니다.`);
    return;
  }
  const prev = current ? employeeBurden(current) : null;
  if (prev == null) return;
  const d = Math.abs(v - prev);
  if (d > R.deltaFatalPp) {
    C.fatal("BURDEN_DELTA", "$aggregate.employeeBurden", `근로자 부담 합계가 ${pp(prev)} → ${pp(v)} (${((v - prev) * 100).toFixed(4)}%p) 로 변했습니다. FATAL 상한 ${(R.deltaFatalPp * 100).toFixed(2)}%p. ${R.basis}`);
  } else if (d > R.deltaBlockPp) {
    C.block("BURDEN_DELTA", "$aggregate.employeeBurden", `근로자 부담 합계가 ${((v - prev) * 100).toFixed(4)}%p 변했습니다(BLOCK 임계 ${(R.deltaBlockPp * 100).toFixed(2)}%p). ${R.basis}`);
  }
}

// ── 실수령액 회귀 — 가장 강력한 종단 검사 ────────────────────────
/**
 * 고정 바스켓에 대해 구 원장 vs 신 원장 실수령액을 비교한다.
 * 개별 요율 검사를 전부 통과하는 '조합 오류' 를 잡는 유일한 방어선이다.
 * 엔진 로드에 실패하면 조용히 넘어가지 않고 WARN 을 남긴다.
 */
function checkNetPayRegression(C, ledger, current, rules, taxTable) {
  const R = rules.netPayRegression;
  if (!current || !taxTable) return [];
  let calcNetPay;
  try {
    ({ calcNetPay } = require(path.join(ROOT, "src", "engine", "net-pay.js")));
  } catch (e) {
    C.warn("REGRESSION_UNAVAILABLE", "$regression", `실수령액 회귀 검사를 실행할 수 없습니다: ${e.message}`);
    return [];
  }
  const rows = [];
  for (const input of R.basket) {
    let before, after;
    try {
      before = calcNetPay(input, current, taxTable);
      after = calcNetPay(input, ledger, taxTable);
    } catch (e) {
      C.fatal("REGRESSION_THROW", "$regression", `바스켓 ${JSON.stringify(input)} 계산이 예외를 던졌습니다: ${e.message}`);
      continue;
    }
    const d = after.netPay - before.netPay;
    const ratio = before.gross > 0 ? Math.abs(d) / before.gross : 0;
    rows.push({
      input,
      gross: before.gross,
      netBefore: before.netPay,
      netAfter: after.netPay,
      delta: d,
      ratioOfGross: ratio,
    });
    if (ratio > R.fatalPctOfGross) {
      C.fatal("REGRESSION_DELTA", "$regression", `${JSON.stringify(input)}: 실수령액이 ${before.netPay} → ${after.netPay} (${d >= 0 ? "+" : ""}${d}원, 총지급액의 ${(ratio * 100).toFixed(3)}%p) 변했습니다. FATAL 임계 ${(R.fatalPctOfGross * 100).toFixed(2)}%p.`);
    } else if (ratio > R.blockPctOfGross) {
      C.block("REGRESSION_DELTA", "$regression", `${JSON.stringify(input)}: 실수령액 ${d >= 0 ? "+" : ""}${d}원 (총지급액의 ${(ratio * 100).toFixed(3)}%p). BLOCK 임계 ${(R.blockPctOfGross * 100).toFixed(2)}%p.`);
    }
  }
  return rows;
}

// ── (c) lastVerified ─────────────────────────────────────────────
function checkLastVerified(C, ledger, rules, today) {
  const v = ledger.lastVerified;
  if (!isIsoDate(v)) {
    C.fatal("LAST_VERIFIED_FORMAT", "lastVerified", `'${v}' 는 달력상 실재하는 YYYY-MM-DD 가 아닙니다.`);
    return;
  }
  const t = today || new Date().toISOString().slice(0, 10);
  if (v > t) {
    C.fatal("LAST_VERIFIED_FUTURE", "lastVerified", `미래 날짜입니다: ${v} > ${t}.`);
    return;
  }
  const days = Math.round((Date.parse(t) - Date.parse(v)) / 86400000);
  const S = rules.staleness;
  if (days > S.lastVerifiedFatalDays) {
    C.fatal("LAST_VERIFIED_STALE", "lastVerified", `${days}일 전에 확인된 원장입니다(FATAL ${S.lastVerifiedFatalDays}일). 요율이 최소 한 번의 개정 주기를 통째로 놓쳤습니다.`);
  } else if (days > S.lastVerifiedWarnDays) {
    C.warn("LAST_VERIFIED_AGING", "lastVerified", `${days}일 전에 확인됐습니다(WARN ${S.lastVerifiedWarnDays}일). 자동 갱신 파이프라인이 돌지 않고 있을 수 있습니다.`);
  }
}

// ── diff 화이트리스트 — 조용한 훼손 방지 ─────────────────────────
function isProtected(p, rules) {
  const P = rules.protectedPaths;
  if (P.exact.some((x) => p === x || p.startsWith(x + "."))) return true;
  // 키 세그먼트가 '$' 로 시작하면 주석·미해결 이슈 기록이다. 이 저장소의 안전장치다.
  return p.split(".").some((seg) => seg.startsWith("$"));
}

function isMutable(p, rules) {
  return rules.mutablePaths.allow.some((x) => p === x || p.startsWith(x + "."));
}

function checkDiff(C, ledger, current, rules) {
  if (!current) return { changed: [], added: [], removed: [] };
  const a = flatten(current);
  const b = flatten(ledger);
  const changed = [];
  const added = [];
  const removed = [];

  for (const k of Object.keys(a)) {
    if (!(k in b)) {
      removed.push(k);
      C.fatal("KEY_REMOVED", k, `키가 삭제됐습니다(${JSON.stringify(a[k]).slice(0, 80)}). 스크래퍼가 템플릿으로 파일을 다시 쓰면서 주석·미해결 이슈를 날리는 전형적 사고입니다.`);
    } else if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
      changed.push({ path: k, from: a[k], to: b[k] });
      if (isProtected(k, rules)) {
        C.fatal("PROTECTED_MODIFIED", k, `보호 경로가 수정됐습니다: ${JSON.stringify(a[k]).slice(0, 60)} → ${JSON.stringify(b[k]).slice(0, 60)}. 이 항목들(주석·미해결 이슈·입력 방어값)이 이 저장소의 안전장치입니다.`);
      } else if (!isMutable(k, rules)) {
        C.block("UNLISTED_CHANGE", k, `자동 갱신 화이트리스트에 없는 경로가 바뀌었습니다: ${JSON.stringify(a[k]).slice(0, 60)} → ${JSON.stringify(b[k]).slice(0, 60)}.`);
      }
    }
  }
  for (const k of Object.keys(b)) {
    if (!(k in a)) {
      added.push(k);
      C.block("KEY_ADDED", k, `새 키가 추가됐습니다: ${JSON.stringify(b[k]).slice(0, 80)}. 사람이 의도를 확인해야 합니다.`);
    }
  }
  return { changed, added, removed };
}

// ── 간이세액표 검사 ──────────────────────────────────────────────
function validateTaxTable(table, rules, prevTable) {
  const C = makeCollector();
  const R = rules.taxTable;
  const rows = table && table.rows;
  if (!Array.isArray(rows)) {
    C.fatal("TAX_ROWS_MISSING", "rows", "간이세액표 rows 가 배열이 아닙니다.");
    return finish(C, {});
  }
  if (rows.length !== R.rowCount) {
    C.fatal("TAX_ROW_COUNT", "rows", `행 수가 ${rows.length} 입니다(${R.rowCount} 기대). 파서가 깨졌거나 별표 서식이 바뀌었습니다.`);
  }
  if (table.rowCount != null && table.rowCount !== rows.length) {
    C.fatal("TAX_ROW_COUNT_META", "rowCount", `메타 rowCount(${table.rowCount})와 실제 행 수(${rows.length})가 다릅니다.`);
  }

  let breaks = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!Array.isArray(r) || r.length !== R.columnCount) {
      C.fatal("TAX_COL_COUNT", `rows.${i}`, `열 수가 ${Array.isArray(r) ? r.length : "N/A"} 입니다(${R.columnCount} 기대).`);
      continue;
    }
    if (r.some((v) => typeof v !== "number" || !Number.isInteger(v) || v < 0)) {
      C.fatal("TAX_CELL_TYPE", `rows.${i}`, `음수·비정수·비숫자 셀이 있습니다: ${JSON.stringify(r)}`);
      continue;
    }
    const [from, to, ...tax] = r;
    if (!(to > from)) C.fatal("TAX_BRACKET", `rows.${i}`, `구간 상한(${to})이 하한(${from})보다 커야 합니다.`);
    if (i > 0 && rows[i - 1][1] !== from) breaks++;
    // 같은 행: 부양가족 수가 늘면 세액은 비증가
    for (let j = 1; j < tax.length; j++) {
      if (tax[j] > tax[j - 1]) {
        C.fatal("TAX_DEPENDENT_MONOTONIC", `rows.${i}.${j + 2}`, `부양가족 ${j}명(${tax[j - 1]}) → ${j + 1}명(${tax[j]}) 으로 세액이 증가했습니다. 셀이 밀렸습니다.`);
        break;
      }
    }
    for (const v of tax) {
      if (v % R.taxMultipleOf !== 0) {
        C.fatal("TAX_MULTIPLE", `rows.${i}`, `세액 ${v} 가 ${R.taxMultipleOf}원 배수가 아닙니다.`);
        break;
      }
    }
    // 월급여액은 천원 단위다. 세액/월급여 비율이 최고세율을 넘으면 셀이 밀린 것.
    const incomeWon = from * 1000;
    if (incomeWon > 0 && tax[0] / incomeWon > R.maxTaxRatioOfIncome) {
      C.fatal("TAX_RATIO", `rows.${i}`, `세액(${tax[0]}) / 월급여(${incomeWon}) = ${(tax[0] / incomeWon).toFixed(3)} 가 최고세율 ${R.maxTaxRatioOfIncome} 를 넘습니다. ${R.maxTaxRatioBasis}`);
    }
  }
  if (breaks > 0) {
    C.fatal("TAX_CONTINUITY", "rows", `구간 연속성이 ${breaks}곳에서 깨졌습니다(이전 행 상한 ≠ 다음 행 하한). 틈에 걸린 급여는 세액을 못 찾습니다.`);
  }

  // 열 단조성 — 급여가 오르면 세액은 비감소
  for (let col = 2; col < R.columnCount; col++) {
    for (let i = 1; i < rows.length; i++) {
      if (!Array.isArray(rows[i]) || !Array.isArray(rows[i - 1])) break;
      if (rows[i][col] < rows[i - 1][col]) {
        C.fatal("TAX_INCOME_MONOTONIC", `rows.${i}.${col}`, `급여가 올랐는데 세액이 감소했습니다: ${rows[i - 1][col]} → ${rows[i][col]} (열 ${col}).`);
        break;
      }
    }
  }

  // 본표 변경은 항상 BLOCK — 2024판과 2026판의 646행이 완전히 동일했다.
  if (prevTable && Array.isArray(prevTable.rows)) {
    const a = JSON.stringify(prevTable.rows);
    const b = JSON.stringify(rows);
    if (a !== b) {
      let diffCells = 0;
      const n = Math.min(prevTable.rows.length, rows.length);
      for (let i = 0; i < n; i++) {
        const x = prevTable.rows[i] || [];
        const y = rows[i] || [];
        for (let j = 0; j < Math.max(x.length, y.length); j++) if (x[j] !== y[j]) diffCells++;
      }
      C.block("TAX_TABLE_CHANGED", "rows", `본표가 바뀌었습니다(다른 셀 ${diffCells}개, 행 수 ${prevTable.rows.length} → ${rows.length}). 2024판과 2026판의 646행이 완전히 동일했으므로, 본표 변경은 개정보다 파싱 사고일 확률이 높습니다. 사람이 diff 를 봐야 합니다.`);
    }
  }
  return finish(C, {});
}

// ── 낡음(staleness) 감시 ─────────────────────────────────────────
/**
 * '실패 시 멈춤' 은 감시가 없으면 무기한 침묵이 된다.
 * 달력 게이트로 침묵을 깨뜨린다. 워크플로가 매일 이것을 돌린다.
 */
function checkStaleness(ledger, rules, todayStr) {
  const C = makeCollector();
  const today = todayStr || new Date().toISOString().slice(0, 10);
  const y = Number(today.slice(0, 4));
  const md = today.slice(5);

  checkLastVerified(C, ledger, rules, today);

  if (ledger.year < y) {
    C.fatal("LEDGER_YEAR_PAST", "year", `원장 연도가 ${ledger.year} 인데 오늘은 ${today} 입니다. ${y}년 원장이 없습니다.`);
  }

  for (const g of rules.staleness.gates) {
    if (md < g.afterMonthDay) continue;
    if (g.check === "baseIncomeBracketForJuly") {
      const bs = ledger.nationalPension && ledger.nationalPension.baseIncomeBrackets;
      const has = Array.isArray(bs) && bs.some((b) => b.from === `${y}-07-01`);
      if (!has) C.fatal("STALE_BASE_INCOME", "nationalPension.baseIncomeBrackets", `${today} 인데 ${y}-07-01 시작 구간이 없습니다. ${g.reason}`);
    } else if (g.check === "nextYearMinimumWage") {
      // 다음 연도 최저임금은 원장에 아직 안 들어가지만, 고시가 났는지 확인은 해야 한다.
      C.warn("STALE_NEXT_MW", "minimumWage", `${today} 기준 ${y + 1}년 최저임금 고시 확인이 필요합니다. ${g.reason} (tools/fetch-rates.js 의 $forecast 팩트로 확인)`);
    } else if (g.check === "nextYearLedger") {
      if (ledger.year <= y) C.warn("STALE_NEXT_LEDGER", "year", `${today} 기준 ${y + 1}년 원장 준비가 필요합니다. ${g.reason}`);
    } else if (g.check === "taxTableRevisionConfirmed") {
      const lv = ledger.lastVerified;
      if (isIsoDate(lv) && lv < `${y}-03-01`) {
        C.warn("STALE_TAX_TABLE", "lastVerified", `${today} 인데 마지막 확인이 ${lv} 로 ${y}-03-01 이전입니다. ${g.reason}`);
      }
    }
  }
  return finish(C, {});
}

// ── 결과 정리 ────────────────────────────────────────────────────
function finish(C, extra) {
  const fatal = C.issues.filter((i) => i.level === "FATAL");
  const block = C.issues.filter((i) => i.level === "BLOCK");
  const warn = C.issues.filter((i) => i.level === "WARN");
  const info = C.issues.filter((i) => i.level === "INFO");
  return {
    ok: fatal.length === 0,
    autoMergeable: fatal.length === 0 && block.length === 0,
    fatal,
    block,
    warn,
    info,
    issues: C.issues,
    ...extra,
  };
}

// ── 공개 API ─────────────────────────────────────────────────────
/**
 * @param {object} o
 * @param {object} o.candidate  검사 대상 원장
 * @param {object} [o.current]  직전 원장(변동폭·diff 검사용). 없으면 해당 검사 생략.
 * @param {object} [o.rules]    기본값 data/sanity-rules.json
 * @param {object} [o.taxTable] 실수령액 회귀 검사용
 * @param {string} [o.today]    'YYYY-MM-DD'. 테스트에서 시간을 고정하기 위해.
 */
function validate(o) {
  const rules = o.rules || JSON.parse(fs.readFileSync(DEFAULT_RULES, "utf8"));
  const C = makeCollector();
  const ledger = o.candidate;

  if (!ledger || typeof ledger !== "object") {
    C.fatal("NOT_OBJECT", "$root", `원장이 객체가 아닙니다: ${typeof ledger}.`);
    return finish(C, {});
  }
  if (!Number.isInteger(ledger.year)) {
    C.fatal("YEAR", "year", `year 가 정수가 아닙니다: ${JSON.stringify(ledger.year)}.`);
  }

  checkFieldFormat(C, ledger, o.current, rules);
  checkPensionSchedule(C, ledger, rules);
  checkDeltas(C, ledger, o.current, rules);
  checkCrossConsistency(C, ledger, rules);
  checkBrackets(C, ledger, rules);
  checkAggregate(C, ledger, o.current, rules);
  checkLastVerified(C, ledger, rules, o.today);
  const diff = checkDiff(C, ledger, o.current, rules);
  const regression = checkNetPayRegression(C, ledger, o.current, rules, o.taxTable);

  // effectiveFrom 형식·연도 정합
  for (const [sec, allowMidYear] of [
    ["nationalPension", false],
    ["healthInsurance", false],
    ["longTermCare", false],
    ["employmentInsurance", true],
    ["minimumWage", false],
  ]) {
    const ef = ledger[sec] && ledger[sec].effectiveFrom;
    if (ef === undefined) continue;
    if (!isIsoDate(ef)) {
      C.fatal("EFFECTIVE_FROM_FORMAT", `${sec}.effectiveFrom`, `'${ef}' 는 달력상 실재하는 YYYY-MM-DD 가 아닙니다.`);
    } else if (Number(ef.slice(0, 4)) !== ledger.year && !allowMidYear) {
      C.block("EFFECTIVE_FROM_YEAR", `${sec}.effectiveFrom`, `시행일 연도(${ef})가 원장 연도(${ledger.year})와 다릅니다.`);
    }
  }
  {
    const ef = ledger.employmentInsurance && ledger.employmentInsurance.effectiveFrom;
    if (isIsoDate(ef) && ef.slice(5) !== "01-01") {
      C.info("EI_MIDYEAR", "employmentInsurance.effectiveFrom", `고용보험 시행일이 연중(${ef})입니다. 전례가 있으므로(2019-10-01, 2022-07-01) 오류가 아닙니다.`);
    }
  }

  return finish(C, { diff, regression, employeeBurden: employeeBurden(ledger) });
}

// ── CLI ──────────────────────────────────────────────────────────
function formatReport(res, title) {
  const L = [];
  L.push(`# ${title}`);
  L.push("");
  L.push(`- FATAL ${res.fatal.length} / BLOCK ${res.block.length} / WARN ${res.warn.length}`);
  L.push(`- 판정: ${res.fatal.length ? "★후보 폐기(FATAL)★" : res.block.length ? "사람 승인 필요(BLOCK)" : "자동 병합 가능"}`);
  L.push("");
  for (const [lvl, arr] of [["FATAL", res.fatal], ["BLOCK", res.block], ["WARN", res.warn], ["INFO", res.info]]) {
    if (!arr.length) continue;
    L.push(`## ${lvl}`);
    for (const i of arr) L.push(`- \`${i.path}\` [${i.code}] ${i.message}`);
    L.push("");
  }
  if (res.diff && res.diff.changed && res.diff.changed.length) {
    L.push("## 변경된 값");
    L.push("");
    L.push("| 경로 | 이전 | 이후 |");
    L.push("|---|---|---|");
    for (const c of res.diff.changed) L.push(`| \`${c.path}\` | ${JSON.stringify(c.from)} | ${JSON.stringify(c.to)} |`);
    L.push("");
  }
  if (res.regression && res.regression.length) {
    L.push("## 실수령액 회귀 (고정 바스켓)");
    L.push("");
    L.push("| 입력 | 총지급액(월) | 실수령 이전 | 실수령 이후 | 차이 |");
    L.push("|---|---:|---:|---:|---:|");
    for (const r of res.regression) {
      L.push(`| ${JSON.stringify(r.input)} | ${r.gross.toLocaleString()} | ${r.netBefore.toLocaleString()} | ${r.netAfter.toLocaleString()} | ${r.delta >= 0 ? "+" : ""}${r.delta.toLocaleString()} |`);
    }
    L.push("");
  }
  return L.join("\n");
}

function main() {
  const argv = process.argv.slice(2);
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--current") flags.current = argv[++i];
    else if (argv[i] === "--tax-table") flags.taxTable = argv[++i];
    else if (argv[i] === "--today") flags.today = argv[++i];
    else if (argv[i] === "--json") flags.json = true;
    else if (argv[i] === "--staleness") flags.staleness = true;
    else positional.push(argv[i]);
  }
  const target = positional[0] || path.join(ROOT, "data", "rates-2026.json");
  const rules = JSON.parse(fs.readFileSync(DEFAULT_RULES, "utf8"));
  const candidate = JSON.parse(fs.readFileSync(path.resolve(target), "utf8"));
  const current = flags.current ? JSON.parse(fs.readFileSync(path.resolve(flags.current), "utf8")) : null;
  const taxTablePath = flags.taxTable || path.join(ROOT, "data", `simplified-tax-table-${candidate.year}.json`);
  let taxTable = null;
  try {
    taxTable = JSON.parse(fs.readFileSync(taxTablePath, "utf8"));
  } catch {
    /* 간이세액표가 없으면 회귀 검사를 생략한다 */
  }

  const res = flags.staleness
    ? checkStaleness(candidate, rules, flags.today)
    : validate({ candidate, current, rules, taxTable, today: flags.today });

  if (flags.json) {
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
  } else {
    process.stdout.write(formatReport(res, flags.staleness ? "낡음(staleness) 감시" : `위생 검사 — ${path.relative(ROOT, path.resolve(target))}`) + "\n");
  }
  // FATAL 2 / BLOCK 1 / 통과 0
  process.exit(res.fatal.length ? 2 : res.block.length ? 1 : 0);
}

if (require.main === module) main();

module.exports = {
  validate,
  validateTaxTable,
  checkStaleness,
  formatReport,
  employeeBurden,
  flatten,
  getPath,
  DEFAULT_RULES,
  DEFAULT_HISTORY,
};
