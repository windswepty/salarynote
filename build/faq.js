/**
 * 각 페이지의 <h2>질문 + 뒤따르는 문단으로 FAQPage 구조화 데이터를 생성한다.
 *
 * 본문을 그대로 쓰기 때문에 글을 고치면 구조화 데이터도 같이 따라간다.
 * 손으로 따로 관리하면 본문과 어긋나는데, 구글은 그것을 스팸 신호로 본다.
 *
 * 물음표로 끝나는 h2 만 대상으로 삼는다(설명형 제목은 FAQ 가 아니다).
 */
const fs = require("fs");
const path = require("path");

const WEB = path.join(__dirname, "..", "web");
const MARK_OPEN = "<!--FAQ-->";
const MARK_CLOSE = "<!--/FAQ-->";

const strip = (h) => h.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const esc = (s) => s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));

function extract(html) {
  const prose = html.match(/<div class="card prose">([\s\S]*?)<\/div>/);
  if (!prose) return [];
  const parts = prose[1].split(/<h2>/).slice(1);
  const out = [];
  for (const p of parts) {
    const q = strip(p.slice(0, p.indexOf("</h2>")));
    // 한국어 제목은 물음표 없이 '~나요' 로 끝나는 경우가 많다.
    // 물음표만 보면 거의 다 걸러지므로 의문형 어미도 함께 본다.
    const isQuestion = /[?？]$/.test(q) || /(나요|가요|까요|난가요|건가요|하나요|되나요|인가요|습니다만)$/.test(q);
    if (!isQuestion) continue;
    const body = p.slice(p.indexOf("</h2>") + 5);
    const paras = [...body.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => strip(m[1]));
    const a = paras.join(" ");
    if (q && a && a.length >= 30) out.push({ q, a });
  }
  return out;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === "index.html") out.push(p);
  }
  return out;
}

let total = 0, pages = 0;
for (const file of walk(WEB)) {
  const src = fs.readFileSync(file, "utf8");
  const faqs = extract(src);

  const block = faqs.length
    ? MARK_OPEN +
      '\n<script type="application/ld+json">\n' +
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: faqs.map((f) => ({
          "@type": "Question",
          name: esc(f.q),
          acceptedAnswer: { "@type": "Answer", text: esc(f.a) },
        })),
      }, null, 1) +
      "\n</script>\n" + MARK_CLOSE
    : MARK_OPEN + MARK_CLOSE;

  let next;
  if (src.includes(MARK_OPEN)) {
    next = src.replace(new RegExp(MARK_OPEN + "[\s\S]*?" + MARK_CLOSE), block);
  } else {
    next = src.replace("</head>", block + "\n</head>");
  }
  if (next !== src) fs.writeFileSync(file, next, "utf8");
  if (faqs.length) { pages++; total += faqs.length; }
}
console.log(`FAQ 구조화 데이터: ${pages}개 페이지, 질문 ${total}개`);
