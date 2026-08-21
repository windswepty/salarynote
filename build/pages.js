/**
 * 사이트 페이지 정의 — 단일 출처.
 * 계산기를 추가하면 여기에만 추가하고 `node build/nav.js` 를 돌린다.
 * 내비게이션과 sitemap 이 함께 갱신된다.
 */
module.exports = [
  { url: "/",                nav: "연봉",     title: "연봉 실수령액",   priority: "1.0", changefreq: "monthly" },
  { url: "/monthly-salary/", nav: "월급",     title: "월급 실수령액",   priority: "0.9", changefreq: "monthly" },
  { url: "/four-insurance/", nav: "4대보험",  title: "4대보험",        priority: "0.9", changefreq: "monthly" },
  { url: "/severance-pay/",  nav: "퇴직금",   title: "퇴직금",          priority: "0.9", changefreq: "monthly" },
  { url: "/weekly-holiday-pay/", nav: "주휴수당", title: "주휴수당", priority: "0.9", changefreq: "monthly" },
  { url: "/annual-leave/",       nav: "연차",     title: "연차수당", priority: "0.9", changefreq: "monthly" },
  { url: "/wage-converter/",     nav: "환산",     title: "시급 연봉 환산", priority: "0.9", changefreq: "monthly" },
  { url: "/overtime-pay/",    nav: "야근수당", title: "연장·야간·휴일수당", priority: "0.9", changefreq: "monthly" },
  { url: "/minimum-wage/",    nav: "최저임금",  title: "최저임금 위반 확인", priority: "0.9", changefreq: "monthly" },
  { url: "/part-time/",       nav: "알바",     title: "아르바이트 급여", priority: "0.9", changefreq: "monthly" },
  { url: "/unemployment/",    nav: "실업급여", title: "실업급여",        priority: "0.9", changefreq: "monthly" },
  { url: "/about/",           nav: null,       title: "소개", priority: "0.4", changefreq: "yearly" },
  { url: "/privacy/",        nav: null,      title: "개인정보처리방침", priority: "0.2", changefreq: "yearly" },
];
