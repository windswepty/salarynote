/**
 * 근로소득 간이세액표(소득세법 시행령 [별표 2]) 646행을 원문 PDF 에서 뽑는다.
 *
 *   node tools/parse-tax-table.js --fetch                     법제처에서 받아 파싱
 *   node tools/parse-tax-table.js --pdf <파일>                 로컬 PDF 파싱
 *   node tools/parse-tax-table.js --txt <파일>                 추출된 텍스트 파싱
 *   node tools/parse-tax-table.js --fetch --check              현역 원장과 대조 (CI 용)
 *   node tools/parse-tax-table.js --fetch --out <파일>          rows 를 JSON 으로 저장
 *
 * ★왜 이 파일이 필요한가★
 * 이 646행 표는 사이트에서 가장 큰 데이터이고 소득세 전부가 여기서 나온다.
 * 그런데 지금까지 이 표를 어떻게 만들었는지가 저장소에 남아 있지 않았다.
 * 임시 스크립트로 한 번 만들고 버렸기 때문에, 매년 2월말 개정될 때마다 사람이
 * 처음부터 다시 해야 했다. 재현 불가능한 데이터는 자동화의 벽이다.
 *
 * ★-layout 을 쓰면 안 된다★
 * pdftotext -layout 은 페이지 경계에서 행을 흘린다. 실측: 646행 중 620행만
 * 나오고 2,550천원과 2,810천원 사이 26행이 통째로 사라졌다. 그런데도 파일은
 * 멀쩡해 보이고 첫 행과 마지막 행은 정확히 일치한다. 행 수만 세거나 앞뒤만
 * 비교하면 절대 못 잡는다. -raw 는 646행 전부를 정확히 준다.
 * 그래서 아래 불변식에 ★구간 연속성★ 검사를 넣었다. 한 행이라도 빠지면
 * 앞 행의 to 와 다음 행의 from 이 어긋나므로 반드시 걸린다.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const { get } = require(path.join(ROOT, "tools", "lib", "net.js"));
const { resolve } = require(path.join(ROOT, "tools", "lib", "resolve-ledger.js"));

const LAW = "https://www.law.go.kr";
const BYL_NAME = "근로소득 간이세액표";

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const has = (name) => process.argv.includes(name);

/* ── 원문 확보 ──────────────────────────────────────────────── */

/** 법제처 별표 검색으로 별표2 의 PDF 링크와 공포일자를 찾는다. */
async function locate() {
  const url = `${LAW}/DRF/lawSearch.do?OC=test&type=JSON&target=licbyl` +
    `&query=${encodeURIComponent(BYL_NAME)}&display=5`;
  const res = JSON.parse(await get(url, { as: "text" }));
  const s = res.licBylSearch;
  if (!s) throw new Error(`별표 검색 응답 형식이 다릅니다 — ${url}`);

  const list = Array.isArray(s.licbyl) ? s.licbyl : s.licbyl ? [s.licbyl] : [];
  // 이름이 비슷한 별표가 여럿이다(연금소득·종교인소득 간이세액표). 반드시 좁힌다.
  const hit = list.filter((b) =>
    b.관련법령명 === "소득세법 시행령" && String(b.별표번호) === "000200");
  if (hit.length !== 1) {
    throw new Error(
      `별표2 를 특정하지 못했습니다(후보 ${hit.length}개). ` +
      `법제처 별표 목록 구조가 바뀌었을 수 있습니다. 후보: ` +
      JSON.stringify(list.map((b) => `${b.관련법령명}/${b.별표번호}/${b.별표명}`)));
  }
  const b = hit[0];
  if (!b.별표서식PDF파일링크) throw new Error("별표2 의 PDF 링크가 없습니다.");
  return {
    name: b.별표명,
    promulgated: b.공포일자,          // YYYYMMDD
    decreeNo: b.공포번호,
    pdfUrl: LAW + b.별표서식PDF파일링크,
  };
}

/** PDF → 텍스트. -raw 여야 한다. 이유는 파일 상단 주석 참조. */
function pdfToText(pdfPath) {
  const out = path.join(os.tmpdir(), `byl2-${process.pid}.txt`);
  try {
    execFileSync("pdftotext", ["-raw", pdfPath, out], { stdio: "pipe" });
  } catch (e) {
    throw new Error(
      "pdftotext 실행에 실패했습니다. poppler-utils 가 필요합니다.\n" +
      "  Ubuntu: sudo apt-get install -y poppler-utils\n" +
      `  원본 오류: ${e.message}`);
  }
  const txt = fs.readFileSync(out, "utf8");
  fs.unlinkSync(out);
  return txt;
}

/* ── 파싱 ───────────────────────────────────────────────────── */

const toNum = (s) => (s === "-" ? 0 : Number(s.replace(/,/g, "")));

/**
 * 별표2 자체의 개정일자를 PDF 첫머리에서 뽑는다.  "[별표 2] <개정 2026. 2. 27.>"
 *
 * ★검색 API 의 공포일자를 쓰면 안 된다.★ 그것은 시행령 전체의 최신 개정일이라
 * 별표2 와 무관한 조문이 고쳐져도 바뀐다. 실측: API 는 20260522(대통령령
 * 제36343호)를 주는데 별표2 의 실제 개정일은 2026-02-27 이다. 전자를 쓰면
 * 표가 그대로인데도 매번 '개정됨' 으로 잘못 감지한다.
 *
 * 한글은 폰트 문제로 추출에서 빠지므로 날짜 숫자만 남는다. 그래서 '개정' 이라는
 * 글자를 찾지 않고 꺾쇠 안의 날짜 형태를 찾는다.
 */
function parseRevision(txt) {
  const m = txt.match(/<\s*(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?\s*>/);
  if (!m) return null;
  const p = (x) => String(x).padStart(2, "0");
  return `${m[1]}-${p(m[2])}-${p(m[3])}`;
}

/**
 * 표 본문을 뽑는다. 한 행은 '구간 시작, 구간 끝, 가족수 1~11명' 13개 값이다.
 * PDF 에는 비고·산식 등 다른 숫자 나열도 있으므로 형태만으로 거르지 않고
 * from < to 조건까지 본다.
 */
function parseRows(txt) {
  const rows = [];
  for (const raw of txt.split("\n")) {
    const parts = raw.trim().split(/\s+/);
    if (parts.length !== 13) continue;
    if (!parts.every((p) => /^-$|^[\d,]+$/.test(p))) continue;
    const v = parts.map(toNum);
    if (!(v[0] < v[1])) continue;
    rows.push(v);
  }
  return rows;
}

/**
 * ★불변식★ 하나라도 깨지면 값을 만들지 않고 던진다.
 * 파싱이 조용히 일부만 성공하는 것이 이 데이터에서 가장 위험하다.
 */
function assertValid(rows) {
  const fail = (m) => { throw new Error(`간이세액표 파싱 불변식 위반: ${m}`); };

  if (rows.length < 500) fail(`행이 ${rows.length}개뿐입니다(500개 이상 기대). 추출이 실패했습니다.`);

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.length !== 13) fail(`#${i} 열이 ${r.length}개입니다(13 기대).`);
    if (!(r[0] < r[1])) fail(`#${i} 구간이 뒤집혔습니다: ${r[0]} ~ ${r[1]}`);
    if (r.some((x) => !Number.isFinite(x) || x < 0)) fail(`#${i} 에 음수나 비수치가 있습니다: ${JSON.stringify(r)}`);

    // ★행이 빠졌는지 잡는 유일한 장치.★ -layout 으로 26행이 사라진 적이 있다.
    if (i > 0 && r[0] !== rows[i - 1][1]) {
      fail(`구간이 끊겼습니다: ${rows[i - 1][1]}천원 다음이 ${r[0]}천원입니다. ` +
        `사이의 행이 누락됐습니다(페이지 경계에서 흔히 발생).`);
    }

    // 가족 수가 늘면 세액은 줄거나 같아야 한다.
    for (let c = 3; c < 13; c++) {
      if (r[c] > r[c - 1]) {
        fail(`#${i}(${r[0]}천원) 가족 ${c - 1}명보다 ${c}명의 세액이 큽니다: ` +
          `${r[c - 1]} → ${r[c]}`);
      }
    }
  }

  // 소득이 오르면 세액은 줄지 않아야 한다(같은 가족 수 기준).
  for (let c = 2; c < 13; c++) {
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][c] < rows[i - 1][c]) {
        fail(`가족 ${c - 1}명 열에서 소득이 올랐는데 세액이 줄었습니다: ` +
          `${rows[i - 1][0]}천원 ${rows[i - 1][c]} → ${rows[i][0]}천원 ${rows[i][c]}`);
      }
    }
  }
  return rows;
}

/* ── 실행 ───────────────────────────────────────────────────── */

(async () => {
  let txt, meta = null;

  if (has("--txt")) {
    txt = fs.readFileSync(argOf("--txt"), "utf8");
  } else if (has("--pdf")) {
    txt = pdfToText(argOf("--pdf"));
  } else if (has("--fetch")) {
    meta = await locate();
    console.error(`별표: ${meta.name}`);
    console.error(`공포: ${meta.promulgated} · 대통령령 제${meta.decreeNo}호`);
    const buf = await get(meta.pdfUrl, { as: "buffer", timeoutMs: 120000 });
    if (buf.slice(0, 4).toString() !== "%PDF") {
      throw new Error(`PDF 가 아닌 응답을 받았습니다(${buf.length} bytes). 링크가 바뀌었을 수 있습니다.`);
    }
    const tmp = path.join(os.tmpdir(), `byl2-${process.pid}.pdf`);
    fs.writeFileSync(tmp, buf);
    txt = pdfToText(tmp);
    fs.unlinkSync(tmp);
  } else {
    console.error("사용법: --fetch | --pdf <파일> | --txt <파일>  [--check] [--out <파일>]");
    process.exit(2);
  }

  const rows = assertValid(parseRows(txt));
  const revision = parseRevision(txt);
  console.error(`파싱 ${rows.length}행 · 구간 ${rows[0][0]}천원 ~ ${rows[rows.length - 1][1]}천원`);
  console.error(`별표2 개정일: ${revision || "(추출 실패)"}`);

  if (has("--check")) {
    const L = resolve();
    if (!L.taxTableExists) {
      console.error(`대조할 원장이 없습니다: ${L.taxTablePath}`);
      process.exit(1);
    }
    const led = JSON.parse(fs.readFileSync(L.taxTablePath, "utf8"));
    const diffs = [];
    if (rows.length !== led.rows.length) {
      diffs.push(`행 수: 원문 ${rows.length} ≠ 원장 ${led.rows.length}`);
    }
    const n = Math.min(rows.length, led.rows.length);
    for (let i = 0; i < n; i++) {
      const a = JSON.stringify(rows[i]), b = JSON.stringify(led.rows[i]);
      if (a !== b) diffs.push(`#${i} 원문 ${a} ≠ 원장 ${b}`);
    }
    if (diffs.length) {
      console.error(`\n★간이세액표가 원문과 다릅니다 (${diffs.length}건)★`);
      for (const d of diffs.slice(0, 10)) console.error("  " + d);
      if (diffs.length > 10) console.error(`  ... 외 ${diffs.length - 10}건`);
      console.error("\n별표2 가 개정됐거나 원장이 손상됐습니다. 사람이 확인해야 합니다.");
      process.exit(1);
    }
    // 값이 같아도 개정일이 다르면 다음 개정 때 감지가 어긋난다. 함께 본다.
    if (revision && led.source && led.source.promulgated && revision !== led.source.promulgated) {
      console.error(`
★개정일 불일치★ 원문 ${revision} ≠ 원장 ${led.source.promulgated}`);
      console.error("표의 숫자는 같지만 개정일이 다릅니다. 원장의 source.promulgated 를 확인하십시오.");
      process.exit(1);
    }
    console.error(`원장과 일치: ${L.year}년 ${rows.length}행 · 개정일 ${revision}`);
  }

  if (has("--out")) {
    fs.writeFileSync(argOf("--out"),
      JSON.stringify({ rowCount: rows.length, revision, rows, source: meta }, null, 1) + "\n", "utf8");
    console.error(`저장: ${argOf("--out")}`);
  } else if (!has("--check")) {
    process.stdout.write(JSON.stringify({ rowCount: rows.length, revision, rows }, null, 1) + "\n");
  }
})().catch((e) => {
  console.error("::error::" + e.message);
  process.exit(1);
});
