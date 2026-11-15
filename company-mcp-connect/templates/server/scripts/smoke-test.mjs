#!/usr/bin/env node
/**
 * Claude 에 등록하기 전에 서버가 제대로 뜨는지 확인하는 시험.
 * 실제 Claude 처럼 서버를 띄워(stdio) ① 도구 목록을 받고 ② 읽기 도구를 몇 개 불러 본다.
 *
 *   npm run build
 *   node --env-file=.env scripts/smoke-test.mjs            # 기본 시험
 *   node --env-file=.env scripts/smoke-test.mjs saebom_deadline_list '{"days":30}'   # 도구 하나 골라 부르기
 *
 * 환경변수는 이 스크립트를 실행한 셸(--env-file 포함)에서 서버로 그대로 넘어간다.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(here, "..", "dist", "main.js")],
  env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)),
  stderr: "inherit",
});
const client = new Client({ name: "smoke-test", version: "0.1.0" });

const show = (title, r) => {
  const text = r.content?.map((c) => c.text).join("\n") ?? "";
  console.log(`\n── ${title} ${r.isError ? "❌ 오류" : "✅"}\n${text.length > 1500 ? text.slice(0, 1500) + "\n… (잘림)" : text}`);
  return r;
};

let failed = 0;
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log(`\n── 도구 목록 (${tools.length}개)`);
  for (const t of tools) console.log(`  · ${t.name} — ${t.description.slice(0, 70)}…`);

  const [, , pick, args] = process.argv;
  const calls = pick
    ? [[pick, args ? JSON.parse(args) : {}]]
    : [
        ...tools.filter((t) => t.name.endsWith("project_search")).map((t) => [t.name, { limit: 5 }]),
        ...tools.filter((t) => t.name.endsWith("deadline_list")).map((t) => [t.name, { days: 30, include_overdue: true }]),
        ...tools.filter((t) => t.name.endsWith("manual_find")).map((t) => [t.name, { text: "방수" }]),
      ];
  for (const [name, a] of calls) {
    const r = show(`${name} ${JSON.stringify(a)}`, await client.callTool({ name, arguments: a }));
    if (r.isError) failed++;
  }
} catch (e) {
  console.error("\n❌ 시험 실패:", e instanceof Error ? e.message : e);
  failed++;
} finally {
  await client.close().catch(() => {});
}
console.log(failed ? `\n결과: 실패 ${failed}건` : "\n결과: 통과");
process.exit(failed ? 1 : 0);
