-- ─────────────────────────────────────────────────────────────────────────────
-- 가상 회사 「새봄인테리어」 데모 DB — SQL Server / Azure SQL
-- ⚠️ 미시험: 이 파일은 PostgreSQL·MySQL 판과 같은 구조로 옮겨 적었지만 실제 SQL Server 에서 돌려 보지 않았다.
--    처음 쓸 때는 시험용 DB 에서 먼저 실행하고 오류를 고친다.
-- 실행: sqlcmd -S localhost -U sa -d saebom -i demo.sql   (관리자 계정, 시험용 DB)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE SCHEMA app;
GO
CREATE SCHEMA mcp;
GO

-- ① 원본 표
CREATE TABLE app.customer (
  id INT IDENTITY PRIMARY KEY,
  code NVARCHAR(10) UNIQUE NOT NULL,
  name NVARCHAR(100) NOT NULL,
  phone NVARCHAR(30), email NVARCHAR(100), address NVARCHAR(200),   -- ⛔
  created_at DATE NOT NULL
);
CREATE TABLE app.project (
  id INT IDENTITY PRIMARY KEY,
  code NVARCHAR(20) UNIQUE NOT NULL,
  customer_id INT NOT NULL REFERENCES app.customer(id),
  site_name NVARCHAR(200) NOT NULL,
  status NVARCHAR(10) NOT NULL CHECK (status IN (N'견적', N'계약', N'시공', N'완료')),
  confidential BIT NOT NULL DEFAULT 0,
  amount BIGINT,                                                     -- ⛔
  start_date DATE, end_date DATE, manager NVARCHAR(50), created_by NVARCHAR(100)
);
CREATE TABLE app.deadline (
  id INT IDENTITY PRIMARY KEY,
  project_id INT NOT NULL REFERENCES app.project(id),
  title NVARCHAR(200) NOT NULL,
  kind NVARCHAR(10) NOT NULL,
  due_date DATE NOT NULL,
  done BIT NOT NULL DEFAULT 0
);
GO

DECLARE @today DATE = CAST(GETDATE() AS DATE);
DECLARE @y NVARCHAR(4) = CAST(YEAR(@today) AS NVARCHAR(4));
INSERT INTO app.customer (code, name, phone, email, address, created_at) VALUES
  (N'C0001', N'김하늘', N'010-0000-0001', N'sky@example.com', N'가상시 가상구 1', DATEADD(day, -400, @today)),
  (N'C0002', N'이도윤', N'010-0000-0002', N'doyun@example.com', N'가상시 가상구 2', DATEADD(day, -200, @today)),
  (N'C0003', N'(주)푸른상사', N'02-000-0003', N'office@example.com', N'가상시 가상구 3', DATEADD(day, -90, @today)),
  (N'C0004', N'박서준', N'010-0000-0004', N'sj@example.com', N'가상시 가상구 4', DATEADD(day, -10, @today));
INSERT INTO app.project (code, customer_id, site_name, status, confidential, amount, start_date, end_date, manager) VALUES
  (N'P' + @y + N'-001', 1, N'햇살마을 아파트 302호 전체 리모델링', N'완료', 0, 48000000, DATEADD(day, -120, @today), DATEADD(day, -60, @today), N'최현장'),
  (N'P' + @y + N'-002', 2, N'은행나무 빌라 욕실 2곳', N'시공', 0, 12000000, DATEADD(day, -5, @today), DATEADD(day, 10, @today), N'정반장'),
  (N'P' + @y + N'-003', 3, N'푸른상사 본사 3층 사무실', N'계약', 0, 95000000, DATEADD(day, 7, @today), DATEADD(day, 40, @today), N'최현장'),
  (N'P' + @y + N'-004', 3, N'푸른상사 신규 지점 (입찰 중)', N'견적', 1, NULL, NULL, NULL, N'최현장'),
  (N'P' + @y + N'-005', 4, N'단풍로 주택 주방', N'견적', 0, NULL, NULL, NULL, N'정반장');
INSERT INTO app.deadline (project_id, title, kind, due_date, done) VALUES
  (2, N'욕실 방수층 양생 확인', N'검수', DATEADD(day, 2, @today), 0),
  (2, N'타일 자재 발주', N'자재', DATEADD(day, -1, @today), 0),
  (2, N'욕실 공사 준공 검수', N'검수', DATEADD(day, 10, @today), 0),
  (3, N'계약금 입금 확인', N'계약', DATEADD(day, 3, @today), 0),
  (3, N'천장재·조명 자재 발주', N'자재', DATEADD(day, 5, @today), 0),
  (3, N'착공 전 현장 실측', N'시공', DATEADD(day, 6, @today), 0);
GO

-- ② AI 전용 뷰. 소유권 체인(같은 소유자 dbo) 덕분에 뷰 권한만으로 원본을 읽는다.
CREATE VIEW mcp.v_project AS
SELECT p.code,
       CASE WHEN p.confidential = 1 AND p.status = N'견적' THEN N'(비공개 견적)' ELSE p.site_name END AS site_name,
       c.code AS customer_code, c.name AS customer_name, p.status, p.start_date, p.end_date, p.manager
  FROM app.project p JOIN app.customer c ON c.id = p.customer_id;
GO
CREATE VIEW mcp.v_customer AS
SELECT c.code, c.name, COUNT(p.id) AS project_count, c.created_at AS first_order_date
  FROM app.customer c LEFT JOIN app.project p ON p.customer_id = c.id
 GROUP BY c.id, c.code, c.name, c.created_at;
GO
CREATE VIEW mcp.v_deadline AS
SELECT p.code AS project_code,
       CASE WHEN p.confidential = 1 AND p.status = N'견적' THEN N'(비공개 견적)' ELSE p.site_name END AS site_name,
       d.title, d.kind, d.due_date,
       DATEDIFF(day, CAST(GETDATE() AS DATE), d.due_date) AS days_left,
       CAST(d.done AS INT) AS done
  FROM app.deadline d JOIN app.project p ON p.id = d.project_id;
GO

-- ③ 함수·프로시저
CREATE FUNCTION mcp.peek_next_project_code() RETURNS NVARCHAR(20) AS
BEGIN
  DECLARE @y NVARCHAR(4) = CAST(YEAR(GETDATE()) AS NVARCHAR(4));
  DECLARE @n INT = (SELECT COALESCE(MAX(CAST(RIGHT(code, 3) AS INT)), 0) + 1 FROM app.project WHERE code LIKE N'P' + @y + N'-%');
  RETURN N'P' + @y + N'-' + RIGHT(N'000' + CAST(@n AS NVARCHAR(10)), 3);
END;
GO
CREATE PROCEDURE mcp.create_project @customer NVARCHAR(10), @site NVARCHAR(200), @start DATE, @actor NVARCHAR(100) AS
BEGIN
  SET NOCOUNT ON;
  IF @actor IS NULL OR @actor = N'' THROW 50001, N'기록자(actor)가 없다 — 등록하지 않는다', 1;
  DECLARE @cid INT = (SELECT id FROM app.customer WHERE code = UPPER(@customer));
  IF @cid IS NULL THROW 50002, N'고객 코드가 없다 — 등록하지 않는다', 1;
  BEGIN TRAN;
    DECLARE @code NVARCHAR(20);
    SELECT @code = mcp.peek_next_project_code() FROM app.project WITH (TABLOCKX, HOLDLOCK) WHERE 1 = 0;
    SET @code = COALESCE(@code, mcp.peek_next_project_code());
    INSERT INTO app.project (code, customer_id, site_name, status, start_date, created_by)
    VALUES (@code, @cid, @site, N'견적', @start, @actor);
  COMMIT;
  SELECT @code AS code;
END;
GO

-- ④ 권한 축소 사용자: mcp 스키마의 SELECT·EXECUTE 만.
--    사내 서버: 로그인 + 사용자 (⛔ 데모용 비밀번호)
CREATE LOGIN mcp_reader WITH PASSWORD = 'Demo-only-change-me-1';
CREATE USER mcp_reader FOR LOGIN mcp_reader;
--    Azure SQL + Entra ID 라면 위 두 줄 대신:  CREATE USER [manager@example.com] FROM EXTERNAL PROVIDER;
GRANT SELECT ON SCHEMA::mcp TO mcp_reader;
GRANT EXECUTE ON OBJECT::mcp.peek_next_project_code TO mcp_reader;
-- 쓰기를 허용하기로 했을 때만:
GRANT EXECUTE ON OBJECT::mcp.create_project TO mcp_reader;
GO
