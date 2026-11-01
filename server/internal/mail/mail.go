// Package mail 定义邮件发送接口；v3.0 先用开发桩，阿里云实现后续接入（不在阻塞项内）。
package mail

import "fmt"

// Mailer 发送邮件的抽象。
type Mailer interface {
	Send(to, subject, body string) error
}

// DevMailer 仅打印到日志，不真正发信，便于本地联调。
type DevMailer struct{}

// Send 实现 Mailer：打印到标准输出。
func (DevMailer) Send(to, subject, body string) error {
	fmt.Printf("[mail:dev] to=%s subject=%s body=%s\n", to, subject, body)
	return nil
}

// New 按 MAIL_MODE 选择实现；默认 dev 桩。
func New(mode string) Mailer {
	if mode == "aliyun" {
		// TODO: 后续实现阿里云邮件推送（不在 v3.0 阻塞项）
		return DevMailer{}
	}
	return DevMailer{}
}
