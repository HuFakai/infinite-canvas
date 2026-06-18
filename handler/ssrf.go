package handler

import (
	"errors"
	"net"
	"net/http"
	"syscall"
	"time"
)

var errBlockedAddress = errors.New("blocked internal address")

// isDisallowedIP 拦截环回 / 私网 / 链路本地 / 未指定 / CGNAT 等不应被服务端代理访问的地址，
// 用于防御 SSRF（含云元数据 169.254.169.254，落在链路本地段）。
func isDisallowedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() {
		return true
	}
	// CGNAT 100.64.0.0/10
	if ip4 := ip.To4(); ip4 != nil && ip4[0] == 100 && ip4[1]&0xc0 == 64 {
		return true
	}
	return false
}

// ssrfSafeControl 在实际建立连接前校验解析出的目标 IP；每次拨号（含重定向后）都会经过这里，
// 因此同时防御 DNS rebinding 与重定向绕过。
func ssrfSafeControl(_ string, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	if ip := net.ParseIP(host); ip == nil || isDisallowedIP(ip) {
		return errBlockedAddress
	}
	return nil
}

// newSSRFSafeClient 返回一个带超时、拒绝内网地址、限制重定向跳数的出站 HTTP 客户端，
// 用于代理用户提供的外部 URL。
func newSSRFSafeClient(timeout time.Duration) *http.Client {
	dialer := &net.Dialer{Timeout: 10 * time.Second, Control: ssrfSafeControl}
	transport := &http.Transport{
		DialContext:           dialer.DialContext,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: timeout,
		ExpectContinueTimeout: time.Second,
	}
	return &http.Client{
		Timeout:   timeout,
		Transport: transport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("too many redirects")
			}
			if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
				return errors.New("blocked redirect scheme")
			}
			return nil
		},
	}
}
