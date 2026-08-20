/**
 * 법제처 DRF OPEN API 클라이언트 — 이 파이프라인의 1차 정본 출처.
 *
 * 확정된 사실(실측 검증됨)
 *  - lawSearch.do(목록) / lawService.do(본문). type=JSON 지원.
 *  - ★query 는 반드시 percent-encoding 해야 한다.★ 안 하면 빈 응답 {} 이 온다.
 *  - OC 파라미터 필수. OC=test 가 동작하나 법제처가 공식 보장한 값이 아니다.
 *    개인 OC 는 발급 시 서버 IP/도메인 등록을 요구해 GitHub Actions(유동 IP)에서는
 *    사실상 쓸 수 없다. 즉 OC=test 는 단일 장애점이며, 막히면 수동 갱신으로 폴백해야 한다.
 *  - MST(법령일련번호)와 flSeq 는 개정마다 바뀐다. ★절대 하드코딩하지 않는다.★
 *    매 실행 lawSearch 로 조회한다.
 *
 * ★치명적 함정★ 국민연금 요율을 국민연금법 '본문' 제88조제3항에서 읽으면 안 된다.
 * 본문은 1천분의 65(=13%)로 2033년 최종값이다. 2026년에 13%를 넣게 된다.
 * 반드시 '부칙 제4조제1항' 의 연도별 표를 읽어야 한다.
 */

const { get, matchOne, num } = require("./net.js");

const BASE = "https://www.law.go.kr/DRF";

function oc() {
  return process.env.LAW_OC && process.env.LAW_OC.trim() ? process.env.LAW_OC.trim() : "test";
}

/** DRF 응답이 인증 오류인지 검사. 오류 문자열을 조용히 넘기면 파싱이 엉뚱하게 실패한다. */
function assertNotAuthError(raw, url) {
  const s = typeof raw === "string" ? raw : JSON.stringify(raw);
  if (/사용자 정보 검증에 실패|필수입력요소 검증에 실패/.test(s)) {
    throw new Error(
      `법제처 DRF 인증 실패 — ${url}\n` +
        `OC='${oc()}' 가 거부됐습니다. OC=test 가 막혔다면 이 파이프라인의 1차 정본 출처가 통째로 죽은 것입니다.\n` +
        `개인 OC 는 서버 IP 등록을 요구해 GitHub Actions 에서 대체가 되지 않으므로 수동 갱신으로 폴백해야 합니다.`
    );
  }
}

async function drfJson(path, params) {
  const qs = Object.entries({ OC: oc(), type: "JSON", ...params })
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  const url = `${BASE}/${path}?${qs}`;
  const raw = await get(url, { as: "text", timeoutMs: 30000 });
  assertNotAuthError(raw, url);
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`법제처 DRF JSON 파싱 실패 — ${url}\n앞부분: ${raw.slice(0, 200)}`);
  }
  if (!data || Object.keys(data).length === 0) {
    throw new Error(`법제처 DRF 빈 응답 {} — ${url} (query percent-encoding 누락 의심)`);
  }
  return { data, url };
}

/** 프리플라이트: OC 가 살아 있는지 확인. 워크플로 첫 스텝에서 부른다. */
async function preflight() {
  const { data, url } = await drfJson("lawSearch.do", { target: "law", display: 1, query: "소득세법" });
  if (!data.LawSearch) throw new Error(`법제처 DRF 응답 형식 이상 — ${url}: ${JSON.stringify(data).slice(0, 200)}`);
  return { ok: true, oc: oc(), url };
}

const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

/** 객체 트리에서 문자열만 평탄화. DRF 조문 구조가 중첩 배열이라 이게 제일 안전하다. */
function flattenStrings(x, out = []) {
  if (typeof x === "string") out.push(x);
  else if (Array.isArray(x)) x.forEach((i) => flattenStrings(i, out));
  else if (x && typeof x === "object") Object.values(x).forEach((v) => flattenStrings(v, out));
  return out;
}

/** 법령명 완전일치로 MST(법령일련번호)를 조회. 하드코딩 금지 원칙이 여기서 충족된다. */
async function lawMst(name) {
  const { data, url } = await drfJson("lawSearch.do", { target: "law", display: 20, query: name });
  const list = asArray(data.LawSearch && data.LawSearch.law);
  const hit = list.find((l) => l["법령명한글"] === name);
  if (!hit) {
    throw new Error(
      `법령 완전일치 실패: '${name}' — ${url}\n후보: ${JSON.stringify(list.map((l) => l["법령명한글"]).slice(0, 10))}`
    );
  }
  return { mst: hit["법령일련번호"], promulgated: hit["공포일자"], effective: hit["시행일자"], searchUrl: url };
}

/** 특정 조(JO 6자리: 조4+항2)의 본문 줄들. */
async function lawArticle(name, jo) {
  const meta = await lawMst(name);
  const { data, url } = await drfJson("lawService.do", { target: "law", MST: meta.mst, JO: jo });
  const body = data["법령"];
  if (!body) throw new Error(`법령 본문 없음 — ${url}`);
  return { ...meta, url, lines: flattenStrings(body["조문"]) };
}

/** 부칙 전체 줄들. 국민연금 연도별 요율이 여기 있다. */
async function lawAddenda(name) {
  const meta = await lawMst(name);
  const { data, url } = await drfJson("lawService.do", { target: "law", MST: meta.mst });
  const body = data["법령"];
  if (!body) throw new Error(`법령 본문 없음 — ${url}`);
  return { ...meta, url, lines: flattenStrings(body["부칙"]), all: body };
}

/** 법령 본문 XML 원문(별표 파싱용). JSON 은 별표단위를 주지 않는 경우가 있어 XML 을 쓴다. */
async function lawXml(name) {
  const meta = await lawMst(name);
  const qs = `OC=${encodeURIComponent(oc())}&target=law&type=XML&MST=${encodeURIComponent(meta.mst)}`;
  const url = `${BASE}/lawService.do?${qs}`;
  const xml = await get(url, { as: "text", timeoutMs: 60000 });
  assertNotAuthError(xml, url);
  return { ...meta, url, xml };
}

/** 행정규칙(고시) 검색 → 완전일치 → 일련번호. */
async function admrulFind(query, exactName) {
  const { data, url } = await drfJson("lawSearch.do", { target: "admrul", display: 20, query });
  const list = asArray(data.AdmRulSearch && data.AdmRulSearch.admrul);
  const hits = exactName ? list.filter((l) => l["행정규칙명"] === exactName) : list;
  if (hits.length === 0) {
    throw new Error(
      `행정규칙 완전일치 실패: '${exactName || query}' — ${url}\n` +
        `후보: ${JSON.stringify(list.map((l) => l["행정규칙명"]).slice(0, 10))}`
    );
  }
  return { hits, searchUrl: url };
}

/** 행정규칙 본문. 조문내용이 통합본이다. ★개정문 필드를 쓰면 직전 연도 값을 넣게 된다.★ */
async function admrulBody(id) {
  const { data, url } = await drfJson("lawService.do", { target: "admrul", ID: id });
  const svc = data.AdmRulService;
  if (!svc) throw new Error(`행정규칙 본문 없음 — ${url}`);
  return { svc, url, text: asArray(svc["조문내용"]).join(" ") };
}

module.exports = {
  BASE,
  oc,
  preflight,
  asArray,
  flattenStrings,
  lawMst,
  lawArticle,
  lawAddenda,
  lawXml,
  admrulFind,
  admrulBody,
  matchOne,
  num,
};
