/**
 * 연봉 실수령액표를 생성한다.
 *
 *   node build/salary-table.js            표를 다시 계산해 써 넣는다
 *   node build/salary-table.js --check    원장과 어긋나면 실패한다 (CI 용)
 *
 * 왜 손으로 쓰지 않는가
 *   이 표에는 숫자가 300개 넘게 들어간다. 요율이 갱신되면 계산기는 새 요율로
 *   계산하는데 표만 옛 숫자로 남는다. 사용자는 어느 쪽이 맞는지 알 수 없고,
 *   틀린 쪽이 검색에 걸린 페이지다. 그래서 표 전체를 원장에서 다시 계산한다.
 *
 * 왜 미리 계산해 HTML 에 박는가
 *   검색엔진이 읽어야 하기 때문이다. 자바스크립트로 그리면 '연봉 5000 실수령액'
 *   같은 검색어에 걸리지 않는다. 이 페이지의 존재 이유가 그 검색어들이다.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "web");
const PAGE = path.join(WEB, "salary-table", "index.html");

const { resolve } = require(path.join(ROOT, "tools", "lib", "resolve-ledger.js"));
const LEDGER = resolve();
const rates = JSON.parse(fs.readFileSync(LEDGER.ledgerPath, "utf8"));
const taxTable = JSON.parse(fs.readFileSync(
  path.join(ROOT, "data", `simplified-tax-table-${LEDGER.year}.json`), "utf8"));
const { calcNetPay } = require(path.join(ROOT, "src", "engine", "net-pay.js"));

const CHECK = process.argv.includes("--check");

/* ── 표의 전제 ────────────────────────────────────────────────
   실수령액은 부양가족 수와 비과세액에 따라 달라져 표 하나로 모두 담을 수 없다.
   그래서 ★계산기의 기본값과 똑같이★ 맞춘다. 같은 사이트에서 표와 계산기가
   다른 숫자를 보이면 어느 쪽이 맞는지 알 수 없고, 그 순간 둘 다 못 믿게 된다.
   실제로 표를 비과세 0원으로 만들었더니 5,000만원 행이 3,522,776원인데
   계산기는 3,571,586원을 보여 48,810원이 어긋났다.
   값을 바꾸려면 web/index.html 의 dep·nt 기본값도 함께 바꿔야 한다. */
const DEPENDENTS = 1;          // 본인만
const NON_TAXABLE = 200_000;   // 식대 월 20만원 (소득세법 시행령 제17조의2)

const FROM = 20_000_000;   // 연봉 2,000만원
const TO = 100_000_000;    // 연봉 1억원
const STEP = 1_000_000;    // 100만원 단위

/**
 * 국민연금 기준소득월액 상·하한은 매년 7월 1일에 바뀐다. 원장에 실린 구간 중
 * 가장 나중 것을 쓴다. 오늘 날짜를 쓰면 빌드할 때마다 결과가 달라져 --check 가
 * 무의미해지고, 고정 날짜를 박으면 구간이 바뀌어도 옛 상한으로 계산한다.
 */
function payDateFromLedger() {
  const brackets = rates.nationalPension.baseIncomeBrackets;
  const latest = brackets.reduce((a, b) => (a.from > b.from ? a : b));
  return { payDate: latest.from, period: `${latest.from} ~ ${latest.to}` };
}

const { payDate, period } = payDateFromLedger();
const won = (n) => Math.round(n).toLocaleString("ko-KR");

function rows() {
  const out = [];
  for (let annual = FROM; annual <= TO; annual += STEP) {
    const r = calcNetPay(
      { annualSalary: annual, dependents: DEPENDENTS, nonTaxable: NON_TAXABLE, payDate },
      rates, taxTable);
    out.push({
      annual,
      gross: r.gross,
      deduction: r.totalDeduction,
      net: r.netPay,
      rate: (r.netPay / r.gross) * 100,
    });
  }
  return out;
}

function tableHtml(list) {
  // '월 세전' 열은 '월급 400 실수령액' 같은 검색을 이 페이지가 받게 하려는 것이다.
  // 월급표를 따로 만들면 같은 값을 라벨만 바꿔 두 번 싣는 셈이라 중복으로 취급된다.
  const head =
    "  <thead><tr>" +
    "<th scope=\"col\">연봉</th>" +
    "<th scope=\"col\" class=\"num\">월 세전</th>" +
    "<th scope=\"col\" class=\"num\">월 실수령액</th>" +
    "<th scope=\"col\" class=\"num drop\">월 공제액</th>" +
    "<th scope=\"col\" class=\"num\">실수령률</th>" +
    "</tr></thead>";

  const body = list.map((r) => {
    const man = r.annual / 10_000;
    const label = man % 10_000 === 0 ? `${man / 10_000}억` : `${won(man)}만원`;
    // 각 행에서 계산기로 넘어간다. 전제를 모두 실어야 계산기가 표와 같은
    // 숫자를 보여준다. v 만 넘기면 계산기 기본값이 적용돼 값이 어긋난다.
    // HTML 속성 안에서는 & 를 이스케이프해야 유효한 문서가 된다.
    const q = `v=${r.annual}&amp;dep=${DEPENDENTS}&amp;nt=${NON_TAXABLE}`;
    return `    <tr><th scope="row"><a href="/?${q}">${label}</a></th>` +
      `<td class="num">${won(r.gross)}</td>` +
      `<td class="num"><b>${won(r.net)}</b></td>` +
      `<td class="num drop">${won(r.deduction)}</td>` +
      `<td class="num">${r.rate.toFixed(1)}%</td></tr>`;
  }).join("\n");

  return `<table class="stable">\n${head}\n  <tbody>\n${body}\n  </tbody>\n</table>`;
}

const MARK_OPEN = "<!--TABLE-->";
const MARK_CLOSE = "<!--/TABLE-->";

const list = rows();
const block = MARK_OPEN + "\n" + tableHtml(list) + "\n" + MARK_CLOSE;

if (!fs.existsSync(PAGE)) {
  console.error(`페이지가 없습니다: ${path.relative(ROOT, PAGE)}`);
  process.exit(1);
}

const src = fs.readFileSync(PAGE, "utf8");
if (!src.includes(MARK_OPEN)) {
  console.error(`${MARK_OPEN} 표식이 없습니다: ${path.relative(ROOT, PAGE)}`);
  process.exit(1);
}

const next = src.replace(
  new RegExp(MARK_OPEN + "[\\s\\S]*?" + MARK_CLOSE.replace("/", "\\/")), block);

if (CHECK) {
  if (next !== src) {
    console.error("실수령액표가 원장과 어긋납니다.");
    console.error("  node build/salary-table.js 를 돌려 다시 계산하십시오.");
    process.exit(1);
  }
  console.log(`실수령액표 확인: ${list.length}행 일치 (${LEDGER.year}년 · 국민연금 ${period})`);
} else {
  fs.writeFileSync(PAGE, next, "utf8");
  const first = list[0], last = list[list.length - 1];
  console.log(`실수령액표 ${list.length}행 (${won(FROM / 10000)}만 ~ ${won(TO / 10000)}만)`);
  console.log(`  국민연금 기준 ${period} (payDate ${payDate})`);
  console.log(`  전제: 부양가족 ${DEPENDENTS}명 · 비과세 ${won(NON_TAXABLE)}원`);
  console.log(`  ${won(first.annual)} → 월 ${won(first.net)}원 (${first.rate.toFixed(1)}%)`);
  console.log(`  ${won(last.annual)} → 월 ${won(last.net)}원 (${last.rate.toFixed(1)}%)`);
}
