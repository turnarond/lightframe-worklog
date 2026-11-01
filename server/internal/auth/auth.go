// Package auth 提供密码哈希（argon2id）与 JWT 签名/校验的纯函数，便于单测。
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/argon2"
)

const (
	argonTime    = 1
	argonMemory  = 64 * 1024
	argonThreads = 4
	argonKeyLen  = 32
	argonSaltLen = 16
)

// HashPassword 使用 argon2id 生成可存储的哈希串。
func HashPassword(pw string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	hash := argon2.IDKey([]byte(pw), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		0x13, argonMemory, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(hash)), nil
}

// VerifyPassword 校验明文密码与哈希串是否匹配（常量时间比较）。
func VerifyPassword(encoded, pw string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 {
		return false
	}
	salt, err1 := base64.RawStdEncoding.DecodeString(parts[4])
	want, err2 := base64.RawStdEncoding.DecodeString(parts[5])
	if err1 != nil || err2 != nil {
		return false
	}
	got := argon2.IDKey([]byte(pw), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return subtle.ConstantTimeCompare(want, got) == 1
}

// SignToken 签发 HS256 JWT，携带 uid 与过期时间。
func SignToken(uid, secret string, d time.Duration) (string, error) {
	claims := jwt.MapClaims{
		"uid": uid,
		"exp": time.Now().Add(d).Unix(),
	}
	c := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return c.SignedString([]byte(secret))
}

// ParseToken 校验并返回 uid；失败返回 error。
func ParseToken(tok, secret string) (string, error) {
	p, err := jwt.Parse(tok, func(t *jwt.Token) (interface{}, error) {
		return []byte(secret), nil
	})
	if err != nil {
		return "", err
	}
	uid, ok := p.Claims.(jwt.MapClaims)["uid"].(string)
	if !ok {
		return "", fmt.Errorf("token missing uid")
	}
	return uid, nil
}

var emailRe = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

// EmailValid 校验邮箱基本格式。
func EmailValid(email string) bool {
	return emailRe.MatchString(email)
}
