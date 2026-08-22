/**
 * 연봉 실수령액표 검증.
 *
 * 이 표에는 숫자가 300개 넘게 들어간다. 사람이 눈으로 확인할 수 없는 양이고,
 * 검색으로 들어온 사람이 계산기를 거치지 않고 표만 보고 돌아갈 수도 있다.
 * 표가 틀리면 사이트에서 가장 많이 읽히는 숫자가 틀린 것이 된다.
 *
 * 그래서 화면에 적힌 값을 다시 파싱해 엔진 결과와 한 칸씩 대조한다.
 * '생성했으니 맞겠지' 가 아니라 '지금 배포된 HTML 이 맞는가' 를 본다.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "web");
const PAGE = path.join(WEB, "salary-table", "index.html");

const { resolve } = require(path.join(ROOT, "tools", "lib", "resolve-ledger.js"));
const L = resolve();
const rates = JSON.parse(fs.readFileSync(L.ledgerPath, "utf8"));
const taxTable = JSON.parse(fs.readFileSync(
  path.join(ROOT, "data", `simplified-tax-table-${L.year}.json`), "utf8"));
const { calcNetPay } = require(path.join(ROOT, "src", "engine", "net-pay.js"));

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); console.log(`  PASS  ${n}`); pass++; } catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; } };

const html = fs.readFileSync(PAGE, "utf8");
const num = (s) => Number(String(s).replace(/,/g, ""));

/** 화면에 렌더된 행을 그대로 읽어 온다. */
function parsed() {
  const body = html.split("<tbody>")[1].split("</tbody>")[0];
  const rows = [];
  for (const line of body.split("\n")) {
    const m = line.match(
      /href="\/\?v=(\d+)[^"]*">([^<]+)<\/a><\/th><td class="num">([\d,]+)<\/td><td class="num"><b>([\d,]+)<\/b><\/td><td class="num drop">([\d,]+)<\/td><td class="num">([\d.]+)%<\/td>/);
    if (m) rows.push({
      annual: Number(m[1]), label: m[2],
      gross: num(m[3]), net: num(m[4]), deduction: num(m[5]), rate: Number(m[6]),
    });
  }
  return rows;
}

const rows = parsed();

// 파서가 표를 못 읽으면 이후 검사가 빈 배열을 돌며 전부 '통과' 한다.
// 실제로 링크 형식을 바꿨을 때 그렇게 됐다. 여기서 먼저 끊는다.
if (rows.length === 0) {
  console.error("  표를 한 행도 읽지 못했습니다. 파서가 HTML 형식과 어긋납니다.");
  process.exit(1);
}

/** 표의 전제. 계산기 HTML 의 기본값에서 직접 읽는다 — 둘이 어긋나면 안 되므로. */
const ASSUMED = (() => {
  const calc = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  const grab = (id) => {
    const m = calc.match(new RegExp(`id="${id}"[^>]*value="([^"]+)"`));
    if (!m) throw new Error(`계산기에서 ${id} 기본값을 못 찾았다`);
    return Number(m[1].replace(/,/g, ""));
  };
  return { dependents: grab("dep"), nonTaxable: grab("nt") };
})();
const payDate = rates.nationalPension.baseIncomeBrackets
  .reduce((a, b) => (a.from > b.from ? a : b)).from;

console.log("\n[연봉 실수령액표]\n");

t("표가 2,000만원부터 1억까지 100만원 단위로 있다", () => {
  assert.strictEqual(rows.length, 81, `행 수 ${rows.length}`);
  assert.strictEqual(rows[0].annual, 20_000_000);
  assert.strictEqual(rows[rows.length - 1].annual, 100_000_000);
  for (let i = 1; i < rows.length; i++)
    assert.strictEqual(rows[i].annual - rows[i - 1].annual, 1_000_000, `${i}번째 간격`);
});

t("★모든 행이 엔진 결과와 한 원도 다르지 않다★", () => {
  const bad = [];
  for (const r of rows) {
    const e = calcNetPay(
      { annualSalary: r.annual, ...ASSUMED, payDate }, rates, taxTable);
    if (e.netPay !== r.net) bad.push(`연봉 ${r.annual}: 표 ${r.net} ≠ 엔진 ${e.netPay}`);
    if (e.totalDeduction !== r.deduction)
      bad.push(`연봉 ${r.annual} 공제: 표 ${r.deduction} ≠ 엔진 ${e.totalDeduction}`);
  }
  assert.strictEqual(bad.length, 0, bad.slice(0, 5).join("\n        "));
});

t("실수령액 + 공제액 = 월 세전", () => {
  for (const r of rows)
    assert.strictEqual(r.net + r.deduction, r.gross,
      `연봉 ${r.annual}: ${r.net} + ${r.deduction} ≠ ${r.gross}`);
});

t("월 세전 열이 연봉을 12로 나눈 값이다", () => {
  // '월급 400 실수령액' 검색이 이 열을 보고 들어온다. 어긋나면 안 된다.
  for (const r of rows) {
    const e = calcNetPay({ annualSalary: r.annual, ...ASSUMED, payDate }, rates, taxTable);
    assert.strictEqual(r.gross, e.gross, `연봉 ${r.annual} 월 세전`);
  }
});

t("실수령률 표기가 실제 비율과 맞는다", () => {
  for (const r of rows) {
    const want = (r.net / r.gross) * 100;
    assert.ok(Math.abs(want - r.rate) < 0.06,
      `연봉 ${r.annual}: 표 ${r.rate}% ≠ 실제 ${want.toFixed(2)}%`);
  }
});

t("연봉이 오르면 실수령액도 오른다 (역전 없음)", () => {
  for (let i = 1; i < rows.length; i++)
    assert.ok(rows[i].net > rows[i - 1].net,
      `연봉 ${rows[i].annual} 에서 역전: ${rows[i - 1].net} → ${rows[i].net}`);
});

t("실수령률은 누진 때문에 내려간다", () => {
  // 소득세가 누진이므로 전체 추세는 하락이어야 한다. 국민연금 상한 때문에
  // 고연봉 구간에서 잠깐 반등할 수 있으므로 양 끝만 비교한다.
  assert.ok(rows[0].rate > rows[rows.length - 1].rate + 5,
    `${rows[0].rate}% → ${rows[rows.length - 1].rate}%`);
});

t("표의 전제가 화면에 적혀 있다", () => {
  // 부양가족·비과세를 밝히지 않으면 '내 월급과 다르다' 는 오해만 남는다.
  for (const need of ["부양가족", "비과세", "1명", "20만원"])
    assert.ok(html.includes(need), `전제 안내에 '${need}' 가 없다`);
});

t("★표와 계산기가 같은 전제를 쓴다★", () => {
  // 표를 비과세 0원으로 만들었더니 5,000만원 행에서 계산기와 48,810원이
  // 어긋났다. 같은 사이트의 두 숫자가 다르면 어느 쪽도 못 믿게 된다.
  const gen = fs.readFileSync(path.join(ROOT, "build", "salary-table.js"), "utf8");
  const num = (re) => Number((gen.match(re) || [])[1].replace(/_/g, ""));
  assert.strictEqual(num(/const DEPENDENTS = ([\d_]+)/), ASSUMED.dependents,
    "생성기의 부양가족 전제가 계산기 기본값과 다르다");
  assert.strictEqual(num(/const NON_TAXABLE = ([\d_]+)/), ASSUMED.nonTaxable,
    "생성기의 비과세 전제가 계산기 기본값과 다르다");
});

t("★행 링크가 표와 똑같은 값을 계산기에 넘긴다★", () => {
  // v 만 넘기면 계산기가 자기 기본값을 써서 표와 다른 숫자를 보여준다.
  for (const r of rows) {
    const want = `href="/?v=${r.annual}&amp;dep=${ASSUMED.dependents}&amp;nt=${ASSUMED.nonTaxable}"`;
    assert.ok(html.includes(want), `연봉 ${r.annual} 링크에 전제가 빠졌다`);
  }
});

t("빌드 --check 가 원장과의 어긋남을 잡는다", () => {
  execFileSync(process.execPath, [path.join(ROOT, "build", "salary-table.js"), "--check"],
    { cwd: ROOT, stdio: "pipe" });
});

t("★국민연금 상한이 바뀌면 표가 낡았다고 알린다★", () => {
  // 상한은 매년 7월 1일에 바뀐다. 원장에 새 구간이 들어왔는데 표를 다시
  // 만들지 않으면 고연봉 구간이 조용히 틀린다. --check 가 그걸 잡아야 한다.
  const gen = fs.readFileSync(path.join(ROOT, "build", "salary-table.js"), "utf8");
  assert.ok(gen.includes("payDateFromLedger"), "payDate 를 원장에서 뽑지 않는다");
  assert.ok(!/payDate:\s*["']\d{4}-\d{2}-\d{2}["']/.test(gen), "payDate 가 하드코딩돼 있다");

  // 상한이 실제로 걸리는 구간이 표 안에 있어야 이 검사가 의미를 갖는다.
  const cap = rates.nationalPension.baseIncomeBrackets
    .reduce((a, b) => (a.from > b.from ? a : b)).max;
  assert.ok(100_000_000 / 12 > cap, `1억의 월급이 상한(${cap})을 넘지 않는다`);
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
