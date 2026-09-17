/**
 * 각 계산기 아래에 '근거 법령' 블록을 심고, 푸터의 면책 문구를 함께 관리한다.
 *
 * 왜 하는가:
 * 서치콘솔 검색어에 "고용보험법 시행령 제68조 구직급여일액 상한액 2026" 이 찍혔다.
 * 조문 번호까지 적어 검색하는 사람은 계산 결과가 아니라 '무엇을 근거로 그 숫자가
 * 나왔는가' 를 찾고 있다. 경쟁 사이트 대부분은 근거를 밝히지 않는다.
 *
 * ★원래 푸터에 근거 조문이 손으로 적혀 있었다.★ 10개 페이지에만 있었고, 링크가
 * 없었고, 페이지마다 범위가 들쭉날쭉했다. 그리고 실업급여 푸터의
 * '고용보험법 시행규칙 제91조' 는 실제 제목이 '직업능력개발 훈련 등 수강증명서'
 * 로 이 계산과 아무 관계가 없었다. 손으로 적은 법령은 아무도 검증하지 않는다.
 * 그래서 전부 원장으로 옮기고 여기서 생성한다.
 *
 * 사용: node build/law-refs.js          (쓰기)
 *       node build/law-refs.js --check  (검사만, 어긋나면 exit 1)
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "web");
const CHECK = process.argv.includes("--check");

const REFS = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "law-refs.json"), "utf8"));
const PAGES = require("./pages.js");

const OPEN = "<!--LAWREF-->";
const CLOSE = "<!--/LAWREF-->";
const FOOT_OPEN = "<!--LAWNOTE-->";
const FOOT_CLOSE = "<!--/LAWNOTE-->";

/**
 * 법제처 사람용 주소. 법령명에서 공백을 뺀다.
 *   '고용보험법 시행령' 제68조 -> /법령/고용보험법시행령/제68조
 * 이 형식으로 전 항목 200 을 확인했다(2026-09-17).
 */
const lawUrl = (a) => `https://www.law.go.kr/법령/${a.law.replace(/\s+/g, "")}/${a.jo}`;

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function blockFor(urlPath) {
  const page = REFS.pages[urlPath];
  if (!page) return null;

  const items = page.articles.map((k) => {
    const a = REFS.articles[k];
    if (!a) throw new Error(`law-refs.json: articles 에 없는 키 '${k}' (페이지 ${urlPath})`);
    return (
      `        <li><a href="${esc(lawUrl(a))}" target="_blank" rel="noopener noreferrer">` +
      `${esc(a.law)} ${esc(a.jo)}</a> <span class="lawref-t">${esc(a.title)}</span></li>`
    );
  });

  // 조문이 아닌 근거(별표·고시)는 링크 형식이 달라 글로만 적는다.
  const extras = (page.extras || []).length
    ? `\n      <p class="lawref-x">그 밖에 ${page.extras.map(esc).join(", ")} 를 따릅니다.</p>`
    : "";

  return (
    `${OPEN}\n` +
    `      <section class="lawref" aria-labelledby="lawref-h">\n` +
    `        <h2 id="lawref-h">근거 법령</h2>\n` +
    `        <p>이 계산기가 따르는 조문입니다. 법제처 국가법령정보센터 원문으로 연결됩니다.</p>\n` +
    `        <ul>\n${items.join("\n")}\n        </ul>${extras}\n` +
    `      </section>\n` +
    `      ${CLOSE}`
  );
}

const MAIN_END = "</main>";
/** 손으로 적힌 옛 푸터 근거 줄. 원장으로 옮겼으므로 걷어낸다. */
const OLD_FOOT = /[ \t]*<p>근거:[\s\S]*?<\/p>\n?/;

let changed = 0, problems = [], stale = [];

for (const p of PAGES) {
  const want = blockFor(p.url);
  const file = path.join(WEB, p.url === "/" ? "index.html" : path.join(p.url.slice(1), "index.html"));
  if (!fs.existsSync(file)) { if (want) problems.push(`${p.url} 파일 없음`); continue; }

  const src = fs.readFileSync(file, "utf8");
  let next = src;

  if (want) {
    if (next.includes(OPEN)) {
      // ★백슬래시를 두 번 써야 한다.★ 일반 문자열에서 "[\s\S]" 는 \s 가 알려진
      // 이스케이프가 아니라 그냥 s 로 죽어 [sS] 가 된다. build/faq.js 에서 당했다.
      next = next.replace(new RegExp(OPEN + "[\\s\\S]*?" + CLOSE), want);
    } else {
      const at = next.lastIndexOf(MAIN_END);
      if (at < 0) { problems.push(`${p.url} 에 </main> 이 없음`); continue; }
      next = next.slice(0, at) + want + "\n    " + next.slice(at);
    }

    // 푸터 면책 문구도 원장에서 찍는다.
    const note = `${FOOT_OPEN}${REFS.pages[p.url].note}${FOOT_CLOSE}`;
    if (next.includes(FOOT_OPEN)) {
      next = next.replace(new RegExp(FOOT_OPEN + "[\\s\\S]*?" + FOOT_CLOSE), note);
    } else {
      next = next.replace(OLD_FOOT, "");
      const f = next.lastIndexOf("</footer>");
      if (f < 0) { problems.push(`${p.url} 에 </footer> 가 없음`); continue; }
      next = next.slice(0, f) + `  <p>${note}</p>\n` + next.slice(f);
    }
  }

  if (next !== src) {
    stale.push(p.url);
    if (!CHECK) fs.writeFileSync(file, next, "utf8");
    changed++;
  }
}

const nArt = Object.keys(REFS.articles).length;
const nPage = Object.keys(REFS.pages).length;
console.log(`근거 법령: 조문 ${nArt}개 · 페이지 ${nPage}개 · ${changed}개 ${CHECK ? "불일치" : "갱신"}`);

if (problems.length) {
  console.error("\n★ 처리하지 못한 페이지:");
  for (const m of problems) console.error("  " + m);
  process.exit(1);
}
if (CHECK && stale.length) {
  console.error(`\n★ 근거 법령이 원장과 어긋납니다: ${stale.join(", ")}`);
  console.error("  node build/law-refs.js 를 실행하세요.");
  process.exit(1);
}
