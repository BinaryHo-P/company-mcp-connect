# company-mcp-server (템플릿)

회사 DB·문서 저장소를 Claude 에 연결하는 MCP 서버 골격. 가상 회사 「새봄인테리어」(인테리어 시공사) 예시가 들어 있다 — 모든 데이터는 지어낸 것이다.

```
src/
  bootstrap.ts   쓰지 않는 환경변수 지우기, 로그를 stderr 로        (반드시 첫 import)
  config.ts      환경변수 검사 — 잘못되면 뜨지 않는다
  db/            postgres · mysql · sqlserver 어댑터 + 권한 축소 롤 검사
  storage/       local · gcs · s3 · azure 어댑터 (읽기 전용, 폴더 밖 차단)
  tools.ts       ★ Claude 에 내놓는 도구 목록 — 회사에 맞게 고칠 곳
  redact.ts      결과 가림 2차(연락처 칸·이메일·전화번호)
  audit.ts       감사 로그(JSON Lines)
  ledger.ts      쓰기 중복 방지 원장
  main.ts        시작 순서
sql/<DB>/demo.sql  가상 DB + 뷰 + 쓰기 함수 + 권한 축소 롤 (②~④를 회사 표에 맞춰 고친다)
demo/manuals/      가상 업무 매뉴얼
scripts/smoke-test.mjs  등록 전 시험
```

빠른 시작: `npm install && npm run build && cp .env.example .env` → `.env` 채우기 → `node --env-file=.env scripts/smoke-test.mjs`.
자세한 절차는 스킬의 `references/` 문서를 본다.
