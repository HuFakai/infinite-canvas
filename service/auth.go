package service

import (
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

type TokenClaims struct {
	UserID   string         `json:"userId"`
	Username string         `json:"username"`
	Role     model.UserRole `json:"role"`
	jwt.RegisteredClaims
}

func EnsureDefaultAdmin() error {
	username := strings.TrimSpace(config.Cfg.AdminUsername)
	password := config.Cfg.AdminPassword
	if username == "" || strings.TrimSpace(password) == "" {
		return nil
	}
	WarnDefaultSecurityConfig()
	admin, ok, err := repository.FirstAdmin()
	if err != nil {
		return err
	}
	if !ok {
		hash, err := hashPassword(password)
		if err != nil {
			return err
		}
		_, err = repository.SaveUser(model.User{
			ID:        newID("user"),
			Username:  username,
			Password:  hash,
			Role:      model.UserRoleAdmin,
			AffCode:   newAffCode(),
			Status:    model.UserStatusActive,
			CreatedAt: now(),
			UpdatedAt: now(),
		})
		return err
	}
	// 已存在管理员：把用户名/密码校正为 .env 配置，保留其 ID 与关联数据。
	// .env 是该私有化部署唯一的凭据来源（无站内改密入口），故每次启动以其为准。
	changed := false
	if admin.Username != username {
		admin.Username = username
		changed = true
	}
	// 密码每次哈希都不同，必须比对而非直接覆盖，避免每次启动无谓写库。
	if bcrypt.CompareHashAndPassword([]byte(admin.Password), []byte(password)) != nil {
		hash, err := hashPassword(password)
		if err != nil {
			return err
		}
		admin.Password = hash
		changed = true
	}
	if !changed {
		return nil
	}
	normalizeUserDefaults(&admin)
	admin.UpdatedAt = now()
	_, err = repository.SaveUser(admin)
	return err
}

// 登录防爆破：按用户名做内存级失败计数 + 退避锁定。
// 部署拓扑为 nginx→Next→Go 全经 127.0.0.1，按客户端 IP 限流无效，故按用户名。
const (
	loginMaxFailures   = 5
	loginLockoutWindow = time.Minute
)

type loginAttempt struct {
	failures  int
	lastFail  time.Time
	lockUntil time.Time
}

var (
	loginAttempts   = map[string]*loginAttempt{}
	loginAttemptsMu sync.Mutex
)

// dummyPasswordHash 用于用户不存在时也跑一次 bcrypt 比对，抹平用户枚举计时差。
var dummyPasswordHash, _ = bcrypt.GenerateFromPassword([]byte("infinite-canvas-timing-equalizer"), bcrypt.DefaultCost)

func loginKey(username string) string {
	return strings.ToLower(strings.TrimSpace(username))
}

func loginLocked(key string) (bool, time.Duration) {
	loginAttemptsMu.Lock()
	defer loginAttemptsMu.Unlock()
	attempt := loginAttempts[key]
	if attempt != nil && attempt.lockUntil.After(time.Now()) {
		return true, time.Until(attempt.lockUntil)
	}
	return false, 0
}

func recordLoginFailure(key string) {
	current := time.Now()
	loginAttemptsMu.Lock()
	defer loginAttemptsMu.Unlock()
	// 限制 map 体积，避免未鉴权输入撑爆内存。
	if len(loginAttempts) > 1024 {
		for k, v := range loginAttempts {
			if v.lockUntil.Before(current) && current.Sub(v.lastFail) > time.Hour {
				delete(loginAttempts, k)
			}
		}
	}
	attempt := loginAttempts[key]
	if attempt == nil {
		attempt = &loginAttempt{}
		loginAttempts[key] = attempt
	}
	attempt.failures++
	attempt.lastFail = current
	if attempt.failures >= loginMaxFailures {
		backoff := loginLockoutWindow << min(attempt.failures-loginMaxFailures, 5)
		if backoff > 30*time.Minute {
			backoff = 30 * time.Minute
		}
		attempt.lockUntil = current.Add(backoff)
	}
}

func recordLoginSuccess(key string) {
	loginAttemptsMu.Lock()
	defer loginAttemptsMu.Unlock()
	delete(loginAttempts, key)
}

func Login(username string, password string) (model.AuthSession, error) {
	key := loginKey(username)
	if locked, retryIn := loginLocked(key); locked {
		return model.AuthSession{}, safeMessageError{message: fmt.Sprintf("登录尝试过于频繁，请 %d 秒后再试", int(retryIn.Seconds())+1)}
	}
	user, ok, err := repository.GetUserByUsername(strings.TrimSpace(username))
	if err != nil {
		return model.AuthSession{}, err
	}
	if !ok {
		_ = bcrypt.CompareHashAndPassword(dummyPasswordHash, []byte(password))
		recordLoginFailure(key)
		return model.AuthSession{}, safeMessageError{message: "用户名或密码错误"}
	}
	if bcrypt.CompareHashAndPassword([]byte(user.Password), []byte(password)) != nil {
		recordLoginFailure(key)
		return model.AuthSession{}, safeMessageError{message: "用户名或密码错误"}
	}
	if user.Status == model.UserStatusBan {
		return model.AuthSession{}, safeMessageError{message: "账号已被禁用"}
	}
	recordLoginSuccess(key)
	normalizeUserDefaults(&user)
	user.LastLoginAt = now()
	user.UpdatedAt = now()
	user, err = repository.SaveUser(user)
	if err != nil {
		return model.AuthSession{}, err
	}
	return newSession(user)
}

func ParseToken(tokenText string) (TokenClaims, error) {
	claims := TokenClaims{}
	token, err := jwt.ParseWithClaims(tokenText, &claims, func(token *jwt.Token) (any, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("登录状态无效")
		}
		return []byte(config.Cfg.JWTSecret), nil
	})
	if err != nil || !token.Valid {
		return TokenClaims{}, errors.New("登录状态无效")
	}
	return claims, nil
}

func CurrentAuthUser(tokenText string) (model.AuthUser, bool) {
	claims, err := ParseToken(tokenText)
	if err != nil {
		return model.AuthUser{}, false
	}
	user, ok, err := repository.GetUserByID(claims.UserID)
	if err != nil || !ok {
		return model.AuthUser{}, false
	}
	if user.Status == model.UserStatusBan {
		return model.AuthUser{}, false
	}
	return model.PublicUser(user), true
}

func GuestUser() model.AuthUser {
	return model.AuthUser{ID: "", Username: "guest", Role: model.UserRoleGuest}
}

func newSession(user model.User) (model.AuthSession, error) {
	token, err := newToken(user)
	if err != nil {
		return model.AuthSession{}, err
	}
	return model.AuthSession{Token: token, User: model.PublicUser(user)}, nil
}

func newToken(user model.User) (string, error) {
	expireHours := config.Cfg.JWTExpireHours
	if expireHours <= 0 {
		expireHours = 168
	}
	claims := TokenClaims{
		UserID:   user.ID,
		Username: user.Username,
		Role:     user.Role,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Duration(expireHours) * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			Subject:   user.ID,
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(config.Cfg.JWTSecret))
}

func hashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	return string(hash), err
}

func now() string {
	return time.Now().Format(time.RFC3339)
}

func newID(prefix string) string {
	return prefix + "-" + uuid.NewString()
}

func newAffCode() string {
	return strings.ToUpper(strings.ReplaceAll(uuid.NewString()[:8], "-", ""))
}

func normalizeUserDefaults(user *model.User) {
	if user.Status == "" {
		user.Status = model.UserStatusActive
	}
	if user.AffCode == "" {
		user.AffCode = newAffCode()
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func WarnDefaultSecurityConfig() {
	if config.Cfg.AdminUsername == "admin" && config.Cfg.AdminPassword == "infinite-canvas" {
		log.Println("WARNING: using default admin credentials, please set ADMIN_USERNAME and ADMIN_PASSWORD to safer values before deployment")
	}
	if n := len(strings.TrimSpace(config.Cfg.AdminPassword)); n > 0 && n < 8 {
		log.Println("WARNING: ADMIN_PASSWORD is shorter than 8 characters and is easy to brute-force; consider a stronger password")
	}
}
