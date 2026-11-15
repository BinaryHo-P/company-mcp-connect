import "./bootstrap.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AuditLog } from "./audit.js";
import { bindActor, loadConfig } from "./config.js";
import { connectDb } from "./db/index.js";
import { WriteLedger } from "./ledger.js";
import { redact } from "./redact.js";
import { connectStorage } from "./storage/index.js";
import { buildTools, callTool } from "./tools.js";

/**
 * 시작 순서 — 하나라도 실패하면 뜨지 않는다(반쯤 열린 채로 일하지 않는다).
 *  1. 설정 검사(config.ts)
 *  2. DB 접속 → 권한 축소 롤인지 확인(관리자·소유자·쓰기 권한이면 거절) → 원본 표가 막혔는지 확인
 *  3. 클라우드 인증이면 DB 가 확인한 계정을 기록자로 묶는다
 *  4. 저장소 연결, 도구 목록 만들기
 */
async function main(): Promise<void> {
  let config = loadConfig(process.env);
  const db = await connectDb(config.db);
  try {
    const who = await db.assertLeastPrivilege(config.isolationProbe);
    config = bindActor(config, who);
    console.error(`[mcp] 격리 확인 — 접속 계정 ${who}${config.isolationProbe ? ` · 원본 표 ${config.isolationProbe} 차단 확인` : " · (MCP_ISOLATION_PROBE 없음: 원본 표 차단 확인 생략)"}`);
  } catch (e) {
    await db.close().catch(() => {});
    throw e;
  }

  const storage = await connectStorage(config.storage);
  const dataSource = `${config.db.kind} ${config.db.label}`;
  const tools = buildTools({
    config, db, storage, dataSource,
    audit: new AuditLog(config.auditLog, config.actor),
    ledger: new WriteLedger(config.stateDir, config.db.label.replace(/[^A-Za-z0-9_.-]+/g, "_")),
  });

  const server = new Server(
    { name: "company-mcp", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        `${config.companyName} 사내 시스템 조회 도구다. 연결된 DB: ${dataSource}. ` +
        "고객 연락처와 비공개 건의 이름은 회사 규칙에 따라 가려진다. 0건은 0건으로 전하고 지어내지 않는다. " +
        "쓰기 도구는 사용자 승인 없이 confirm=true 로 부르지 않는다.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const r = await callTool(tools, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>);
    /* 결과는 나가기 직전에 한 번 더 가린다(redact.ts). */
    return { content: [{ type: "text" as const, text: JSON.stringify(redact(r.data), null, 2) }], isError: r.isError };
  });

  /* Claude 를 닫으면 stdin 이 닫힌다. 그때 반드시 끝나야 한다(남은 프로세스가 DB 연결을 쥐고 있지 않게).
     드라이버의 정리가 멈춰도 2초 뒤에는 강제로 끝낸다. */
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => process.exit(0), 2000).unref();
    void db.close().catch(() => {}).finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);

  await server.connect(new StdioServerTransport());
  console.error(
    `[mcp] 시작 — ${dataSource} · 저장소 ${storage?.label ?? "없음"} · 기록자 ${config.actor ?? "(없음)"} · 쓰기 ${config.writesEnabled ? "켜짐" : "꺼짐"} · 도구 ${tools.length}개`,
  );
}

main().catch((e: unknown) => {
  console.error("[mcp] 시작 실패:", e instanceof Error ? e.message : e);
  process.exit(1);
});
