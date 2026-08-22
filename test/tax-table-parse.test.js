/**
 * 간이세액표 파서 검증.
 *
 * 이 646행 표에서 소득세 전부가 나온다. 사이트에서 가장 큰 데이터이자
 * 사람이 눈으로 확인할 수 없는 양이다.
 *
 * ★이 테스트의 핵심은 '파서가 되는가' 가 아니라 '파서가 조용히 실패하지
 *   않는가' 다.★ 실제로 pdftotext -layout 으로 뽑았을 때 646행 중 620행만
 *   나오고 26행이 통째로 사라졌는데, 첫 행과 마지막 행은 정확히 일치했고
 *   파일도 멀쩡해 보였다. 행 수를 세거나 앞뒤만 비교하는 검사로는 못 잡는다.
 *   그래서 손상된 입력을 일부러 만들어 파서가 터지는지 확인한다.
 *
 * 네트워크를 쓰지 않는다. 커밋된 픽스처(법제처 별표2 PDF 의 -raw 추출본)로
 * 검사하므로 CI 가 출처 장애에 흔들리지 않는다. 원문과의 대조는
 * rates-watch 워크플로가 --fetch --check 로 매일 수행한다.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TOOL = path.join(ROOT, "tools", "parse-tax-table.js");
const FIXTURE = path.join(__dirname, "fixtures", "byl2-2026-raw.txt");

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); console.log(`  PASS  ${n}`); pass++; } catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; } };

/** 파서를 텍스트 입력으로 돌린다. { code, out, err } 를 돌려준다. */
function run(txt, extraArgs = []) {
  const tmp = path.join(require("os").tmpdir(), `byl2-test-${process.pid}-${Math.abs(txt.length)}.txt`);
  fs.writeFileSync(tmp, txt, "utf8");
  try {
    const out = execFileSync(process.execPath, [TOOL, "--txt", tmp, ...extraArgs],
      { cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return { code: 0, out, err: "" };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: e.stdout || "", err: e.stderr || "" };
  } finally {
    fs.unlinkSync(tmp);
  }
}

const fixture = fs.readFileSync(FIXTURE, "utf8");
const ledger = JSON.parse(fs.readFileSync(
  path.join(ROOT, "data", "simplified-tax-table-2026.json"), "utf8"));

console.log("\n[간이세액표 파서]\n");

t("픽스처가 커밋돼 있다", () => {
  assert.ok(fs.existsSync(FIXTURE), "test/fixtures/byl2-2026-raw.txt 가 없다");
  assert.ok(fixture.length > 20000, `픽스처가 너무 작다: ${fixture.length}바이트`);
});

t("★원문에서 646행을 그대로 재현한다★", () => {
  const r = run(fixture);
  assert.strictEqual(r.code, 0, `파서 실패:\n${r.err}`);
  const parsed = JSON.parse(r.out);
  assert.strictEqual(parsed.rowCount, ledger.rows.length, "행 수 불일치");
  for (let i = 0; i < ledger.rows.length; i++) {
    assert.strictEqual(JSON.stringify(parsed.rows[i]), JSON.stringify(ledger.rows[i]),
      `#${i} 불일치`);
  }
});

t("별표2 자체의 개정일을 뽑는다 (시행령 공포일이 아니라)", () => {
  // 검색 API 는 시행령 전체의 최신 개정일(2026-05-22)을 준다. 별표2 는 2026-02-27 이다.
  // 전자를 쓰면 표가 그대로인데도 매번 '개정됨' 으로 잘못 감지한다.
  const parsed = JSON.parse(run(fixture).out);
  assert.strictEqual(parsed.revision, ledger.source.promulgated);
});

t("--check 가 현역 원장과 대조한다", () => {
  const r = run(fixture, ["--check"]);
  assert.strictEqual(r.code, 0, `대조 실패:\n${r.err}`);
});

/* ── 여기부터가 진짜 목적: 조용한 실패를 막는가 ─────────────── */

/** 표 본문 행만 골라 인덱스를 돌려준다. */
function rowLineIndexes(lines) {
  const idx = [];
  lines.forEach((l, i) => {
    const p = l.trim().split(/\s+/);
    if (p.length === 13 && p.every((x) => /^-$|^[\d,]+$/.test(x))) {
      const a = Number(p[0].replace(/,/g, "")), b = Number(p[1].replace(/,/g, ""));
      if (a < b) idx.push(i);
    }
  });
  return idx;
}

t("★행이 하나라도 빠지면 터진다★", () => {
  // -layout 으로 26행이 사라졌던 사고의 회귀 테스트. 구간 연속성 검사가 유일한 방어선이다.
  const lines = fixture.split("\n");
  const idx = rowLineIndexes(lines);
  assert.ok(idx.length > 300, "픽스처에서 행을 찾지 못했다");
  const cut = idx[Math.floor(idx.length / 2)];
  const broken = lines.filter((_, i) => i !== cut).join("\n");

  const r = run(broken);
  assert.notStrictEqual(r.code, 0, "행이 빠졌는데 파서가 성공했다");
  assert.ok(/구간이 끊겼습니다/.test(r.err), `기대한 오류가 아니다:\n${r.err}`);
});

t("★연속된 여러 행이 빠져도 터진다★", () => {
  // 페이지 경계에서는 한 행이 아니라 수십 행이 통째로 사라진다.
  const lines = fixture.split("\n");
  const idx = new Set(rowLineIndexes(lines).slice(200, 226));   // 26행
  const broken = lines.filter((_, i) => !idx.has(i)).join("\n");

  const r = run(broken);
  assert.notStrictEqual(r.code, 0, "26행이 빠졌는데 파서가 성공했다");
  assert.ok(/구간이 끊겼습니다/.test(r.err), `기대한 오류가 아니다:\n${r.err}`);
});

t("세액이 거꾸로면 터진다 (가족 수가 늘면 세액은 줄어야 한다)", () => {
  const lines = fixture.split("\n");
  const i = rowLineIndexes(lines)[300];
  const p = lines[i].trim().split(/\s+/);
  [p[2], p[3]] = [p[3], p[2]];               // 1명과 2명 세액을 맞바꾼다
  lines[i] = p.join(" ");
  const r = run(lines.join("\n"));
  assert.notStrictEqual(r.code, 0, "역전된 세액을 통과시켰다");
  assert.ok(/세액이 큽니다|세액이 줄었습니다/.test(r.err), `기대한 오류가 아니다:\n${r.err}`);
});

t("표가 통째로 없으면 터진다", () => {
  const r = run("의미 없는 텍스트\n1 2 3\n");
  assert.notStrictEqual(r.code, 0, "빈 표를 통과시켰다");
  assert.ok(/500개 이상 기대/.test(r.err), `기대한 오류가 아니다:\n${r.err}`);
});

t("불변식은 통과하지만 원장과 다르면 --check 가 잡는다", () => {
  // ★변조 값을 아무렇게나 고르면 안 된다.★ 큰 값을 넣으면 단조성 불변식에서
  // 먼저 걸려 --check 까지 가지도 못한다(실제로 그랬다). 여기서 보려는 것은
  // '모든 불변식을 통과하는 그럴듯한 변조' 를 원장 대조가 잡아내는지다.
  // 마지막 행 마지막 열을 아주 조금만 올린다. 같은 행 앞 열보다 작고,
  // 앞 행 같은 열보다 크므로 두 단조성 모두 유지된다.
  const lines = fixture.split("\n");
  const idx = rowLineIndexes(lines);
  const i = idx[idx.length - 1];
  const p = lines[i].trim().split(/\s+/);
  const cur = Number(p[12].replace(/,/g, ""));
  const ceil = Number(p[11].replace(/,/g, ""));
  assert.ok(cur + 10 < ceil, "변조 여유가 없다 — 픽스처 구조를 확인하라");
  p[12] = (cur + 10).toLocaleString("en-US");
  lines[i] = p.join(" ");

  const r = run(lines.join("\n"), ["--check"]);
  assert.notStrictEqual(r.code, 0, "변조된 표를 원장과 같다고 판정했다");
  assert.ok(/원문과 다릅니다/.test(r.err), `기대한 오류가 아니다:\n${r.err}`);
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
