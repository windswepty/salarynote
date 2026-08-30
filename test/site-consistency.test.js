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
         .replace(/<!--([A-Z]+)-->[\s\S]*?<!--\/\1-->/g, "");
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

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
