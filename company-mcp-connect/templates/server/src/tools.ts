import type { McpConfig } from "./config.js";
import type { AuditLog } from "./audit.js";
import type { Db } from "./db/index.js";
import { digest, type WriteLedger } from "./ledger.js";
import type { Storage } from "./storage/index.js";

/**
 * Claude 에 내놓는 도구 목록 — 이 파일이 "AI 가 볼 수 있는 것과 할 수 있는 것"의 전부다.
 *
 * 예시는 가상 회사 「새봄인테리어」(인테리어 시공사)다. 실제 회사에 맞출 때는
 *  - 도구 이름 앞머리(PREFIX)를 회사 약칭으로 바꾸고,
 *  - SQL 의 뷰 이름·칸 이름을 회사 DB 에 만든 뷰로 바꾸고,
 *  - description 을 "직원이 실제로 할 질문"이 들어가게 고쳐 쓴다(Claude 는 이 글을 읽고 도구를 고른다).
 *
 * 원칙
 *  - SQL 을 Claude 가 직접 쓰게 하는 "아무 쿼리나 실행" 도구는 만들지 않는다. 정해 둔 질문만 받는다.
 *  - 도구는 원본 표가 아니라 mcp 스키마의 "뷰"만 읽는다. 가림은 뷰에서 1차로 한다.
 *  - 모든 호출은 감사 로그 두 줄(CALL·RESULT)을 남긴다.
 *  - 쓰기 도구는 MCP_ENABLE_WRITES=1 일 때만 목록에 나타나고, confirm=true 없이는 미리보기만 한다.
 */

export const PREFIX = "saebom_";

export interface ToolResponse {
  data: unknown;
  isError: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(input: Record<string, unknown>): Promise<ToolResponse>;
}

export interface Ctx {
  config: McpConfig;
  db: Db;
  storage: Storage | null;
  audit: AuditLog;
  ledger: WriteLedger;
  dataSource: string;
}

type Input = Record<string, unknown>;

/* ───────── 입력 정리 도우미 ───────── */

export const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const int = (v: unknown, dflt: number, min: number, max: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(Math.trunc(v), min), max) : dflt;
/** LIKE 검색어 — % _ 를 글자 그대로 찾게 이스케이프하지 않고, 아예 지운다(단순하게). */
const like = (s: string): string => `%${s.replace(/[%_\\]/g, "").toLowerCase()}%`;
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object", properties, required, additionalProperties: false,
});

export const ok = (data: unknown): ToolResponse => ({ data, isError: false });
export const fail = (message: string): ToolResponse => ({ data: { error: message }, isError: true });

/** DB 가 "규칙상 거절"한 오류인가(아무것도 쓰이지 않았음이 확실). 연결 끊김 같은 오류와 구별한다. */
function isRefusal(db: Db, e: unknown): boolean {
  const x = e as { code?: string; errno?: number; number?: number };
  if (db.kind === "postgres") return x.code === "P0001"; // RAISE EXCEPTION
  if (db.kind === "mysql") return x.errno === 1644; // SIGNAL SQLSTATE '45000'
  return typeof x.number === "number" && x.number >= 50000; // THROW 50001
}

/** 모든 도구 공통: 감사 로그 두 줄 + 오류를 Claude 가 읽을 수 있는 말로. */
function audited(ctx: Ctx, tool: string, run: (i: Input) => Promise<{ data: unknown; rows: number }>): McpTool["handler"] {
  return async (input) => {
    const started = Date.now();
    await ctx.audit.write({ tool, phase: "CALL", input });
    try {
      const { data, rows } = await run(input);
      await ctx.audit.write({ tool, phase: "RESULT", input, outcome: rows ? "OK" : "EMPTY", rows, ms: Date.now() - started });
      return ok(data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const outcome = isRefusal(ctx.db, e) ? "DENIED" : "ERROR";
      await ctx.audit.write({ tool, phase: "RESULT", input, outcome, rows: 0, ms: Date.now() - started, error: msg });
      return fail(msg);
    }
  };
}

/* ───────── 도구 목록 ───────── */

export function buildTools(ctx: Ctx): McpTool[] {
  const { db } = ctx;
  const tools: McpTool[] = [
    {
      name: `${PREFIX}project_search`,
      description:
        "시공 현장(프로젝트)을 현장 코드·현장명·고객명으로 찾는다. 「강남 아파트 현장 지금 어디까지 했어?」 「김OO 고객 현장 목록」 같은 질문에 먼저 쓴다. " +
        "status 로 단계(견적·계약·시공·완료)를 좁힐 수 있다. 계약 전 비공개 견적은 현장명이 '(비공개 견적)'으로 가려져 현장명으로는 찾아지지 않는다(코드·고객명으로는 찾아진다). " +
        "0건이면 없다고 답하고 지어내지 않는다. 읽기 전용.",
      inputSchema: object({
        text: { type: "string", description: "현장 코드(P2026-001)·현장명·고객명의 일부. 비우면 최근 현장." },
        status: { type: "string", enum: ["견적", "계약", "시공", "완료"] },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "기본 20." },
      }),
      handler: audited(ctx, `${PREFIX}project_search`, async (i) => {
        const where: string[] = [];
        const params: unknown[] = [];
        const text = str(i.text);
        if (text) {
          params.push(like(text));
          const n = params.length;
          where.push(`(lower(code) LIKE $${n} OR lower(site_name) LIKE $${n} OR lower(customer_name) LIKE $${n})`);
        }
        const status = str(i.status);
        if (status) {
          params.push(status);
          where.push(`status = $${params.length}`);
        }
        params.push(int(i.limit, 20, 1, 50));
        const rows = await db.query(
          `SELECT code, site_name, customer_code, customer_name, status, start_date, end_date, manager
             FROM mcp.v_project ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
            ORDER BY code DESC ${db.limit(params.length)}`,
          params,
        );
        return { data: { count: rows.length, projects: rows, data_source: ctx.dataSource }, rows: rows.length };
      }),
    },
    {
      name: `${PREFIX}project_detail`,
      description:
        "현장 한 건의 요약과 남은 일정(기한)을 돌려준다. code 는 project_search 결과의 code 를 그대로 쓴다. 공사 금액·고객 연락처는 돌려주지 않는다. 읽기 전용.",
      inputSchema: object({ code: { type: "string", description: "현장 코드. 예: P2026-001" } }, ["code"]),
      handler: audited(ctx, `${PREFIX}project_detail`, async (i) => {
        const code = str(i.code)?.toUpperCase();
        if (!code) throw new Error("code 가 비었다. project_search 로 먼저 찾는다.");
        const [project] = await db.query(
          `SELECT code, site_name, customer_code, customer_name, status, start_date, end_date, manager
             FROM mcp.v_project WHERE code = $1`,
          [code],
        );
        if (!project) return { data: { found: false, code }, rows: 0 };
        const deadlines = await db.query(
          `SELECT title, kind, due_date, days_left, done FROM mcp.v_deadline WHERE project_code = $1 ORDER BY due_date`,
          [code],
        );
        return { data: { found: true, project, deadlines }, rows: 1 };
      }),
    },
    {
      name: `${PREFIX}customer_search`,
      description:
        "고객을 이름이나 고객 코드(C0001)로 찾는다. 현장 수와 첫 거래일만 돌려주고 전화·이메일·주소는 돌려주지 않는다 — 연락처를 물으면 사내 고객관리 화면에서 확인하라고 안내한다. 읽기 전용.",
      inputSchema: object({
        text: { type: "string", description: "이름 또는 고객 코드의 일부. 비우면 전체." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "기본 30." },
      }),
      handler: audited(ctx, `${PREFIX}customer_search`, async (i) => {
        const text = str(i.text);
        const params: unknown[] = text ? [like(text)] : [];
        const where = text ? "WHERE lower(code) LIKE $1 OR lower(name) LIKE $1" : "";
        params.push(int(i.limit, 30, 1, 100));
        const rows = await db.query(
          `SELECT code, name, project_count, first_order_date FROM mcp.v_customer ${where}
            ORDER BY code ${db.limit(params.length)}`,
          params,
        );
        return { data: { count: rows.length, customers: rows }, rows: rows.length };
      }),
    },
    {
      name: `${PREFIX}deadline_list`,
      description:
        "앞으로 다가오는 미완료 일정(계약·자재 발주·검수 등)을 날짜순으로 돌려준다. 「이번 주 자재 발주 마감 뭐 있어?」 같은 질문에 쓴다. " +
        "include_overdue=true 면 지났는데 완료 표시가 없는 것도 함께(days_left 음수). 읽기 전용.",
      inputSchema: object({
        days: { type: "integer", minimum: 1, maximum: 365, description: "오늘부터 며칠 앞까지. 기본 14." },
        include_overdue: { type: "boolean" },
        kind: { type: "string", description: "일정 종류로 좁힐 때. 예: 자재" },
      }),
      handler: audited(ctx, `${PREFIX}deadline_list`, async (i) => {
        const params: unknown[] = [i.include_overdue === true ? -3650 : 0, int(i.days, 14, 1, 365)];
        let where = "done = 0 AND days_left BETWEEN $1 AND $2";
        const kind = str(i.kind);
        if (kind) {
          params.push(kind);
          where += ` AND kind = $${params.length}`;
        }
        const rows = await db.query(
          `SELECT project_code, site_name, title, kind, due_date, days_left FROM mcp.v_deadline
            WHERE ${where} ORDER BY due_date, project_code`,
          params,
        );
        return { data: { count: rows.length, deadlines: rows, data_source: ctx.dataSource }, rows: rows.length };
      }),
    },
    {
      name: `${PREFIX}next_project_code`,
      description:
        "다음 현장 코드를 미리 본다. 번호를 예약하지 않는다 — 실제 번호는 현장을 등록하는 순간 정해지고, 그사이 다른 등록이 있으면 달라진다. 읽기 전용.",
      inputSchema: object({}),
      handler: audited(ctx, `${PREFIX}next_project_code`, async () => {
        const [r] = await db.query<{ code: string }>("SELECT mcp.peek_next_project_code() AS code");
        return { data: { next_code: r?.code ?? null, reserved: false }, rows: r ? 1 : 0 };
      }),
    },
  ];

  /* ───────── 업무 매뉴얼(파일 저장소) — 저장소를 설정했을 때만 ───────── */
  if (ctx.storage) tools.push(...manualTools(ctx, ctx.storage));

  /* ───────── 쓰기 — 기본으로 목록에 없다 ───────── */
  if (ctx.config.writesEnabled) tools.push(createProjectTool(ctx));

  return tools;
}

/* ───────── 매뉴얼 찾기·읽기 ───────── */

const READ_LIMIT = 12_000; // 문서 한 건 최대 바이트. 넘으면 truncated=true
const SCAN_LIMIT = 200; // 찾기에서 훑는 최대 문서 수

function manualTools(ctx: Ctx, storage: Storage): McpTool[] {
  return [
    {
      name: `${PREFIX}manual_find`,
      description:
        "회사 업무 매뉴얼·사내 규정 문서에서 낱말이 들어간 대목을 찾는다. 「욕실 방수 공사 순서가 어떻게 돼?」 「하자 접수되면 뭐부터 해?」 같은 사내 절차 질문은 먼저 이 도구를 부른다. " +
        "text 에는 핵심 낱말만 띄어 써서 넣는다(모두 들어간 줄을 찾는다). text 를 비우면 문서 목록이 온다. 0건이면 매뉴얼에 없다고 답하고 회사 규칙을 지어내지 않는다. " +
        "답할 때 문서 이름(path)과 제목을 근거로 밝힌다. 읽기 전용.",
      inputSchema: object({
        text: { type: "string", description: "핵심 낱말(띄어쓰기로 여러 개). 비우면 문서 목록." },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "최대 대목 수. 기본 8." },
      }),
      handler: audited(ctx, `${PREFIX}manual_find`, async (i) => {
        const files = await storage.list();
        const text = str(i.text);
        if (!text) {
          return { data: { count: files.length, documents: files, source: storage.label }, rows: files.length };
        }
        const words = text.toLowerCase().split(/\s+/).filter(Boolean);
        const max = int(i.limit, 8, 1, 20);
        const hits: { path: string; heading: string | null; line: number; excerpt: string }[] = [];
        for (const f of files.slice(0, SCAN_LIMIT)) {
          if (hits.length >= max) break;
          const { text: body } = await storage.readText(f.path, READ_LIMIT * 4);
          /* 한 줄이 "그 줄 + 소속 제목" 안에 낱말을 모두 담고, 줄 자체에도 낱말이 하나 이상 있으면 찾은 것으로 본다. */
          let heading: string | null = null;
          const lines = body.split(/\r?\n/);
          for (let n = 0; n < lines.length && hits.length < max; n++) {
            const line = lines[n]!;
            if (/^#{1,6}\s/.test(line)) heading = line.replace(/^#+\s*/, "");
            const low = line.toLowerCase();
            const scope = `${low} ${(heading ?? "").toLowerCase()}`;
            if (line.trim() && words.some((w) => low.includes(w)) && words.every((w) => scope.includes(w))) {
              hits.push({ path: f.path, heading, line: n + 1, excerpt: line.trim().slice(0, 300) });
            }
          }
        }
        return {
          data: { count: hits.length, hits, note: "전문은 manual_read 로 읽는다.", source: storage.label },
          rows: hits.length,
        };
      }),
    },
    {
      name: `${PREFIX}manual_read`,
      description:
        "업무 매뉴얼 문서 한 건의 전문을 읽는다. path 는 manual_find 결과의 path 를 그대로 쓴다. 절차 전체 순서를 물을 때 쓴다. " +
        "문서의 숫자·기간·금액은 적힌 그대로 옮긴다. 읽기 전용.",
      inputSchema: object({ path: { type: "string", description: "문서 경로. 예: 시공/욕실-방수.md" } }, ["path"]),
      handler: audited(ctx, `${PREFIX}manual_read`, async (i) => {
        const path = str(i.path);
        if (!path) throw new Error("path 가 비었다. manual_find 로 문서 목록을 먼저 본다.");
        const { text, truncated } = await storage.readText(path, READ_LIMIT);
        return { data: { path, truncated, text }, rows: 1 };
      }),
    },
  ];
}

/* ───────── 현장 등록(쓰기) ───────── */

function createProjectTool(ctx: Ctx): McpTool {
  const { db } = ctx;
  const name = `${PREFIX}project_create`;
  const call = (args: unknown[]) => {
    const sql =
      db.kind === "postgres" ? "SELECT mcp.create_project($1, $2, $3, $4) AS code"
      : db.kind === "mysql" ? "CALL mcp.create_project($1, $2, $3, $4)"
      : "EXEC mcp.create_project $1, $2, $3, $4";
    return db.query<{ code: string }>(sql, args);
  };

  return {
    name,
    description:
      "새 현장을 견적 단계로 등록하고 현장 코드를 매긴다. confirm 없이 부르면 등록하지 않고 예상 코드와 그 고객의 기존 현장을 보여 준다. " +
      "사용자에게 내용을 보여 주고 '등록해'라는 승인을 받은 뒤에만 confirm=true 로 부른다. 같은 내용의 재호출은 차단된다.",
    inputSchema: object({
      customer_code: { type: "string", description: "고객 코드(C0001). customer_search 로 확인한 값." },
      site_name: { type: "string", description: "현장명. 예: 분당 OO아파트 101동 욕실" },
      start_date: { type: "string", description: "착공 예정일 YYYY-MM-DD. 모르면 비운다." },
      confirm: { type: "boolean", description: "true 일 때만 실제로 등록한다." },
      allow_duplicate: { type: "boolean", description: "같은 내용이지만 별개 현장임을 사용자가 확인했을 때만." },
    }, ["customer_code", "site_name"]),

    handler: audited(ctx, name, async (i) => {
      const customer = str(i.customer_code)?.toUpperCase();
      const site = str(i.site_name);
      const start = str(i.start_date);
      if (!customer || !site) throw new Error("customer_code 와 site_name 이 필요하다.");
      if (start && !/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new Error("start_date 는 YYYY-MM-DD 꼴이다.");

      if (i.confirm !== true) {
        const [next] = await db.query<{ code: string }>("SELECT mcp.peek_next_project_code() AS code");
        const existing = await db.query(
          `SELECT code, site_name, status FROM mcp.v_project WHERE customer_code = $1 ORDER BY code DESC ${db.limit(2)}`,
          [customer, 10],
        );
        return {
          data: {
            dry_run: true, written: false,
            would_create: { customer_code: customer, site_name: site, start_date: start, expected_code: next?.code ?? null },
            existing_projects_of_customer: existing,
            note: "아직 등록하지 않았다. 사용자에게 보여 주고 승인을 받은 뒤에만 confirm=true 로 다시 부른다. 예상 코드는 예약이 아니다.",
          },
          rows: 0,
        };
      }

      const claim = await ctx.ledger.claim(digest("project_create", { customer, site, start }), i.allow_duplicate === true);
      if (!claim.claimed) {
        return {
          data: {
            written: false, duplicate_blocked: true, prior: claim.prior,
            problem: "같은 내용의 등록 요청이 이미 있었다. 다시 부르면 현장이 둘 생긴다. project_search 로 확인하고, 정말 별개 현장이면 사용자 승인 후 allow_duplicate=true 로 부른다.",
          },
          rows: 0,
        };
      }
      try {
        const [r] = await call([customer, site, start, ctx.config.actor]);
        if (!r?.code) throw new Error("등록 함수가 코드를 돌려주지 않았다.");
        await ctx.ledger.done(claim.key, r.code);
        return { data: { written: true, code: r.code, registered_by: ctx.config.actor }, rows: 1 };
      } catch (e) {
        /* DB 가 규칙상 거절 → 아무것도 안 생김 → 원장 지움. 그 밖의 오류 → 들어갔는지 모름 → 막아 둠. */
        if (isRefusal(db, e)) await ctx.ledger.release(claim.key);
        else await ctx.ledger.unknown(claim.key);
        throw e;
      }
    }),
  };
}

export async function callTool(tools: McpTool[], name: string, input: Input): Promise<ToolResponse> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return fail(`그런 도구는 없다: ${name}`);
  try {
    return await tool.handler(input);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
