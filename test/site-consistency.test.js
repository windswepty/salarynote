/**
 * 화면에 적힌 숫자가 원장과 일치하는지 검사한다.
 *
 * 적대적 검증에서 나온 critical 결함에 대한 회귀 테스트다:
 * 요율이 HTML 본문 11곳에 손으로 박혀 있었고, 파이프라인·빌드·테스트 어디도
 * 원장과 대조하지 않았다. 첫 자동 갱신이 병합되는 순간 계산기는 새 요율로 계산하고
 * 같은 페이지 본문은 옛 요율을 단언하게 된다. 사용자는 어느 쪽이 맞는지 알 수 없다.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "web");
const L = require(path.join(ROOT, "tools", "lib", "resolve-ledger.js")).resolve();
const rates = JSON.parse(fs.readFileSync(L.ledgerPath, "utf8"));

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); console.log(`  PASS  ${n}`); pass++; } catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; } };

const htmls = (function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".html")) out.push(p);
  }
  return out;
})(WEB);

console.log("\n[사이트-원장 정합성]\n");

t("화면 숫자가 원장과 일치한다 (stamp --check)", () => {
  execFileSync(process.execPath, [path.join(ROOT, "build", "stamp.js"), "--check"], { stdio: "pipe" });
});

t("모든 계산기 페이지에 기준 정보 푸터가 있다", () => {
  const calc = htmls.filter((f) => !/404\.html|google[0-9a-f]+\.html|privacy/.test(f));
  assert.ok(calc.length >= 7, `계산기 페이지 ${calc.length}개`);
  for (const f of calc) {
    const s = fs.readFileSync(f, "utf8");
    assert.ok(s.includes("<!--STAMP:footer-->"), `${path.relative(WEB, f)} 에 푸터 표식 없음`);
  }
});

t("푸터에 자료 확인일(lastVerified)이 노출된다", () => {
  // 갱신이 몇 년 멈춰도 화면에 날짜가 있으면 사용자가 알아챌 수 있다.
  const s = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  assert.ok(s.includes(rates.lastVerified), `푸터에 ${rates.lastVerified} 가 없다`);
});

t("원장 밖에 살아있는 요율 숫자가 하드코딩돼 있지 않다", () => {
  const live = [
    [rates.nationalPension.totalRate, "국민연금 총요율"],
    [rates.healthInsurance.totalRate, "건강보험 총요율"],
    [rates.employmentInsurance.unemploymentTotalRate, "고용보험 요율"],
  ].map(([v, label]) => [(v * 100).toFixed(6).replace(/0+$/, "").replace(/\.$/, "") + "%", label]);

  const offenders = [];
  for (const f of htmls) {
    let s = fs.readFileSync(f, "utf8");
    // 표식 안쪽과 생성된 푸터는 정당하다
    s = s.replace(/<span data-rate="[^"]+"[^>]*>[\s\S]*?<\/span>/g, "")
         .replace(/<!--STAMP:footer-->[\s\S]*?<!--\/STAMP-->/g, "");
    for (const [str, label] of live)
      if (s.includes(str)) offenders.push(`${path.relative(WEB, f)}: ${label} ${str}`);
  }
  assert.strictEqual(offenders.length, 0, "표식 밖 하드코딩:\n        " + offenders.join("\n        "));
});

t("번들이 해석된 원장의 값을 담고 있다", () => {
  // 연도가 바뀌었는데 번들러가 옛 원장을 읽으면 여기서 걸린다.
  const src = fs.readFileSync(path.join(WEB, "assets", "engine.js"), "utf8");
  const m = src.match(/"year":\s*(\d{4})/);
  assert.ok(m, "번들에 year 가 없다");
  assert.strictEqual(Number(m[1]), L.year, `번들 연도 ${m[1]} ≠ 해석된 원장 ${L.year}`);
  assert.ok(src.includes(`"lastVerified": "${rates.lastVerified}"`), "번들의 lastVerified 불일치");
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
