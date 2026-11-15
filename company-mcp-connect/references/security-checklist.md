# 보안 체크리스트

3단계에서 이 회사에 맞게 채워 보여 주고, 6단계에서 실제로 시험한다. 각 항목 옆 `[코드]` 는 템플릿에서 그 장치가 있는 곳이다.
회사 사정상 항목을 빼야 하면 빼되, 뺀 이유를 기록하게 한다.

## 목차
A. 무엇을 열 것인가 (표면)
B. 누구로 붙을 것인가 (접속 계정)
C. 무엇을 가릴 것인가 (가림)
D. 무엇을 남길 것인가 (기록)
E. 쓰기
F. 실행 환경
G. 시험으로 확인할 것

---

## A. 표면 — "할 수 있는 일"은 도구 목록이 전부다
- [ ] A-1 도구는 정해 둔 질문만 받는다. `run_sql`·`read_any_file` 같은 만능 도구가 없다. `[tools.ts]`
- [ ] A-2 입력은 enum·최대값·형식으로 좁혔고 `additionalProperties: false` 다. `[tools.ts object()]`
- [ ] A-3 SQL 은 자리표시자(`$1`)로만 값을 넣는다. 문자열을 이어 붙여 SQL 을 만들지 않는다. `[tools.ts]`
- [ ] A-4 한 번에 돌려주는 건수에 상한이 있다(검색 50, 목록 100 등). `[tools.ts int()]`
- [ ] A-5 문서 읽기는 정해 둔 폴더·확장자 안에서만, 파일 하나의 크기 상한이 있다. `[storage/index.ts cleanPath·READ_LIMIT]`

## B. 접속 계정 — 권한 축소 롤
- [ ] B-1 MCP 전용 DB 계정(롤)을 따로 만든다. 사람이 쓰는 관리자 계정·앱 계정을 같이 쓰지 않는다. `[sql/*/demo.sql ④]`
- [ ] B-2 그 롤은 `mcp` 스키마의 **뷰 읽기 + 정해진 함수 실행**만 할 수 있다. 원본 표는 권한 없음. `[demo.sql ④]`
- [ ] B-3 서버는 기동할 때 롤을 검사하고, 다음이면 **뜨지 않는다**: 슈퍼유저·관리자 묶음(cloudsqlsuperuser·rds_superuser·azure_pg_admin·sysadmin·db_owner)·BYPASSRLS·표 소유자·표 직접 쓰기 권한·GRANT OPTION. `[db/*.ts assertLeastPrivilege]`
- [ ] B-4 원본 표 하나를 `MCP_ISOLATION_PROBE` 로 지정해, 실제로 "권한 없음"으로 막히는지 기동 때마다 확인한다. `[assertLeastPrivilege(probe)]`
  - PostgreSQL 은 표가 실제로 있는지도 카탈로그로 확인한다. MySQL·SQL Server 는 권한 없는 계정이 표의 존재를 확인할 수 없으므로 **관리자가 표 이름을 한 번 확인**해 둔다.
- [ ] B-5 **클라우드 DB 는 비밀번호 대신 클라우드 계정 인증**(GCP IAM·AWS IAM·Azure AD)을 쓴다. 이유: 노트북에 비밀번호가 남지 않고, DB 가 "누가 붙었는지"를 증명해 주므로 감사 로그의 기록자를 믿을 수 있다. `[config.ts MCP_DB_AUTH]`
- [ ] B-6 비밀번호 롤은 내 PC(localhost)에서만 기본 허용. 사내 서버라 비밀번호 롤밖에 없으면 `MCP_DB_PASSWORD_REMOTE_OK=1` 을 명시하고, 그 비밀번호는 길고 무작위이며 `.env` 파일(권한 600)에만 둔다. `[config.ts checkPasswordUrl]`
- [ ] B-7 접속 주소의 쿼리 인자로 접속지를 바꾸는 우회(`?host=`)를 막는다. `[config.ts HOST_OVERRIDES]`
- [ ] B-8 원격 DB 접속은 TLS 로 하고 인증서를 검증한다(RDS 는 인증서 묶음 파일 지정). `[db/*.ts ssl]`

## C. 가림 — "볼 수 있는 것"은 뷰가 전부다
- [ ] C-1 연락처·주민번호·계좌·금액처럼 열지 않기로 한 칸은 **뷰에 아예 넣지 않는다**(1차). `[demo.sql ②]`
- [ ] C-2 조건부 가림(비공개 건 이름 등)은 뷰의 `CASE` 로 한다 — 그러면 검색으로도 새지 않는다. `[demo.sql v_project]`
- [ ] C-3 서버가 결과를 내보내기 직전에 한 번 더 거른다(2차): 연락처처럼 생긴 칸 이름은 칸째 제거, 글 속 이메일·전화번호는 가림. `[redact.ts]`
  - 2차 가림은 안전망이다. 이것만 믿고 뷰에 민감 칸을 두지 않는다.
  - 매뉴얼 본문의 회사 대표번호도 가려진다. 보여야 하면 회사가 판단해 예외를 둔다.
- [ ] C-4 오류 메시지에 비밀번호가 든 접속 주소 원문을 싣지 않는다. `[config.ts]`
- [ ] C-5 매뉴얼 문서 자체에 고객 실명·연락처가 있으면 문서를 익명화한 뒤 저장소에 둔다(도구가 대신 가려 주지 않는 내용이 있다).

## D. 기록 — 감사 로그
- [ ] D-1 모든 도구 호출이 두 줄(CALL·RESULT: 도구·입력·결과 건수·소요 시간·오류)로 남는다. `[audit.ts, tools.ts audited()]`
- [ ] D-2 로그에는 결과 본문(고객 정보)을 적지 않는다. 입력 중 비밀처럼 생긴 칸은 `***`. 보관 위치는 `MCP_AUDIT_LOG`(기본 `~/.local/state/company-mcp/audit.jsonl`, 권한 600). 여럿이 쓰면 DB 의 감사 표(INSERT 전용 함수)로 옮기는 것을 검토한다.
- [ ] D-3 기록자(actor): 클라우드 IAM 이면 **DB 가 확인한 접속 계정**이 기록자다. `MCP_ACTOR` 를 적었다면 그 계정과 같아야 하고, 다르면 뜨지 않는다. `[config.ts bindActor]`

## E. 쓰기
- [ ] E-1 쓰기 도구는 `MCP_ENABLE_WRITES=1` 일 때만 목록에 나타난다(기본 꺼짐). `[tools.ts buildTools]`
- [ ] E-2 기록자 없는 쓰기는 받지 않는다(비밀번호 롤이면 `MCP_ACTOR` 필수). `[config.ts loadConfig]`
- [ ] E-3 `confirm=true` 없이 부르면 미리보기(예상 결과 + 비슷한 기존 건)만 돌려준다. description 에 "사용자 승인 뒤에만 confirm" 을 적는다. `[tools.ts createProjectTool]`
- [ ] E-4 같은 내용의 재호출은 **중복 방지 원장**이 막는다(입력 지문으로 파일을 배타 생성 — Claude 창이 여러 개여도 한 건만). 원장에는 지문·상태·결과 번호만. `[ledger.ts]`
  - DB 가 규칙상 거절 → 원장 지움(고쳐서 다시 가능) / 연결 오류 등 결과 불명 → `UNKNOWN` 으로 막아 둠(사람이 확인 후 `allow_duplicate`).
- [ ] E-5 쓰기는 표 권한이 아니라 **DB 함수(SECURITY DEFINER / DEFINER 프로시저)** 로만 한다. 함수가 규칙(존재 확인·번호 매기기·기록자)을 지킨다. 롤에는 표 INSERT/UPDATE 권한이 없다. `[demo.sql ③]`
- [ ] E-6 삭제 도구는 만들지 않는다.

## F. 실행 환경
- [ ] F-1 서버가 쓰지 않는 환경변수(다른 DB 주소·외부 서비스 키)는 시작할 때 지운다(허용 목록 방식). `[bootstrap.ts]`
- [ ] F-2 stdout 은 MCP 통신 전용 — 로그는 stderr 로. `[bootstrap.ts]`
- [ ] F-3 Claude 를 닫으면(stdin 종료) 서버도 2초 안에 끝난다 — DB 연결이 남지 않게. `[main.ts shutdown]`
- [ ] F-4 `.env` 는 저장소에 올리지 않는다(`.gitignore`). 클라우드 키 파일(JSON 서비스 계정 키)은 쓰지 않고 사용자 로그인(ADC·SSO·az login)을 쓴다.
- [ ] F-5 서버 폴더와 `~/.local/state/company-mcp/` 는 그 사람만 읽을 수 있다.

## G. 시험으로 확인할 것 (6단계)
| # | 시험 | 기대 결과 |
|---|---|---|
| G-1 | 관리자 계정 주소로 서버 시작 | `권한 축소 롤이 아니다` 로 시작 실패 |
| G-2 | MCP 롤에 원본 표 SELECT 를 잠시 주고 시작 | `원본 표 … 를 읽을 수 있다` 로 시작 실패 (시험 후 권한 회수) |
| G-3 | MCP 롤에 표 INSERT 를 잠시 주고 시작 | `표 직접 쓰기 권한` 으로 시작 실패 (시험 후 회수) |
| G-4 | 고객 찾기 결과 | 전화·이메일·주소 칸이 없다 |
| G-5 | 비공개 건 검색 | 이름이 가려져 나오고, 이름으로는 찾아지지 않는다 |
| G-6 | `manual_read` 에 `../../.env` | `경로가 올바르지 않다` 오류 |
| G-7 | 쓰기 켜고 `confirm` 없이 등록 | `dry_run: true, written: false` |
| G-8 | 같은 등록을 confirm 으로 두 번 | 두 번째는 `duplicate_blocked: true` |
| G-9 | 원격 주소 + 비밀번호(허락 없이) | 시작 실패 |
| G-10 | Claude 를 닫은 뒤 프로세스 목록 | 서버 프로세스가 남지 않는다 |
| G-11 | 감사 로그 | 호출마다 CALL·RESULT 두 줄, 결과 본문 없음 |
