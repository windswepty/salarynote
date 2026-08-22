/**
 * 출처 서버에 실제로 닿는지 진단한다.  node tools/reachability.js
 *
 * ★왜 필요한가★
 * GitHub Actions 에서 법제처 프리플라이트가 'fetch failed' 로 죽었다. 그런데
 * 같은 코드가 국내 개발 PC 에서는 잘 돈다. 원인 후보가 여럿이다 — 해외 IP 차단,
 * 데이터센터 IP 차단, TLS 협상 실패, 방화벽, 일시 장애.
 *
 * 프리플라이트는 첫 출처에서 죽으면서 나머지 출처가 살아 있는지조차 알려주지
 * 않았다. 그래서 "법제처만 막힌 것인가, 한국 사이트가 전부 막힌 것인가" 를
 * 구분할 수 없었다. 그 구분에 따라 대응이 완전히 달라진다.
 *
 * 이 스크립트는 실패해도 종료 코드 0 이다. 판단 재료를 모으는 것이 목적이지
 * 파이프라인을 멈추는 것이 목적이 아니다.
 */
const dns = require("dns").promises;
const net = require("net");
const tls = require("tls");

const HOSTS = [
  ["www.law.go.kr", "법제처 국가법령정보센터 (1차 정본)"],
  ["www.4insure.or.kr", "4대사회보험 정보연계센터"],
  ["www.minimumwage.go.kr", "최저임금위원회"],
  ["www.nps.or.kr", "국민연금공단"],
  ["github.com", "대조군 — 여기까지 막히면 러너 네트워크 문제"],
];

const TIMEOUT = 8000;

/** DNS A 레코드. 실패하면 이름 해석 단계에서 막힌 것이다. */
async function resolve(host) {
  try {
    return { ok: true, ips: await dns.resolve4(host) };
  } catch (e) {
    return { ok: false, err: e.code || e.message };
  }
}

/** TCP 443 연결. 여기서 막히면 IP 차단이나 방화벽이다. */
function connect(host) {
  return new Promise((done) => {
    const started = Date.now();
    const s = net.connect({ host, port: 443 });
    const finish = (ok, err) => {
      s.destroy();
      done({ ok, err, ms: Date.now() - started });
    };
    s.setTimeout(TIMEOUT, () => finish(false, "TIMEOUT"));
    s.once("connect", () => finish(true));
    s.once("error", (e) => finish(false, e.code || e.message));
  });
}

/** TLS 핸드셰이크. TCP 는 되는데 여기서 막히면 SNI 기반 차단이다. */
function handshake(host) {
  return new Promise((done) => {
    const started = Date.now();
    const s = tls.connect({ host, port: 443, servername: host });
    const finish = (ok, err) => {
      s.destroy();
      done({ ok, err, ms: Date.now() - started });
    };
    s.setTimeout(TIMEOUT, () => finish(false, "TIMEOUT"));
    s.once("secureConnect", () => finish(true));
    s.once("error", (e) => finish(false, e.code || e.message));
  });
}

/** 실제 HTTP 요청. 여기까지 와야 '닿는다' 고 말할 수 있다. */
async function http(host) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT);
  const started = Date.now();
  try {
    const res = await fetch(`https://${host}/`, {
      signal: ac.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; salarynote-reachability/1.0)" },
    });
    return { ok: true, status: res.status, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, err: e.cause?.code || e.name || e.message, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

const mark = (r) => (r.ok ? "OK" : "실패");

(async () => {
  console.log("## 출처 도달성 진단\n");
  console.log("| 호스트 | DNS | TCP:443 | TLS | HTTP | 비고 |");
  console.log("|---|---|---|---|---|---|");

  const rows = [];
  for (const [host, label] of HOSTS) {
    const d = await resolve(host);
    const t = d.ok ? await connect(host) : { ok: false, err: "DNS 실패" };
    const s = t.ok ? await handshake(host) : { ok: false, err: "-" };
    const h = s.ok ? await http(host) : { ok: false, err: "-" };
    rows.push({ host, label, d, t, s, h });

    const cell = (r) => (r.ok ? "OK" + (r.ms ? ` ${r.ms}ms` : "") : `❌ ${r.err}`);
    console.log(
      `| \`${host}\` | ${d.ok ? d.ips[0] : "❌ " + d.err} | ${cell(t)} | ${cell(s)} | ` +
      `${h.ok ? "HTTP " + h.status : "❌ " + h.err} | ${label} |`
    );
  }

  console.log("\n### 해석\n");
  const control = rows.find((r) => r.host === "github.com");
  const korean = rows.filter((r) => r.host !== "github.com");
  const reachable = korean.filter((r) => r.h.ok);

  if (!control.h.ok) {
    console.log("- 대조군(github.com)조차 막혔습니다. 특정 사이트 문제가 아니라 러너 네트워크 문제입니다.");
  } else if (reachable.length === 0) {
    console.log("- **한국 출처가 전부 막혔습니다.** 해외/데이터센터 IP 차단으로 보입니다.");
    console.log("  GitHub Actions 에서 요율을 읽어오는 구조 자체를 바꿔야 합니다.");
  } else if (reachable.length < korean.length) {
    const blocked = korean.filter((r) => !r.h.ok).map((r) => r.host);
    console.log(`- 일부만 막혔습니다: ${blocked.join(", ")}`);
    console.log("  막힌 출처를 대체하거나, 남은 출처만으로 교차검증이 가능한지 따져야 합니다.");
  } else {
    console.log("- 모든 출처에 닿습니다. 실패했다면 일시 장애이거나 특정 경로의 문제입니다.");
  }
})();
