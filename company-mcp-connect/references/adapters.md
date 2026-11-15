# 어댑터별 설정 — DB · 인증 · 저장소

아래 예시의 이름(`saebom-prod`, `saebom-db`, `manager@example.com`, `123456789012` 등)은 모두 가상이다. 사용자의 실제 값으로 바꾼다.
클라우드 쪽 명령(권한 부여·플래그 변경)은 **사용자나 클라우드 담당자가 직접 실행**한다. Claude 는 명령과 영향을 설명만 한다.

## 목차
1. 조합표
2. 환경변수 전체 목록
3. DB 별 준비
   - 3-1 내 PC / 사내 서버 (비밀번호 롤)
   - 3-2 GCP Cloud SQL + IAM
   - 3-3 AWS RDS + IAM
   - 3-4 Azure + Entra ID(Azure AD)
4. 저장소 별 준비 (로컬 · GCS · S3 · Azure Blob)
5. DB 마다 다른 SQL 문법 정리

---

## 1. 조합표

| DB \ 인증 | password | gcp-iam | aws-iam | azure-ad |
|---|---|---|---|---|
| PostgreSQL (`pg`, 기본 설치) | ✅ | ✅ `@google-cloud/cloud-sql-connector` | ✅ `@aws-sdk/rds-signer` | ✅ `@azure/identity` |
| MySQL (`mysql2`) | ✅ | ✅ `@google-cloud/cloud-sql-connector` | ✅ `@aws-sdk/rds-signer` | ✅ `@azure/identity` |
| SQL Server (`mssql`) | ✅ | ❌ (Cloud SQL for SQL Server 는 IAM DB 로그인 없음) | ❌ (RDS for SQL Server 도 없음) | ✅ (Azure SQL, 추가 패키지 없음) |

| 저장소 | 패키지 | 로그인 |
|---|---|---|
| `local` | 없음 | 없음 |
| `gcs` | `@google-cloud/storage` | `gcloud auth application-default login` |
| `s3` | `@aws-sdk/client-s3` | `aws sso login --profile <프로필>` + `AWS_PROFILE` |
| `azure` | `@azure/storage-blob` `@azure/identity` | `az login` |

필요한 패키지만 설치한다: `npm install mysql2` 처럼. 없는 패키지가 필요하면 서버가 "npm install …" 을 알려 주며 멈춘다.

시험 범위(템플릿 작성 시점): PostgreSQL+password, MySQL+password, 로컬 저장소는 가상 DB 로 실제 동작을 확인했다. **클라우드 인증(gcp-iam·aws-iam·azure-ad), SQL Server, GCS·S3·Azure Blob 은 패키지 로딩과 오류 메시지까지만 확인했고 실제 계정으로는 미시험**이다. 처음 쓰는 조합은 시험용 인스턴스에서 먼저 확인한다.

---

## 2. 환경변수 전체 목록

| 이름 | 뜻 | 기본값 |
|---|---|---|
| `MCP_COMPANY_NAME` | Claude 에 보이는 회사 이름 | 우리 회사 |
| `MCP_DB_KIND` | `postgres` · `mysql` · `sqlserver` | postgres |
| `MCP_DB_AUTH` | `password` · `gcp-iam` · `aws-iam` · `azure-ad` | password |
| `MCP_DB_URL` | (password) `postgres://롤:비번@localhost:5432/db` · `mysql://…` · `mssql://…` | — |
| `MCP_DB_PASSWORD_REMOTE_OK` | (password) `1` 이면 localhost 가 아닌 주소 허용 | 꺼짐 |
| `MCP_DB_USER` / `MCP_DB_NAME` | (클라우드) DB 사용자 / DB 이름 | — |
| `MCP_DB_HOST` / `MCP_DB_PORT` | (aws·azure) 호스트 / 포트 | DB 기본 포트 |
| `MCP_GCP_INSTANCE` | (gcp) `project:region:instance` | — |
| `MCP_GCP_IP_TYPE` | (gcp) `PUBLIC` · `PRIVATE` · `PSC` | PUBLIC |
| `MCP_AWS_REGION` | (aws) 예: `ap-northeast-2` | — |
| `MCP_DB_SSL_CA` | (aws) RDS 인증서 묶음 파일 경로 | — |
| `MCP_ISOLATION_PROBE` | 막혀 있어야 할 원본 표 `schema.table` | 없음(검사 생략 — 권장하지 않음) |
| `MCP_STORAGE_KIND` | `none` · `local` · `gcs` · `s3` · `azure` | none |
| `MCP_STORAGE_ROOT` | 폴더 경로 / 버킷 / 컨테이너 | — |
| `MCP_STORAGE_PREFIX` | 버킷 안 하위 경로(예 `manuals/`) | 없음 |
| `MCP_STORAGE_EXT` | 읽을 확장자 | `.md,.txt` |
| `MCP_S3_REGION` | (s3) 지역 | — |
| `MCP_AZURE_ACCOUNT_URL` | (azure) `https://<계정>.blob.core.windows.net` | — |
| `MCP_ACTOR` | 기록자 이메일. 클라우드 인증이면 비우거나 접속 계정과 같게 | 없음 |
| `MCP_ENABLE_WRITES` | `1` 이면 쓰기 도구를 연다 | 꺼짐 |
| `MCP_STATE_DIR` | 원장·감사 로그 폴더 | `~/.local/state/company-mcp` |
| `MCP_AUDIT_LOG` | 감사 로그 파일 | `<STATE_DIR>/audit.jsonl` |
| `MCP_KEEP_ENV` | 지우지 말고 남길 추가 환경변수 이름(쉼표) | 없음 |

`MCP_` 로 시작하지 않는 변수는 OS·클라우드 로그인용 몇 개를 빼고 시작할 때 지워진다(`bootstrap.ts`).

---

## 3. DB 별 준비

공통: 먼저 `sql/<DB>/demo.sql` 의 ②뷰 ③함수 ④롤 부분을 회사 표에 맞춰 고친 SQL 을 만들고, **시험용 DB** 에서 관리자 계정으로 실행해 본다.

### 3-1 내 PC / 사내 서버 (비밀번호 롤)

```
MCP_DB_KIND=postgres
MCP_DB_AUTH=password
MCP_DB_URL=postgres://mcp_reader:<긴 무작위 비밀번호>@localhost:5432/saebom
MCP_ISOLATION_PROBE=app.customer
```
- 사내 서버(다른 PC)면 `MCP_DB_PASSWORD_REMOTE_OK=1` 을 더하고, DB 서버 방화벽에서 이 PC 만 허용한다.
- 비밀번호 생성: `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`
- 비밀번호는 `.env` 에만. Claude 설정에는 `--env-file` 경로만 적는다.

### 3-2 GCP Cloud SQL + IAM (Google 계정으로 로그인, 비밀번호 없음)

왜: 프록시 데몬·열린 포트·비밀번호가 없다. 커넥터가 Google 로그인 토큰으로 TLS 직접 접속하고, DB 의 `current_user` 가 곧 그 Google 계정이라 감사 로그의 기록자가 증명된다.

클라우드 담당자가 한 번:
```bash
# ⚠ --database-flags 는 기존 플래그를 "통째로 교체"하고 인스턴스를 재시작한다.
#   먼저 현재 값을 확인해 함께 적고, 업무 시간 밖에, 백업 후 실행한다.
gcloud sql instances describe saebom-db --project saebom-prod --format='value(settings.databaseFlags)'
gcloud sql instances patch saebom-db --project saebom-prod --database-flags cloudsql.iam_authentication=on   # MySQL 은 cloudsql_iam_authentication=on
gcloud sql users create manager@example.com --instance saebom-db --project saebom-prod --type CLOUD_IAM_USER
gcloud projects add-iam-policy-binding saebom-prod --member user:manager@example.com --role roles/cloudsql.client
gcloud projects add-iam-policy-binding saebom-prod --member user:manager@example.com --role roles/cloudsql.instanceUser
```
DB 에서(관리자로):
```sql
-- PostgreSQL: demo.sql ④ 의 롤을 로그인 없는 묶음으로 만들고 IAM 사용자에게 물려준다
CREATE ROLE mcp_reader NOLOGIN;            -- (LOGIN PASSWORD … 대신)
-- … GRANT 들은 demo.sql ④ 그대로 …
GRANT mcp_reader TO "manager@example.com";
-- MySQL: IAM 사용자 이름은 이메일의 @ 앞부분(manager)
-- CREATE ROLE mcp_reader; GRANT SELECT ON mcp.* TO mcp_reader; …; GRANT mcp_reader TO 'manager'@'%'; SET DEFAULT ROLE mcp_reader TO 'manager'@'%';
```
사용자 PC 에서 한 번(브라우저 로그인 — 사용자가 직접):
```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project saebom-prod
npm install @google-cloud/cloud-sql-connector
```
```
MCP_DB_AUTH=gcp-iam
MCP_GCP_INSTANCE=saebom-prod:asia-northeast3:saebom-db
MCP_DB_USER=manager@example.com        # MySQL 이면 manager
MCP_DB_NAME=saebom
```
서비스 계정이면 PostgreSQL 사용자 이름은 `sa-name@saebom-prod.iam` (`.gserviceaccount.com` 을 뗀다).

### 3-3 AWS RDS + IAM

클라우드 담당자가 한 번: RDS 인스턴스에서 **IAM DB authentication** 을 켜고, 사용자(또는 SSO 권한 세트)에 다음 정책을 붙인다.
```json
{ "Effect": "Allow", "Action": "rds-db:connect",
  "Resource": "arn:aws:rds-db:ap-northeast-2:123456789012:dbuser:db-ABCDEFGHIJKL/mcp_user" }
```
DB 에서:
```sql
-- PostgreSQL
CREATE USER mcp_user; GRANT rds_iam TO mcp_user; GRANT mcp_reader TO mcp_user;   -- mcp_reader 는 NOLOGIN 묶음
-- MySQL
CREATE USER 'mcp_user'@'%' IDENTIFIED WITH AWSAuthenticationPlugin AS 'RDS';
GRANT mcp_reader TO 'mcp_user'@'%'; SET DEFAULT ROLE mcp_reader TO 'mcp_user'@'%';
```
사용자 PC:
```bash
aws sso login --profile saebom
curl -o ~/.config/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
npm install @aws-sdk/rds-signer
```
```
AWS_PROFILE=saebom
MCP_DB_AUTH=aws-iam
MCP_DB_HOST=saebom-db.abcdefghijkl.ap-northeast-2.rds.amazonaws.com
MCP_DB_USER=mcp_user
MCP_DB_NAME=saebom
MCP_AWS_REGION=ap-northeast-2
MCP_DB_SSL_CA=/Users/<나>/.config/rds-global-bundle.pem
```
토큰은 15분짜리지만 서버가 접속할 때마다 새로 받는다. IAM 인증은 사용자별 계정이 아니라 `mcp_user` 하나를 여럿이 쓰는 구조가 흔하다 — 이때 DB 기록자는 `mcp_user` 이므로 사람 구분이 필요하면 사람마다 DB 사용자를 따로 만든다.

### 3-4 Azure + Entra ID (Azure AD)

클라우드 담당자가 한 번: 서버에 Entra 관리자를 지정하고, 그 관리자 계정으로 DB 에 접속해 사용자를 만든다.
```sql
-- Azure Database for PostgreSQL (flexible)
SELECT * FROM pgaadauth_create_principal('manager@example.com', false, false);
GRANT mcp_reader TO "manager@example.com";
-- Azure Database for MySQL (flexible)
-- CREATE AADUSER 'manager@example.com'; GRANT mcp_reader TO 'manager@example.com'; SET DEFAULT ROLE …;
-- Azure SQL (SQL Server)
-- CREATE USER [manager@example.com] FROM EXTERNAL PROVIDER;
-- GRANT SELECT ON SCHEMA::mcp TO [manager@example.com]; GRANT EXECUTE ON OBJECT::mcp.peek_next_project_code TO [manager@example.com];
```
사용자 PC:
```bash
az login
npm install @azure/identity        # PostgreSQL·MySQL. Azure SQL 은 mssql 만 있으면 된다
```
```
MCP_DB_AUTH=azure-ad
MCP_DB_HOST=saebom-db.postgres.database.azure.com     # Azure SQL: saebom.database.windows.net
MCP_DB_USER=manager@example.com
MCP_DB_NAME=saebom
```

---

## 4. 저장소 별 준비

공통: **매뉴얼 전용 폴더/접두어**를 따로 두고 그 아래만 읽기 권한을 준다. 버킷 전체 권한을 주지 않는다.

### local (내 PC·NAS 공유 폴더)
```
MCP_STORAGE_KIND=local
MCP_STORAGE_ROOT=/Users/<나>/회사매뉴얼        # Windows: C:\회사매뉴얼  또는 \\NAS\매뉴얼
```
폴더 밖을 가리키는 심볼릭 링크는 따라가지 않는다. 점(.)으로 시작하는 파일·폴더는 목록에 안 나온다.

### gcs
```bash
gcloud storage buckets add-iam-policy-binding gs://saebom-docs --member user:manager@example.com --role roles/storage.objectViewer
npm install @google-cloud/storage
```
```
MCP_STORAGE_KIND=gcs
MCP_STORAGE_ROOT=saebom-docs
MCP_STORAGE_PREFIX=manuals/
```
접두어 단위로 더 좁히려면 IAM 조건(`resource.name.startsWith("projects/_/buckets/saebom-docs/objects/manuals/")`)을 쓴다.

### s3
IAM 정책(접두어로 제한):
```json
{ "Version": "2012-10-17", "Statement": [
  { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::saebom-docs",
    "Condition": { "StringLike": { "s3:prefix": ["manuals/*"] } } },
  { "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::saebom-docs/manuals/*" } ] }
```
```
AWS_PROFILE=saebom
MCP_STORAGE_KIND=s3
MCP_STORAGE_ROOT=saebom-docs
MCP_STORAGE_PREFIX=manuals/
MCP_S3_REGION=ap-northeast-2
```

### azure (Blob)
컨테이너 범위로 **Storage Blob Data Reader** 역할을 사용자에게 준다.
```
MCP_STORAGE_KIND=azure
MCP_AZURE_ACCOUNT_URL=https://saebomdocs.blob.core.windows.net
MCP_STORAGE_ROOT=manuals
```

---

## 5. DB 마다 다른 SQL 문법 정리

도구 SQL 은 DB 공통으로 쓰고, 다른 부분은 **뷰 안**에 넣는다.

| 할 일 | PostgreSQL | MySQL | SQL Server | 템플릿에서 |
|---|---|---|---|---|
| 자리표시자 | `$1` | `?` | `@p1` | 도구는 `$1` 로 쓰고 어댑터가 바꾼다 |
| 개수 제한 | `LIMIT n` | `LIMIT n` | `OFFSET 0 ROWS FETCH NEXT n ROWS ONLY` | `db.limit(n)` |
| 남은 날 수 | `due - current_date` | `DATEDIFF(due, CURDATE())` | `DATEDIFF(day, CAST(GETDATE() AS date), due)` | 뷰의 `days_left` |
| 참·거짓 | boolean | TINYINT | BIT | 뷰에서 0/1 정수로 통일 |
| 대소문자 무시 검색 | `lower(x) LIKE lower($1)` | 같음(기본 콜레이션은 이미 무시) | 같음 | 도구의 `like()` |
| 쓰기 함수 호출 | `SELECT f($1…)` | `CALL p(?…)` (마지막 SELECT 를 돌려받음) | `EXEC p @p1…` | `createProjectTool` 의 분기 |
| 규칙상 거절 | `RAISE EXCEPTION` (P0001) | `SIGNAL SQLSTATE '45000'` (1644) | `THROW 50001…` | `isRefusal()` |
| 날짜 칸 | 문자열로 받게 설정함 | `dateStrings: true` | JS Date(UTC 자정) | 어댑터 |
