// Package db 负责 pgx 连接池与迁移执行。
// 同步时间戳统一用 BIGINT 毫秒（与客户端 updatedAt 同尺度），避免 timestamptz 与 ms since 的类型冲突。
package db

import (
	"context"
	"embed"
	"fmt"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// NewPool 建立连接池。
func NewPool(url string) (*pgxpool.Pool, error) {
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		return nil, fmt.Errorf("connect pg: %w", err)
	}
	return pool, nil
}

// MigrateUp 按文件名顺序执行 migrations/*.sql（幂等，建表用 IF NOT EXISTS）。
func MigrateUp(pool *pgxpool.Pool) error {
	entries, err := migrationsFS.ReadDir("migrations")
	if err != nil {
		return fmt.Errorf("read migrations: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	ctx := context.Background()
	for _, n := range names {
		sqlBytes, err := migrationsFS.ReadFile("migrations/" + n)
		if err != nil {
			return fmt.Errorf("read %s: %w", n, err)
		}
		if _, err := pool.Exec(ctx, string(sqlBytes)); err != nil {
			return fmt.Errorf("migrate %s: %w", n, err)
		}
	}
	return nil
}
