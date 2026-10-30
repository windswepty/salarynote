/**
 * 배포된 사이트를 실제로 열어 점검한다. 저장소 테스트가 보지 못하는 것
 * (Cloudflare 설정, 리디렉트, 외부 법령 링크)을 본다.
 *
 *   node tools/live-check.js            전체 점검 (법령 링크 포함, 1분 남짓)
 *   node tools/live-check.js --fast     법령 링크는 건너뛴다
 *
 * 문제가 하나라도 있으면 exit 1.
 */
const path = require("path");
const PAGES = require(path.join(__dirname, "..", "build", "pages.js"));

const BASE = "https://salarynote.kr";
// 게시자 ID 는 원장(data/adsense.json) 한 곳에만 둔다.
const PUB = require(path.join(__dirname, "..", "data", "adsense.json")).publisherId.replace(/^ca-/, "");
const FAST = process.argv.includes("--fast");
// 애드센스 크롤러 이름으로 연다. Cloudflare 봇 차단이 이 이름을 막으면 심사가 통째로 실패한다.
const UA = { "user-agent": "Mozilla/5.0 (compatible; Mediapartners-Google)" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const issues = [];
  const internal = new Set();
  const law = new Set();

  for (const p of PAGES) {
    const r = await fetch(BASE + p.url, { headers: UA, redirect: "manual" });
    const h = await r.text();
    const can = (h.match(/rel="canonical" href="([^"]+)"/) || [])[1];
    const desc = (h.match(/<meta name="description" content="([^"]*)"/) || [])[1] || "";
    const h1 = (h.match(/<h1[\s>]/g) || []).length;
    const checks = {
      status: r.status === 200,
      h1: h1 === 1,
      canonical: can === BASE + p.url,
      adsense: h.includes("ca-" + PUB),
      lang: /<html lang="ko"/.test(h),
      viewport: /name="viewport"/.test(h),
      description: desc.length >= 50 && desc.length <= 160,
      // Cloudflare 이메일 난독화가 문의처를 가리면 심사자에게 연락처가 안 보인다.
      email: !/email-protection|__cf_email__/.test(h),
      // 치환되지 않은 토큰이나 계산 실패 흔적.
      clean: !/__BASE_URL__|__CONTACT_EMAIL__|NaN원|\[object /.test(h.replace(/<script[\s\S]*?<\/script>/g, "")),
    };
    for (const m of h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      try { JSON.parse(m[1]); } catch { checks.jsonld = false; }
    }
    const bad = Object.entries(checks).filter(([, ok]) => ok === false).map(([k]) => k);
    console.log(`${r.status} ${p.url.padEnd(30)} ${bad.length ? "★ " + bad.join(", ") : "ok"}`);
    if (bad.length) issues.push(`${p.url}: ${bad.join(", ")}`);
    for (const m of h.matchAll(/href="(\/[^"#]*)"/g)) if (!m[1].startsWith("/cdn-cgi")) internal.add(m[1]);
    for (const m of h.matchAll(/href="(https:\/\/www\.law\.go\.kr[^"]+)"/g)) law.add(m[1]);
  }

  for (const u of internal) {
    const r = await fetch(BASE + u, { redirect: "manual" });
    if (r.status !== 200) issues.push(`내부 링크 ${u} → ${r.status}`);
  }
  console.log(`\n내부 링크 ${internal.size}개 확인`);

  if (!FAST) {
    for (const u of law) {
      const r = await fetch(u).catch(() => ({ status: "ERR" }));
      if (r.status !== 200) issues.push(`법령 링크 ${u} → ${r.status}`);
      await sleep(900);   // 법제처는 연달아 요청하면 끊는다
    }
    console.log(`법령 링크 ${law.size}개 확인`);
  }

  const expect = [
    ["/ads.txt", 200], ["/robots.txt", 200], ["/sitemap.xml", 200], ["/favicon.ico", 200], ["/no-such-page/", 404],
  ];
  for (const [u, code] of expect) {
    const r = await fetch(BASE + u, { redirect: "manual" });
    if (r.status !== code) issues.push(`${u} → ${r.status} (기대 ${code})`);
  }
  const ads = await (await fetch(BASE + "/ads.txt")).text();
  if (!ads.includes(PUB)) issues.push("ads.txt 에 게시자 ID 없음");
  const sm = await (await fetch(BASE + "/sitemap.xml")).text();
  const locs = (sm.match(/<loc>/g) || []).length;
  if (locs !== PAGES.length) issues.push(`sitemap URL ${locs}개 ≠ 페이지 ${PAGES.length}개`);

  // 옛 주소·www·http 는 경로를 유지한 채 https://salarynote.kr 로 넘어가야 한다.
  for (const from of ["https://salarynote.pages.dev/annual-leave/", "https://www.salarynote.kr/annual-leave/", "http://salarynote.kr/annual-leave/"]) {
    const r = await fetch(from, { redirect: "manual" }).catch(() => null);
    const to = r && r.headers.get("location");
    if (!r || r.status !== 301 || to !== BASE + "/annual-leave/") issues.push(`리디렉트 ${from} → ${r ? r.status + " " + to : "연결 실패"}`);
  }
  console.log("특수 파일·리디렉트 확인");

  console.log(issues.length ? `\n문제 ${issues.length}건:\n  ${issues.join("\n  ")}` : "\n문제 없음");
  process.exit(issues.length ? 1 : 0);
})();
