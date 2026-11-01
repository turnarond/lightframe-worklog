package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"lightframe/worklog-server/internal/auth"
)

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	var p struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	_ = json.NewDecoder(r.Body).Decode(&p)
	if !auth.EmailValid(p.Email) {
		writeErr(w, http.StatusBadRequest, "invalid email")
		return
	}
	if len(p.Password) < 8 {
		writeErr(w, http.StatusBadRequest, "password too short (>=8)")
		return
	}
	hash, err := auth.HashPassword(p.Password)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "hash")
		return
	}
	var id string
	err = s.Pool.QueryRow(r.Context(),
		`insert into users(email, password_hash) values($1,$2) returning id`, p.Email, hash).Scan(&id)
	if err != nil {
		if isUniqueViolation(err) {
			writeErr(w, http.StatusConflict, "email already registered")
			return
		}
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	s.writeTokens(w, http.StatusCreated, id, p.Email)
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var p struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	_ = json.NewDecoder(r.Body).Decode(&p)
	var id, hash, email string
	err := s.Pool.QueryRow(r.Context(),
		`select id, password_hash, email from users where email=$1`, p.Email).Scan(&id, &hash, &email)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusUnauthorized, "invalid email or password")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	if !auth.VerifyPassword(hash, p.Password) {
		writeErr(w, http.StatusUnauthorized, "invalid email or password")
		return
	}
	s.writeTokens(w, http.StatusOK, id, email)
}

func (s *Server) handleRefresh(w http.ResponseWriter, r *http.Request) {
	var p struct {
		RefreshToken string `json:"refresh_token"`
	}
	_ = json.NewDecoder(r.Body).Decode(&p)
	uid, err := auth.ParseToken(p.RefreshToken, s.JWTSecret)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "invalid refresh token")
		return
	}
	s.writeTokens(w, http.StatusOK, uid, "")
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "23505"
	}
	return false
}
