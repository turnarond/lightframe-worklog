// Package api 实现 HTTP 路由：账号（注册/登录/刷新/找回/重置）与同步（pull/push）。
// 线协议统一 camelCase（与 Electron 客户端一致）：updatedAt/deletedAt/id/key/date/value，时间戳为毫秒。
package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"lightframe/worklog-server/internal/auth"
	"lightframe/worklog-server/internal/mail"
)

type ctxKey string

const uidKey ctxKey = "uid"

// Server 聚合运行依赖。
type Server struct {
	Pool      *pgxpool.Pool
	JWTSecret string
	Mailer    mail.Mailer
}

// Router 构建全部路由。
func (s *Server) Router() *chi.Mux {
	r := chi.NewRouter()
	r.Post("/api/auth/register", s.handleRegister)
	r.Post("/api/auth/login", s.handleLogin)
	r.Post("/api/auth/refresh", s.handleRefresh)
	r.Post("/api/auth/forgot", s.handleForgot)
	r.Post("/api/auth/reset", s.handleReset)
	r.Group(func(protected chi.Router) {
		protected.Use(s.requireAuth)
		protected.Get("/api/sync/pull", s.handlePull)
		protected.Post("/api/sync/push", s.handlePush)
	})
	return r
}

func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authz := r.Header.Get("Authorization")
		if !strings.HasPrefix(authz, "Bearer ") {
			writeErr(w, http.StatusUnauthorized, "missing token")
			return
		}
		uid, err := auth.ParseToken(strings.TrimPrefix(authz, "Bearer "), s.JWTSecret)
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "invalid token")
			return
		}
		ctx := context.WithValue(r.Context(), uidKey, uid)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func uid(r *http.Request) string {
	if v, ok := r.Context().Value(uidKey).(string); ok {
		return v
	}
	return ""
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"error": msg})
}

func (s *Server) writeTokens(w http.ResponseWriter, status int, id, email string) {
	access, err := auth.SignToken(id, s.JWTSecret, 15*time.Minute)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "sign token")
		return
	}
	refresh, err := auth.SignToken(id, s.JWTSecret, 30*24*time.Hour)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "sign token")
		return
	}
	out := map[string]any{"access_token": access, "refresh_token": refresh}
	if email != "" {
		out["email"] = email
	}
	writeJSON(w, status, out)
}
