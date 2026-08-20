/**
 * 번들 정합성 테스트.
 * build/bundle.js 가 만든 브라우저 번들이 원본 엔진과 동일한 값을 내는지 검증한다.
 * 번들링은 정규식 치환을 쓰므로 조용히 깨질 수 있다. 그것을 여기서 잡는다.
 */
const assert = require("assert");
const path = require("path");

const R = (p) => require(path.join(__dirname, "..", p));
const L = require(path.join(__dirname, "..", "tools", "lib", "resolve-ledger.js")).resolve();
const rates = require(L.ledgerPath);
const table = require(L.taxTablePath);
const { calcNetPay } = R("src/engine/net-pay.js");
const { lookupTableTax } = R("src/engine/income-tax.js");

// 번들을 브라우저처럼 로드한다.
const g = {};
new Function("window", require("fs").readFileSync(path.join(__dirname, "..", "web/assets/engine.js"), "utf8"))(g);
const B = g.SalaryNote;

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
};

console.log("\n[브라우저 번들 정합성]\n");

t("번들이 공개 API를 모두 노출한다", () => {
  for (const k of ["rates", "taxTable", "calcNetPay", "calcSocialInsurance", "calcIncomeTax", "lookupTableTax"])
    assert.ok(B[k], `${k} 누락`);
});

t("번들에 실린 데이터가 원본 JSON과 동일하다", () => {
  assert.deepStrictEqual(B.rates, rates);
  assert.deepStrictEqual(B.taxTable, table);
});

t("정답지 4건이 번들에서도 동일하다", () => {
  const cases = [[2_500_000, 1, 35_600], [3_000_000, 1, 74_350], [4_000_000, 1, 195_960], [5_000_000, 1, 335_470]];
  for (const [inc, n, expected] of cases)
    assert.strictEqual(B.lookupTableTax(inc, n, B.taxTable).amount, expected, `${inc}/${n}명`);
});

t("실수령액이 원본 엔진과 완전히 일치한다 (스윕)", () => {
  let checked = 0;
  for (let annual = 24_000_000; annual <= 200_000_000; annual += 1_130_000) {
    for (const dep of [1, 2, 4]) {
      const input = { annualSalary: annual, dependents: dep, nonTaxable: 200_000, payDate: "2026-08-25" };
      const a = calcNetPay(input, rates, table);
      const b = B.calcNetPay(input, B.rates, B.taxTable);
      assert.strictEqual(b.netPay, a.netPay, `netPay @ ${annual}/${dep}`);
      assert.strictEqual(b.totalDeduction, a.totalDeduction, `공제합계 @ ${annual}/${dep}`);
      assert.strictEqual(b.incomeTax, a.incomeTax, `소득세 @ ${annual}/${dep}`);
      checked++;
    }
  }
  assert.ok(checked > 400, `표본이 너무 적다: ${checked}`);
  console.log(`        (${checked}건 대조)`);
});

t("번들도 잘못된 입력을 조용히 통과시키지 않는다", () => {
  assert.throws(() => B.calcNetPay({ annualSalary: "", dependents: 1, payDate: "2026-08-25" }, B.rates, B.taxTable));
  assert.throws(() => B.calcNetPay({ annualSalary: 3e7, dependents: 1, payDate: "2026-8-5" }, B.rates, B.taxTable));
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
