package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"lightframe/worklog-server/internal/mail"
	"lightframe/worklog-server/internal/testutil"
)

func TestMain(m *testing.M) {
	code := m.Run()
	testutil.Stop()
	os.Exit(code)
}

func newServer(t *testing.T) (*Server, *pgxpool.Pool) {
	pool := testutil.TestPool(t)
	return &Server{Pool: pool, JWTSecret: "test-secret", Mailer: mail.DevMailer{}}, pool
}

func doPost(t *testing.T, r http.Handler, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func doGet(t *testing.T, r http.Handler, path string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func authed(t *testing.T, r http.Handler, email, pw string) string {
	doPost(t, r, "/api/auth/register", `{"email":"`+email+`","password":"`+pw+`"}`)
	w := doPost(t, r, "/api/auth/login", `{"email":"`+email+`","password":"`+pw+`"}`)
	var resp struct {
		AccessToken string `json:"access_token"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	return resp.AccessToken
}

func doPostA(t *testing.T, r http.Handler, token, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func doGetA(t *testing.T, r http.Handler, token, path string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestRegisterLogin(t *testing.T) {
	s, _ := newServer(t)
	r := s.Router()

	w := doPost(t, r, "/api/auth/register", `{"email":"a@b.com","password":"password1"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("register want 201 got %d", w.Code)
	}
	dup := doPost(t, r, "/api/auth/register", `{"email":"a@b.com","password":"password1"}`)
	if dup.Code != http.StatusConflict {
		t.Fatalf("dup register want 409 got %d", dup.Code)
	}
	login := doPost(t, r, "/api/auth/login", `{"email":"a@b.com","password":"password1"}`)
	if login.Code != http.StatusOK {
		t.Fatalf("login want 200 got %d", login.Code)
	}
	if !strings.Contains(login.Body.String(), "access_token") {
		t.Fatal("login response missing access_token")
	}
	bad := doPost(t, r, "/api/auth/login", `{"email":"a@b.com","password":"wrong"}`)
	if bad.Code != http.StatusUnauthorized {
		t.Fatalf("bad login want 401 got %d", bad.Code)
	}
}

func TestPushPullLWW(t *testing.T) {
	s, _ := newServer(t)
	r := s.Router()
	tok := authed(t, r, "lww@b.com", "password1")

	body := `{"changes":[{"type":"tasks","id":"T1","title":"x","updatedAt":1000,"deletedAt":null}]}`
	w := doPostA(t, r, tok, "/api/sync/push", body)
	if w.Code != http.StatusOK {
		t.Fatalf("push want 200 got %d", w.Code)
	}
	pull := doGetA(t, r, tok, "/api/sync/pull?since=0&types=tasks")
	if !strings.Contains(pull.Body.String(), `"id":"T1"`) {
		t.Fatal("pull missing T1")
	}
	// 更旧的版本应被 LWW 拒绝
	doPostA(t, r, tok, "/api/sync/push",
		`{"changes":[{"type":"tasks","id":"T1","title":"old","updatedAt":500,"deletedAt":null}]}`)
	pull2 := doGetA(t, r, tok, "/api/sync/pull?since=0&types=tasks")
	if strings.Contains(pull2.Body.String(), `"title":"old"`) {
		t.Fatal("LWW failed: stale version overwrote newer")
	}
}

func TestSoftDeleteSync(t *testing.T) {
	s, _ := newServer(t)
	r := s.Router()
	tok := authed(t, r, "del@b.com", "password1")

	doPostA(t, r, tok, "/api/sync/push",
		`{"changes":[{"type":"tasks","id":"T2","title":"d","updatedAt":200,"deletedAt":900}]}`)
	pull := doGetA(t, r, tok, "/api/sync/pull?since=0&types=tasks")
	if !strings.Contains(pull.Body.String(), `"deletedAt":900`) {
		t.Fatal("soft delete not synced")
	}
}

func TestSyncIsolation(t *testing.T) {
	s, pool := newServer(t)
	r := s.Router()
	tokA := authed(t, r, "usera@b.com", "password1")
	tokB := authed(t, r, "userb@b.com", "password1")

	doPostA(t, r, tokA, "/api/sync/push",
		`{"changes":[{"type":"tasks","id":"OWN","title":"a","updatedAt":100,"deletedAt":null}]}`)
	pullB := doGetA(t, r, tokB, "/api/sync/pull?since=0&types=tasks")
	if strings.Contains(pullB.Body.String(), `"id":"OWN"`) {
		t.Fatal("user B should not see user A's data")
	}
	_ = pool
}

func TestForgotReset(t *testing.T) {
	s, pool := newServer(t)
	r := s.Router()
	_ = authed(t, r, "fg@b.com", "password1")

	// 未知邮箱也返回 200（防枚举）
	unk := doPost(t, r, "/api/auth/forgot", `{"email":"nobody@x.com"}`)
	if unk.Code != http.StatusOK {
		t.Fatalf("forgot unknown want 200 got %d", unk.Code)
	}
	// 已知邮箱返回 200
	known := doPost(t, r, "/api/auth/forgot", `{"email":"fg@b.com"}`)
	if known.Code != http.StatusOK {
		t.Fatalf("forgot known want 200 got %d", known.Code)
	}
	// 直接造一个 reset token 写入库，验证 reset 改密后可登录
	plain := "reset-token-123"
	_, err := pool.Exec(context.Background(),
		`update users set reset_token_hash=$1, reset_expires_at=now()+interval '15 minutes' where email=$2`,
		sha256Hex(plain), "fg@b.com")
	if err != nil {
		t.Fatalf("seed reset token: %v", err)
	}
	reset := doPost(t, r, "/api/auth/reset", `{"token":"reset-token-123","password":"newpass123"}`)
	if reset.Code != http.StatusOK {
		t.Fatalf("reset want 200 got %d", reset.Code)
	}
	login := doPost(t, r, "/api/auth/login", `{"email":"fg@b.com","password":"newpass123"}`)
	if login.Code != http.StatusOK {
		t.Fatalf("login with new password want 200 got %d", login.Code)
	}
}
