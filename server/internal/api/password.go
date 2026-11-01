package api

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"

	"lightframe/worklog-server/internal/auth"
)

func (s *Server) handleForgot(w http.ResponseWriter, r *http.Request) {
	var p struct {
		Email string `json:"email"`
	}
	_ = json.NewDecoder(r.Body).Decode(&p)
	var id string
	err := s.Pool.QueryRow(r.Context(), `select id from users where email=$1`, p.Email).Scan(&id)
	if err == nil {
		token := randHex(32)
		_, _ = s.Pool.Exec(r.Context(),
			`update users set reset_token_hash=$1, reset_expires_at=now()+interval '15 minutes' where id=$2`,
			sha256Hex(token), id)
		link := "lightframe://reset?token=" + token
		_ = s.Mailer.Send(p.Email, "重置你的光影工作志密码", "点击链接重置密码："+link)
	}
	// 无论邮箱是否存在都返回 200，防枚举
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleReset(w http.ResponseWriter, r *http.Request) {
	var p struct {
		Token    string `json:"token"`
		Password string `json:"password"`
	}
	_ = json.NewDecoder(r.Body).Decode(&p)
	if len(p.Password) < 8 {
		writeErr(w, http.StatusBadRequest, "password too short (>=8)")
		return
	}
	var id string
	err := s.Pool.QueryRow(r.Context(),
		`select id from users where reset_token_hash=$1 and reset_expires_at > now()`, sha256Hex(p.Token)).Scan(&id)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid or expired token")
		return
	}
	hash, err := auth.HashPassword(p.Password)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "hash")
		return
	}
	_, err = s.Pool.Exec(r.Context(),
		`update users set password_hash=$1, reset_token_hash=null, reset_expires_at=null where id=$2`, hash, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}
