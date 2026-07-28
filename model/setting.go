package model

import "encoding/json"

type SettingKey string

const (
	SettingKeyPublic  SettingKey = "public"
	SettingKeyPrivate SettingKey = "private"
)

// ModelChannel 模型渠道配置。
type ModelChannel struct {
	ID           string               `json:"id"`
	Protocol     string               `json:"protocol"`
	Name         string               `json:"name"`
	BaseURL      string               `json:"baseUrl"`
	APIKey       string               `json:"apiKey"`
	Models       []string             `json:"models"`
	Weight       int                  `json:"weight"`
	Timeout      int                  `json:"timeout"`
	Enabled      bool                 `json:"enabled"`
	Remark       string               `json:"remark"`
	ImageAdapter *ImageChannelAdapter `json:"imageAdapter,omitempty"`
}

// ImageChannelAdapter 用固定字段描述异步生图协议，不允许执行自定义脚本。
type ImageChannelAdapter struct {
	Enabled       bool     `json:"enabled"`
	CreatePath    string   `json:"createPath"`
	TaskIDPath    string   `json:"taskIdPath"`
	StatusPath    string   `json:"statusPath"`
	StatusField   string   `json:"statusField"`
	SuccessValues []string `json:"successValues"`
	FailureValues []string `json:"failureValues"`
	ResultPaths   []string `json:"resultPaths"`
	ErrorPaths    []string `json:"errorPaths"`
	PollInterval  int      `json:"pollInterval"`
	MaxAttempts   int      `json:"maxAttempts"`
}

// ModelCost 模型算力点配置。
type ModelCost struct {
	Model   string `json:"model"`
	Credits int    `json:"credits"`
}

// PublicModelChannelSetting 公开模型渠道配置。
type PublicModelChannelSetting struct {
	AvailableModels    []string                 `json:"availableModels"`
	ModelCosts         []ModelCost              `json:"modelCosts"`
	Channels           []PublicModelChannelInfo `json:"channels"`
	DefaultModel       string                   `json:"defaultModel"`
	DefaultImageModel  string                   `json:"defaultImageModel"`
	DefaultTextModel   string                   `json:"defaultTextModel"`
	SystemPrompt       string                   `json:"systemPrompt"`
	SystemPrompts      SystemPromptSetting      `json:"systemPrompts"`
	AllowCustomChannel *bool                    `json:"allowCustomChannel"`
}

type SystemPromptSetting struct {
	Image         string `json:"image"`
	Text          string `json:"text"`
	Workflow      string `json:"workflow"`
	WorkflowAgent string `json:"workflowAgent"`
}

type PublicModelChannelInfo struct {
	ID       string   `json:"id"`
	Protocol string   `json:"protocol"`
	Name     string   `json:"name"`
	BaseURL  string   `json:"baseUrl"`
	Models   []string `json:"models"`
	Weight   int      `json:"weight"`
	Timeout  int      `json:"timeout"`
	Enabled  bool     `json:"enabled"`
	Remark   string   `json:"remark"`
}

// PublicSetting 公开配置。
type PublicSetting struct {
	Site         PublicSiteSetting         `json:"site"`
	ModelChannel PublicModelChannelSetting `json:"modelChannel"`
	Auth         PublicAuthSetting         `json:"auth"`
	Storage      PublicStorageSetting      `json:"storage"`
	Membership   PublicMembershipSetting   `json:"membership"`
}

// PublicSiteSetting 站点基础信息，影响导航、标题、登录页等。
type PublicSiteSetting struct {
	Name        string `json:"name"`
	Subtitle    string `json:"subtitle"`
	Description string `json:"description"`
	LogoURL     string `json:"logoUrl"`
	FaviconURL  string `json:"faviconUrl"`
	Copyright   string `json:"copyright"`
}

type PublicStorageSetting struct {
	Mode              string `json:"mode"`
	AllowUserProvider bool   `json:"allowUserProvider"`
}

type PublicAuthSetting struct {
	AllowRegister *bool                    `json:"allowRegister"`
	LinuxDo       PublicLinuxDoAuthSetting `json:"linuxDo"`
	OIDC          PublicOIDCAuthSetting    `json:"oidc"`
}

type PublicLinuxDoAuthSetting struct {
	Enabled bool `json:"enabled"`
}

type PublicOIDCAuthSetting struct {
	Enabled     bool   `json:"enabled"`
	DisplayName string `json:"displayName"`
	IconURL     string `json:"iconUrl"`
}

// PublicMembershipSetting 会员功能公开配置。
type PublicMembershipSetting struct {
	Enabled        bool     `json:"enabled"`
	PaymentMethods []string `json:"paymentMethods"` // wechat / alipay
	ServiceNotice  string   `json:"serviceNotice"`
}

// PrivateSetting 私有配置。
type PrivateSetting struct {
	Channels   []ModelChannel        `json:"channels"`
	PromptSync PromptSyncSetting     `json:"promptSync"`
	AILog      AILogSetting          `json:"aiLog"`
	Auth       PrivateAuthSetting    `json:"auth"`
	Storage    PrivateStorageSetting `json:"storage"`
	Payment    PrivatePaymentSetting `json:"payment"`
}

type AILogSetting struct {
	LocalDirectReportEnabled *bool               `json:"localDirectReportEnabled"`
	Cleanup                  AILogCleanupSetting `json:"cleanup"`
}

type AILogCleanupSetting struct {
	Enabled       *bool  `json:"enabled"`
	RetentionDays int    `json:"retentionDays"`
	Cron          string `json:"cron"`
}

type PrivateStorageSetting struct {
	Mode               string                      `json:"mode"`
	AllowUserProvider  bool                        `json:"allowUserProvider"`
	Providers          []StorageProvider           `json:"providers"`
	RoundRobinCursor   int                         `json:"roundRobinCursor"`
	CapacityCheck      StorageCapacityCheckSetting `json:"capacityCheck"`
	CapacityLimitBytes int64                       `json:"capacityLimitBytes"`
}

type StorageProvider struct {
	ID                string `json:"id"`
	Name              string `json:"name"`
	Type              string `json:"type"`
	Endpoint          string `json:"endpoint"`
	Region            string `json:"region"`
	Bucket            string `json:"bucket"`
	AccessKeyID       string `json:"accessKeyId"`
	SecretAccessKey   string `json:"secretAccessKey"`
	PublicBaseURL     string `json:"publicBaseUrl"`
	PathPrefix        string `json:"pathPrefix"`
	Weight            int    `json:"weight"`
	Enabled           bool   `json:"enabled"`
	OwnerUserID       string `json:"ownerUserId"`
	CapacityBytes     int64  `json:"capacityBytes"`
	CapacityCheckedAt string `json:"capacityCheckedAt"`
	CapacityExceeded  bool   `json:"capacityExceeded"`
}

type StorageCapacityCheckSetting struct {
	Enabled *bool  `json:"enabled"`
	Cron    string `json:"cron"`
}

// PromptSyncSetting 提示词定时同步配置。
type PromptSyncSetting struct {
	Enabled *bool              `json:"enabled"`
	Cron    string             `json:"cron"`
	Sources []PromptJSONSource `json:"sources"`
}

type PromptJSONSource struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	URL     string `json:"url"`
	Enabled bool   `json:"enabled"`
}

type PrivateAuthSetting struct {
	LinuxDo PrivateLinuxDoAuthSetting `json:"linuxDo"`
	OIDC    PrivateOIDCAuthSetting    `json:"oidc"`
}

type PrivateLinuxDoAuthSetting struct {
	ClientID     string `json:"clientId"`
	ClientSecret string `json:"clientSecret"`
}

// PrivateOIDCAuthSetting 通用 OIDC 登录配置。Issuer 用于自动发现端点；
// 三个 claim 字段允许把不同 IdP 的用户名/昵称/头像 claim 映射到本系统字段。
type PrivateOIDCAuthSetting struct {
	Issuer           string `json:"issuer"`
	ClientID         string `json:"clientId"`
	ClientSecret     string `json:"clientSecret"`
	Scopes           string `json:"scopes"`
	UsernameClaim    string `json:"usernameClaim"`
	DisplayNameClaim string `json:"displayNameClaim"`
	AvatarClaim      string `json:"avatarClaim"`
}

// PrivatePaymentSetting 支付渠道私有配置。
type PrivatePaymentSetting struct {
	ZPay   PrivateZPaySetting   `json:"zpay"`
	Alipay PrivateAlipaySetting `json:"alipay"`
	Wechat PrivateWechatSetting `json:"wechat"`
}

// PrivateZPaySetting ZPay 聚合支付配置（https://zpayz.cn）。
type PrivateZPaySetting struct {
	Enabled    bool   `json:"enabled"`
	PID        string `json:"pid"`
	Key        string `json:"key"`
	GatewayURL string `json:"gatewayUrl"`
	NotifyURL  string `json:"notifyUrl"`
	ReturnURL  string `json:"returnUrl"`
}

// PrivateAlipaySetting 支付宝直连配置。
type PrivateAlipaySetting struct {
	Enabled    bool   `json:"enabled"`
	AppID      string `json:"appId"`
	PrivateKey string `json:"privateKey"`
	PublicKey  string `json:"publicKey"`
	GatewayURL string `json:"gatewayUrl"`
	NotifyURL  string `json:"notifyUrl"`
	ReturnURL  string `json:"returnUrl"`
	Sandbox    bool   `json:"sandbox"`
}

// PrivateWechatSetting 微信支付直连配置（Native 扫码 / H5）。
type PrivateWechatSetting struct {
	Enabled       bool   `json:"enabled"`
	AppID         string `json:"appId"`
	MchID         string `json:"mchId"`
	APIKey        string `json:"apiKey"`
	APIV3Key      string `json:"apiV3Key"`
	NotifyURL     string `json:"notifyUrl"`
	SerialNo      string `json:"serialNo"`
	MchPrivateKey string `json:"mchPrivateKey"`
}

// Setting 系统配置。
type Setting struct {
	Key       SettingKey      `json:"key" gorm:"primaryKey"`
	Value     json.RawMessage `json:"value" gorm:"serializer:json"`
	CreatedAt string          `json:"createdAt"`
	UpdatedAt string          `json:"updatedAt"`
}

// Settings 系统公开和私有配置。
type Settings struct {
	Public  PublicSetting  `json:"public"`
	Private PrivateSetting `json:"private"`
}
