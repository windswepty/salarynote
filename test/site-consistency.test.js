/**
 * 화면에 적힌 숫자가 원장과 일치하는지 검사한다.
 *
 * 적대적 검증에서 나온 critical 결함에 대한 회귀 테스트다:
 * 요율이 HTML 본문 11곳에 손으로 박혀 있었고, 파이프라인·빌드·테스트 어디도
 * 원장과 대조하지 않았다. 첫 자동 갱신이 병합되는 순간 계산기는 새 요율로 계산하고
 * 같은 페이지 본문은 옛 요율을 단언하게 된다. 사용자는 어느 쪽이 맞는지 알 수 없다.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "web");
const L = require(path.join(ROOT, "tools", "lib", "resolve-ledger.js")).resolve();
const rates = JSON.parse(fs.readFileSync(L.ledgerPath, "utf8"));

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); console.log(`  PASS  ${n}`); pass++; } catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; } };

const htmls = (function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".html")) out.push(p);
  }
  return out;
})(WEB);

console.log("\n[사이트-원장 정합성]\n");

t("화면 숫자가 원장과 일치한다 (stamp --check)", () => {
  execFileSync(process.execPath, [path.join(ROOT, "build", "stamp.js"), "--check"], { stdio: "pipe" });
});

t("모든 계산기 페이지에 기준 정보 푸터가 있다", () => {
  const calc = htmls.filter((f) => !/404\.html|google[0-9a-f]+\.html|privacy/.test(f));
  assert.ok(calc.length >= 7, `계산기 페이지 ${calc.length}개`);
  for (const f of calc) {
    const s = fs.readFileSync(f, "utf8");
    assert.ok(s.includes("<!--STAMP:footer-->"), `${path.relative(WEB, f)} 에 푸터 표식 없음`);
  }
});

t("푸터에 자료 확인일(lastVerified)이 노출된다", () => {
  // 갱신이 몇 년 멈춰도 화면에 날짜가 있으면 사용자가 알아챌 수 있다.
  const s = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  assert.ok(s.includes(rates.lastVerified), `푸터에 ${rates.lastVerified} 가 없다`);
});

t("원장 밖에 살아있는 요율 숫자가 하드코딩돼 있지 않다", () => {
  const live = [
    [rates.nationalPension.totalRate, "국민연금 총요율"],
    [rates.healthInsurance.totalRate, "건강보험 총요율"],
    [rates.employmentInsurance.unemploymentTotalRate, "고용보험 요율"],
  ].map(([v, label]) => [(v * 100).toFixed(6).replace(/0+$/, "").replace(/\.$/, "") + "%", label]);

  const offenders = [];
  for (const f of htmls) {
    let s = fs.readFileSync(f, "utf8");
    // 표식 안쪽과 빌드가 생성한 블록은 정당하다.
    // <!--RATES--> <!--TABLE--> 처럼 짝을 이루는 주석 사이는 전부 생성물이라
    // 원장에서 나온 값일 수밖에 없다. 손으로 쓴 산문만 검사 대상이다.
    s = s.replace(/<span data-rate="[^"]+"[^>]*>[\s\S]*?<\/span>/g, "")
         .replace(/<!--STAMP:footer-->[\s\S]*?<!--\/STAMP-->/g, "")
         .replace(/<!--([A-Z]+)-->[\s\S]*?<!--\/\1-->/g, "")
         // 계산 예시·가이드 표는 build/examples.js 가 엔진·원장으로 만든다.
         .replace(/<!--EXAMPLE:[\w-]+-->[\s\S]*?<!--\/EXAMPLE-->/g, "");
    for (const [str, label] of live) {
      // 부분 문자열로 찾으면 안 된다. 실수령액표의 '89.5%' 안에 국민연금 '9.5%' 가,
      // '81.8%' 안에 고용보험 '1.8%' 가 들어 있어 멀쩡한 페이지가 걸린다.
      // 숫자 앞에 다른 숫자나 소수점이 붙어 있으면 다른 값이다.
      const re = new RegExp("(?<![\\d.])" + str.replace(/\./g, "\\."));
      if (re.test(s)) offenders.push(`${path.relative(WEB, f)}: ${label} ${str}`);
    }
  }
  assert.strictEqual(offenders.length, 0, "표식 밖 하드코딩:\n        " + offenders.join("\n        "));
});

t("번들이 해석된 원장의 값을 담고 있다", () => {
  // 연도가 바뀌었는데 번들러가 옛 원장을 읽으면 여기서 걸린다.
  const src = fs.readFileSync(path.join(WEB, "assets", "engine.js"), "utf8");
  const m = src.match(/"year":\s*(\d{4})/);
  assert.ok(m, "번들에 year 가 없다");
  assert.strictEqual(Number(m[1]), L.year, `번들 연도 ${m[1]} ≠ 해석된 원장 ${L.year}`);
  assert.ok(src.includes(`"lastVerified": "${rates.lastVerified}"`), "번들의 lastVerified 불일치");
});

/* ── 애드센스 ───────────────────────────────────────────────────
   코드가 한 페이지라도 빠지면 광고가 덜 나오는 게 아니라 소유권 확인이
   실패해 심사 자체가 막힌다. 페이지를 추가할 때 가장 잊기 쉬운 항목이라
   빌드 검사를 테스트로 강제한다. */

const ADS = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "adsense.json"), "utf8"));

t("애드센스 코드가 모든 페이지에 심어져 있다", () => {
  execFileSync(process.execPath, [path.join(ROOT, "build", "adsense.js"), "--check"],
    { cwd: ROOT, stdio: "pipe" });
});

t("파비콘 태그와 파일이 모두 있다", () => {
  execFileSync(process.execPath, [path.join(ROOT, "build", "favicon.js"), "--check"],
    { cwd: ROOT, stdio: "pipe" });
  // 태그만 있고 파일이 없으면 404 만 늘어난다. 로고로도 쓰는 svg 는 특히 눈에 띈다.
  for (const f of ["favicon.ico", "favicon.svg", "apple-touch-icon.png"])
    assert.ok(fs.existsSync(path.join(WEB, f)), `web/${f} 가 없다`);
});

t("상단바 구조가 전환 스크립트의 가정과 맞는다", () => {
  // nav-transition.js 는 .ptitle 과 main 만 갈아끼우고 .nav 는 aria-current 만
  // 고친다. 내비가 교체 대상 안으로 들어가면 전환 중에 통째로 사라져
  // 밑줄 애니메이션이 깨진다. 상단바가 .wrap 밖에 있어야 하는 이유다.
  for (const f of htmls) {
    const s = fs.readFileSync(f, "utf8");
    if (!s.includes('class="nav"')) continue;
    const rel = path.relative(WEB, f);
    const bar = s.indexOf('<header class="topbar">');
    const wrap = s.indexOf('<div class="wrap">');
    assert.ok(bar >= 0, `${rel}: 상단바가 없다`);
    assert.ok(bar < wrap, `${rel}: 상단바가 .wrap 안에 있다`);
    assert.ok(s.indexOf('class="nav"') < wrap, `${rel}: 내비가 .wrap 안에 있다`);
    assert.ok(s.indexOf('class="ptitle"') > wrap, `${rel}: ptitle 이 .wrap 밖에 있다`);
  }
});

t("게시자 ID 가 원장 밖에 하드코딩돼 있지 않다", () => {
  // HTML 과 ads.txt 는 생성물이라 당연히 들어 있다. 그 밖의 소스에 박혀 있으면
  // ID 를 바꿀 때 한쪽만 바뀌어 조용히 어긋난다.
  const LEDGER = path.join(ROOT, "data", "adsense.json");
  const offenders = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(js|json)$/.test(e.name) && f !== LEDGER
               && fs.readFileSync(f, "utf8").includes(ADS.publisherId))
        offenders.push(path.relative(ROOT, f));
    }
  };
  for (const dir of ["build", "src", "tools", "data"]) walk(path.join(ROOT, dir));
  assert.strictEqual(offenders.length, 0, "ID 하드코딩: " + offenders.join(", "));
});

t("ads.txt 가 애드센스 형식을 지킨다", () => {
  const txt = fs.readFileSync(path.join(WEB, "ads.txt"), "utf8");
  assert.ok(/\n$/.test(txt), "마지막 줄바꿈이 없으면 마지막 줄이 무시될 수 있다");
  const parts = txt.trim().split(/,\s*/);
  assert.strictEqual(parts[0], "google.com");
  assert.strictEqual(parts[1], ADS.publisherId, "ads.txt 의 게시자 ID 가 원장과 다르다");
  assert.strictEqual(parts[2], "DIRECT");
  assert.strictEqual(parts[3], "f08c47fec0942fa0", "구글 인증기관 ID 는 고정값이다");
});

t("오류 페이지에는 광고 코드를 넣지 않는다", () => {
  // 애드센스 프로그램 정책상 오류 페이지 게재는 금지다.
  const src = fs.readFileSync(path.join(WEB, "404.html"), "utf8");
  assert.ok(!src.includes("adsbygoogle"), "404 페이지에 광고 코드가 있다");
});

t("개인정보처리방침이 광고 쿠키를 고지한다", () => {
  // 제3자 광고 쿠키 고지는 애드센스 필수 요건이다. 없으면 반려된다.
  const src = fs.readFileSync(path.join(WEB, "privacy", "index.html"), "utf8");
  for (const need of ["쿠키", "AdSense", "제3자", "google.com/settings/ads"])
    assert.ok(src.includes(need), `방침에 '${need}' 고지가 없다`);
  assert.ok(!/광고를 게재하지 않으며/.test(src),
    "광고를 도입했는데 '게재하지 않는다'는 옛 문장이 남아 있다");
});
t("★FAQ 구조화 데이터가 본문과 같은 숫자를 말한다★", () => {
  // faq.js 의 치환 정규식이 한동안 [sS] 였다. 일반 문자열에서 "\s" 는 알려진
  // 이스케이프가 아니라 그냥 s 로 죽기 때문이다. 표식이 비어 있을 때는 0글자로
  // 매칭돼 잘 도는 것처럼 보이지만, 한 번 내용이 채워지면 그 뒤로 영영 다시
  // 쓰이지 않는다. 그래서 본문 요율을 고쳐도 구조화 데이터만 옛 숫자로 남아
  // 구글에는 틀린 값이 노출되고 있었다. 화면과 구조화 데이터를 대조한다.
  const strip = (x) => x.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const offenders = [];

  for (const f of htmls) {
    const src = fs.readFileSync(f, "utf8");
    const block = src.match(/<!--FAQ-->([\s\S]*?)<!--\/FAQ-->/);
    if (!block || !block[1].trim()) continue;

    const json = block[1].match(/<script[^>]*>([\s\S]*?)<\/script>/);
    if (!json) continue;

    // 본문(main)만 본다. head 의 구조화 데이터끼리 비교하면 의미가 없다.
    const body = strip(src.split("<main")[1] || "");
    for (const item of JSON.parse(json[1]).mainEntity) {
      for (const p of item.acceptedAnswer.text.match(/[\d.]+%/g) || [])
        if (!body.includes(p))
          offenders.push(`${path.relative(WEB, f)}: 구조화 데이터의 ${p} 가 본문에 없다`);
    }
  }
  assert.strictEqual(offenders.length, 0,
    "구조화 데이터가 본문과 어긋남:\n        " + offenders.join("\n        "));
});

t("★입력칸 속성에 연도가 박혀 있지 않다★", () => {
  // 실업급여 페이지에 max="2026-12-31" 이 손으로 적혀 있었다. 2027-01-01 이
  // 되면 그 달력은 작년까지만 고를 수 있고, 사용자는 이유를 모른 채 계산을
  // 못 한다. 본문 숫자만 원장과 맞추고 입력칸 속성은 감시망 밖에 두었던 탓이다.
  const offenders = [];
  for (const f of htmls) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/<(?:input|select)\s[^>]*>/g)) {
      const tag = m[0];
      if (!/(?:min|max|value)="[^"]*\d{4}-\d{2}-\d{2}"/.test(tag)) continue;
      if (/data-stamp=/.test(tag)) continue;   // 원장에서 찍히면 정당하다
      offenders.push(`${path.relative(WEB, f)}: ${tag.slice(0, 110)}`);
    }
  }
  assert.strictEqual(offenders.length, 0,
    "날짜가 손으로 박힌 입력칸:\n        " + offenders.join("\n        "));
});

t("★계산기 기본값이 원장 밖에서 오지 않는다★", () => {
  // 식대 비과세 20만원이 세 페이지에 손으로 적혀 있었고 원장에는 아예 없었다.
  // 한도가 바뀌면(2023년에 10만→20만 인상 전례) 계산기 기본값만 옛 금액으로
  // 남아 조용히 다른 답을 보여준다.
  const cap = rates.nonTaxable.mealAllowanceMonthlyCap;
  const asText = cap.toLocaleString("ko-KR");
  const offenders = [];
  for (const f of htmls) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/<input\s[^>]*>/g)) {
      const tag = m[0];
      if (!new RegExp(`value="${asText.replace(/,/g, ",")}"`).test(tag)) continue;
      if (/data-stamp=/.test(tag)) continue;
      offenders.push(`${path.relative(WEB, f)}: ${tag.slice(0, 110)}`);
    }
  }
  assert.strictEqual(offenders.length, 0,
    `비과세 한도(${asText})가 원장 없이 박힌 입력칸:\n        ` + offenders.join("\n        "));
});

t("실업급여 날짜 상한이 원장 코호트와 일치한다", () => {
  const u = JSON.parse(fs.readFileSync(
    path.join(ROOT, "data", `unemployment-${L.year}.json`), "utf8"));
  const wantMax = u.cohorts.map((c) => c.leaveDateTo).sort().pop();
  const src = fs.readFileSync(path.join(WEB, "unemployment", "index.html"), "utf8");
  const m = src.match(/id="uiLeave"[^>]*max="([^"]+)"/);
  assert.ok(m, "이직일 입력의 max 를 찾지 못했다");
  assert.strictEqual(m[1], wantMax,
    "달력 상한이 원장의 마지막 코호트 종료일과 다르다");
});

t("색인 진행표가 페이지 목록과 어긋나지 않는다", () => {
  // 새 계산기를 만들고 색인 요청 목록에 넣는 것을 잊으면, 만든 사람만 아는
  // 페이지가 된다. 검색 유입이 전부인 사이트에서 그건 안 만든 것과 같다.
  execFileSync(process.execPath,
    [path.join(ROOT, "tools", "index-status.js"), "--check"], { stdio: "pipe" });
});

t("근거 법령 블록이 원장과 일치한다 (law-refs --check)", () => {
  execFileSync(process.execPath, [path.join(ROOT, "build", "law-refs.js"), "--check"], { stdio: "pipe" });
});

t("모든 계산기 페이지에 근거 법령이 있다", () => {
  const REFS = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "law-refs.json"), "utf8"));
  const PAGES = require(path.join(ROOT, "build", "pages.js"));
  // 소개·개인정보처리방침은 계산을 하지 않으므로 근거 법령이 없는 것이 맞다.
  const exempt = new Set(["/about/", "/privacy/", "/guide/"]);
  const missing = PAGES.filter((p) => !exempt.has(p.url) && !REFS.pages[p.url]).map((p) => p.url);
  assert.strictEqual(missing.length, 0,
    `근거 법령이 없는 계산기 페이지: ${missing.join(", ")}`);
});

t("★근거 법령이 실제 화면에 나온다★", () => {
  const REFS = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "law-refs.json"), "utf8"));
  for (const [url, page] of Object.entries(REFS.pages)) {
    const file = path.join(WEB, url === "/" ? "index.html" : path.join(url.slice(1), "index.html"));
    const src = fs.readFileSync(file, "utf8");
    for (const k of page.articles) {
      const a = REFS.articles[k];
      // 조문 번호가 본문에 그대로 있어야 한다. 블록만 있고 내용이 비면 소용없다.
      assert.ok(src.includes(`${a.law} ${a.jo}`),
        `${url} 에 '${a.law} ${a.jo}' 가 없다`);
    }
  }
});

t("★근거 법령 링크가 법제처 주소 형식이다★", () => {
  const REFS = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "law-refs.json"), "utf8"));
  for (const [k, a] of Object.entries(REFS.articles)) {
    // 법령명에서 공백을 빼야 법제처가 200 을 준다. 공백이 남으면 404 가 된다.
    const want = `https://www.law.go.kr/법령/${a.law.replace(/\s+/g, "")}/${a.jo}`;
    assert.ok(/^제\d+조(의\d+)?$/.test(a.jo), `${k}: 조 형식이 이상하다 — ${a.jo}`);
    assert.ok(!want.includes(" "), `${k}: 링크에 공백이 남았다 — ${want}`);
  }
});

t("근거 법령 항목 수가 읽을 만한 범위다", () => {
  const REFS = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "law-refs.json"), "utf8"));
  // 너무 많으면 아무도 안 읽어서 근거를 다는 의미가 사라지고,
  // 비어 있으면 블록만 있고 내용이 없는 꼴이 된다.
  for (const [url, page] of Object.entries(REFS.pages)) {
    assert.ok(page.articles.length >= 1, `${url}: 비어 있다`);
    assert.ok(page.articles.length <= 10, `${url}: ${page.articles.length}개로 너무 많다`);
    assert.ok(page.note && page.note.includes("법적 효력은 없습니다"),
      `${url}: 면책 문구가 없다`);
  }
});

t("★법령 근거가 HTML 에 손으로 적혀 있지 않다★", () => {
  // 손으로 적은 법령은 아무도 검증하지 않는다. 실제로 실업급여 푸터의
  // '고용보험법 시행규칙 제91조' 는 전혀 다른 내용(수강증명서)이었다.
  const offenders = [];
  for (const f of htmls) {
    const src = fs.readFileSync(f, "utf8");
    if (/<p>근거:/.test(src)) offenders.push(path.relative(WEB, f));
  }
  assert.strictEqual(offenders.length, 0,
    `푸터에 손으로 적은 근거 줄이 남아 있다: ${offenders.join(", ")}`);
});

t("모든 계산기 페이지에 면책 문구가 있다", () => {
  const REFS = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "law-refs.json"), "utf8"));
  for (const url of Object.keys(REFS.pages)) {
    const file = path.join(WEB, url === "/" ? "index.html" : path.join(url.slice(1), "index.html"));
    const src = fs.readFileSync(file, "utf8");
    assert.ok(src.includes("<!--LAWNOTE-->"), `${url} 에 면책 표식이 없다`);
    assert.ok(src.includes(REFS.pages[url].note), `${url} 의 면책 문구가 원장과 다르다`);
  }
});

t("근거 법령 원장에 죽은 키가 없다", () => {
  const REFS = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "law-refs.json"), "utf8"));
  const used = new Set(Object.values(REFS.pages).flatMap((p) => p.articles));
  for (const k of used) {
    assert.ok(REFS.articles[k], `pages 가 가리키는 조문이 없다: ${k}`);
  }
  const unused = Object.keys(REFS.articles).filter((k) => !used.has(k));
  assert.strictEqual(unused.length, 0, `어느 페이지에서도 안 쓰는 조문: ${unused.join(", ")}`);
});


t("애드센스 상태가 원장과 일치한다 (adsense --check)", () => {
  execFileSync(process.execPath, [path.join(ROOT, "build", "adsense.js"), "--check"], { stdio: "pipe" });
});

t("★광고 스위치를 껐다 켜면 바이트가 그대로다★", () => {
  // 위치가 흔들리면 내용이 같은데도 16개 파일이 '바뀜' 으로 잡히고,
  // set-base-url.js 가 내용 해시로 lastmod 를 정하므로 sitemap 이 전 페이지를
  // '오늘 수정됨' 으로 신고한다. 그런 거짓 신고가 반복되면 구글이 우리
  // lastmod 를 믿지 않게 되고, 진짜 바뀐 날 재크롤링이 늦어진다.
  const ads = path.join(ROOT, "build", "adsense.js");
  const ledger = path.join(ROOT, "data", "adsense.json");

  const before = new Map();
  for (const f of htmls) before.set(f, fs.readFileSync(f, "utf8"));
  const adsTxt = path.join(WEB, "ads.txt");
  const adsBefore = fs.existsSync(adsTxt) ? fs.readFileSync(adsTxt, "utf8") : null;
  const ledgerBefore = fs.readFileSync(ledger, "utf8");

  try {
    execFileSync(process.execPath, [ads, "--off"], { stdio: "pipe" });
    // 꺼진 동안에는 광고 흔적이 하나도 없어야 한다.
    for (const f of htmls) {
      const s = fs.readFileSync(f, "utf8");
      assert.ok(!s.includes("adsbygoogle"), `${path.relative(WEB, f)} 에 광고 코드가 남아 있다`);
      assert.ok(!s.includes("<!--ADSENSE-->"), `${path.relative(WEB, f)} 에 광고 표식이 남아 있다`);
    }
    assert.ok(!fs.existsSync(adsTxt), "꺼진 상태인데 ads.txt 가 남아 있다");

    execFileSync(process.execPath, [ads, "--on"], { stdio: "pipe" });
  } finally {
    // 테스트가 중간에 깨져도 원래 상태로 돌려놓는다.
    if (fs.readFileSync(ledger, "utf8") !== ledgerBefore) fs.writeFileSync(ledger, ledgerBefore, "utf8");
  }

  for (const [f, s] of before) {
    assert.strictEqual(fs.readFileSync(f, "utf8"), s,
      `${path.relative(WEB, f)} 가 껐다 켠 뒤 달라졌다`);
  }
  const adsAfter = fs.existsSync(adsTxt) ? fs.readFileSync(adsTxt, "utf8") : null;
  assert.strictEqual(adsAfter, adsBefore, "ads.txt 가 껐다 켠 뒤 달라졌다");
});

t("광고 코드는 언제나 </head> 바로 앞에 온다", () => {
  // 자리가 하나여야 껐다 켜도 같은 결과가 나온다.
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "adsense.json"), "utf8"));
  if (cfg.enabled === false) return; // 꺼진 상태에서는 검사할 것이 없다
  for (const f of htmls) {
    const s = fs.readFileSync(f, "utf8");
    if (!s.includes("<!--ADSENSE-->")) continue;
    const after = s.slice(s.indexOf("<!--/ADSENSE-->"));
    assert.ok(/^<!--\/ADSENSE-->\s*<\/head>/i.test(after),
      `${path.relative(WEB, f)}: 광고 코드가 </head> 바로 앞이 아니다`);
  }
});

t("★canonical·robots·sitemap·빌드 기본값이 모두 같은 주소다★", () => {
  // 주소를 바꿀 때 한 곳이라도 옛 주소로 남으면 구글이 받는 신호가 엇갈린다.
  // 실제로 set-base-url.js 는 __BASE_URL__ 토큰만 치환했는데, 토큰은 첫 배포 때
  // 이미 사라져서 .kr 로 옮기려 하자 sitemap 만 바뀌고 canonical 16곳과
  // robots.txt 는 pages.dev 에 남을 뻔했다. 절반만 옮긴 사이트는 색인에 해롭다.
  const sitemap = fs.readFileSync(path.join(WEB, "sitemap.xml"), "utf8");
  const origin = (sitemap.match(/<loc>(https?:\/\/[^/<]+)\//) || [])[1];
  assert.ok(origin, "sitemap.xml 에서 주소를 찾지 못했다");

  const allJs = fs.readFileSync(path.join(ROOT, "build", "all.js"), "utf8");
  const dflt = (allJs.match(/SN_BASE_URL \|\| "([^"]+)"/) || [])[1];
  assert.strictEqual(dflt, origin, "build/all.js 의 기본 주소가 sitemap 과 다르다 — 다음 빌드가 주소를 되돌린다");

  const robots = fs.readFileSync(path.join(WEB, "robots.txt"), "utf8");
  assert.ok(robots.includes(`Sitemap: ${origin}/sitemap.xml`), `robots.txt 의 Sitemap 이 ${origin} 이 아니다`);

  let n = 0;
  for (const f of htmls) {
    const m = fs.readFileSync(f, "utf8").match(/<link rel="canonical" href="([^"]+)"/);
    if (!m) continue;
    n++;
    assert.ok(m[1].startsWith(origin + "/"), `${path.relative(WEB, f)} 의 canonical 이 ${m[1]} 이다(기대: ${origin})`);
  }
  assert.ok(n >= 15, `canonical 이 있는 페이지가 ${n}개뿐이다`);
});

t("오류 페이지에는 광고가 붙지 않는다", () => {
  // 애드센스 프로그램 정책. 붙으면 계정 제재 사유가 된다.
  const notFound = path.join(WEB, "404.html");
  if (!fs.existsSync(notFound)) return;
  const s = fs.readFileSync(notFound, "utf8");
  assert.ok(!s.includes("adsbygoogle"), "404.html 에 광고 코드가 있다");
});


t("내비·푸터가 pages.js 와 일치한다 (nav --check)", () => {
  execFileSync(process.execPath, [path.join(ROOT, "build", "nav.js"), "--check"], { stdio: "pipe" });
});

t("★사이트 안에서 도달할 수 없는 페이지가 없다★", () => {
  // /about/ 은 인바운드 링크가 0개라 서치콘솔이 '참조 페이지: 감지된 페이지
  // 없음' 이라고 했고 색인되지 않았다. 링크가 없는 페이지는 구글이 중요하지
  // 않다고 본다. sitemap 에만 있는 것으로는 부족하다.
  const PAGES = require(path.join(ROOT, "build", "pages.js"));
  const inbound = new Map(PAGES.map((p) => [p.url, 0]));

  for (const f of htmls) {
    const rel = "/" + path.relative(WEB, f).split(path.sep).join("/");
    const self = rel.replace(/index\.html$/, "");
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/href="(\/[^"#?]*)"/g)) {
      const target = m[1];
      if (target === self) continue;              // 자기 자신은 세지 않는다
      if (inbound.has(target)) inbound.set(target, inbound.get(target) + 1);
    }
  }

  const orphans = [...inbound].filter(([, n]) => n === 0).map(([u]) => u);
  assert.strictEqual(orphans.length, 0,
    `사이트 안에서 링크되지 않는 페이지: ${orphans.join(", ")}`);

  // 한 곳에서만 링크되는 페이지도 위험하다. 그 한 곳이 고아면 같이 묻힌다.
  const weak = [...inbound].filter(([, n]) => n < 3).map(([u, n]) => `${u}(${n})`);
  assert.strictEqual(weak.length, 0, `인바운드 링크가 너무 적은 페이지: ${weak.join(", ")}`);
});

t("모든 페이지에서 개인정보처리방침에 닿을 수 있다", () => {
  // 애드센스 정책상 개인정보처리방침은 쉽게 찾을 수 있어야 한다.
  for (const f of htmls) {
    const rel = path.relative(WEB, f).split(path.sep).join("/");
    if (rel === "404.html" || rel.startsWith("google") || rel === "privacy/index.html") continue;
    const src = fs.readFileSync(f, "utf8");
    assert.ok(src.includes('href="/privacy/"'), `${rel} 에 개인정보처리방침 링크가 없다`);
  }
});

t("404 페이지에는 푸터 링크를 넣지 않는다", () => {
  // sitemap 에도 없고 검색에 걸려서도 안 되는 페이지다.
  const f = path.join(WEB, "404.html");
  if (!fs.existsSync(f)) return;
  assert.ok(!fs.readFileSync(f, "utf8").includes("<!--FOOTLINKS-->"),
    "404.html 에 푸터 링크가 들어갔다");
});


t("계산 예시가 엔진·원장과 일치한다 (examples --check)", () => {
  // 예시 숫자를 손으로 고치거나 원장만 바뀌면 본문과 계산기가 다른 답을 낸다.
  execFileSync(process.execPath, [path.join(ROOT, "build", "examples.js"), "--check"], { stdio: "pipe" });
});

t("설명 글 안에 <div> 가 없다 (FAQ 구조화 데이터가 잘리지 않는다)", () => {
  // faq.js 는 'card prose' 를 첫 </div> 까지만 읽는다. 안에 div 가 끼면
  // 그 뒤의 질문이 구조화 데이터에서 조용히 사라진다.
  const bad = htmls.filter((f) => {
    const m = fs.readFileSync(f, "utf8").match(/<div class="card prose">([\s\S]*?)\n<\/div>/);
    return m && /<div[\s>]/.test(m[1]);
  }).map((f) => path.relative(WEB, f));
  assert.strictEqual(bad.length, 0, `prose 안에 div: ${bad.join(", ")}`);
});

t("계산기마다 본문 속 링크로 2곳 이상에서 연결된다 (related)", () => {
  // 상단 메뉴 링크만 있던 /monthly-salary/ 를 서치콘솔이 '참조 페이지: 감지된
  // 페이지 없음' 으로 보였다(2026-10). 메뉴 밖 본문 링크로도 이어져야 한다.
  const PAGES = require(path.join(ROOT, "build", "pages.js"));
  const calc = PAGES.filter((p) => p.related);
  const inbound = Object.fromEntries(calc.map((p) => [p.url, new Set()]));
  for (const p of calc) for (const u of p.related) if (inbound[u]) inbound[u].add(p.url);
  const weak = calc.filter((p) => inbound[p.url].size < 2).map((p) => p.url);
  assert.strictEqual(weak.length, 0, `related 로 2곳 미만에서만 연결: ${weak.join(", ")}`);
  execFileSync(process.execPath, [path.join(ROOT, "build", "nav.js"), "--check"], { stdio: "pipe" });
});

t("계산기 페이지의 설명 글이 얇지 않다", () => {
  // 2026-10 애드센스가 '가치가 별로 없는 콘텐츠' 로 거절했다. 설명이 짧은
  // 계산기 페이지는 흔한 계산기와 구별되지 않는다. 공백을 뺀 글자 수로 센다.
  const PAGES = require(path.join(ROOT, "build", "pages.js"));
  const MIN = 1300;
  const exempt = new Set(["/salary-table/", "/insurance-rates/", "/about/", "/privacy/", "/guide/"]); // 표가 본문이거나 목록 페이지
  const thin = PAGES.filter((p) => !exempt.has(p.url)).map((p) => {
    const f = path.join(WEB, p.url === "/" ? "index.html" : path.join(p.url.slice(1), "index.html"));
    const m = fs.readFileSync(f, "utf8").match(/<div class="card prose">([\s\S]*?)\n<\/div>/);
    const n = m ? m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, "").length : 0;
    return { url: p.url, n };
  }).filter((x) => x.n < MIN);
  assert.strictEqual(thin.length, 0, `설명 글 ${MIN}자 미만: ${thin.map((x) => `${x.url} ${x.n}자`).join(", ")}`);
});


console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
