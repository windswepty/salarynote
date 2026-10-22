/**
 * 모든 페이지의 상단 내비게이션과 푸터 링크를 build/pages.js 기준으로 다시 써 넣는다.
 * 계산기가 늘어날 때마다 여러 HTML 을 손으로 고치면 반드시 빠뜨리는 곳이 생긴다.
 *
 *   node build/nav.js
 *   node build/nav.js --check   어긋나면 실패한다 (CI 용)
 *
 * ★푸터 링크가 왜 필요한가★
 * 상단 내비는 계산기만 싣는다(pages.js 의 nav 가 null 이면 빠진다). 그 결과
 * /about/ 은 사이트 어디에서도 링크되지 않는 고아 페이지가 됐고, /privacy/ 는
 * 그 고아 페이지에서만 링크됐다. 서치콘솔이 /about/ 을 두고 '참조 페이지:
 * 감지된 페이지 없음' 이라고 한 이유가 이것이다. 링크가 없는 페이지는 구글이
 * 중요하지 않다고 보고 색인하지 않는다 — 실제로 둘 다 '크롤링됨 - 현재 색인이
 * 생성되지 않음' 이었다. 다른 페이지는 인바운드가 15~16개인데 이 둘만 0~1개였다.
 *
 * 개인정보처리방침은 애드센스 정책상 쉽게 찾을 수 있어야 하므로 더더욱 그렇다.
 */
const fs = require("fs");
const path = require("path");
const PAGES = require("./pages.js");

const WEB = path.join(__dirname, "..", "web");
const items = PAGES.filter((p) => p.nav);
// 상단에 싣지 않는 페이지(소개·개인정보처리방침)는 푸터에서 받는다.
// 여기서 빠지면 그 페이지는 사이트 안에서 도달할 수 없게 된다.
// 가이드 글은 푸터가 아니라 /guide/ 목록과 본문 링크로 이어진다(푸터가 길어지면 아무도 안 본다).
const footItems = PAGES.filter((p) => !p.nav && !p.kind);
const guides = PAGES.filter((p) => p.kind === "guide");

const G_OPEN = "<!--GUIDELIST-->";
const G_CLOSE = "<!--/GUIDELIST-->";

/** /guide/ 목록. 가이드를 pages.js 에 추가하면 여기에 저절로 실린다. */
function guideListHtml() {
  const lis = guides.map((g) =>
    `<li><a href="${g.url}">${g.title}</a><span class="guidelist-d">${g.desc}</span></li>`);
  return `${G_OPEN}<ul class="guidelist">${lis.join("")}</ul>${G_CLOSE}`;
}

const F_OPEN = "<!--FOOTLINKS-->";
const F_CLOSE = "<!--/FOOTLINKS-->";

function footHtml(currentUrl) {
  const links = footItems
    .filter((p) => p.url !== currentUrl)   // 자기 자신은 링크하지 않는다
    .map((p) => `<a href="${p.url}">${p.title}</a>`);
  return `${F_OPEN}<p class="footlinks">${links.join(" · ")}</p>${F_CLOSE}`;
}

const R_OPEN = "<!--RELATED-->";
const R_CLOSE = "<!--/RELATED-->";
const byUrl = Object.fromEntries(PAGES.map((p) => [p.url, p]));

/**
 * 본문 아래 '함께 보면 좋은 계산기'. 상단 메뉴는 모든 페이지에 똑같이 붙는
 * 틀이라 구글이 본문 링크만큼 무게를 두지 않는다. 실제로 메뉴 링크가 15개씩
 * 있는데도 /monthly-salary/ 가 '참조 페이지: 감지된 페이지 없음' 이었다.
 */
function relatedHtml(page) {
  const items = page.related.map((u) => {
    const r = byUrl[u];
    if (!r) throw new Error(`${page.url} 의 related 에 없는 페이지: ${u}`);
    if (u === page.url) throw new Error(`${page.url} 가 자기 자신을 related 로 가리킨다`);
    return `<li><a href="${r.url}">${r.title}</a> <span class="related-d">${r.desc}</span></li>`;
  });
  const hasGuide = page.related.some((u) => byUrl[u].kind === "guide");
  const heading = hasGuide ? "함께 보면 좋은 계산기와 가이드" : "함께 보면 좋은 계산기";
  return `${R_OPEN}<section class="related" aria-labelledby="related-h"><h2 id="related-h">${heading}</h2>` +
    `<ul>${items.join("")}</ul></section>${R_CLOSE}`;
}

function navHtml(currentUrl, pad) {
  const links = items.map((p) => {
    const cur = p.url === currentUrl ? ' aria-current="page"' : "";
    return `${pad}  <a href="${p.url}"${cur}>${p.nav}<span class="bar"></span></a>`;
  });
  return `${pad}<nav class="nav">\n${links.join("\n")}\n${pad}</nav>`;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".html")) out.push(p);
  }
  return out;
}

const CHECK = process.argv.includes("--check");
let changed = 0, skipped = [], stale = [], noFooter = [];

for (const file of walk(WEB)) {
  const src = fs.readFileSync(file, "utf8");
  if (!/<nav class="nav">/.test(src)) { skipped.push(path.relative(WEB, file)); continue; }

  // 이 파일이 어느 페이지인지 경로로 판정한다.
  const rel = "/" + path.relative(WEB, file).split(path.sep).join("/");
  const url = rel.replace(/index\.html$/, "");

  // 들여쓰기를 고정하면 상단바 구조가 바뀔 때 조용히 어긋난다. 실제 들여쓰기를 읽어 따라간다.
  const pad = (src.match(/^([ \t]*)<nav class="nav">/m) || [, "  "])[1];
  let next = src.replace(/^[ \t]*<nav class="nav">[\s\S]*?<\/nav>/m, navHtml(url, pad));

  // 푸터 링크는 pages.js 에 실린 페이지에만 넣는다. 404.html 은 sitemap 에도
  // 없고 검색에 걸려서도 안 되는 오류 페이지라 링크 대상이 아니다.
  if (PAGES.some((p) => p.url === url)) {
    const foot = footHtml(url);
    if (next.includes(F_OPEN)) {
      next = next.replace(new RegExp(F_OPEN + "[\\s\\S]*?" + F_CLOSE), foot);
    } else if (/<\/footer>/.test(next)) {
      next = next.replace(/([ \t]*)<\/footer>/, `$1  ${foot}\n$1</footer>`);
    } else {
      noFooter.push(path.relative(WEB, file));
    }
  }

  const page = byUrl[url];
  if (page && page.kind === "hub") {
    if (!next.includes(G_OPEN)) noFooter.push(path.relative(WEB, file) + " (GUIDELIST 표식 없음)");
    else next = next.replace(new RegExp(G_OPEN + "[\\s\\S]*?" + G_CLOSE), () => guideListHtml());
  }
  if (page && page.related) {
    const block = relatedHtml(page);
    if (next.includes(R_OPEN)) {
      next = next.replace(new RegExp(R_OPEN + "[\\s\\S]*?" + R_CLOSE), () => block);
    } else if (next.includes("<!--LAWREF-->")) {
      next = next.replace("<!--LAWREF-->", () => block + "\n<!--LAWREF-->");
    } else {
      noFooter.push(path.relative(WEB, file) + " (LAWREF 표식 없음)");
    }
  }

  if (next !== src) {
    stale.push(path.relative(WEB, file));
    if (!CHECK) fs.writeFileSync(file, next, "utf8");
    changed++;
  }
}

console.log(`내비 항목 ${items.length}개: ${items.map((i) => i.nav).join(" / ")}`);
console.log(`푸터 링크 ${footItems.length}개: ${footItems.map((i) => i.title).join(" / ")}`);
console.log(`${CHECK ? "불일치" : "갱신된"} 파일: ${changed}개`);
if (skipped.length) console.log(`내비 없는 파일(정상): ${skipped.join(", ")}`);
if (noFooter.length) {
  console.error(`\n★ </footer> 가 없어 푸터 링크를 넣지 못한 파일: ${noFooter.join(", ")}`);
  process.exit(1);
}
if (CHECK && stale.length) {
  console.error(`\n★ 내비·푸터가 pages.js 와 어긋납니다: ${stale.join(", ")}`);
  console.error("  node build/nav.js 를 실행하세요.");
  process.exit(1);
}
