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
 *   node tools/index-status.js --check      진행표가 페이지 목록과 어긋나면 exit 1
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DB_PATH = path.join(ROOT, "data", "index-status.json");
const PAGES = require(path.join(ROOT, "build", "pages.js"));
const BASE_URL = process.env.SN_BASE_URL || "https://salarynote.pages.dev";

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
} else if (cmd) {
  console.error(`알 수 없는 명령: ${cmd}\n사용: node tools/index-status.js [요청|완료 <경로>] [--check]`);
  process.exit(1);
} else {
  show();
}
