/**
 * 원장에서 파생되는 모든 것을 정해진 순서로 다시 만든다.
 *
 *   node build/all.js            다시 만든다
 *   node build/all.js --check    어긋난 것이 있으면 실패한다 (CI 용)
 *
 * ★왜 이 파일이 필요한가★
 * 원장이 바뀌면 다시 만들어야 하는 것이 engine.js 하나가 아니다. 화면 본문의
 * 요율 표식, 푸터, 실수령액표 81행, 4대보험 요율표까지 전부 원장에서 나온다.
 *
 * 자동 갱신 워크플로는 오랫동안 build/bundle.js 만 돌렸다. 그래서 원장이
 * 실제로 갱신되는 날 engine.js 만 새 요율이 되고 나머지는 옛 숫자로 남아
 * 테스트가 무너지고, 워크플로는 원장 변경을 되돌리고 이슈만 남겼다.
 * 즉 ★자동 갱신이 작동할 수 없는 상태★ 였다. 새 페이지를 추가할 때마다
 * 워크플로를 같이 고쳐야 한다는 규칙은 반드시 잊힌다. 그래서 목록을 여기
 * 한 곳에 두고, 워크플로·CI·사람이 모두 이 파일만 부른다.
 *
 * 순서에는 이유가 있다.
 *   nav      페이지 목록이 바뀌면 모든 페이지의 내비를 다시 쓴다
 *   stamp    본문 요율 표식과 푸터
 *   salary/insurance  원장으로 표를 다시 계산
 *   faq      완성된 본문의 h2 를 읽어 구조화 데이터를 만든다 (본문 뒤여야 한다)
 *   adsense/favicon   head 에 태그를 심는다 (새 페이지가 생긴 뒤여야 한다)
 *   sitemap  페이지 목록 확정 후
 *   bundle   원장을 브라우저용으로 묶는다
 */
const { execFileSync } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CHECK = process.argv.includes("--check");

// 사이트 주소. set-base-url 은 canonical 과 sitemap 을 같이 만든다.
const BASE_URL = process.env.SN_BASE_URL || "https://salarynote.pages.dev";

/** [스크립트, 추가 인자, --check 를 지원하는가] */
const STEPS = [
  ["nav.js", [], false],
  ["stamp.js", [], true],
  ["salary-table.js", [], true],
  ["insurance-rates.js", [], true],
  ["faq.js", [], false],
  ["adsense.js", [], true],
  ["favicon.js", [], true],
  ["set-base-url.js", [BASE_URL], false],
  ["bundle.js", [], false],
];

let failed = 0;
for (const [script, args, supportsCheck] of STEPS) {
  // --check 를 지원하지 않는 단계는 검사 모드에서 건너뛴다. 실행하면 파일을
  // 고쳐 버려 '검사만' 이라는 약속이 깨진다. 이 단계들의 결과는 뒤따르는
  // 단계나 site-consistency 테스트가 간접적으로 확인한다.
  if (CHECK && !supportsCheck) continue;

  const argv = [path.join(__dirname, script), ...args, ...(CHECK ? ["--check"] : [])];
  try {
    const out = execFileSync(process.execPath, argv, { cwd: ROOT, encoding: "utf8" });
    if (!CHECK) process.stdout.write(out);
  } catch (e) {
    failed++;
    process.stderr.write(`\n[${script}] 실패\n`);
    process.stderr.write((e.stdout || "") + (e.stderr || ""));
  }
}

if (failed) {
  console.error(`\n${failed}개 단계가 실패했습니다.`);
  if (CHECK) console.error("  node build/all.js 를 돌려 파생물을 다시 만드십시오.");
  process.exit(1);
}
console.log(CHECK ? "\n파생물 검사: 원장과 모두 일치" : "\n파생물 재생성 완료");
