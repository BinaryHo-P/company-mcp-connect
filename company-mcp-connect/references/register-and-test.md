# Claude 에 등록하기 · 시험 순서

## 목차
1. 등록 전 준비
2. Claude Code 에 등록
3. Claude Desktop 에 등록
4. 시험 순서
5. 자주 나는 오류

---

## 1. 등록 전 준비

```bash
cd <서버 폴더>
npm install
npm run build                 # dist/main.js 가 생긴다
cp .env.example .env          # 값을 채운다. 비밀번호는 여기에만
chmod 600 .env                # Mac·Linux
node --env-file=.env scripts/smoke-test.mjs    # 4-2 의 스모크 시험이 통과해야 등록한다
```
Node.js 20 이상이 필요하다(`node -v`). 없으면 https://nodejs.org 에서 LTS 를 설치한다.

## 2. Claude Code 에 등록

```bash
claude mcp add saebom --scope user -- node --env-file=/절대경로/서버폴더/.env /절대경로/서버폴더/dist/main.js
```
- `--scope user` 는 모든 폴더에서 보인다. 특정 프로젝트 폴더에서만 쓰려면 `--scope local`.
- Windows 예: `claude mcp add saebom --scope user -- "C:\Program Files\nodejs\node.exe" --env-file=C:\saebom-mcp\.env C:\saebom-mcp\dist\main.js`
- 확인: `claude mcp list` 에서 `saebom … ✓ Connected`. 새 Claude Code 세션을 열면 도구가 보인다(`/mcp` 로 목록 확인).
- 클라우드 인증이면 `.env` 에 비밀이 없으므로 `-e MCP_DB_AUTH=gcp-iam -e MCP_GCP_INSTANCE=…` 처럼 직접 적어도 된다.
- 쓰기를 켤 때는 같은 이름을 지우고(`claude mcp remove saebom --scope user`) `MCP_ENABLE_WRITES=1` 을 더해 다시 등록한다. 읽기용·쓰기용을 이름을 달리해 따로 두는 것도 방법이다.

## 3. Claude Desktop 에 등록

설정 파일을 연다(Claude Desktop → 설정 → 개발자 → 설정 편집, 또는 직접):
- Mac: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "saebom": {
      "command": "/usr/local/bin/node",
      "args": ["--env-file=/Users/<나>/saebom-mcp/.env", "/Users/<나>/saebom-mcp/dist/main.js"]
    }
  }
}
```
- `command` 는 **node 의 절대경로**로 쓴다(`which node` / Windows `where node`). Desktop 앱은 터미널의 PATH 를 모를 때가 많다.
- 이미 다른 서버가 있으면 `mcpServers` 안에 항목만 더한다(JSON 쉼표 주의).
- 저장 후 Claude Desktop 을 **완전히 종료했다가** 다시 연다. 입력창의 도구(🔨/커넥터) 메뉴에 saebom 이 보이면 된다.
- 서버 로그: Mac `~/Library/Logs/Claude/mcp-server-saebom.log`, Windows `%APPDATA%\Claude\logs\mcp-server-saebom.log` — 시작 실패 이유가 여기에 찍힌다.

## 4. 시험 순서

위에서부터 차례로. 하나라도 실패하면 다음으로 가지 않는다.

### 4-1 가상 DB 로 골격 확인 (선택, 권장)
회사 DB 를 건드리기 전에 템플릿이 이 PC 에서 도는지 본다. Docker 가 있으면:
```bash
docker run -d --name saebom-demo -e POSTGRES_PASSWORD=<관리자비번> -e POSTGRES_DB=saebom -p 55432:5432 postgres:16-alpine
docker exec -i saebom-demo psql -U postgres -d saebom < sql/postgres/demo.sql
```
`.env`:
```
MCP_DB_URL=postgres://mcp_reader:demo-only-change-me@localhost:55432/saebom
MCP_ISOLATION_PROBE=app.customer
MCP_STORAGE_KIND=local
MCP_STORAGE_ROOT=./demo/manuals
```
끝나면 `docker rm -f saebom-demo`.

### 4-2 스모크 시험
```bash
node --env-file=.env scripts/smoke-test.mjs
```
기대: stderr 에 `격리 확인 — 접속 계정 … · 원본 표 … 차단 확인`, 도구 목록, 읽기 도구 결과, 마지막 줄 `결과: 통과`.
도구 하나만: `node --env-file=.env scripts/smoke-test.mjs saebom_deadline_list '{"days":30}'`

### 4-3 안전장치 시험
`security-checklist.md` 의 G-1 ~ G-11 을 실행한다. 권한을 일부러 주는 시험(G-2, G-3)은 **시험용 DB 에서만**, 끝나면 반드시 회수한다.

예(PostgreSQL):
```bash
# G-1 관리자 계정이면 거절
MCP_DB_URL=postgres://postgres:<관리자비번>@localhost:55432/saebom node --env-file=.env dist/main.js </dev/null
# → [mcp] 시작 실패: 접속 롤 postgres 은(는) 권한 축소 롤이 아니다: 슈퍼유저, …
```

### 4-4 Claude 에서 실제 질문
새 세션에서 1단계의 업무 질문을 **사용자 말투 그대로** 던진다. 볼 것:
- 맞는 도구를 골랐나(도구 호출 표시를 펼쳐 본다)
- 0건일 때 "없다"고 했나, 지어내지 않았나
- 가린 정보를 물었을 때("OO 고객 전화번호") 도구가 없다고/가려졌다고 답했나
- 매뉴얼 답에 문서 이름을 근거로 댔나
- (쓰기를 켰다면) "등록해 줘"에 바로 등록하지 않고 미리보기를 먼저 보여 줬나

엉뚱한 도구를 고르면 코드가 아니라 **description** 을 고친다(실제 질문 예시를 넣는 것이 가장 효과적).

### 4-5 운영 연결
시험용에서 다 통과한 뒤에 운영 DB 주소(또는 클라우드 인증)로 바꾼다. 처음 며칠은 감사 로그(`~/.local/state/company-mcp/audit.jsonl`)를 열어 어떤 질문이 들어오는지 본다.

### 결과 보고 양식
```
| 항목 | 결과 |
| 스모크(도구 목록·읽기 도구) | 통과 / 실패(이유) |
| G-1 … G-11 | 통과 / 실패 / 미시험(이유: 예 — 실제 클라우드 계정 없음) |
| Claude 실제 질문 n개 | 맞는 도구 n/n |
```

## 5. 자주 나는 오류

| 메시지 | 원인 · 해결 |
|---|---|
| `권한 축소 롤이 아니다: …` | 관리자/소유자 계정으로 붙었다. MCP 전용 롤을 쓴다. 이 검사를 끄지 않는다. |
| `원본 표 … 를 읽을 수 있다` | 롤에 원본 표 권한이 남아 있다. `REVOKE` 하고 뷰만 연다. |
| `격리 확인용 표 … 가 없다` | `MCP_ISOLATION_PROBE` 이름이 틀렸다. 관리자 계정으로 표 이름을 확인한다. |
| `MCP_DB_URL 이 내 컴퓨터(localhost)가 아니다` | 원격 DB 에 비밀번호로 붙으려 했다. 클라우드면 IAM 인증, 사내 서버면 `MCP_DB_PASSWORD_REMOTE_OK=1`. |
| `패키지 … 가 필요하다: npm install …` | 그 DB·저장소용 선택 패키지를 설치하고 `npm run build`. |
| `Could not load the default credentials` | `gcloud auth application-default login` 을 사용자가 실행한다. |
| `permission denied for function …` | 롤에 함수 EXECUTE 권한이 없다(demo.sql ④ 참고). |
| Claude Desktop 에 서버가 안 보임 | node 절대경로, JSON 쉼표, 앱 완전 재시작, 로그 파일 확인. |
| 도구는 보이는데 Claude 가 안 씀 | description 에 실제 질문 예시를 넣는다. 다른 서버와 이름이 비슷하면 PREFIX 를 바꾼다. |
| `Failed to connect …` (SQL Server) | 서버 주소·포트·방화벽. 로컬 컨테이너가 아니면 정식 TLS 인증서가 필요하다. |
