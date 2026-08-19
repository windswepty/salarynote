/**
 * 브라우저 번들 생성기.
 *
 * 엔진(src/engine/*.js)은 CommonJS 그대로 두고 여기서 감싼다.
 * 이유: 그 엔진은 92개 테스트로 검증됐고 적대적 검증까지 통과했다.
 * 브라우저에 태우자고 ESM 으로 고쳐 쓰면 검증된 코드를 건드리게 된다.
 * 데이터 JSON 도 함께 넣어 fetch 없이 동작하게 한다(file:// 로 열어도 됨).
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
/**
 * 줄바꿈을 LF 로 정규화해서 읽는다.
 * Windows + git 조합에서 작업 파일이 CRLF 가 되는데, 아래 치환 정규식들이
 * LF 를 가정하고 있어 조용히 매치에 실패한다. 실제로 그 버그로
 * 브라우저 번들에 node 전용 require 가 남아 사이트 전체가 죽은 적이 있다.
 */
const CR = String.fromCharCode(13);
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").split(CR).join("");

const rates = read("data/rates-2026.json");
const table = read("data/simplified-tax-table-2026.json");

const MODULES = ["insurance.js", "income-tax.js", "net-pay.js", "severance.js", "work-allowance.js"];

const wrapped = MODULES.map((name) => {
  let src = read(path.join("src/engine", name));
  // node 전용 구문을 브라우저용으로 치환한다.
  src = src
    .replace(/const path = require\("path"\);\n/g, "")
    .replace(/require\(path\.join\(\s*__dirname,\s*"([^"]+)"\s*\)\)/gs, '__req("$1")');
  return `  __mod["${name}"] = (function () {
    const module = { exports: {} };
    ${src}
    return module.exports;
  })();`;
}).join("\n\n");

const out = `/* 샐러리노트 계산 엔진 번들 — build/bundle.js 가 생성. 직접 고치지 말 것. */
(function (global) {
  "use strict";
  const __mod = {};
  function __req(name) {
    if (!__mod[name]) throw new Error("모듈 로드 순서 오류: " + name);
    return __mod[name];
  }

${wrapped}

  global.SalaryNote = {
    rates: ${rates},
    taxTable: ${table},
    calcNetPay: __mod["net-pay.js"].calcNetPay,
    annualToMonthly: __mod["net-pay.js"].annualToMonthly,
    calcSocialInsurance: __mod["insurance.js"].calcSocialInsurance,
    calcIncomeTax: __mod["income-tax.js"].calcIncomeTax,
    lookupTableTax: __mod["income-tax.js"].lookupTableTax,
    calcSeverance: __mod["severance.js"].calcSeverance,
    calcWeeklyHolidayPay: __mod["work-allowance.js"].calcWeeklyHolidayPay,
    calcAnnualLeave: __mod["work-allowance.js"].calcAnnualLeave,
    convertWage: __mod["work-allowance.js"].convertWage,
  };
})(typeof window !== "undefined" ? window : globalThis);
`;

const dest = path.join(ROOT, "web/assets/engine.js");
fs.writeFileSync(dest, out, "utf8");
console.log("engine.js", (fs.statSync(dest).size / 1024).toFixed(0) + "KB");
