/**
 * salarynote.kr 의 네임서버 전파 상태를 확인한다.
 *
 * 네임서버를 바꾸면 .kr 레지스트리가 새 위임을 퍼뜨릴 때까지 조회가 실패한다
 * (SERVFAIL). 실패가 '문제' 인지 '아직 반영 전' 인지 구별하려고 만들었다.
 *
 * 사용: node tools/check-domain.js
 */
const DOMAIN = process.argv[2] || "salarynote.kr";
const WANT = ["dan.ns.cloudflare.com", "maeve.ns.cloudflare.com"];

const CODE = { 0: "정상", 2: "SERVFAIL (아직 반영 전이거나 위임 오류)", 3: "도메인 없음(NXDOMAIN)" };

async function q(name, type, resolver) {
  const url = resolver === "google"
    ? `https://dns.google/resolve?name=${name}&type=${type}`
    : `https://cloudflare-dns.com/dns-query?name=${name}&type=${type}`;
  const res = await fetch(url, { headers: { accept: "application/dns-json" } });
  return res.json();
}

(async () => {
  console.log(`\n=== ${DOMAIN} 네임서버 전파 확인 ===\n`);
  let ok = 0;
  for (const r of ["google", "cloudflare"]) {
    try {
      const d = await q(DOMAIN, "NS", r);
      const ns = (d.Answer || []).map((a) => a.data.replace(/\.$/, "").toLowerCase());
      const label = r === "google" ? "Google DNS    " : "Cloudflare DNS";
      if (ns.length) {
        const hit = WANT.every((w) => ns.includes(w));
        console.log(`${label}  ${hit ? "✓" : "△"}  ${ns.join(", ")}`);
        if (hit) ok++;
      } else {
        console.log(`${label}  ✗  ${CODE[d.Status] || "Status " + d.Status}`);
      }
    } catch (e) {
      console.log(`${r}: 조회 실패 — ${e.message}`);
    }
  }

  console.log("");
  if (ok === 2) {
    console.log("전파 완료. Cloudflare 대시보드가 Active 로 바뀌었는지 확인하세요.");
  } else {
    console.log("아직 반영 전입니다. .kr 은 보통 1~4시간, 최대 24시간 걸립니다.");
    console.log("24시간이 지나도 그대로면 가비아에서 네임서버가 제대로 저장됐는지 확인하십시오.");
  }
  console.log("");
})();
