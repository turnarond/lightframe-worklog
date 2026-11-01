package db_test

import (
	"context"
	"os"
	"testing"

	"lightframe/worklog-server/internal/db"
	"lightframe/worklog-server/internal/testutil"
)

func TestMain(m *testing.M) {
	code := m.Run()
	testutil.Stop()
	os.Exit(code)
}

func TestMigrateUpCreatesUsers(t *testing.T) {
	pool := testutil.TestPool(t)
	if err := db.MigrateUp(pool); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := pool.QueryRow(context.Background(), "select count(*) from users").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("want 0 rows, got %d", n)
	}
	var name string
	if err := pool.QueryRow(context.Background(),
		"select table_name from information_schema.tables where table_name='tasks'").Scan(&name); err != nil {
		t.Fatalf("tasks table missing: %v", err)
	}
}
