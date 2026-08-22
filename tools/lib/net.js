/**
 * 네트워크 유틸 — 타임아웃·재시도·호출 간격 제어.
 *
 * 설계 원칙
 *  1. 의존성 0. node 내장 fetch(18+)만 쓴다. 테스트가 순수 node + assert 인 관례를 유지한다.
 *  2. ★파싱 실패를 '값 없음' 으로 만들지 않는다.★ 응답이 왔는데 기대한 정규식이
 *     없으면 그것은 '해당 항목이 없다' 가 아니라 '출처 구조가 바뀌었다' 이다.
 *     4insure 는 NetFunnel 대기열 페이지를 200 으로 반환할 수 있어 특히 그렇다.
 *  3. 재시도는 네트워크·5xx 에만 한다. 4xx 는 즉시 포기한다(재시도해도 같고,
 *     data.go.kr 처럼 횟수 제한이 있는 곳에서는 재시도가 캡차를 유발한다).
 */

const DEFAULT_UA = "Mozilla/5.0 (compatible; salarynote-rate-updater/1.0; +https://github.com/windswepty/salarynote)";

/**
 * 호스트별 최소 호출 간격(ms).
 * ★data.go.kr 은 다운로드 횟수 제한이 있고 초과 시 캡차를 요구한다.★
 * 현재 어떤 출처도 data.go.kr 을 쓰지 않지만, 누가 추가할 경우를 대비해
 * 여기에 강한 제한을 박아 둔다. 그리고 조사에서 data.go.kr 에는 요율 API 가
 * 아예 없다는 것이 확인됐으므로 애초에 추가하지 말 것.
 */
const HOST_MIN_INTERVAL_MS = {
  "www.law.go.kr": 400,
  "law.go.kr": 400,
  "www.4insure.or.kr": 1500,
  "www.minimumwage.go.kr": 1000,
  "www.nps.or.kr": 1000,
  "www.data.go.kr": 10000,
  "apis.data.go.kr": 10000,
  "*": 300,
};

/**
 * 호스트별 최소 타임아웃·재시도(ms).
 *
 * ★law.go.kr 은 GitHub Actions 에서 유난히 느리다.★ 실측(2026-08-22, 러너):
 *   TCP 384ms / TLS 5,683ms / HTTP 타임아웃.
 *   같은 시각 다른 한국 출처는 TLS 0.7~1.4초, 국내 PC 에서는 78ms 였다.
 *   차단이 아니라 지연이며, 지연이 커지면 간헐적으로 'fetch failed' 로 끊긴다.
 *   실제로 예약 실행 두 번이 이것 때문에 죽었다.
 *
 * 호출 지점마다 타임아웃을 적는 방식은 새 호출을 추가할 때 반드시 잊힌다.
 * 그래서 호출자가 더 짧게 요청해도 여기 하한을 밑돌지 않게 한다.
 */
const HOST_MIN_TIMEOUT_MS = {
  "www.law.go.kr": 60000,
  "law.go.kr": 60000,
  "*": 0,
};
const HOST_MIN_RETRIES = {
  "www.law.go.kr": 4,
  "law.go.kr": 4,
  "*": 0,
};

/** 호스트별 마지막 호출 시각. */
const lastCallAt = new Map();

/** 호스트별 누적 호출 수. 폭주 방지용 상한을 건다. */
const callCount = new Map();
/* 호스트별 호출 상한. 재시도도 실제 요청이므로 여기에 포함된다.
   law.go.kr 은 느려서 재시도를 4회까지 허용했으므로 상한도 함께 올려야 한다.
   그러지 않으면 재시도가 상한을 먹어 '호출 상한 초과' 로 엉뚱하게 죽는다. */
const MAX_CALLS_PER_HOST_BY_HOST = { "www.law.go.kr": 150, "law.go.kr": 150 };
const MAX_CALLS_PER_HOST = 40;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "*";
  }
}

async function throttle(url) {
  const host = hostOf(url);
  const n = (callCount.get(host) || 0) + 1;
  callCount.set(host, n);
  const cap = MAX_CALLS_PER_HOST_BY_HOST[host] ?? MAX_CALLS_PER_HOST;
  if (n > cap) {
    throw new Error(
      `호출 상한 초과: ${host} 에 ${cap}회를 넘겨 호출했습니다. ` +
        `무한 루프이거나 재시도가 폭주한 것입니다. 출처를 괴롭히지 않도록 중단합니다.`
    );
  }
  const min = HOST_MIN_INTERVAL_MS[host] ?? HOST_MIN_INTERVAL_MS["*"];
  const prev = lastCallAt.get(host);
  if (prev != null) {
    const wait = min - (Date.now() - prev);
    if (wait > 0) await sleep(wait);
  }
  lastCallAt.set(host, Date.now());
}

/**
 * 타임아웃·재시도가 붙은 fetch. 실패하면 throw 한다(조용히 null 을 돌려주지 않는다).
 *
 * @param {string} url
 * @param {object} [opt]
 * @param {number} [opt.timeoutMs=20000]
 * @param {number} [opt.retries=2]        네트워크·5xx 에 한해 재시도할 횟수
 * @param {number} [opt.backoffMs=1500]
 * @param {'text'|'json'|'buffer'} [opt.as='text']
 */
async function get(url, opt = {}) {
  const {
    as = "text",
    headers = {},
  } = opt;

  // 느린 출처는 호출자가 짧게 요청해도 하한을 적용한다. 이유는 위 표 참조.
  const host = hostOf(url);
  const timeoutMs = Math.max(
    opt.timeoutMs ?? 20000,
    HOST_MIN_TIMEOUT_MS[host] ?? HOST_MIN_TIMEOUT_MS["*"]);
  const retries = Math.max(
    opt.retries ?? 2,
    HOST_MIN_RETRIES[host] ?? HOST_MIN_RETRIES["*"]);
  const backoffMs = opt.backoffMs ?? 1500;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(backoffMs * attempt);
    await throttle(url);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": DEFAULT_UA, ...headers },
        signal: ac.signal,
        redirect: "follow",
      });
      if (!res.ok) {
        const e = new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
        e.status = res.status;
        // 4xx 는 재시도해도 결과가 같다. 호출 제한이 있는 출처를 자극하지 않기 위해 즉시 포기.
        if (res.status >= 400 && res.status < 500) throw Object.assign(e, { noRetry: true });
        throw e;
      }
      if (as === "buffer") return Buffer.from(await res.arrayBuffer());
      const text = await res.text();
      if (as === "json") {
        try {
          return JSON.parse(text);
        } catch {
          throw Object.assign(
            new Error(
              `JSON 파싱 실패 — ${url}\n` +
                `응답 앞부분: ${text.slice(0, 200).replace(/\s+/g, " ")}\n` +
                `law.go.kr DRF 는 query 를 percent-encoding 하지 않으면 빈 응답 {} 을 줍니다.`
            ),
            { noRetry: true }
          );
        }
      }
      return text;
    } catch (e) {
      lastErr = e;
      if (e.noRetry) break;
      if (e.name === "AbortError") lastErr = new Error(`타임아웃 ${timeoutMs}ms — ${url}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/**
 * 정규식 매치를 강제한다. 매치가 없으면 '값 없음' 이 아니라 '파싱 실패' 로 터진다.
 * ★매치가 2개 이상이면 모호 파싱으로 보고 역시 터진다.★
 * "9%에서 9.5%로" 같은 문장에서 9 를 집는 사고를 막는다.
 */
function matchOne(text, re, label) {
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  const all = [...text.matchAll(new RegExp(re.source, flags))];
  if (all.length === 0) {
    throw new Error(
      `파싱 실패 [${label}]: 정규식 ${re} 가 응답에서 매치되지 않았습니다. ` +
        `출처 구조가 바뀌었거나 대기열/오류 페이지를 받았을 수 있습니다. ` +
        `이것을 '값 없음' 으로 처리하면 조용히 틀립니다.`
    );
  }
  if (all.length > 1) {
    const shown = all.slice(0, 3).map((m) => m[0].replace(/\s+/g, " ").slice(0, 60));
    throw new Error(
      `모호 파싱 [${label}]: 정규식 ${re} 가 ${all.length}곳에서 매치됐습니다. ` +
        `어느 것이 맞는지 알 수 없으므로 값을 만들지 않고 중단합니다. 예: ${JSON.stringify(shown)}`
    );
  }
  return all[0];
}

/** 숫자 문자열(콤마 포함)을 정수로. 자릿수 유실을 잡기 위해 원문도 함께 돌려준다. */
function num(s) {
  const clean = String(s).replace(/,/g, "").trim();
  if (!/^-?\d+(\.\d+)?$/.test(clean)) {
    throw new Error(`숫자 파싱 실패: ${JSON.stringify(s)}`);
  }
  return Number(clean);
}

/** HTML 태그 제거 + 공백 정규화. */
const stripTags = (s) =>
  s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

module.exports = { get, matchOne, num, stripTags, sleep, DEFAULT_UA };
