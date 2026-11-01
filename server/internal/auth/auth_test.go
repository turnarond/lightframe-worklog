package auth

import (
	"testing"
	"time"
)

func TestHashVerify(t *testing.T) {
	h, err := HashPassword("s3cret")
	if err != nil {
		t.Fatal(err)
	}
	if !VerifyPassword(h, "s3cret") {
		t.Fatal("should verify")
	}
	if VerifyPassword(h, "wrong") {
		t.Fatal("should reject wrong password")
	}
}

func TestHashUniqueSalt(t *testing.T) {
	a, _ := HashPassword("same")
	b, _ := HashPassword("same")
	if a == b {
		t.Fatal("same password should produce different hashes (random salt)")
	}
}

func TestJWT(t *testing.T) {
	tok, err := SignToken("user-uuid", "secret", 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	uid, err := ParseToken(tok, "secret")
	if err != nil || uid != "user-uuid" {
		t.Fatalf("bad token: uid=%q err=%v", uid, err)
	}
	if _, err := ParseToken(tok, "wrong-secret"); err == nil {
		t.Fatal("should reject wrong secret")
	}
}

func TestEmailValid(t *testing.T) {
	cases := map[string]bool{
		"a@b.com": true,
		"x@y.cn":  true,
		"bad":     false,
		"a@b":     false,
		"@b.com":  false,
	}
	for email, want := range cases {
		if EmailValid(email) != want {
			t.Fatalf("EmailValid(%q)=%v want %v", email, EmailValid(email), want)
		}
	}
}
