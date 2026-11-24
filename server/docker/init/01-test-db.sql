-- Test database for the automated backend tests (truncated by the suites).
CREATE DATABASE IF NOT EXISTS label_mes_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
GRANT ALL PRIVILEGES ON label_mes_test.* TO 'label_mes'@'%';
-- Prisma migrate dev needs a shadow database.
GRANT CREATE, DROP, ALTER, INDEX, REFERENCES ON *.* TO 'label_mes'@'%';
FLUSH PRIVILEGES;
