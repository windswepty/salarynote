/**
 * 법제처 원문으로 조문을 확인한다. 본문에 조문을 인용하기 전에 쓴다.
 *
 *   node tools/law-article.js "근로기준법|제36조" "최저임금법 시행령|제5조"
 *   node tools/law-article.js "근로기준법 시행령|제27조의2"
 *
 * ★조문 번호를 기억으로 적지 않는다.★ data/law-refs.json 의 원칙과 같다.
 * 법제처 서버에 연달아 요청하면 응답이 끊기므로 1.2초 간격을 두고 세 번까지 다시 묻는다.
 */
const path = require("path");
const law = require(path.join(__dirname, "lib", "law-go-kr.js"));

/** '제27조의2' → '002702' (조 4자리 + 가지번호 2자리) */
function joCode(jo) {
  const m = String(jo).match(/^제?(\d+)조(?:의(\d+))?$/);
  if (!m) throw new Error(`조문 형식이 아닙니다: ${jo} (예: 제36조, 제27조의2)`);
  return m[1].padStart(4, "0") + (m[2] || "0").padStart(2, "0");
}

const NOISE = /^(\d{4,}|[A-Z]|조문|항|호|Y|N|신설|개정|[①-⑳]|\d+\.|[가-하]\.|\s*)$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('사용: node tools/law-article.js "법령명|제N조" ...');
    process.exit(1);
  }
  let failed = 0;
  for (const arg of args) {
    const [name, jo] = arg.split("|");
    let done = false;
    for (let t = 0; t < 3 && !done; t++) {
      try {
        const a = await law.lawArticle(name, joCode(jo));
        console.log(`\n##### ${name} ${jo} (시행 ${a.effective})`);
        console.log(a.lines.filter((l) => !NOISE.test(l.trim())).join("\n"));
        done = true;
      } catch (e) {
        if (t === 2) { console.log(`\n##### ${name} ${jo} 실패: ${e.message.slice(0, 200)}`); failed++; }
        else await sleep(2500);
      }
    }
    await sleep(1200);
  }
  process.exit(failed ? 1 : 0);
})();
