#!/usr/bin/env node
/**
 * 요율 수집기 — 각 항목을 2개 이상 독립 출처에서 가져온다.
 *
 * 이 스크립트는 원장(data/rates-*.json)을 절대 건드리지 않는다.
 * 관측 결과(observations)만 JSON 으로 떨어뜨린다. 판단은 sanity-check / update-rates 가 한다.
 *
 * 출처 등급
 *  primary   : 법제처 law.go.kr DRF (법령·고시 원문). 정본.
 *  secondary : 4대사회보험 정보연계센터 / 최저임금위원회 / 국민연금공단.
 *  ★국세청 안내 웹페이지(nts.go.kr)는 어떤 등급으로도 쓰지 않는다.★
 *    구버전을 노출해 실제로 자녀공제액을 틀리게 넣은 전례가 있다.
 *
 * 자동 병합 자격
 *  독립 출처 2개 이상이 같은 값을 낼 때만 autoMerge=true.
 *  출처가 하나뿐인 항목(건강보험료 상·하한, 자녀공제액)은 singleSource=true 로
 *  명시하고 자동 병합 대상에서 뺀다. 사람이 반드시 본다.
 *
 * 실행:
 *   node tools/fetch-rates.js [--year 2026] [--out data/candidates/observations-2026.json]
 *   환경변수 LAW_OC (없으면 test)
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const net = require(path.join(__dirname, "lib", "net.js"));
const law = require(path.join(__dirname, "lib", "law-go-kr.js"));

const { get, matchOne, num, stripTags } = net;

// ── 관측 수집기 ─────────────────────────────────────────────────
const observations = [];
const failures = [];
const notes = [];

/**
 * ★API 키 유출 방지★
 * 법제처 DRF URL 에는 OC 파라미터가 들어 있다. LAW_OC 시크릿을 쓰는 경우
 * 그 URL 을 원장이나 PR 본문에 그대로 실으면 비공개 저장소라도 시크릿이 평문으로 남는다.
 * 기록 전에 OC 값을 지운다.
 */
function scrubOc(url) {
  return String(url || "").replace(/([?&]OC=)[^&]*/gi, "$1<OC>");
}

/**
 * @param {string} fact      원장 경로에 대응하는 팩트 키
 * @param {string} sourceId  독립 출처 식별자. 같은 id 는 독립으로 세지 않는다.
 * @param {'primary'|'secondary'} tier
 * @param {string} url       조회에 쓴 URL(OC 는 마스킹된다)
 * @param {string} [cite]    원장 source 필드에 넣을 사람이 열어볼 수 있는 영구 링크.
 *                           DRF URL 은 API 엔드포인트라 사람이 열면 쓸모가 없다.
 */
function rec(fact, sourceId, tier, value, url, quote, cite) {
  observations.push({
    fact,
    sourceId,
    tier,
    value,
    url: scrubOc(url),
    cite: cite || null,
    quote: (quote || "").slice(0, 300),
  });
}

/** law.go.kr 의 사람용 영구 링크. 법령명·행정규칙명은 개정돼도 바뀌지 않는다. */
const citeLaw = (name) => `https://www.law.go.kr/법령/${encodeURIComponent(name)}`;
const citeAdmrul = (name) => `https://www.law.go.kr/행정규칙/${encodeURIComponent(name)}`;

async function step(label, fn) {
  try {
    await fn();
  } catch (e) {
    failures.push({ step: label, error: String(e && e.message ? e.message : e) });
    process.stderr.write(`  [FAIL] ${label}: ${e && e.message ? e.message : e}\n`);
  }
}

// ── 1. 법제처: 국민연금 요율 (부칙 제4조제1항) ───────────────────
async function lawPension(year) {
  const a = await law.lawAddenda("국민연금법");
  const idx = a.lines.findIndex((l) =>
    /사업장가입자의 연금보험료 중 사업장가입자의 기여금 및 사용자의 부담금/.test(l)
  );
  if (idx < 0) {
    throw new Error(
      "국민연금법 부칙 제4조제1항(사업장가입자 기여금·부담금) 블록을 찾지 못했습니다. " +
        "★본문 제88조제3항으로 폴백하면 안 됩니다★ — 본문은 1천분의 65(13%)로 2033년 최종값입니다."
    );
  }
  const block = a.lines.slice(idx, idx + 12).join("\n");
  // 부칙 제4조제2항은 지역가입자용(1천분의 95)이므로 '1만분의' 패턴만 잡는다.
  const m = matchOne(block, new RegExp(`${year}년은 1만분의 ([0-9,]+)`), `국민연금 ${year}년 부칙 요율`);
  const halfRate = num(m[1]) / 10000;
  const total = Math.round(halfRate * 2 * 1e6) / 1e6;

  if (year >= 2033) {
    notes.push(
      `${year}년은 부칙 제4조의 열거 구간(~2032)을 넘었을 수 있습니다. 부칙에서 값을 찾았다면 그대로 쓰되, ` +
        `못 찾으면 본문 제88조제3항(13%)으로 명시적으로 분기해야 합니다.`
    );
  }
  rec("nationalPension.totalRate", "law.go.kr", "primary", total, a.url, m[0], citeLaw("국민연금법"));
  rec("nationalPension.employeeRate", "law.go.kr", "primary", halfRate, a.url, m[0], citeLaw("국민연금법"));
}

// ── 2. 법제처: 건강보험료율 (시행령 제44조제1항) ─────────────────
async function lawHealth() {
  const a = await law.lawArticle("국민건강보험법 시행령", "004400");
  const text = a.lines.join("\n");
  const m = matchOne(text, /직장가입자의 보험료율[\s\S]{0,120}?1만분의 ([0-9,]+)/, "건강보험료율");
  const total = num(m[1]) / 10000;
  rec("healthInsurance.totalRate", "law.go.kr", "primary", total, a.url, m[0], citeLaw("국민건강보험법 시행령"));
  rec("healthInsurance.employeeRate", "law.go.kr", "primary", Math.round((total / 2) * 1e6) / 1e6, a.url, m[0], citeLaw("국민건강보험법 시행령"));
}

// ── 3. 법제처: 장기요양보험료율 (시행령 제4조) ───────────────────
async function lawLtc() {
  const a = await law.lawArticle("노인장기요양보험법 시행령", "000400");
  const text = a.lines.join("\n");
  const m = matchOne(text, /장기요양보험료율은 100만분의 ([0-9,]+)/, "장기요양보험료율");
  // 100만분율이며 기준은 '보수월액' 이다. 건강보험료 대비 13.14% 는 파생 표시값이다.
  rec("longTermCare.rateOfIncome", "law.go.kr", "primary", num(m[1]) / 1e6, a.url, m[0], citeLaw("노인장기요양보험법 시행령"));
}

// ── 4. 법제처: 고용보험 실업급여 요율 (보험료징수법 시행령 제12조) ──
async function lawEmployment() {
  const a = await law.lawArticle(
    "고용보험 및 산업재해보상보험의 보험료징수 등에 관한 법률 시행령",
    "001200"
  );
  const text = a.lines.join("\n");
  const m = matchOne(text, /실업급여의 보험료율: 1천분의 ([0-9,]+)/, "고용보험 실업급여 요율");
  const total = num(m[1]) / 1000;
  rec("employmentInsurance.unemploymentTotalRate", "law.go.kr", "primary", total, a.url, m[0], citeLaw("고용보험 및 산업재해보상보험의 보험료징수 등에 관한 법률 시행령"));
  rec("employmentInsurance.employeeRate", "law.go.kr", "primary", Math.round((total / 2) * 1e6) / 1e6, a.url, m[0], citeLaw("고용보험 및 산업재해보상보험의 보험료징수 등에 관한 법률 시행령"));
  // ★고용보험 실업급여 요율은 시행일이 1월 1일이 아니었던 전례가 있다(2019-10-01, 2022-07-01).★
  //  다만 lawSearch 가 주는 '시행일자' 는 시행령 전체의 시행일이지 이 조항의 시행일이 아니다.
  //  둘을 혼동하면 원장의 effectiveFrom 이 조용히 틀린다. 그래서 값으로 쓰지 않고
  //  참고 팩트로만 기록해 사람이 부칙을 읽도록 넘긴다.
  if (a.effective) {
    rec("$reference.employmentInsurance.decreeEffective", "law.go.kr", "primary", isoDate(a.effective), a.url, `시행령 전체 시행일자 ${a.effective}`);
    notes.push(
      `고용보험 실업급여 요율의 시행일은 자동 추출하지 않습니다. 조회된 ${isoDate(a.effective)} 는 ` +
        `보험료징수법 시행령 '전체' 의 시행일이며 제12조제1항제2호의 시행일이 아닙니다. ` +
        `요율이 실제로 바뀌면 부칙을 사람이 읽어 effectiveFrom 을 정해야 합니다.`
    );
  }
}

// ── 5. 법제처: 국민연금 기준소득월액 상·하한 (복지부 고시) ────────
async function lawBaseIncome(year) {
  const { hits } = await law.admrulFind("기준소득월액", "국민연금 기준소득월액 하한액과 상한액");
  const id = hits[0]["행정규칙일련번호"];
  const b = await law.admrulBody(id);
  // ★'개정문' 필드는 "400천원을 410천원으로" 형태의 diff 다. 쓰면 직전 연도 값을 넣게 된다.
  //  반드시 '조문내용'(통합본)을 쓴다.
  const s = b.text;
  const lo = matchOne(s, /하한액\s*:\s*([0-9,]+)천원/, "기준소득월액 하한");
  const hi = matchOne(s, /상한액\s*:\s*([0-9,]+)천원/, "기준소득월액 상한");
  const per = s.match(/적용기간\s*:\s*(\d{4})년도\s*(\d+)월분부터\s*(\d{4})년도\s*(\d+)월분까지/);
  rec("nationalPension.baseIncome.min", "law.go.kr", "primary", num(lo[1]) * 1000, b.url, lo[0], citeAdmrul("국민연금 기준소득월액 하한액과 상한액"));
  rec("nationalPension.baseIncome.max", "law.go.kr", "primary", num(hi[1]) * 1000, b.url, hi[0], citeAdmrul("국민연금 기준소득월액 하한액과 상한액"));
  if (per) {
    rec("nationalPension.baseIncome.from", "law.go.kr", "primary", `${per[1]}-07-01`, b.url, per[0]);
    rec("nationalPension.baseIncome.to", "law.go.kr", "primary", `${per[3]}-06-30`, b.url, per[0]);
    if (Number(per[2]) !== 7 || Number(per[4]) !== 6) {
      notes.push(`기준소득월액 적용기간이 7월~6월이 아닙니다: ${per[0]}. 구간 규칙 재확인 필요.`);
    }
  } else {
    notes.push("기준소득월액 고시에서 적용기간을 파싱하지 못했습니다. 구간 시작·종료일을 사람이 확인해야 합니다.");
  }
}

// ── 6. 법제처: 건강보험 월보험료 상·하한 (복지부 고시) — ★단일 출처★ ──
async function lawHealthPremiumBounds() {
  const { hits } = await law.admrulFind("월별 보험료액의 상한과 하한", "월별 건강보험료액의 상한과 하한에 관한 고시");
  const id = hits[0]["행정규칙일련번호"];
  const b = await law.admrulBody(id);
  const s = b.text;
  const up = matchOne(s, /상한액[\s\S]{0,200}?직장가입자의 보수월액보험료\s*:\s*([0-9,]+)원/, "건보 보험료 상한");
  const lo = matchOne(s, /하한액[\s\S]{0,200}?직장가입자의 보수월액보험료\s*:\s*([0-9,]+)원/, "건보 보험료 하한");
  rec("healthInsurance.premiumBounds.max", "law.go.kr", "primary", num(up[1]), b.url, up[0], citeAdmrul("월별 건강보험료액의 상한과 하한에 관한 고시"));
  rec("healthInsurance.premiumBounds.min", "law.go.kr", "primary", num(lo[1]), b.url, lo[0], citeAdmrul("월별 건강보험료액의 상한과 하한에 관한 고시"));
  notes.push(
    "건강보험 월보험료 상·하한은 법제처 고시 원문 1개 출처뿐입니다(공단 페이지는 robots.txt 로 자동 수집 불가). " +
      "★자동 병합 대상이 아닙니다.★ clamp 대상은 보수월액이 아니라 '보험료액' 이며 노사 합산 기준입니다."
  );
}

// ── 7. 법제처: 최저임금 고시 PDF ────────────────────────────────
/**
 * pdftotext(poppler-utils) 실행 파일을 찾는다.
 * Windows + Git Bash 에서는 /mingw64/bin 에 있지만 node 가 보는 PATH 에는 없다.
 * PDFTOTEXT 환경변수로 직접 지정할 수 있다.
 */
function findPdftotext() {
  const candidates = [
    process.env.PDFTOTEXT,
    "pdftotext",
    "C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe",
    "/mingw64/bin/pdftotext",
    "/usr/bin/pdftotext",
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      execFileSync(c, ["-v"], { stdio: "ignore" });
      return c;
    } catch (e) {
      // ★xpdf 계열 pdftotext 는 '-v' 에 대해 종료 코드 99 를 낸다.★
      // 종료 코드만 보고 '없음' 으로 판정하면 실제로는 설치돼 있는데 건너뛴다.
      // 실행 파일 자체를 못 찾은 경우(ENOENT/EACCES)만 '없음' 으로 본다.
      if (e && (e.code === "ENOENT" || e.code === "EACCES")) continue;
      return c;
    }
  }
  return null;
}

function hasPdftotext() {
  return findPdftotext() != null;
}

async function lawMinimumWage(year) {
  const name = `${year}년 적용 최저임금 고시`;
  const { hits } = await law.admrulFind(name, name);
  const id = hits[0]["행정규칙일련번호"];
  const b = await law.admrulBody(id);
  // ★조문내용이 빈 문자열이다. PDF 첨부만 존재한다.★
  const links = law.asArray(b.svc["첨부파일"] && b.svc["첨부파일"]["첨부파일링크"]);
  const names = law.asArray(b.svc["첨부파일"] && b.svc["첨부파일"]["첨부파일명"]);
  const idx = names.findIndex((n) => /최저임금\s*고시/.test(n) && /\.pdf$/i.test(n));
  if (idx < 0) throw new Error(`최저임금 고시 PDF 첨부를 찾지 못했습니다. 첨부: ${JSON.stringify(names)}`);
  // flSeq 는 개정마다 바뀐다. 여기서 매번 동적으로 얻으므로 하드코딩이 없다.
  const url = String(links[idx]).replace(/^http:/, "https:");

  const pdftotext = findPdftotext();
  if (!pdftotext) {
    throw new Error(
      `pdftotext(poppler-utils)가 없어 최저임금 고시 PDF 를 파싱할 수 없습니다. ` +
        `이 출처를 건너뜁니다 — 최저임금은 최저임금위원회 표 1개 출처만 남아 자동 병합 대상에서 빠집니다. ` +
        `CI 에서는 'sudo apt-get install -y poppler-utils' 를 넣으십시오. (PDF: ${url})`
    );
  }

  const buf = await get(url, { as: "buffer", timeoutMs: 60000 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "salarynote-mw-"));
  const pdfPath = path.join(dir, "mw.pdf");
  const txtPath = path.join(dir, "mw.txt");
  fs.writeFileSync(pdfPath, buf);
  execFileSync(pdftotext, ["-enc", "UTF-8", "-layout", pdfPath, txtPath]);
  const t = fs.readFileSync(txtPath, "utf8");
  // ★PDF 텍스트는 토큰 순서가 뒤섞여 나온다('년 2026 적용'). 연도·고시번호를 PDF 에서
  //  파싱하려 하면 실패한다. 금액 토큰만 온전하므로 금액만 뽑고 메타는 admrul 에서 가져온다.
  const hr = matchOne(t, /시간급[\s\S]{0,120}?([0-9]{1,3},[0-9]{3})\s*원/, "최저임금 시급(PDF)");
  const mo = matchOne(t, /월\s*환산액\s*([0-9,]+)\s*원/, "최저임금 월환산액(PDF)");
  const meta = b.svc["행정규칙기본정보"] || {};
  rec("minimumWage.hourly", "law.go.kr", "primary", num(hr[1]), url, `${meta["발령번호"] || ""} ${hr[0]}`, citeAdmrul(name));
  rec("minimumWage.monthly209h", "law.go.kr", "primary", num(mo[1]), url, mo[0], citeAdmrul(name));
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 임시 디렉터리 정리 실패는 무시 */
  }
}

// ── 8. 법제처: 간이세액표 별표2 비고 — 자녀공제액 ★단일 출처★ ────
async function lawChildTaxCredit() {
  const { xml, url } = await law.lawXml("소득세법 시행령");
  const unit = xml.match(
    /<별표단위[^>]*>(?:(?!<\/별표단위>)[\s\S])*?근로소득 간이세액표[\s\S]*?<\/별표단위>/
  );
  if (!unit) throw new Error("소득세법 시행령 XML 에서 '근로소득 간이세액표' 별표단위를 찾지 못했습니다.");
  const bodyM = unit[0].match(/<별표내용>([\s\S]*?)<\/별표내용>/);
  if (!bodyM) throw new Error("별표내용 블록이 없습니다.");
  const text = [...bodyM[1].matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((m) => m[1]).join("");

  // ★컷 마커는 반드시 '(단위: 원)' 을 쓴다.★ '6.' 로 자르면 '2026. 2. 27.' 의 '6.' 에
  //  걸려 조용히 빈 결과가 나온다. 실제로 겪은 사고다.
  const cut = text.indexOf("(단위: 원)");
  if (cut < 0) throw new Error("별표2 비고 컷 마커 '(단위: 원)' 를 찾지 못했습니다. 서식이 바뀌었습니다.");
  const head = text.slice(0, cut).replace(/\s+/g, " ").trim();

  const rev = matchOne(head, /<개정\s*([^>]+)>/, "별표2 개정일자")[1].trim();
  const child = [
    ...head.matchAll(
      /자녀가 (\d+명(?: 이상)?)인 경우 : ([\d,]+)원(?: \+ 2명 초과 자녀 1명당 ([\d,]+)원)?/g
    ),
  ];
  const spec = [...head.matchAll(/(\d{1,3}(?:,\d{3})*만원) \+ 연간 총급여액의 ([\d.]+)%/g)];
  if (child.length !== 3 || spec.length !== 12) {
    throw new Error(
      `별표2 비고 서식 불변식 위반: 자녀공제 항목 ${child.length}개(3 기대), 특별공제 항목 ${spec.length}개(12 기대). ` +
        `서식이 바뀌었으므로 자동 병합하지 않고 사람을 부릅니다.`
    );
  }
  const one = num(child[0][2]);
  const two = num(child[1][2]);
  const base = num(child[2][2]);
  const extra = num(child[2][3]);
  rec("childTaxCredit.one", "law.go.kr", "primary", one, url, child[0][0], citeLaw("소득세법 시행령"));
  rec("childTaxCredit.two", "law.go.kr", "primary", two, url, child[1][0], citeLaw("소득세법 시행령"));
  rec("childTaxCredit.threePlusBase", "law.go.kr", "primary", base, url, child[2][0], citeLaw("소득세법 시행령"));
  rec("childTaxCredit.threePlusPerExtra", "law.go.kr", "primary", extra, url, child[2][0], citeLaw("소득세법 시행령"));
  rec("taxTable.revision", "law.go.kr", "primary", rev, url, `<개정 ${rev}>`);
  notes.push(
    `간이세액표 자녀공제액은 법제처 별표2 원문 1개 출처뿐입니다(국세청 웹페이지는 근거로 쓰지 않습니다). ` +
      `★어떤 변동도 자동 병합하지 않습니다.★ 별표2 개정일자: ${rev}`
  );
}

// ── 9. 4대사회보험 정보연계센터 (2차 출처, 요율 4개) ─────────────
async function fourInsure() {
  const url = "https://www.4insure.or.kr/pbiz/ntcn/inscSmlCalcView.do";
  const h = await get(url, { timeoutMs: 30000 });
  // NetFunnel 대기열 페이지가 200 으로 올 수 있다. 정규식이 안 맞으면 matchOne 이 터진다.
  const nps = matchOne(
    h,
    /기준 소득월액<\/td>\s*<td>([0-9.]+)%<\/td>\s*<td>([0-9.]+)%<\/td>\s*<td>([0-9.]+)%<\/td>/,
    "4insure 국민연금 요율"
  );
  rec("nationalPension.totalRate", "4insure", "secondary", num(nps[1]) / 100, url, stripTags(nps[0]));
  rec("nationalPension.employeeRate", "4insure", "secondary", num(nps[2]) / 100, url, stripTags(nps[0]));

  const nhi = matchOne(h, /건강보험료<\/td>\s*<td>보수월액<\/td>\s*<td>([0-9.]+)%<\/td>/, "4insure 건강보험료율");
  const nhiTotal = num(nhi[1]) / 100;
  rec("healthInsurance.totalRate", "4insure", "secondary", nhiTotal, url, stripTags(nhi[0]));
  rec("healthInsurance.employeeRate", "4insure", "secondary", Math.round((nhiTotal / 2) * 1e6) / 1e6, url, stripTags(nhi[0]));

  // ★이 행의 '부과기준' 칸은 '건강보험료' 라고 적혀 있지만 값 0.9448% 는
  //  보수월액 대비 요율이다(법제처 시행령 제4조의 100만분의 9448과 일치).
  //  페이지 라벨을 믿지 말고 값의 자릿수로 판단할 것.
  const ltc = matchOne(h, /장기요양보험료<\/td>\s*<td>건강보험료<\/td>\s*<td>([0-9.]+)%<\/td>/, "4insure 장기요양요율");
  rec("longTermCare.rateOfIncome", "4insure", "secondary", num(ltc[1]) / 100, url, stripTags(ltc[0]));

  const ei = matchOne(h, /실업급여[\s\S]{0,80}?<td>([0-9.]+)%<\/td>\s*<td>([0-9.]+)%<\/td>/, "4insure 고용보험 요율");
  const eiEmp = num(ei[1]) / 100;
  rec("employmentInsurance.unemploymentTotalRate", "4insure", "secondary", Math.round((eiEmp + num(ei[2]) / 100) * 1e6) / 1e6, url, stripTags(ei[0]));
  rec("employmentInsurance.employeeRate", "4insure", "secondary", eiEmp, url, stripTags(ei[0]));

  const cap = matchOne(
    h,
    /신고한 소득월액이 ([0-9,]+)만원보다 적으면[\s\S]{0,80}?([0-9,]+)만원보다 많으면/,
    "4insure 기준소득월액 상·하한"
  );
  rec("nationalPension.baseIncome.min", "4insure", "secondary", num(cap[1]) * 10000, url, stripTags(cap[0]));
  rec("nationalPension.baseIncome.max", "4insure", "secondary", num(cap[2]) * 10000, url, stripTags(cap[0]));

  // ★카나리★ 같은 페이지의 인라인 JS 상수는 자기 페이지 본문·법정 고시와 불일치하는
  //  낡은 값이다(실측: npsLlmtAmt=400000 인데 본문·고시는 410,000).
  //  절대 값으로 쓰지 말고 불일치 로그만 남긴다.
  const jsLo = h.match(/npsLlmtAmt\s*=\s*"(\d+)"/);
  const jsHi = h.match(/npsUpprAmt\s*=\s*"(\d+)"/);
  if (jsLo && num(jsLo[1]) !== num(cap[1]) * 10000) {
    notes.push(
      `[카나리] 4insure 인라인 JS 상수 npsLlmtAmt=${jsLo[1]} 가 같은 페이지 본문(${num(cap[1]) * 10000})과 다릅니다. ` +
        `이 출처의 관리 상태가 느슨하다는 신호입니다. JS 상수는 값으로 쓰지 않습니다.`
    );
  }
  if (jsHi && num(jsHi[1]) !== num(cap[2]) * 10000) {
    notes.push(`[카나리] 4insure npsUpprAmt=${jsHi[1]} 가 본문(${num(cap[2]) * 10000})과 다릅니다.`);
  }
}

// ── 10. 최저임금위원회 (2차 출처) ───────────────────────────────
async function minimumWageCommittee(year) {
  const url = "https://www.minimumwage.go.kr/minWage/policy/decisionMain.do";
  const h = await get(url, { timeoutMs: 30000 });
  const rows = [...h.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) =>
    [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => stripTags(c[1]))
  );
  const yy = String(year).slice(2);
  const prefix = String.fromCharCode(39) + yy + ".01.01"; // '26.01.01
  const row = rows.find((r) => r[0] && r[0].indexOf(prefix) === 0);
  if (!row) {
    throw new Error(
      `최저임금위원회 표에서 ${year}년 행(${prefix})을 찾지 못했습니다. 표 구조가 바뀌었거나 아직 미게시입니다.`
    );
  }
  rec("minimumWage.hourly", "minimumwage.go.kr", "secondary", num(row[1]), url, row.join(" | "));
  if (row[3]) rec("minimumWage.monthly209h", "minimumwage.go.kr", "secondary", num(row[3]), url, row.join(" | "));

  // 다음 연도 행이 미리 올라오는 패턴이 있다. ★현행값과 예고값을 헷갈리면 1년치가 통째로 틀린다.★
  // 그래서 정보성 팩트로만 기록하고 원장 반영 후보로 쓰지 않는다.
  const nextRow = rows.find((r) => r[0] && r[0].indexOf(String.fromCharCode(39) + String(year + 1).slice(2) + ".01.01") === 0);
  if (nextRow) {
    rec("$forecast.minimumWage.nextYearHourly", "minimumwage.go.kr", "secondary", num(nextRow[1]), url, nextRow.join(" | "));
    notes.push(
      `[예고] ${year + 1}년 최저임금 ${nextRow[1]}원 (고시일 ${nextRow[6] || "?"}) 가 이미 표에 올라와 있습니다. ` +
        `현행값이 아니므로 원장에 넣지 않습니다.`
    );
  }
}

// ── 11. 국민연금공단 (3차 출처) ─────────────────────────────────
async function npsService(year) {
  const url = "https://www.nps.or.kr/pnsinfo/ntpsklg/getOHAF0038M0.do?menuId=MN24001113";
  const h = await get(url, { timeoutMs: 40000 });
  const m = h.match(/보험료율\s*([0-9.]+)%로 부과된/);
  if (m) rec("nationalPension.totalRate", "nps.or.kr", "secondary", num(m[1]) / 100, url, m[0]);
  const re = new RegExp(
    `${year}\\.7\\.1\\.~${year + 1}\\.6\\.30\\.\\s*\\(최저\\)\\s*([0-9,]+)만원\\s*/\\s*\\(최고\\)\\s*([0-9,]+)만원`
  );
  const c = h.match(re);
  if (c) {
    rec("nationalPension.baseIncome.min", "nps.or.kr", "secondary", num(c[1]) * 10000, url, c[0]);
    rec("nationalPension.baseIncome.max", "nps.or.kr", "secondary", num(c[2]) * 10000, url, c[0]);
  }
  if (!m && !c) throw new Error("nps.or.kr 에서 요율·기준소득월액을 모두 파싱하지 못했습니다. 페이지 개편 의심.");
}

// ── 유틸 ────────────────────────────────────────────────────────
function isoDate(yyyymmdd) {
  const s = String(yyyymmdd);
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s;
}

/** 부동소수 노이즈를 제거하고 값을 비교 가능한 정규형으로. */
function canon(v) {
  if (typeof v === "number") return Math.round(v * 1e9) / 1e9;
  return v;
}

/** 팩트별로 관측을 묶고, 독립 출처 수와 일치 여부를 판정한다. */
function summarize() {
  const byFact = {};
  for (const o of observations) (byFact[o.fact] ||= []).push(o);

  const facts = {};
  for (const [fact, obs] of Object.entries(byFact)) {
    const values = obs.map((o) => canon(o.value));
    const distinct = [...new Set(values.map((v) => JSON.stringify(v)))];
    const sourceIds = [...new Set(obs.map((o) => o.sourceId))];
    const agree = distinct.length === 1;
    const independent = sourceIds.length;
    const primary = obs.find((o) => o.tier === "primary");

    facts[fact] = {
      // 값은 항상 1차 정본(법제처)을 우선한다. 2차 출처가 달라도 법제처 값을 후보로 삼되
      // agree=false 이므로 자동 병합은 되지 않는다.
      value: primary ? canon(primary.value) : canon(values[0]),
      valueFrom: primary ? primary.sourceId : obs[0].sourceId,
      agree,
      independentSources: independent,
      singleSource: independent < 2,
      autoMerge: agree && independent >= 2 && !fact.startsWith("$"),
      disagreement: agree ? null : distinct.map((d) => JSON.parse(d)),
      observations: obs.map((o) => ({
        sourceId: o.sourceId,
        tier: o.tier,
        value: canon(o.value),
        url: o.url,
        cite: o.cite,
        quote: o.quote,
      })),
    };
  }
  return facts;
}

// ── main ────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { year: new Date().getFullYear(), out: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--year") out.year = Number(argv[++i]);
    else if (argv[i] === "--out") out.out = argv[++i];
  }
  if (!Number.isInteger(out.year) || out.year < 2020 || out.year > 2100) {
    throw new Error(`--year 값이 이상합니다: ${out.year}`);
  }
  return out;
}

async function collect(year) {
  process.stderr.write(`[fetch-rates] 대상 연도 ${year} / LAW_OC=${law.oc()}\n`);

  // 프리플라이트: OC 가 막혔으면 여기서 즉시 멈춘다.
  const pf = await law.preflight();
  process.stderr.write(`  프리플라이트 OK (OC=${pf.oc})\n`);

  await step("법제처 국민연금 요율(부칙 제4조)", () => lawPension(year));
  await step("법제처 건강보험료율(시행령 제44조)", () => lawHealth());
  await step("법제처 장기요양보험료율(시행령 제4조)", () => lawLtc());
  await step("법제처 고용보험 실업급여 요율(징수법 시행령 제12조)", () => lawEmployment());
  await step("법제처 국민연금 기준소득월액 고시", () => lawBaseIncome(year));
  await step("법제처 건강보험 월보험료 상·하한 고시", () => lawHealthPremiumBounds());
  await step("법제처 최저임금 고시 PDF", () => lawMinimumWage(year));
  await step("법제처 간이세액표 별표2 비고(자녀공제액)", () => lawChildTaxCredit());
  await step("4대사회보험 정보연계센터", () => fourInsure());
  await step("최저임금위원회", () => minimumWageCommittee(year));
  await step("국민연금공단", () => npsService(year));

  const facts = summarize();
  return {
    schema: "salarynote/observations@1",
    fetchedAt: new Date().toISOString(),
    targetYear: year,
    lawOc: law.oc(),
    pdftotext: hasPdftotext(),
    facts,
    failures,
    notes,
    sourcePolicy: {
      primary: "law.go.kr DRF (법령·고시 원문)",
      secondary: ["4insure.or.kr", "minimumwage.go.kr", "nps.or.kr"],
      excluded: {
        "nts.go.kr": "구버전 노출 전례. 어떤 등급으로도 쓰지 않는다.",
        "data.go.kr": "요율 API 가 존재하지 않음(조사로 확인). 파일데이터는 횟수 제한·캡차.",
        "comwel.or.kr": "robots.txt 상 해당 경로 미허용",
        "nhis.or.kr": "robots.txt 가 /nhis/ 차단",
        "longtermcare.or.kr": "robots.txt Disallow: /",
      },
    },
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const outPath = args.out
    ? path.resolve(args.out)
    : path.join(__dirname, "..", "data", "candidates", `observations-${args.year}.json`);

  const result = await collect(args.year);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n", "utf8");

  const facts = Object.entries(result.facts);
  const auto = facts.filter(([, f]) => f.autoMerge).length;
  const single = facts.filter(([, f]) => f.singleSource).length;
  const bad = facts.filter(([, f]) => !f.agree).length;

  process.stderr.write("\n");
  for (const [k, f] of facts) {
    const mark = f.agree ? (f.independentSources >= 2 ? " OK " : "단일") : "불일치";
    process.stderr.write(
      `[${mark}] ${k.padEnd(44)} ${String(f.value).padEnd(14)} (출처 ${f.independentSources}개: ${f.observations
        .map((o) => o.sourceId)
        .join(", ")})\n`
    );
  }
  process.stderr.write(
    `\n팩트 ${facts.length}개 / 자동병합 가능 ${auto} / 단일출처 ${single} / 불일치 ${bad} / 수집실패 ${failures.length}\n`
  );
  for (const n of result.notes) process.stderr.write(`  · ${n}\n`);
  process.stderr.write(`\n관측 파일: ${outPath}\n`);

  // ★수집 실패가 있어도 이 스크립트는 0 으로 끝난다.★
  // 판단은 update-rates.js 가 한다. 여기서 죽으면 부분 결과조차 남지 않아
  // 무엇이 왜 막혔는지 알 수 없게 된다.
  process.stdout.write(outPath + "\n");
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`\n[fetch-rates] 치명적 오류: ${e && e.stack ? e.stack : e}\n`);
    process.exit(2);
  });
}

module.exports = { collect, summarize };
