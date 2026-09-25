/**
 * 구글 색인 요청 진행표.
 *
 * 왜 필요한가:
 * 서치콘솔은 "이 URL 이 색인됐는가" 는 보여주지만 "내가 어디까지 요청했는가" 는
 * 보여주지 않는다. URL 검사로 하나씩 확인할 수는 있는데, 그 검사 자체가 하루
 * 할당량을 깎아먹는다. 확인하려다 요청을 못 하게 되는 셈이다. 그래서 진행 상황은
 * 우리 쪽에 적어 두고, 할당량은 오직 '요청' 에만 쓴다.
 *
 * 사용:
 *   node tools/index-status.js              현황 보기 + 오늘 요청할 것 한 개
 *   node tools/index-status.js 요청 /part-time/   요청했다고 기록
 *   node tools/index-status.js 완료 /part-time/   색인된 것을 확인했다고 기록
 *   node tools/index-status.js 가져오기 표.csv   서치콘솔 CSV 로 한 번에 맞추기
 *   node tools/index-status.js --check      진행표가 페이지 목록과 어긋나면 exit 1
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DB_PATH = path.join(ROOT, "data", "index-status.json");
const PAGES = require(path.join(ROOT, "build", "pages.js"));
const BASE_URL = process.env.SN_BASE_URL || "https://salarynote.kr";

const db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));

/**
 * ★페이지를 새로 만들면 진행표에도 저절로 들어와야 한다.★
 * 안 그러면 새 계산기를 만들어 놓고 색인 요청을 영영 안 하게 된다. 만든 사람만
 * 아는 페이지는 없는 페이지와 같다.
 */
function drift() {
  const known = new Set(Object.keys(db.pages));
  const real = new Set(PAGES.map((p) => p.url));
  return {
    missing: [...real].filter((u) => !known.has(u)),   // 페이지는 있는데 진행표에 없음
    orphan: [...known].filter((u) => !real.has(u)),    // 진행표에만 있고 페이지는 없음
  };
}

/** KST 기준 오늘. Actions 는 UTC 라 그냥 쓰면 한국 새벽에 어제 날짜가 찍힌다. */
function today() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

const MARK = { indexed: "[O]", requested: "[.]", todo: "[ ]", skip: "[-]" };
const WORD = { indexed: "색인됨", requested: "요청함", todo: "대기", skip: "제외" };

function rows() {
  return Object.entries(db.pages)
    .map(([url, v]) => ({ url, ...v, title: (PAGES.find((p) => p.url === url) || {}).title || "?" }))
    .sort((a, b) => a.order - b.order);
}

function show() {
  const all = rows();
  const done = all.filter((r) => r.status === "indexed").length;
  const target = all.filter((r) => r.status !== "skip").length;

  console.log(`\n색인 진행 ${done}/${target}\n`);
  for (const r of all) {
    const when = r.date ? ` ${r.date}` : "";
    console.log(
      `  ${MARK[r.status] || "[?]"} ${r.url.padEnd(22)} ${WORD[r.status].padEnd(4)}${when}` +
      `${r.status === "skip" ? "" : ""}  ${r.title}`
    );
  }

  const pending = all.filter((r) => r.status === "requested");
  if (pending.length) {
    console.log(`\n결과 대기 중 (${pending.length}개) — 서치콘솔에서 색인됐는지 보고 \`완료\` 로 기록하십시오.`);
  }

  const next = all.find((r) => r.status === "todo");
  console.log("");
  if (!next) {
    console.log("요청할 페이지가 남아 있지 않습니다.");
  } else {
    console.log("─".repeat(64));
    console.log("오늘 요청할 주소 (서치콘솔 맨 위 검사창에 붙여넣기):");
    console.log("");
    console.log(`  ${BASE_URL}${next.url}`);
    console.log("");
    console.log("  검사 → '색인 생성 요청' 클릭 → 아래 명령으로 기록:");
    console.log(`  node tools/index-status.js 요청 ${next.url}`);
    console.log("─".repeat(64));
  }

  const d = drift();
  if (d.missing.length) console.log(`\n★ 진행표에 없는 페이지: ${d.missing.join(", ")}`);
  if (d.orphan.length) console.log(`\n★ 페이지가 없는 진행표 항목: ${d.orphan.join(", ")}`);
  console.log("");
}

function mark(url, status) {
  if (!db.pages[url]) {
    const near = Object.keys(db.pages).filter((u) => u.includes(url.replace(/\//g, "")));
    console.error(`진행표에 없는 주소: ${url}`);
    if (near.length) console.error(`혹시 이것입니까? ${near.join(", ")}`);
    process.exit(1);
  }
  const prev = db.pages[url].status;
  db.pages[url].status = status;
  db.pages[url].date = today();
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2) + "\n", "utf8");
  console.log(`${url}: ${WORD[prev]} → ${WORD[status]} (${today()})`);
}


/**
 * 서치콘솔이 내보낸 CSV 를 읽어 진행표를 한 번에 맞춘다.
 *
 * 왜 필요한가: 요청했는지 안 했는지를 사람이 기억해 손으로 적으면 결국 틀린다.
 * 실제로 며칠 지나자 "wage-converter 만 남은 것 같은데 확실하지 않다" 가 됐다.
 * 서치콘솔은 색인된 주소 전체를 CSV 로 내보낼 수 있고, 그 파일이 정답이다.
 * 우리가 적어 둔 것과 다르면 CSV 를 믿는다.
 *
 * 받는 곳: 서치콘솔 → 색인 생성 → 페이지 → '색인이 생성된 페이지 보기'
 *          → 오른쪽 위 '내보내기' → CSV 다운로드(zip). 압축을 풀면 나오는
 *          '표.csv' 또는 'Table.csv' 를 그대로 넘기면 된다.
 *
 * 열 이름은 언어와 시점에 따라 달라지므로 이름을 믿지 않는다. 어느 칸이든
 * 우리 주소로 보이는 문자열을 찾는다.
 */
function importCsv(file) {
  if (!file || !fs.existsSync(file)) {
    console.error(`CSV 파일을 찾을 수 없습니다: ${file || "(경로 없음)"}`);
    console.error("서치콘솔 → 색인 생성 → 페이지 → '색인이 생성된 페이지 보기' → 내보내기 → CSV");
    process.exit(1);
  }
  // BOM 이 붙어 오는 경우가 많다. 남겨 두면 첫 칸이 통째로 어긋난다.
  const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  const host = BASE_URL.replace(/^https?:\/\//, "").replace(/\./g, "\\.");

  // 따옴표로 감싼 칸 안에 쉼표가 들어 있을 수 있다. 칸을 나누려 들지 말고
  // 주소 모양만 직접 집는다.
  const RE = new RegExp('https?://' + host + '(/[^\\s",]*)?', "g");
  const found = new Set();
  for (const m of text.matchAll(RE)) {
    let u = m[1] || "/";
    if (!u.endsWith("/")) u += "/";   // 서치콘솔은 끝 슬래시를 떼고 주기도 한다
    found.add(u);
  }

  if (found.size === 0) {
    console.error("CSV 에서 우리 주소를 하나도 찾지 못했습니다.");
    console.error(`찾던 형태: ${BASE_URL}/...`);
    console.error("다른 속성의 CSV 이거나, 차트 요약본 파일일 수 있습니다.");
    process.exit(1);
  }

  const changes = [], unknown = [];
  for (const u of found) {
    if (!db.pages[u]) { unknown.push(u); continue; }
    if (db.pages[u].status !== "indexed") {
      changes.push(`  ${u} : ${WORD[db.pages[u].status]} → 색인됨`);
      db.pages[u].status = "indexed";
      db.pages[u].date = today();
    }
  }

  // ★CSV 에 없는데 우리가 색인됐다고 적어 둔 것은 되돌린다.★
  // 색인은 나중에 취소되기도 한다(중복 판정, 품질 판단). 우리 기록만 색인됨으로
  // 남으면 빠진 페이지를 영영 모르고 지나간다.
  const dropped = [];
  for (const [u, v] of Object.entries(db.pages)) {
    if (v.status === "indexed" && !found.has(u)) {
      dropped.push(`  ${u} : 색인됨 → 대기 (CSV 에 없음)`);
      v.status = "todo";
      v.date = null;
    }
  }

  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2) + "\n", "utf8");

  console.log(`CSV 에서 색인된 주소 ${found.size}개를 읽었습니다.`);
  if (changes.length) { console.log("\n새로 색인 확인:"); changes.forEach((c) => console.log(c)); }
  if (dropped.length) { console.log("\n★색인에서 빠졌습니다:"); dropped.forEach((c) => console.log(c)); }
  if (unknown.length) { console.log("\n진행표에 없는 주소(무시함):"); unknown.forEach((u) => console.log(`  ${u}`)); }
  if (!changes.length && !dropped.length) console.log("바뀐 것이 없습니다. 진행표가 이미 맞습니다.");
  console.log("");
  show();
}

const [cmd, arg] = process.argv.slice(2);

if (cmd === "--check") {
  const d = drift();
  if (d.missing.length || d.orphan.length) {
    console.error("색인 진행표가 페이지 목록과 어긋납니다.");
    for (const u of d.missing) console.error(`  진행표에 없음: ${u}`);
    for (const u of d.orphan) console.error(`  페이지가 없음: ${u}`);
    process.exit(1);
  }
  console.log(`색인 진행표: ${Object.keys(db.pages).length}개 항목 · 페이지 목록과 일치`);
} else if (cmd === "요청" || cmd === "request") {
  mark(arg, "requested");
} else if (cmd === "완료" || cmd === "done") {
  mark(arg, "indexed");
} else if (cmd === "가져오기" || cmd === "import") {
  importCsv(arg);
} else if (cmd) {
  console.error(`알 수 없는 명령: ${cmd}\n` +
    "사용: node tools/index-status.js [요청|완료 <경로>] [가져오기 <CSV>] [--check]");
  process.exit(1);
} else {
  show();
}
