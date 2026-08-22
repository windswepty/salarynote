/**
 * 원장 연도 해석기 — 연도를 한 곳에서만 정한다.
 *
 * ★왜 이 파일이 있는가★
 * 이전에는 build/bundle.js·ci.yml·test/*.test.js·워크플로가 각자 "2026" 을 하드코딩했다.
 * 그러면 사람이 data/rates-2027.json 을 만들어도 번들은 계속 2026 원장을 읽는다.
 * 파이프라인은 2027 원장을 갱신하고, PR 은 정상적으로 뜨고, 테스트도 통과하고,
 * 사람이 병합하고, 배포까지 되는데 ★사이트만 2026 요율로 계산한다.★
 * 초록불 뒤에 숨은 '조용히 틀린 값' 이며, 실제로 재현해 확인한 경로다.
 *
 * 그래서 연도는 파일 이름에서 뽑되, 그 해석을 여기 한 곳에 둔다.
 *
 * ★조용한 폴백을 하지 않는다.★
 * 해가 바뀌었는데 새 원장이 없으면 작년 원장으로 조용히 넘어가지 않는다.
 * 그것이 정확히 위의 사고다. 대신 시끄럽게 멈춘다(assertCurrent).
 * 1월 1일에 번들이 안 만들어지는 편이, 작년 요율을 새해에 배포하는 것보다 낫다.
 * 이미 커밋된 web/assets/engine.js 로 사이트는 계속 뜬다.
 *
 * ★다만 '오늘 이하 중 최신' 이지 '무조건 최신' 은 아니다.★
 * 다음 해 원장을 미리 준비해 둘 수 있어야 하기 때문이다. 자세한 이유는
 * resolve() 위의 주석에 있다.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");

/** KST 기준 오늘. 워크플로도 러너 UTC 에 +9 시간을 해서 같은 값을 쓴다. */
function kstToday(now) {
  const t = (now ? new Date(now) : new Date()).getTime();
  return new Date(t + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** data/rates-<year>.json 으로 존재하는 연도 목록(오름차순). */
function availableYears(root) {
  const dir = path.join(root || ROOT, "data");
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    throw new Error(`data 디렉터리를 읽을 수 없습니다: ${dir} (${e.message})`);
  }
  return names
    .map((n) => /^rates-(\d{4})\.json$/.exec(n))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

/**
 * ★오늘 기준으로 현역인 원장을 고른다 — '가장 최신' 이 아니라 '오늘 유효한' 것.★
 *
 * 예전에는 무조건 최신 연도를 골랐다. 그러면 다음 해 원장을 미리 만들어 둘 수가
 * 없다. 2026년 12월에 rates-2027.json 을 넣는 순간 resolve() 가 2027 을 고르고
 * assertCurrent 가 '원장 연도가 미래입니다' 로 빌드를 죽인다(재현 확인).
 *
 * 그래서 다음 해 요율이 이미 고시돼 있어도 준비를 미뤄야 했고, 1월 1일이
 * 지나서야 사람이 손으로 만들 수 있었다. 무인 연도 전환을 막는 진짜 벽이 이것이다.
 *
 * 이제 오늘 연도 이하 중 가장 큰 것을 고른다. 그러면
 *  - 12월에 내년 원장을 병합해 둬도 사이트는 계속 올해 값으로 동작하고,
 *  - 1월 1일이 되면 아무도 손대지 않아도 새 원장이 저절로 현역이 된다.
 *
 * 오탈자 방어는 assertNoFarFuture 가 맡는다. 내년까지만 허용하므로
 * rates-3026.json 같은 실수는 여전히 걸린다.
 * @returns {{year:number, ledgerPath:string, taxTablePath:string, taxTableExists:boolean}}
 */
function resolve(opts = {}) {
  const root = opts.root || ROOT;
  const years = availableYears(root);
  if (years.length === 0) {
    throw new Error(`data/rates-<연도>.json 이 하나도 없습니다: ${path.join(root, "data")}`);
  }
  const thisYear = Number((opts.today || kstToday()).slice(0, 4));
  assertNoFarFuture(years, thisYear, root);

  // 오늘 연도 이하 중 가장 큰 것. 하나도 없으면(전부 미래) 가장 이른 것을 돌려주어
  // assertCurrent 가 '현역 원장이 없습니다' 로 정확히 보고하게 한다.
  const usable = years.filter((y) => y <= thisYear);
  const year = usable.length ? usable[usable.length - 1] : years[0];
  const ledgerPath = path.join(root, "data", `rates-${year}.json`);
  const taxTablePath = path.join(root, "data", `simplified-tax-table-${year}.json`);
  return {
    year,
    availableYears: years,
    ledgerPath,
    taxTablePath,
    taxTableExists: fs.existsSync(taxTablePath),
  };
}

/**
 * 원장 파일 이름의 연도가 터무니없이 미래이면 던진다.
 *
 * resolve() 가 '오늘 이하 중 최신' 을 고르게 되면서, 미래 연도 파일은 그냥
 * 무시된다. 그러면 rates-3026.json 같은 오탈자가 조용히 묻힌다. 내년까지는
 * 정상적인 사전 준비이므로 허용하고, 그 너머는 실수로 본다.
 */
function assertNoFarFuture(years, thisYear, root) {
  const bad = years.filter((y) => y > thisYear + 1);
  if (bad.length) {
    throw new Error(
      `원장 연도가 너무 먼 미래입니다: ${bad.join(", ")} (오늘 ${thisYear}년).\n` +
        `다음 해까지는 미리 준비할 수 있지만 그 너머는 파일 이름 오탈자로 봅니다.\n` +
        `확인: ${path.join(root || ROOT, "data")}`
    );
  }
}

/**
 * 해석된 원장이 '오늘' 기준으로 현역인지 확인한다. 아니면 던진다.
 *
 * ★이 함수가 번들 게이트의 존재 이유다.★ 조용히 작년 원장으로 번들을 만드는 것을
 * 막는 유일한 지점이다. 메시지에 '코드 변경과 무관하다' 를 반드시 적는다 —
 * CSS 만 고치러 온 사람이 요율 오류로 빌드가 죽는 걸 보게 되기 때문이다.
 */
function assertCurrent(r, todayStr) {
  const today = todayStr || kstToday();
  const y = Number(today.slice(0, 4));
  if (r.year < y) {
    throw new Error(
      `현역 원장이 없습니다: 가장 최신 원장이 ${r.year}년인데 오늘은 ${today}(KST) 입니다.\n` +
        `★이 실패는 당신의 코드 변경과 무관합니다.★ ${y}년 요율 원장이 아직 만들어지지 않았습니다.\n` +
        `작년 요율을 새해에 배포하는 것보다 빌드를 멈추는 쪽을 택합니다(4대보험 요율은 1월 1일에 바뀝니다).\n` +
        `해결: data/rates-${y}.json 과 data/simplified-tax-table-${y}.json 을 만드십시오.\n` +
        `이미 커밋된 web/assets/engine.js 로 사이트는 계속 동작합니다.`
    );
  }
  if (r.year > y) {
    // resolve() 가 오늘 이하를 고르므로 여기 걸리는 것은 '전부 미래' 인 경우뿐이다.
    throw new Error(
      `현역 원장이 없습니다: 가장 이른 원장이 ${r.year}년인데 오늘은 ${today}(KST) 입니다.\n` +
        `올해 원장이 없습니다. 파일 이름이나 시스템 시각을 확인하십시오.`
    );
  }
  return r;
}

/** 원장 파일 이름의 연도와 내용의 year 필드가 일치하는지. 어긋나면 조용히 틀린다. */
function assertYearMatchesContent(r, ledger) {
  if (ledger && ledger.year !== r.year) {
    throw new Error(
      `원장 파일 이름의 연도(${r.year})와 내용의 year 필드(${ledger.year})가 다릅니다: ${r.ledgerPath}\n` +
        `파일을 복사해 새 연도 원장을 만들면서 year 를 고치지 않은 전형적 실수입니다.`
    );
  }
  return r;
}

module.exports = { resolve, assertCurrent, assertNoFarFuture, assertYearMatchesContent, availableYears, kstToday, ROOT };

// CLI: 워크플로·CI 가 셸에서 연도/경로를 뽑을 때 쓴다.
//   node tools/lib/resolve-ledger.js year   -> 2026
//   node tools/lib/resolve-ledger.js ledger -> data/rates-2026.json
if (require.main === module) {
  const what = process.argv[2] || "year";
  try {
    const r = resolve();
    if (what === "year") process.stdout.write(String(r.year) + "\n");
    else if (what === "ledger") process.stdout.write(path.relative(ROOT, r.ledgerPath).split("\\").join("/") + "\n");
    else if (what === "taxtable") process.stdout.write(path.relative(ROOT, r.taxTablePath).split("\\").join("/") + "\n");
    else throw new Error(`알 수 없는 인자: ${what} (year|ledger|taxtable)`);
  } catch (e) {
    process.stderr.write(`[resolve-ledger] ${e.message}\n`);
    process.exit(1);
  }
}
