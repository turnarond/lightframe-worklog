// Package testutil 提供测试用临时 Postgres（embedded-postgres 单例）+ 自动迁移。
// 这样后端可在无系统 PG 的本机走完整 TDD；生产环境不使用本包。
package testutil

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/fergusstrange/embedded-postgres"
	"github.com/jackc/pgx/v5/pgxpool"

	"lightframe/worklog-server/internal/db"
)

// pickPort 为每个测试进程选一个独立端口（基于 pid），避免跨包/跨次端口冲突。
func pickPort() uint32 {
	return 55000 + uint32(os.Getpid()%1500)
}

var (
	once    sync.Once
	pool    *pgxpool.Pool
	pg      *embeddedpostgres.EmbeddedPostgres
	startErr error
)

func start() {
	dir, err := os.MkdirTemp("", "worklog-pg")
	if err != nil {
		startErr = err
		return
	}
	port := pickPort()
	cfg := embeddedpostgres.DefaultConfig().
		Username("pguser").
		Password("pgpass").
		Database("worklog_test").
		Port(port).
		RuntimePath(filepath.Join(dir, "runtime")).
		DataPath(filepath.Join(dir, "data")).
		BinariesPath(filepath.Join(dir, "bin"))

	pg = embeddedpostgres.NewDatabase(cfg)
	if err := pg.Start(); err != nil {
		startErr = err
		return
	}
	url := fmt.Sprintf("postgres://pguser:pgpass@localhost:%d/worklog_test?sslmode=disable", port)
	ctx := context.Background()
	pool, startErr = pgxpool.New(ctx, url)
	if startErr != nil {
		return
	}
	startErr = db.MigrateUp(pool)
}

// TestPool 返回共享的测试连接池（首次调用会拉起临时 PG 并执行迁移）。
func TestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	once.Do(start)
	if startErr != nil {
		t.Fatalf("embedded postgres start failed: %v", startErr)
	}
	return pool
}

// Stop 停止临时 PG，供 TestMain 在测试结束后清理。
func Stop() {
	if pg != nil {
		_ = pg.Stop()
		pg = nil
	}
}
