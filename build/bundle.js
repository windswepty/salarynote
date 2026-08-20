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

/**
 * 원장 경로는 파일명에 연도가 박혀 있으므로 절대 하드코딩하지 않는다.
 *
 * 하드코딩했을 때 실제로 벌어지는 일(검증에서 재현됨):
 * 2027년 원장을 만들어 파이프라인이 갱신해도 번들러는 2026 원장만 읽으므로
 * engine.js 가 바이트 단위로 변하지 않는다. 테스트도 전부 통과하고 PR 도 정상적으로
 * 뜨기 때문에, 사람이 검토하고 병합해도 사이트만 옛 요율에 고정된다.
 * 이 프로젝트가 가장 두려워하는 '초록불 뒤에 숨은 틀린 값'이다.
 *
 * 그래서 없으면 조용히 폴백하지 않고 빌드를 실패시킨다.
 * 1월 1일에 번들이 안 만들어지는 편이 옛 요율을 배포하는 것보다 낫다
 * (engine.js 는 이미 커밋돼 있어 사이트는 계속 뜬다).
 */
const { resolve, assertYearMatchesContent } = require("../tools/lib/resolve-ledger.js");
const LEDGER = resolve();
const readAbs = (abs) => fs.readFileSync(abs, "utf8").split(CR).join("");
const rates = readAbs(LEDGER.ledgerPath);
const table = readAbs(LEDGER.taxTablePath);
assertYearMatchesContent(LEDGER, JSON.parse(rates));
console.log(`원장: ${path.basename(LEDGER.ledgerPath)} (${LEDGER.year}년)`);

/**
 * ★위생 검사 게이트 — 파이프라인을 우회한 손편집에 대한 마지막 방어선★
 *
 * 자동 갱신 파이프라인(tools/update-rates.js)은 검증을 통과한 값만 원장에 쓴다.
 * 그러나 사람이 data/rates-*.json 을 직접 고치면 그 검증을 통째로 건너뛴다.
 * 여기서 FATAL 을 만나면 번들이 생성되지 않고, 번들이 없으면 배포도 되지 않는다.
 * (main 병합 = Cloudflare Pages 즉시 배포이므로 이 지점이 실질적 마지막 관문이다.)
 *
 * SKIP_SANITY=1 로 우회할 수 있게 두지 않는다. 우회 스위치는 결국 켜진 채로 남는다.
 */
{
  const { validate, validateTaxTable } = require(path.join(ROOT, "tools", "sanity-check.js"));
  const ledger = JSON.parse(rates);
  const taxTable = JSON.parse(table);
  const problems = [];
  for (const [label, res] of [
    ["요율 원장", validate({ candidate: ledger, taxTable })],
    ["간이세액표", validateTaxTable(taxTable, JSON.parse(read("data/sanity-rules.json")), null)],
  ]) {
    for (const f of res.fatal) problems.push(`  [${label}] ${f.path} [${f.code}] ${f.message}`);
  }
  if (problems.length) {
    console.error("\n★원장 위생 검사 FATAL — 번들을 생성하지 않습니다★\n");
    console.error(problems.join("\n"));
    console.error(
      "\n조용히 틀린 값을 배포하느니 멈춥니다. data/*.json 을 고쳐서 통과시키거나," +
        "\n임계값이 정말 틀렸다면 data/sanity-rules.json 을 근거와 함께 고치십시오.\n"
    );
    process.exit(1);
  }
}

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
