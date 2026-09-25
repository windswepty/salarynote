#!/usr/bin/env node
/**
 * 요율 원장 갱신 오케스트레이터.
 *
 * 흐름
 *   관측(observations) → 교차검증 → 후보 원장 생성 → 위생 검사 → 판정
 *
 * ★원장을 망가뜨리지 않는 것이 최우선이다.★
 * 어떤 실패 경로에서도 data/rates-*.json 은 마지막 정상값 그대로 남는다.
 * 원장에 쓰는 시점은 오직 하나 — 모든 검사를 통과하고 --apply 가 주어졌을 때뿐이다.
 * 쓰기는 임시 파일에 먼저 하고 rename 으로 원자적으로 교체한다(중간에 죽어도 반쪽 파일이 안 남는다).
 *
 * 자동 반영 자격 (전부 만족해야 함)
 *   1. 독립 출처 2개 이상이 같은 값을 냈다 (fetch-rates 의 autoMerge)
 *   2. 해당 필드가 '항상 사람 확인' 목록(자녀공제액 등)에 없다
 *   3. 위생 검사에 FATAL·BLOCK 이 없다
 * 하나라도 어긋나면 값을 적용하지 않고 후보 파일 + 리포트만 남긴다.
 *
 * 종료 코드
 *   0  통과 — 변경 없음, 또는 --apply 로 원장 갱신 완료
 *   1  사람 확인 필요 — BLOCK / 단일 출처 / 출처 불일치. 원장 미변경.
 *   2  FATAL 또는 수집 실패. 원장 미변경.
 *
 * 실행
 *   node tools/update-rates.js --year 2026 [--observations <path>] [--apply]
 *                              [--report report.md] [--summary summary.json]
 *   --observations 를 주지 않으면 fetch-rates 를 직접 실행해 네트워크에서 수집한다.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const sanity = require(path.join(__dirname, "sanity-check.js"));
const jsonPatch = require(path.join(__dirname, "lib", "json-patch.js"));
const { kstToday } = require(path.join(__dirname, "lib", "resolve-ledger.js"));

// ── 팩트 → 원장 경로 매핑 ────────────────────────────────────────
/**
 * alwaysHuman: 2출처가 일치해도 자동 반영하지 않는다.
 *   childTaxCredit — 실제로 프로덕션 오류를 낸 유일한 필드. 그리고 출처가 법제처 하나뿐이다.
 * derived: 다른 필드에서 계산되므로 관측값을 직접 쓰지 않는다.
 */
const FACT_MAP = {
  "nationalPension.totalRate": { ledger: "nationalPension.totalRate", section: "nationalPension" },
  "nationalPension.employeeRate": { ledger: "nationalPension.employeeRate", section: "nationalPension" },
  "healthInsurance.totalRate": { ledger: "healthInsurance.totalRate", section: "healthInsurance" },
  "healthInsurance.employeeRate": { ledger: "healthInsurance.employeeRate", section: "healthInsurance" },
  "longTermCare.rateOfIncome": { ledger: "longTermCare.rateOfIncome", section: "longTermCare" },
  "employmentInsurance.unemploymentTotalRate": { ledger: "employmentInsurance.unemploymentTotalRate", section: "employmentInsurance" },
  "employmentInsurance.employeeRate": { ledger: "employmentInsurance.employeeRate", section: "employmentInsurance" },
  "minimumWage.hourly": { ledger: "minimumWage.hourly", section: "minimumWage" },
  "minimumWage.monthly209h": { ledger: "minimumWage.monthly209h", section: "minimumWage" },
  "childTaxCredit.one": { ledger: "childTaxCredit.one", section: "childTaxCredit", alwaysHuman: true },
  "childTaxCredit.two": { ledger: "childTaxCredit.two", section: "childTaxCredit", alwaysHuman: true },
  "childTaxCredit.threePlusBase": { ledger: "childTaxCredit.threePlusBase", section: "childTaxCredit", alwaysHuman: true },
  "childTaxCredit.threePlusPerExtra": { ledger: "childTaxCredit.threePlusPerExtra", section: "childTaxCredit", alwaysHuman: true },
};

/** 원장에 대응 필드가 없거나 엔진이 아직 쓰지 않는 팩트. 리포트에만 싣는다. */
const REPORT_ONLY = {
  "healthInsurance.premiumBounds.max":
    "원장에 premiumBounds 필드가 없고 calcHealthInsurance 에 clamp 가 구현돼 있지 않다. 출처도 법제처 고시 하나뿐이다. 단시간·일용 계산기를 추가하기 전에 사람이 필드 신설과 clamp 구현을 함께 해야 한다.",
  "healthInsurance.premiumBounds.min": "위와 동일.",
  "taxTable.revision": "간이세액표 개정일자. 값 갱신이 아니라 개정 감지 신호로만 쓴다.",
};

/** 아래에서 전용 로직이 따로 처리하는 팩트. 일반 매핑 루프에서 건너뛴다. */
const HANDLED_SEPARATELY = new Set([
  "nationalPension.baseIncome.min",
  "nationalPension.baseIncome.max",
  "nationalPension.baseIncome.from",
  "nationalPension.baseIncome.to",
]);

// ── 유틸 ────────────────────────────────────────────────────────
const clone = (o) => JSON.parse(JSON.stringify(o));
const get = sanity.getPath;

function set(obj, p, v) {
  const keys = p.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== "object") cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = v;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 원자적 쓰기. 중간에 죽어도 반쪽 파일이 남지 않는다. */
function writeAtomic(file, text) {
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

/**
 * 원장 텍스트에 바뀐 값만 국소적으로 갈아 끼운다.
 *
 * JSON.stringify 로 통째로 다시 쓰면 손으로 맞춘 서식이 전부 뒤집혀
 * 값 하나 바뀐 diff 가 파일 전체가 된다. 그러면 사람이 검토를 포기하는데,
 * 이 프로젝트에서 사람 검토 1회는 틀린 요율의 무인 배포를 막는 마지막 장치다.
 *
 * 갈아 끼운 뒤 반드시 다시 파싱해 목표 객체와 일치하는지 확인한다.
 * 국소 수정이 조용히 어긋나면 그게 바로 '조용한 오염' 이다.
 */
function renderLedger(originalText, expected, changedLeaves) {
  const edits = changedLeaves.map((c) => ({ path: c.path, text: JSON.stringify(c.to) }));
  let out;
  try {
    out = jsonPatch.patch(originalText, edits);
  } catch (e) {
    throw new Error(
      `원장 국소 수정에 실패했습니다: ${e.message}\n` +
        `서식을 뒤엎는 전체 재작성으로 폴백하지 않습니다 — 사람이 직접 반영하십시오.`
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch (e) {
    throw new Error(`국소 수정 결과가 유효한 JSON 이 아닙니다: ${e.message}`);
  }
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
    throw new Error(
      "국소 수정 결과가 검증된 후보 객체와 일치하지 않습니다. 원장을 쓰지 않습니다.\n" +
        "이것은 패처 버그이며, 조용히 다른 값을 배포하는 것보다 멈추는 것이 낫습니다."
    );
  }
  return out;
}

// ── 후보 원장 생성 ───────────────────────────────────────────────
/**
 * @returns {{candidate:object, applied:Array, deferred:Array, reportOnly:Array, conflicts:Array}}
 *   applied   — 자동 반영 자격을 갖춘 변경 (후보에 반영됨)
 *   deferred  — 값은 달라졌으나 자격 미달이라 반영하지 않은 것 (사람 확인 필요)
 *   conflicts — 원장 값과는 같지만 출처끼리 다투는 항목 (아래 주석 참조)
 */
function buildCandidate(current, obs, todayStr) {
  const candidate = clone(current);
  const applied = [];
  const deferred = [];
  const reportOnly = [];
  /**
   * ★값이 안 바뀌었어도 출처 불일치는 반드시 사람에게 알린다.★
   *
   * 원장 값이 1차 출처(법제처)와 같으면 '재확인 완료' 로 넘어가고 싶어지지만,
   * 그때 2차 출처가 다른 값을 말하고 있다면 그 항목은 사실상 단일 출처로 떨어진 것이다.
   * 원장이 "독립 출처 2개로 검증됨" 이라고 주장하는 근거가 사라졌는데도
   * 리포트에 '전 항목 통과' 라고 찍히면, 그것이 바로 이 프로젝트가 가장 두려워하는
   * '조용한 확인' 이다. 값이 틀린 게 아니라 검증이 틀린 것이라 더 오래 안 들킨다.
   *
   * 실제로 일어날 시나리오: 매년 1월 초, 법제처는 새 요율인데 4insure 는 아직 구값인 구간.
   * 또는 2차 출처 페이지 구조가 바뀌어 엉뚱한 셀을 집기 시작한 경우.
   * 원장은 건드리지 않되(값은 1차 출처와 일치하므로 옳다) 종료 코드 1로 사람을 부른다.
   */
  const conflicts = [];
  const touchedSections = new Set();

  for (const [fact, f] of Object.entries(obs.facts)) {
    if (fact.startsWith("$")) continue; // 예고값·참고값 등 정보성 팩트
    if (HANDLED_SEPARATELY.has(fact)) continue;

    if (REPORT_ONLY[fact]) {
      reportOnly.push({ fact, value: f.value, reason: REPORT_ONLY[fact], observations: f.observations });
      continue;
    }
    const m = FACT_MAP[fact];
    if (!m) {
      reportOnly.push({ fact, value: f.value, reason: "원장에 대응하는 경로가 정의되지 않았습니다(FACT_MAP 미등록).", observations: f.observations });
      continue;
    }

    const before = get(candidate, m.ledger);
    if (same(before, f.value)) {
      // 값은 같다. 그러나 출처끼리 다투고 있다면 '재확인 완료' 로 삼키지 않는다(위 conflicts 주석 참조).
      if (!f.agree) {
        conflicts.push({
          fact,
          path: m.ledger,
          value: before,
          disagreement: f.disagreement,
          observations: f.observations,
          reason:
            `원장 값(${JSON.stringify(before)})은 1차 출처와 일치하지만 출처들이 서로 다른 값을 말하고 있습니다. ` +
            `이 항목은 지금 사실상 단일 출처로 떨어졌으므로 '2출처 검증됨' 이라고 볼 수 없습니다. ` +
            `2차 출처가 갱신에 뒤처진 것인지(1월 초에 흔함) 파싱이 깨진 것인지 사람이 판별해야 합니다.`,
        });
      }
      applied.push({
        fact,
        path: m.ledger,
        from: before,
        to: f.value,
        unchanged: true,
        conflicted: !f.agree,
        sources: f.observations.map((o) => o.sourceId),
      });
      continue;
    }

    const reasons = [];
    if (!f.agree) reasons.push(`출처 불일치: ${JSON.stringify(f.disagreement)}`);
    if (f.independentSources < 2) reasons.push(`독립 출처가 ${f.independentSources}개뿐입니다(2개 이상 필요).`);
    if (m.alwaysHuman) reasons.push("이 필드는 출처가 일치해도 항상 사람이 확인합니다.");

    if (reasons.length) {
      deferred.push({ fact, path: m.ledger, from: before, to: f.value, reasons, observations: f.observations });
    } else {
      set(candidate, m.ledger, f.value);
      touchedSections.add(m.section);
      applied.push({ fact, path: m.ledger, from: before, to: f.value, sources: f.observations.map((o) => o.sourceId) });
    }
  }

  // ── 장기요양 파생값 ──────────────────────────────────────────
  // 엔진은 rateOfHealthPremium(건강보험료 대비)을 쓰고, 법령 정본은 rateOfIncome(보수월액 대비)이다.
  // 둘이 어긋난 채로 남으면 위생 검사의 LTC_DERIVATION 이 FATAL 을 낸다. 여기서 함께 맞춘다.
  const nhi = get(candidate, "healthInsurance.totalRate");
  const inc = get(candidate, "longTermCare.rateOfIncome");
  const curPct = get(candidate, "longTermCare.rateOfHealthPremium");
  if (typeof nhi === "number" && typeof inc === "number" && nhi > 0) {
    const derived = Math.round((inc / nhi) * 1e4) / 1e4; // 고시 표기가 소수점 넷째자리(13.14%)
    const roundTrip = Math.round(nhi * derived * 1e6) / 1e6;
    if (!same(curPct, derived)) {
      if (roundTrip !== inc) {
        deferred.push({
          fact: "longTermCare.rateOfHealthPremium",
          path: "longTermCare.rateOfHealthPremium",
          from: curPct,
          to: derived,
          reasons: [
            `파생값이 왕복하지 않습니다: round6(${nhi} × ${derived}) = ${roundTrip} ≠ 관측 rateOfIncome ${inc}. ` +
              `건강보험료 대비 비율의 표기 자릿수가 바뀌었거나 둘 중 하나를 잘못 파싱했습니다.`,
          ],
          observations: [],
        });
      } else {
        set(candidate, "longTermCare.rateOfHealthPremium", derived);
        touchedSections.add("longTermCare");
        applied.push({
          fact: "longTermCare.rateOfHealthPremium",
          path: "longTermCare.rateOfHealthPremium",
          from: curPct,
          to: derived,
          derived: `round4(rateOfIncome ${inc} / 건강보험료율 ${nhi})`,
          sources: ["derived"],
        });
      }
    }
  }

  // ── 국민연금 기준소득월액 구간 ────────────────────────────────
  const bi = {
    min: obs.facts["nationalPension.baseIncome.min"],
    max: obs.facts["nationalPension.baseIncome.max"],
    from: obs.facts["nationalPension.baseIncome.from"],
    to: obs.facts["nationalPension.baseIncome.to"],
  };
  if (bi.min && bi.max && bi.from && bi.to) {
    // ★금액(min/max)만 2출처 일치를 요구한다.★
    // 구간 시작·종료일은 고시의 '적용기간' 문언에서만 나오고(법제처 단일 출처),
    // 형태가 7-01 ~ 다음해 6-30 으로 구조적으로 고정돼 있어 교차검증 대상이 아니다.
    // 대신 그 형태를 여기서 강제하고, 어긋나면 사람에게 넘긴다.
    const shapeOk =
      typeof bi.from.value === "string" &&
      typeof bi.to.value === "string" &&
      bi.from.value.slice(5) === "07-01" &&
      bi.to.value.slice(5) === "06-30" &&
      Number(bi.to.value.slice(0, 4)) === Number(bi.from.value.slice(0, 4)) + 1;
    const agree = bi.min.agree && bi.max.agree && bi.min.independentSources >= 2 && bi.max.independentSources >= 2 && shapeOk;
    const brackets = get(candidate, "nationalPension.baseIncomeBrackets") || [];
    const idx = brackets.findIndex((b) => b.from === bi.from.value);
    const want = { from: bi.from.value, to: bi.to.value, min: bi.min.value, max: bi.max.value };
    if (idx >= 0) {
      if (!same(brackets[idx], want)) {
        const entry = { fact: "nationalPension.baseIncomeBrackets", path: `nationalPension.baseIncomeBrackets.${idx}`, from: brackets[idx], to: want };
        if (agree) {
          brackets[idx] = want;
          touchedSections.add("nationalPension");
          applied.push({ ...entry, sources: bi.min.observations.map((o) => o.sourceId) });
        } else {
          deferred.push({
            ...entry,
            reasons: [
              shapeOk
                ? `기준소득월액 상·하한의 출처가 불일치하거나 독립 출처가 부족합니다(하한 ${bi.min.independentSources}개, 상한 ${bi.max.independentSources}개).`
                : `적용기간 형태가 7-01 ~ 다음해 6-30 이 아닙니다: ${bi.from.value} ~ ${bi.to.value}.`,
            ],
            observations: bi.min.observations,
          });
        }
      } else {
        // 구간 내용은 원장과 같다. 그래도 출처가 다투면 알린다(위 conflicts 주석 참조).
        if (!agree) {
          conflicts.push({
            fact: "nationalPension.baseIncomeBrackets",
            path: `nationalPension.baseIncomeBrackets.${idx}`,
            value: want,
            disagreement: { min: bi.min.disagreement, max: bi.max.disagreement },
            observations: bi.min.observations,
            reason:
              `기준소득월액 구간은 원장과 같지만 출처가 불일치하거나 독립 출처가 부족합니다` +
              `(하한 ${bi.min.independentSources}개, 상한 ${bi.max.independentSources}개, 형태 정상=${shapeOk}).`,
          });
        }
        applied.push({ fact: "nationalPension.baseIncomeBrackets", path: `nationalPension.baseIncomeBrackets.${idx}`, from: want, to: want, unchanged: true, conflicted: !agree, sources: bi.min.observations.map((o) => o.sourceId) });
      }
    } else {
      // 새 구간 추가는 키 추가이므로 위생 검사에서 BLOCK 이 된다. 여기서도 사람에게 넘긴다.
      deferred.push({
        fact: "nationalPension.baseIncomeBrackets",
        path: "nationalPension.baseIncomeBrackets[+]",
        from: null,
        to: want,
        reasons: [
          `원장에 없는 새 구간입니다(${want.from} ~ ${want.to}). 구간 추가는 매년 7월 1일에 한 번 일어나며, ` +
            `연속성·커버리지에 직접 영향을 주므로 항상 사람이 확인합니다.`,
        ],
        observations: bi.min.observations,
      });
    }
  }

  // ── 출처 URL 갱신 ─────────────────────────────────────────────
  // 값이 실제로 바뀐 섹션만 갱신한다. 법제처 URL 에는 MST 가 들어 있어 모법 개정마다 바뀌므로,
  // 값이 그대로인데 URL 만 매번 흔들리면 무의미한 diff 가 매일 생긴다.
  for (const sec of touchedSections) {
    const factKey = Object.entries(FACT_MAP).find(([, m]) => m.section === sec);
    const f = factKey && obs.facts[factKey[0]];
    if (!f) continue;
    const primary = f.observations.find((o) => o.tier === "primary");
    const secondary = f.observations.find((o) => o.tier === "secondary");
    // ★DRF API 엔드포인트가 아니라 사람이 열어볼 수 있는 영구 링크(cite)를 넣는다.★
    // DRF URL 은 MST 가 박혀 있어 모법 개정마다 죽고, OC 파라미터까지 달고 있다.
    if (primary && candidate[sec] && "source" in candidate[sec]) candidate[sec].source = primary.cite || primary.url;
    // sourceAlt 는 이미 존재하는 섹션에만 채운다(키 추가는 BLOCK 을 유발한다).
    if (secondary && candidate[sec] && "sourceAlt" in candidate[sec]) candidate[sec].sourceAlt = secondary.cite || secondary.url;
  }

  // ── 완전성 검사 ───────────────────────────────────────────────
  // ★'확인했다'는 도장을 '확인이 깨졌다'는 사실 위에 찍지 않는다.★
  //
  // 적대적 검증에서 재현된 결함: observations 에서 minimumWage 두 팩트를 지우면
  // (수집 실패를 기록하지 않은 채) 판정이 "전 항목 통과 — 자동 반영 가능."으로 나오고
  // exit 0, lastVerified=오늘 이 원장에 찍혔다. 팩트가 0개여도 마찬가지였다.
  //
  // 피해 사슬: 값 변경이 없으면 워크플로가 PR 없이 lastVerified 를 main 에 직행시킨다
  // -> 신선도 게이트(45일 경고 / 400일 FATAL)가 리셋된다
  // -> 성공 조건부인 healthchecks 핑이 초록으로 나간다.
  // 즉 아무것도 검증하지 못한 실행이 침묵 감지 장치 3개를 전부 만족시킨다.
  //
  // 기존 코드는 '수집기가 예외를 던졌다'는 부수 신호(obs.failures)에 기대고 있었다.
  // 그건 '필드가 검증됐다'는 불변식이 아니다. 소프트 매치(`if (m)`)나 팩트 키 오타
  // 한 글자면 예외 없이 조용히 빠진다. 그래서 여기서 불변식으로 못박는다.
  const observedKeys = new Set(Object.keys(obs.facts || {}));
  const missing = Object.keys(FACT_MAP).filter((k) => !observedKeys.has(k));

  if (missing.length === 0) {
    // 전 필드가 실제로 재관측됐을 때만 하트비트를 찍는다.
    candidate.lastVerified = todayStr;
  }

  return {
    candidate, applied, deferred, reportOnly, conflicts, missing,
    lastVerifiedStamped: missing.length === 0,
    touchedSections: [...touchedSections],
  };
}

// ── 리포트 ──────────────────────────────────────────────────────
function buildReport(ctx) {
  const { year, obs, build, res, verdict, applyMode, ledgerPath, candidatePath } = ctx;
  const L = [];
  L.push(`# 요율 원장 자동 갱신 — ${year}년`);
  L.push("");
  L.push(`- 판정: **${verdict.label}** (종료 코드 ${verdict.code})`);
  L.push(`- 수집 시각: ${obs.fetchedAt}`);
  L.push(`- 원장: \`${path.relative(ROOT, ledgerPath)}\` / 후보: \`${path.relative(ROOT, candidatePath)}\``);
  L.push(`- 원장 반영: ${verdict.code === 0 && applyMode ? "완료" : "**하지 않음** (마지막 정상값 유지)"}`);
  L.push(`- 위생 검사: FATAL ${res.fatal.length} / BLOCK ${res.block.length} / WARN ${res.warn.length}`);
  L.push("");

  if (obs.failures.length) {
    L.push("## 수집 실패");
    L.push("");
    L.push("출처가 죽었거나 구조가 바뀌었습니다. 파싱 실패를 '값 없음' 으로 처리하지 않습니다.");
    L.push("");
    for (const f of obs.failures) L.push(`- **${f.step}** — ${f.error}`);
    L.push("");
  }

  const conflicts = build.conflicts || [];
  if (conflicts.length) {
    L.push("## ★출처 불일치 — 값은 그대로지만 검증이 깨졌습니다★");
    L.push("");
    L.push(
      "아래 항목은 원장 값이 1차 출처(법제처)와 일치해 원장을 건드리지 않았습니다. " +
        "그러나 2차 출처가 다른 값을 말하고 있어 **더 이상 '독립 출처 2개로 검증됨' 이라고 말할 수 없습니다.** " +
        "값이 틀린 게 아니라 검증이 틀린 상태라 그냥 두면 오래 안 들킵니다."
    );
    L.push("");
    for (const c of conflicts) {
      L.push(`### \`${c.path}\``);
      L.push("");
      L.push(`- 원장·1차 출처 값: ${JSON.stringify(c.value)}`);
      L.push(`- 사유: ${c.reason}`);
      for (const o of c.observations || []) L.push(`  - ${o.sourceId} (${o.tier}): \`${o.value}\` — ${o.url}`);
      L.push("");
    }
  }

  const changed = build.applied.filter((a) => !a.unchanged);
  L.push("## 자동 반영 (독립 출처 2개 이상 일치)");
  L.push("");
  if (changed.length === 0) {
    const conflicted = build.applied.filter((a) => a.conflicted).length;
    L.push(
      `값 변경 없음. 확인만 완료했습니다(재확인 항목 ${build.applied.length}개` +
        (conflicted ? `, 그중 ${conflicted}개는 ★출처 불일치★ 상태입니다` : "") +
        `).`
    );
  } else {
    L.push("| 경로 | 이전 | 이후 | 출처 |");
    L.push("|---|---|---|---|");
    for (const a of changed) L.push(`| \`${a.path}\` | ${JSON.stringify(a.from)} | ${JSON.stringify(a.to)} | ${(a.sources || []).join(", ")} |`);
  }
  L.push("");

  if (build.deferred.length) {
    L.push("## ★사람 확인 필요★ (반영하지 않음)");
    L.push("");
    for (const d of build.deferred) {
      L.push(`### \`${d.path}\``);
      L.push("");
      L.push(`- 현재: ${JSON.stringify(d.from)}`);
      L.push(`- 관측: ${JSON.stringify(d.to)}`);
      for (const r of d.reasons) L.push(`- 사유: ${r}`);
      for (const o of d.observations || []) L.push(`  - ${o.sourceId} (${o.tier}): \`${o.value}\` — ${o.url}`);
      L.push("");
    }
  }

  if (build.reportOnly.length) {
    L.push("## 참고 (원장 미반영 항목)");
    L.push("");
    for (const r of build.reportOnly) {
      L.push(`- \`${r.fact}\` = ${JSON.stringify(r.value)} — ${r.reason}`);
      for (const o of r.observations || []) L.push(`  - ${o.sourceId}: ${o.url}`);
    }
    L.push("");
  }

  if (obs.notes.length) {
    L.push("## 수집 메모");
    L.push("");
    for (const n of obs.notes) L.push(`- ${n}`);
    L.push("");
  }

  L.push("---");
  L.push("");
  L.push(sanity.formatReport(res, "위생 검사 상세"));
  return L.join("\n");
}

// ── main ────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { year: null, observations: null, apply: false, report: null, summary: null, today: null, ledger: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--year") a.year = Number(argv[++i]);
    else if (k === "--observations") a.observations = argv[++i];
    else if (k === "--report") a.report = argv[++i];
    else if (k === "--summary") a.summary = argv[++i];
    else if (k === "--today") a.today = argv[++i];
    else if (k === "--ledger") a.ledger = argv[++i];
    else if (k === "--apply") a.apply = true;
    else throw new Error(`알 수 없는 인자: ${k}`);
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv);
  const today = args.today || kstToday();
  const year = args.year || Number(today.slice(0, 4));

  const ledgerPath = args.ledger ? path.resolve(args.ledger) : path.join(ROOT, "data", `rates-${year}.json`);
  if (!fs.existsSync(ledgerPath)) {
    fail(2, `원장이 없습니다: ${ledgerPath}. 새 연도 원장은 사람이 만들어야 합니다.`);
  }
  const currentText = fs.readFileSync(ledgerPath, "utf8");
  const current = JSON.parse(currentText);
  const rules = JSON.parse(fs.readFileSync(sanity.DEFAULT_RULES, "utf8"));

  let taxTable = null;
  try {
    taxTable = JSON.parse(fs.readFileSync(path.join(ROOT, "data", `simplified-tax-table-${year}.json`), "utf8"));
  } catch {
    /* 없으면 회귀 검사만 생략된다 */
  }

  // ── 관측 확보 ────────────────────────────────────────────────
  let obs;
  if (args.observations) {
    obs = JSON.parse(fs.readFileSync(path.resolve(args.observations), "utf8"));
  } else {
    const { collect } = require(path.join(__dirname, "fetch-rates.js"));
    obs = await collect(year);
  }
  if (obs.targetYear !== year) {
    fail(2, `관측 파일의 대상 연도(${obs.targetYear})가 요청 연도(${year})와 다릅니다.`);
  }

  const candidateDir = path.join(ROOT, "data", "candidates");
  fs.mkdirSync(candidateDir, { recursive: true });
  const candidatePath = path.join(candidateDir, `rates-${year}.candidate.json`);

  // ── 후보 생성 + 위생 검사 ────────────────────────────────────
  const build = buildCandidate(current, obs, today);
  const res = sanity.validate({ candidate: build.candidate, current, rules, taxTable, today });

  // ── 판정 ─────────────────────────────────────────────────────
  const hardFail = res.fatal.length > 0;
  // ★build.conflicts★ — 값은 안 바뀌었지만 출처가 다투는 항목도 사람을 부른다.
  // 이걸 빼면 '전 항목 통과' 라고 찍히면서 교차검증이 무너진 걸 아무도 모른다.
  const needsHuman =
    res.block.length > 0 || build.deferred.length > 0 || obs.failures.length > 0 ||
    build.conflicts.length > 0 ||
    // ★관측 누락은 '이상 없음'이 아니라 '확인 못 함'이다.★ 반드시 사람을 부른다.
    build.missing.length > 0;

  let verdict;
  if (hardFail) verdict = { code: 2, label: "FATAL — 후보 폐기. 원장을 건드리지 않습니다." };
  else if (needsHuman) verdict = { code: 1, label: "사람 확인 필요 — 자동 병합 금지." };
  else verdict = { code: 0, label: "전 항목 통과 — 자동 반영 가능." };
  if (build.missing.length > 0) {
    verdict.label = `관측 누락 ${build.missing.length}건 — 검증되지 않았습니다. 자동 병합 금지.`;
    verdict.missing = build.missing;
  }

  // 원장 서식을 보존한 후보 텍스트. 새 키 추가 등으로 국소 수정이 불가능하면
  // 후보 파일에 한해 전체 직렬화로 폴백한다(후보는 gitignore 대상이라 서식이 덜 중요하다).
  let candidateText;
  let renderError = null;
  try {
    candidateText = renderLedger(currentText, build.candidate, res.diff.changed || []);
  } catch (e) {
    renderError = e.message;
    candidateText = JSON.stringify(build.candidate, null, 2) + "\n";
  }

  // 후보 파일은 항상 남긴다(무엇이 왜 막혔는지 보려면 후보가 있어야 한다).
  // ★단 FATAL 이면 후보를 원장 옆에 두지 않고 .rejected 로 이름을 바꿔 실수 병합을 막는다.★
  const outPath = hardFail ? candidatePath.replace(/\.json$/, ".rejected.json") : candidatePath;
  writeAtomic(outPath, candidateText);
  if (hardFail && fs.existsSync(candidatePath)) fs.unlinkSync(candidatePath);

  const report = buildReport({ year, obs, build, res, verdict, applyMode: args.apply, ledgerPath, candidatePath: outPath });
  if (args.report) writeAtomic(path.resolve(args.report), report + "\n");

  const summary = {
    schema: "salarynote/update-summary@1",
    year,
    today,
    verdict: verdict.code,
    verdictLabel: verdict.label,
    applied: build.applied.filter((a) => !a.unchanged),
    verifiedUnchanged: build.applied.filter((a) => a.unchanged && !a.conflicted).map((a) => a.path),
    sourceConflicts: build.conflicts,
    deferred: build.deferred,
    reportOnly: build.reportOnly,
    fetchFailures: obs.failures,
    fatal: res.fatal,
    block: res.block,
    warn: res.warn,
    regression: res.regression,
    ledgerWritten: false,
    candidatePath: path.relative(ROOT, outPath),
  };

  // ── 원장 반영 ────────────────────────────────────────────────
  if (verdict.code === 0 && args.apply) {
    if (renderError) {
      // 국소 수정이 불가능하면 원장을 쓰지 않는다. 서식을 뒤엎는 전체 재작성은
      // 사람 검토를 무력화하므로, 자동 반영보다 멈추는 쪽을 택한다.
      process.stderr.write(`\n[update-rates] 원장을 쓰지 않습니다 — ${renderError}\n`);
      summary.ledgerWritten = false;
      summary.renderError = renderError;
      if (args.summary) writeAtomic(path.resolve(args.summary), JSON.stringify(summary, null, 2) + "\n");
      process.stdout.write(report + "\n");
      process.exit(1);
    }
    const changed = build.applied.filter((a) => !a.unchanged).length;
    writeAtomic(ledgerPath, candidateText);
    summary.ledgerWritten = true;
    summary.ledgerChangedFields = changed;
    process.stderr.write(`\n[update-rates] 원장 갱신: ${path.relative(ROOT, ledgerPath)} (값 변경 ${changed}건, lastVerified=${today})\n`);
  }

  if (args.summary) writeAtomic(path.resolve(args.summary), JSON.stringify(summary, null, 2) + "\n");
  process.stdout.write(report + "\n");

  if (verdict.code !== 0) {
    process.stderr.write(`\n[update-rates] ★막혔습니다★ ${verdict.label}\n`);
    for (const i of res.fatal) process.stderr.write(`  FATAL ${i.path} [${i.code}] ${i.message}\n`);
    for (const i of res.block) process.stderr.write(`  BLOCK ${i.path} [${i.code}] ${i.message}\n`);
    for (const c of build.conflicts) process.stderr.write(`  출처불일치 ${c.path}: ${JSON.stringify(c.disagreement)}\n`);
    for (const d of build.deferred) process.stderr.write(`  보류 ${d.path}: ${d.reasons.join(" / ")}\n`);
    for (const f of obs.failures) process.stderr.write(`  수집실패 ${f.step}: ${f.error}\n`);
    process.stderr.write(`  원장은 변경되지 않았습니다. 사이트는 마지막 정상값으로 계속 동작합니다.\n`);
  }
  process.exit(verdict.code);
}

function fail(code, msg) {
  process.stderr.write(`[update-rates] ${msg}\n`);
  process.exit(code);
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`\n[update-rates] 치명적 오류: ${e && e.stack ? e.stack : e}\n원장은 변경되지 않았습니다.\n`);
    process.exit(2);
  });
}

module.exports = { buildCandidate, buildReport, FACT_MAP };
