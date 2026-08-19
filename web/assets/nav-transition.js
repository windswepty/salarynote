/**
 * 메뉴 전환 애니메이션.
 *
 * 왜 CSS 의 크로스 도큐먼트 전환(@view-transition)을 쓰지 않는가:
 * 브라우저가 시스템의 '애니메이션 최소화' 설정을 보고 전환 객체 생성 자체를
 * 건너뛴다. CSS 로는 되돌릴 수 없다(실측 확인: pageswap 은 발동하지만
 * event.viewTransition 이 null 이었다).
 *
 * 그래서 같은 문서 안에서 내용만 갈아끼우고 startViewTransition 을 직접 호출한다.
 * 이 API 는 시스템 설정과 무관하게 우리가 정의한 CSS 애니메이션을 그대로 재생한다.
 *
 * 점진적 향상이라 미지원 브라우저·JS 비활성 환경에서는 평범한 페이지 이동이 되고,
 * 각 URL 은 그대로 완전한 HTML 을 서빙하므로 검색엔진에도 영향이 없다.
 */
(function () {
  "use strict";

  if (!document.startViewTransition) return; // 미지원 → 기본 이동에 맡긴다
  if (!window.SN_PAGE) return;

  const cache = new Map();

  /** 페이지의 계산기 종류는 인라인 스크립트에 적혀 있다. 문서를 갈아끼우면
   *  그 스크립트는 실행되지 않으므로 값만 뽑아 직접 호출한다. */
  function readMode(doc) {
    for (const s of doc.querySelectorAll("script:not([src])")) {
      const m = s.textContent.match(/SN_PAGE\(\s*\{\s*mode:\s*["']([a-z]+)["']/i);
      if (m) return m[1];
    }
    return null;
  }

  async function fetchPage(url) {
    if (cache.has(url)) return cache.get(url);
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const data = {
      title: doc.title,
      desc: doc.querySelector('meta[name="description"]')?.content || "",
      ptitle: doc.querySelector(".ptitle"),
      main: doc.querySelector("main"),
      mode: readMode(doc),
    };
    if (!data.main || !data.ptitle || !data.mode) throw new Error("페이지 구조가 예상과 다릅니다");
    cache.set(url, data);
    return data;
  }

  function syncNav(pathname) {
    for (const a of document.querySelectorAll(".nav a")) {
      const isCurrent = new URL(a.href, location.origin).pathname === pathname;
      if (isCurrent) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
  }

  function swap(data, pathname) {
    document.title = data.title;
    const meta = document.querySelector('meta[name="description"]');
    if (meta && data.desc) meta.content = data.desc;

    document.querySelector(".ptitle").replaceWith(data.ptitle.cloneNode(true));
    document.querySelector("main").replaceWith(data.main.cloneNode(true));

    // 밑줄이 '이동'하려면 스냅샷을 찍기 전에 활성 표시가 새 위치로 옮겨져 있어야 한다.
    syncNav(pathname);
    window.SN_PAGE({ mode: data.mode });
  }

  async function go(url, { push }) {
    const target = new URL(url, location.origin);
    let data;
    try {
      data = await fetchPage(target.pathname);
    } catch (e) {
      location.href = target.href; // 실패하면 조용히 멈추지 말고 평범하게 이동
      return;
    }

    if (push) history.pushState({ sn: true }, "", target.pathname);

    // 쿼리스트링은 이전 페이지의 입력값이라 다른 계산기로 가면 의미가 없다.
    if (location.search) history.replaceState({ sn: true }, "", target.pathname);

    const vt = document.startViewTransition(() => swap(data, target.pathname));
    try { await vt.finished; } catch (_) {}
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest("a");
    if (!a || a.target === "_blank" || a.hasAttribute("download")) return;

    const url = new URL(a.href, location.origin);
    if (url.origin !== location.origin) return;
    if (url.pathname === location.pathname) return;
    if (!document.querySelector(`.nav a[href="${url.pathname}"]`)) return; // 계산기 페이지끼리만

    e.preventDefault();
    go(url.pathname, { push: true });
  });

  window.addEventListener("popstate", () => go(location.pathname, { push: false }));

  // 옆 페이지를 미리 받아둔다. 3개뿐이라 부담이 없고 전환이 즉시 시작된다.
  window.addEventListener("load", () => {
    for (const a of document.querySelectorAll(".nav a")) {
      const p = new URL(a.href, location.origin).pathname;
      if (p !== location.pathname) fetchPage(p).catch(() => {});
    }
  });
})();
