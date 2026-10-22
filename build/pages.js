/**
 * 사이트 페이지 정의 — 단일 출처.
 * 계산기를 추가하면 여기에만 추가하고 `node build/nav.js` 를 돌린다.
 * 내비게이션과 sitemap 이 함께 갱신된다.
 *
 * desc·related 는 본문 아래 '함께 보면 좋은 계산기' 를 만든다(build/nav.js).
 * 상단 메뉴 링크만 있으면 구글 서치콘솔이 '참조 페이지: 감지된 페이지 없음' 으로
 * 보는 페이지가 생긴다(2026-10 /monthly-salary/). 본문 속 링크로 서로 잇는다.
 */
module.exports = [
  { url: "/",                nav: "연봉",     title: "연봉 실수령액",   priority: "1.0", changefreq: "monthly",
    desc: "연봉에서 4대보험과 소득세를 뺀 월 실수령액", related: ["/monthly-salary/", "/salary-table/", "/four-insurance/", "/guide/payslip/"] },
  { url: "/monthly-salary/", nav: "월급",     title: "월급 실수령액",   priority: "0.9", changefreq: "monthly",
    desc: "세전 월급으로 바로 계산하는 실수령액", related: ["/", "/salary-table/", "/four-insurance/", "/guide/payslip/"] },
  { url: "/four-insurance/", nav: "4대보험",  title: "4대보험",        priority: "0.9", changefreq: "monthly",
    desc: "국민연금·건강·장기요양·고용보험 근로자 부담액", related: ["/insurance-rates/", "/monthly-salary/", "/", "/guide/insurance-history/"] },
  { url: "/severance-pay/",  nav: "퇴직금",   title: "퇴직금",          priority: "0.9", changefreq: "monthly",
    desc: "평균임금과 근속일수로 계산하는 법정 퇴직금", related: ["/annual-leave/", "/unemployment/", "/monthly-salary/", "/guide/quitting/"] },
  { url: "/weekly-holiday-pay/", nav: "주휴수당", title: "주휴수당", priority: "0.9", changefreq: "monthly",
    desc: "주 15시간 이상 근무자의 유급휴일 수당", related: ["/part-time/", "/minimum-wage/", "/wage-converter/", "/annual-leave/"] },
  { url: "/annual-leave/",       nav: "연차",     title: "연차수당", priority: "0.9", changefreq: "monthly",
    desc: "근속연수별 연차 일수와 미사용 수당", related: ["/severance-pay/", "/weekly-holiday-pay/", "/overtime-pay/", "/parental-leave/"] },
  { url: "/wage-converter/",     nav: "환산",     title: "시급 연봉 환산", priority: "0.9", changefreq: "monthly",
    desc: "시급·월급·연봉을 서로 바꿔 계산", related: ["/minimum-wage/", "/monthly-salary/", "/weekly-holiday-pay/", "/guide/minimum-wage-history/"] },
  { url: "/overtime-pay/",    nav: "야근수당", title: "연장·야간·휴일수당", priority: "0.9", changefreq: "monthly",
    desc: "연장·야간·휴일근로 가산수당, 5인 미만 구분 포함", related: ["/wage-converter/", "/weekly-holiday-pay/", "/minimum-wage/", "/monthly-salary/"] },
  { url: "/minimum-wage/",    nav: "최저임금",  title: "최저임금 위반 확인", priority: "0.9", changefreq: "monthly",
    desc: "내 월급이 최저임금 이상인지 산입범위까지 판정", related: ["/wage-converter/", "/part-time/", "/weekly-holiday-pay/", "/guide/minimum-wage-history/"] },
  { url: "/part-time/",       nav: "알바",     title: "아르바이트 급여", priority: "0.9", changefreq: "monthly",
    desc: "시급과 주 근무시간으로 계산하는 알바 월급", related: ["/weekly-holiday-pay/", "/minimum-wage/", "/four-insurance/", "/severance-pay/"] },
  { url: "/parental-leave/",  nav: "육아휴직",  title: "육아휴직 급여", priority: "0.9", changefreq: "monthly",
    desc: "개월차별 상한을 반영한 육아휴직 급여", related: ["/unemployment/", "/monthly-salary/", "/four-insurance/", "/annual-leave/"] },
  { url: "/unemployment/",    nav: "실업급여", title: "실업급여",        priority: "0.9", changefreq: "monthly",
    desc: "나이·가입기간별 구직급여 일액과 지급일수", related: ["/severance-pay/", "/parental-leave/", "/annual-leave/", "/guide/quitting/"] },
  { url: "/salary-table/",   nav: "실수령액표", title: "연봉 실수령액표", priority: "0.9", changefreq: "monthly",
    desc: "연봉 2,000만~1억원 실수령액을 한 표로", related: ["/", "/monthly-salary/", "/insurance-rates/", "/four-insurance/"] },
  { url: "/insurance-rates/", nav: "요율표", title: "4대보험 요율표", priority: "0.9", changefreq: "monthly",
    desc: "올해 4대보험 요율과 상·하한, 월급별 부담액", related: ["/four-insurance/", "/salary-table/", "/part-time/", "/guide/insurance-history/"] },
  // ── 가이드: 계산기가 아닌 설명 글. kind 가 "guide" 이면 푸터가 아니라 /guide/ 목록에서 이어진다.
  { url: "/guide/",          nav: "가이드",  title: "급여 가이드", kind: "hub", priority: "0.8", changefreq: "monthly",
    desc: "급여명세서, 퇴사, 최저임금, 4대보험을 법령 원문으로 정리한 글" },
  { url: "/guide/payslip/",  nav: null, title: "급여명세서 읽는 법", kind: "guide", priority: "0.7", changefreq: "yearly",
    desc: "명세서의 법정 기재사항과 지급·공제 항목을 한 줄씩 읽는 법",
    related: ["/monthly-salary/", "/overtime-pay/", "/four-insurance/", "/guide/quitting/"] },
  { url: "/guide/quitting/", nav: null, title: "퇴사할 때 받을 돈", kind: "guide", priority: "0.7", changefreq: "yearly",
    desc: "퇴직금·연차수당·실업급여와 14일 지급 기한, 퇴사 전 체크리스트",
    related: ["/severance-pay/", "/annual-leave/", "/unemployment/", "/guide/payslip/"] },
  { url: "/guide/minimum-wage-history/", nav: null, title: "연도별 최저임금", kind: "guide", priority: "0.7", changefreq: "yearly",
    desc: "해마다 오른 최저임금과 결정 절차, 2027년 금액",
    related: ["/minimum-wage/", "/wage-converter/", "/part-time/", "/guide/insurance-history/"] },
  { url: "/guide/insurance-history/", nav: null, title: "4대보험 요율 변화", kind: "guide", priority: "0.7", changefreq: "yearly",
    desc: "국민연금 13%까지의 인상 일정과 건강·장기요양·고용보험 요율 추이",
    related: ["/insurance-rates/", "/four-insurance/", "/", "/guide/minimum-wage-history/"] },
  { url: "/about/",           nav: null,       title: "소개", priority: "0.4", changefreq: "yearly" },
  { url: "/privacy/",        nav: null,      title: "개인정보처리방침", priority: "0.2", changefreq: "yearly" },
];
