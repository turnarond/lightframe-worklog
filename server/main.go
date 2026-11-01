package main

import (
	"log"
	"net/http"
	"os"
	"time"

	"lightframe/worklog-server/internal/api"
	"lightframe/worklog-server/internal/db"
	"lightframe/worklog-server/internal/mail"
)

func main() {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		log.Fatal("DATABASE_URL is required")
	}
	pool, err := db.NewPool(url)
	if err != nil {
		log.Fatalf("connect db: %v", err)
	}
	defer pool.Close()
	if err := db.MigrateUp(pool); err != nil {
		log.Fatalf("migrate: %v", err)
	}

	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		secret = "dev-secret-change-me"
	}
	srv := &api.Server{
		Pool:      pool,
		JWTSecret: secret,
		Mailer:    mail.New(os.Getenv("MAIL_MODE")),
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	s := &http.Server{
		Addr:              ":" + port,
		Handler:           srv.Router(),
		ReadHeaderTimeout: 5 * time.Second,
	}
	log.Printf("worklog-server listening on :%s", port)
	log.Fatal(s.ListenAndServe())
}
