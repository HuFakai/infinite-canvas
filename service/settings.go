package service

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

func PublicSettings() (model.PublicSetting, error) {
	settings, err := repository.GetSettings()
	settings = normalizeSettings(settings)
	settings.Public.ModelChannel.Channels = publicChannelInfos(settings.Private.Channels)

	mode := "local_indexeddb"
	if HasAdminStorageProvider(settings.Private.Storage) {
		mode = "server_sqlite_s3"
	} else if settings.Private.Storage.AllowUserProvider {
		mode = "hybrid"
	}
	settings.Public.Storage.Mode = mode
	settings.Public.Storage.AllowUserProvider = settings.Private.Storage.AllowUserProvider
	if len(settings.Public.ModelChannel.AvailableModels) == 0 {
		settings.Public.ModelChannel.AvailableModels = collectChannelModels(settings.Private.Channels)
	}
	return settings.Public, err
}

func AdminSettings() (model.Settings, error) {
	settings, err := repository.GetSettings()
	return hidePrivateAPIKeys(normalizeSettings(settings)), err
}

func SaveSettings(settings model.Settings) (model.Settings, error) {
	saved, err := repository.GetSettings()
	if err != nil {
		return model.Settings{}, err
	}
	settings = normalizeSettings(settings)
	keepPrivateAPIKeys(&settings, normalizeSettings(saved))
	keepPrivateAuthSecrets(&settings, normalizeSettings(saved))
	keepPrivateStorageSecrets(&settings, normalizeSettings(saved))
	result, err := repository.SaveSettings(settings, now())
	if err == nil {
		RefreshPromptSyncScheduler()
		RefreshStorageCapacityScheduler()
		RefreshAILogCleanupScheduler()
	}
	return hidePrivateAPIKeys(result), err
}

func AdminChannelModels(index *int, channel model.ModelChannel) ([]string, error) {
	resolved, err := resolveAdminChannel(index, channel)
	if err != nil {
		return nil, err
	}
	return fetchAdminChannelModels(resolved)
}

func AdminTestChannelModel(index *int, channel model.ModelChannel, modelName string) (string, error) {
	resolved, err := resolveAdminChannel(index, channel)
	if err != nil {
		return "", err
	}
	return testAdminChannelModel(resolved, modelName)
}

func normalizeSettings(settings model.Settings) model.Settings {
	settings.Private = normalizePrivateSetting(settings.Private)
	settings.Public = normalizePublicSetting(settings.Public)
	if models := collectChannelModels(settings.Private.Channels); len(models) > 0 {
		settings.Public.ModelChannel.AvailableModels = models
	}
	settings.Public.ModelChannel = repairDefaultModels(settings.Public.ModelChannel)
	return settings
}

func normalizePublicSetting(setting model.PublicSetting) model.PublicSetting {
	return normalizePublicSettingWithChannels(setting, nil)
}

func normalizePublicSiteSetting(setting model.PublicSiteSetting) model.PublicSiteSetting {
	if strings.TrimSpace(setting.Name) == "" {
		setting.Name = "无限画布"
	}
	if strings.TrimSpace(setting.Description) == "" {
		setting.Description = "一个无限画布创作工具"
	}
	return setting
}

func normalizePublicSettingWithChannels(setting model.PublicSetting, channels []model.ModelChannel) model.PublicSetting {
	setting.Site = normalizePublicSiteSetting(setting.Site)
	if setting.ModelChannel.AvailableModels == nil {
		setting.ModelChannel.AvailableModels = []string{}
	}
	if setting.ModelChannel.ModelCosts == nil {
		setting.ModelChannel.ModelCosts = []model.ModelCost{}
	}
	if setting.ModelChannel.Channels == nil {
		setting.ModelChannel.Channels = []model.PublicModelChannelInfo{}
	}
	if strings.TrimSpace(setting.ModelChannel.SystemPrompts.Image) == "" {
		setting.ModelChannel.SystemPrompts.Image = firstNonEmpty(setting.ModelChannel.SystemPrompt, DefaultSystemPrompts().Image)
	}
	if strings.TrimSpace(setting.ModelChannel.SystemPrompts.Text) == "" {
		setting.ModelChannel.SystemPrompts.Text = firstNonEmpty(setting.ModelChannel.SystemPrompt, DefaultSystemPrompts().Text)
	}
	if strings.TrimSpace(setting.ModelChannel.SystemPrompts.Workflow) == "" {
		setting.ModelChannel.SystemPrompts.Workflow = DefaultSystemPrompts().Workflow
	}
	if strings.TrimSpace(setting.ModelChannel.SystemPrompts.WorkflowAgent) == "" {
		setting.ModelChannel.SystemPrompts.WorkflowAgent = DefaultSystemPrompts().WorkflowAgent
	}
	for i := range setting.ModelChannel.ModelCosts {
		setting.ModelChannel.ModelCosts[i].Model = strings.TrimSpace(setting.ModelChannel.ModelCosts[i].Model)
		if setting.ModelChannel.ModelCosts[i].Credits < 0 {
			setting.ModelChannel.ModelCosts[i].Credits = 0
		}
	}
	if setting.ModelChannel.AllowCustomChannel == nil {
		enabled := true
		setting.ModelChannel.AllowCustomChannel = &enabled
	}
	if setting.Auth.AllowRegister == nil {
		enabled := true
		setting.Auth.AllowRegister = &enabled
	}
	if setting.Storage.Mode == "" {
		setting.Storage.Mode = "local_indexeddb"
	}
	if setting.Membership.PaymentMethods == nil {
		setting.Membership.PaymentMethods = []string{}
	}
	enabledModels := collectChannelModels(channels)
	if len(enabledModels) > 0 {
		setting.ModelChannel.AvailableModels = enabledModels
	} else {
		setting.ModelChannel.AvailableModels = uniqueStrings(setting.ModelChannel.AvailableModels)
	}
	return setting
}

func normalizePrivateSetting(setting model.PrivateSetting) model.PrivateSetting {
	if setting.Channels == nil {
		setting.Channels = []model.ModelChannel{}
	}
	setting.PromptSync = normalizePromptSyncSetting(setting.PromptSync)
	setting.AILog = normalizeAILogSetting(setting.AILog)
	setting.Storage = normalizePrivateStorageSetting(setting.Storage)
	for i := range setting.Channels {
		if setting.Channels[i].Protocol == "" {
			setting.Channels[i].Protocol = "openai"
		}
		if setting.Channels[i].ID == "" {
			setting.Channels[i].ID = stableModelChannelID(setting.Channels[i])
		}
		if setting.Channels[i].Models == nil {
			setting.Channels[i].Models = []string{}
		}
		if setting.Channels[i].Weight <= 0 {
			setting.Channels[i].Weight = 1
		}
		if setting.Channels[i].Timeout <= 0 {
			setting.Channels[i].Timeout = 600
		}
	}
	return setting
}

func DefaultSystemPrompts() model.SystemPromptSetting {
	return model.SystemPromptSetting{
		Image:    "",
		Text:     "",
		Workflow: "",
		WorkflowAgent: `你是一个用于创建图片创作工作流的产品设计助理。请根据用户需求输出严格 JSON，不要输出 Markdown。
目标：把用户的自然语言需求整理为一个可复用的图片生成工作流。
要求：
1. 工作流必须面向同类型批量创作，变量字段要少而明确。
2. 变量名使用 snake_case，label 使用中文。
3. promptTemplate 必须使用 {{variable_name}} 引用变量。
4. 如果用户需要“多张、系列、组图、文章配图、海报组、写真组、方案集”，mode 使用 multi_image_series；否则使用 single_image。
5. config 只输出必要配置，apiMode 可为 responses 或 images。
6. variables 支持 text、textarea、number、select、boolean。
7. select 类型的 options 必须是字符串数组。
8. 多图工作流必须输出 seriesConfig，用于先生成多条图片提示词草稿。
9. 输出 JSON 结构：
{
  "name": "工作流名称",
  "category": "分类",
  "description": "一句话描述",
  "mode": "single_image",
  "variables": [
    {"key":"product_name","label":"产品名称","type":"text","required":true,"defaultValue":"","options":[]}
  ],
  "config": {
    "promptTemplate": "生成提示词模板",
    "systemPrompt": "系统提示词，可空",
    "model": "",
    "apiMode": "responses",
    "size": "auto",
    "quality": "auto",
    "count": "1",
    "outputFormat": "png",
    "timeout": 600
  },
  "seriesConfig": {
    "targetCount": "4",
    "promptInstruction": "多图拆分规则，可空",
    "reviewRequired": true,
    "concurrency": "3"
  },
  "warnings": []
}`,
	}
}

func normalizePrivateStorageSetting(setting model.PrivateStorageSetting) model.PrivateStorageSetting {
	if setting.Mode == "" {
		setting.Mode = "local_indexeddb"
	}
	if setting.CapacityLimitBytes <= 0 {
		setting.CapacityLimitBytes = 9 * 1024 * 1024 * 1024
	}
	setting.CapacityCheck = normalizeStorageCapacityCheckSetting(setting.CapacityCheck)
	if setting.Providers == nil {
		setting.Providers = []model.StorageProvider{}
	}
	for i := range setting.Providers {
		setting.Providers[i] = normalizeStorageProvider(setting.Providers[i])
	}
	return setting
}

func normalizeStorageCapacityCheckSetting(setting model.StorageCapacityCheckSetting) model.StorageCapacityCheckSetting {
	if setting.Cron == "" {
		setting.Cron = "0 */6 * * *"
	}
	if setting.Enabled == nil {
		enabled := false
		setting.Enabled = &enabled
	}
	return setting
}

func normalizeStorageProvider(provider model.StorageProvider) model.StorageProvider {
	provider.Name = strings.TrimSpace(provider.Name)
	provider.Endpoint = strings.TrimRight(strings.TrimSpace(provider.Endpoint), "/")
	provider.Bucket = strings.TrimSpace(provider.Bucket)
	provider.AccessKeyID = strings.TrimSpace(provider.AccessKeyID)
	if provider.Type == "" {
		provider.Type = "s3"
	}
	if provider.Region == "" {
		provider.Region = "auto"
	}
	if provider.ID == "" {
		provider.ID = stableStorageProviderID(provider)
	}
	if provider.Weight <= 0 {
		provider.Weight = 1
	}
	return provider
}

func stableStorageProviderID(provider model.StorageProvider) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{provider.OwnerUserID, provider.Name, provider.Endpoint, provider.Bucket}, "|")))
	return "storage-" + hex.EncodeToString(sum[:])[:16]
}

func stableModelChannelID(channel model.ModelChannel) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{channel.Name, channel.BaseURL}, "|")))
	return "channel-" + hex.EncodeToString(sum[:])[:16]
}

func hidePrivateAPIKeys(settings model.Settings) model.Settings {
	for i := range settings.Private.Channels {
		settings.Private.Channels[i].APIKey = ""
	}
	for i := range settings.Private.Storage.Providers {
		settings.Private.Storage.Providers[i].SecretAccessKey = ""
	}
	settings.Private.Auth.LinuxDo.ClientSecret = ""
	settings.Private.Auth.OIDC.ClientSecret = ""
	settings.Private.Payment.ZPay.Key = ""
	settings.Private.Payment.Alipay.PrivateKey = ""
	settings.Private.Payment.Wechat.APIKey = ""
	settings.Private.Payment.Wechat.APIV3Key = ""
	settings.Private.Payment.Wechat.MchPrivateKey = ""
	return settings
}

func keepPrivateAPIKeys(settings *model.Settings, saved model.Settings) {
	for i := range settings.Private.Channels {
		if strings.TrimSpace(settings.Private.Channels[i].APIKey) != "" {
			continue
		}
		if channel, ok := findSavedChannel(settings.Private.Channels[i], saved.Private.Channels, i); ok {
			settings.Private.Channels[i].APIKey = channel.APIKey
		}
	}
	if strings.TrimSpace(settings.Private.Payment.ZPay.Key) == "" {
		settings.Private.Payment.ZPay.Key = saved.Private.Payment.ZPay.Key
	}
	if strings.TrimSpace(settings.Private.Payment.Alipay.PrivateKey) == "" {
		settings.Private.Payment.Alipay.PrivateKey = saved.Private.Payment.Alipay.PrivateKey
	}
	if strings.TrimSpace(settings.Private.Payment.Wechat.APIKey) == "" {
		settings.Private.Payment.Wechat.APIKey = saved.Private.Payment.Wechat.APIKey
	}
	if strings.TrimSpace(settings.Private.Payment.Wechat.APIV3Key) == "" {
		settings.Private.Payment.Wechat.APIV3Key = saved.Private.Payment.Wechat.APIV3Key
	}
	if strings.TrimSpace(settings.Private.Payment.Wechat.MchPrivateKey) == "" {
		settings.Private.Payment.Wechat.MchPrivateKey = saved.Private.Payment.Wechat.MchPrivateKey
	}
}

func keepPrivateStorageSecrets(settings *model.Settings, saved model.Settings) {
	for i := range settings.Private.Storage.Providers {
		if strings.TrimSpace(settings.Private.Storage.Providers[i].SecretAccessKey) != "" {
			continue
		}
		if provider, ok := findSavedStorageProvider(settings.Private.Storage.Providers[i], saved.Private.Storage.Providers, i); ok {
			settings.Private.Storage.Providers[i].SecretAccessKey = provider.SecretAccessKey
		}
	}
}

func findSavedStorageProvider(provider model.StorageProvider, saved []model.StorageProvider, index int) (model.StorageProvider, bool) {
	for _, item := range saved {
		if provider.ID != "" && item.ID == provider.ID {
			return item, true
		}
		if item.Name == provider.Name && item.Endpoint == provider.Endpoint && item.Bucket == provider.Bucket {
			return item, true
		}
	}
	if index >= 0 && index < len(saved) {
		return saved[index], true
	}
	return model.StorageProvider{}, false
}

func keepPrivateAuthSecrets(settings *model.Settings, saved model.Settings) {
	if strings.TrimSpace(settings.Private.Auth.LinuxDo.ClientSecret) == "" {
		settings.Private.Auth.LinuxDo.ClientSecret = saved.Private.Auth.LinuxDo.ClientSecret
	}
	if strings.TrimSpace(settings.Private.Auth.OIDC.ClientSecret) == "" {
		settings.Private.Auth.OIDC.ClientSecret = saved.Private.Auth.OIDC.ClientSecret
	}
}

func findSavedChannel(channel model.ModelChannel, saved []model.ModelChannel, index int) (model.ModelChannel, bool) {
	for _, item := range saved {
		if item.Name == channel.Name && item.BaseURL == channel.BaseURL {
			return item, true
		}
	}
	if index < len(saved) {
		return saved[index], true
	}
	return model.ModelChannel{}, false
}

func SelectModelChannel(modelName string) (model.ModelChannel, error) {
	return SelectModelChannelForModel(modelName, "")
}

func SelectModelChannelForModel(modelName string, channelID string) (model.ModelChannel, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return model.ModelChannel{}, err
	}
	channels := modelChannelsForModel(normalizePrivateSetting(settings.Private).Channels, modelName)
	if len(channels) == 0 {
		return model.ModelChannel{}, errors.New("没有可用模型渠道")
	}
	if strings.TrimSpace(channelID) != "" {
		for _, channel := range channels {
			if channel.ID == channelID {
				return channel, nil
			}
		}
	}
	total := 0
	for _, channel := range channels {
		total += channel.Weight
	}
	if total <= 0 {
		return channels[0], nil
	}
	hit := rand.Intn(total)
	for _, channel := range channels {
		hit -= channel.Weight
		if hit < 0 {
			return channel, nil
		}
	}
	return channels[0], nil
}

func BuildModelChannelURL(channel model.ModelChannel, path string) string {
	baseURL := strings.TrimSpace(channel.BaseURL)
	parsed, err := url.Parse(baseURL)
	if err == nil && parsed.Scheme != "" && parsed.Host != "" {
		parsed.RawQuery = ""
		parsed.Fragment = ""
		parsed.Path = normalizeModelChannelPath(parsed.Path)
		return strings.TrimRight(parsed.String(), "/") + path
	}
	baseURL = strings.TrimRight(baseURL, "/")
	lower := strings.ToLower(baseURL)
	if index := strings.Index(lower, "/api/plan/v3"); index >= 0 {
		return baseURL[:index] + "/api/plan/v3" + path
	}
	if strings.HasSuffix(lower, "/v1") || strings.HasSuffix(lower, "/api/v3") {
		return baseURL + path
	}
	return baseURL + "/v1" + path
}

func normalizeModelChannelPath(path string) string {
	path = strings.TrimRight(path, "/")
	lower := strings.ToLower(path)
	if index := strings.Index(lower, "/api/plan/v3"); index >= 0 {
		return path[:index] + "/api/plan/v3"
	}
	if strings.HasSuffix(lower, "/v1") || strings.HasSuffix(lower, "/api/v3") {
		return path
	}
	return path + "/v1"
}

func normalizeModelChannel(channel model.ModelChannel) model.ModelChannel {
	if channel.Protocol == "" {
		channel.Protocol = "openai"
	}
	if channel.ID == "" {
		channel.ID = stableModelChannelID(channel)
	}
	if channel.Models == nil {
		channel.Models = []string{}
	}
	if channel.Weight <= 0 {
		channel.Weight = 1
	}
	if channel.Timeout <= 0 {
		channel.Timeout = 600
	}
	return channel
}

func resolveAdminChannel(index *int, channel model.ModelChannel) (model.ModelChannel, error) {
	resolved := normalizeModelChannel(channel)
	if strings.TrimSpace(resolved.APIKey) == "" {
		settings, err := repository.GetSettings()
		if err != nil {
			return model.ModelChannel{}, err
		}
		saved := normalizePrivateSetting(settings.Private).Channels
		if index != nil && *index >= 0 && *index < len(saved) {
			if resolved.APIKey == "" {
				resolved.APIKey = saved[*index].APIKey
			}
			if resolved.BaseURL == "" {
				resolved.BaseURL = saved[*index].BaseURL
			}
			if resolved.Name == "" {
				resolved.Name = saved[*index].Name
			}
		}
		if resolved.APIKey == "" {
			if savedChannel, ok := findSavedChannel(resolved, saved, -1); ok {
				resolved.APIKey = savedChannel.APIKey
			}
		}
	}
	if strings.TrimSpace(resolved.BaseURL) == "" {
		return model.ModelChannel{}, safeMessageError{message: "缺少接口地址"}
	}
	if strings.TrimSpace(resolved.APIKey) == "" {
		return model.ModelChannel{}, safeMessageError{message: "缺少 API Key"}
	}
	return resolved, nil
}

func fetchAdminChannelModels(channel model.ModelChannel) ([]string, error) {
	request, err := http.NewRequest(http.MethodGet, BuildModelChannelURL(channel, "/models"), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	response, err := HTTPClientForChannel(channel).Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode >= http.StatusBadRequest {
		if response.StatusCode == http.StatusNotFound && isArkPlanBaseURL(channel.BaseURL) {
			return nil, safeMessageError{message: "火山方舟 Agent Plan 未提供 OpenAI /models 接口，请手动填写模型名"}
		}
		return nil, readAdminChannelError(body, response.StatusCode, "读取模型失败")
	}
	var payload struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	_ = json.Unmarshal(body, &payload)
	result := make([]string, 0, len(payload.Data))
	for _, item := range payload.Data {
		if strings.TrimSpace(item.ID) != "" {
			result = append(result, item.ID)
		}
	}
	sort.Strings(result)
	return result, nil
}

func testAdminChannelModel(channel model.ModelChannel, modelName string) (string, error) {
	if strings.TrimSpace(modelName) == "" {
		return "", errors.New("缺少模型名称")
	}
	body, _ := json.Marshal(map[string]any{
		"model": modelName,
		"messages": []map[string]string{{
			"role":    "user",
			"content": "hi",
		}},
	})
	request, err := http.NewRequest(http.MethodPost, BuildModelChannelURL(channel, "/chat/completions"), strings.NewReader(string(body)))
	if err != nil {
		return "", err
	}
	request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	request.Header.Set("Content-Type", "application/json")
	response, err := HTTPClientForChannel(channel).Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	responseBody, _ := io.ReadAll(response.Body)
	if response.StatusCode >= http.StatusBadRequest {
		return "", readAdminChannelError(responseBody, response.StatusCode, "测试失败")
	}
	var payload struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	_ = json.Unmarshal(responseBody, &payload)
	if len(payload.Choices) > 0 && strings.TrimSpace(payload.Choices[0].Message.Content) != "" {
		return payload.Choices[0].Message.Content, nil
	}
	return "ok", nil
}

func readAdminChannelError(body []byte, statusCode int, fallback string) error {
	var payload struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
		Msg string `json:"msg"`
	}
	if len(body) > 0 && json.Unmarshal(body, &payload) == nil {
		if payload.Error != nil && strings.TrimSpace(payload.Error.Message) != "" {
			return safeMessageError{message: payload.Error.Message}
		}
		if strings.TrimSpace(payload.Msg) != "" {
			return safeMessageError{message: payload.Msg}
		}
	}
	if statusCode == http.StatusUnauthorized {
		return safeMessageError{message: "上游接口认证失败（401），请检查 API Key"}
	}
	if statusCode > 0 {
		return safeMessageError{message: fmt.Sprintf("%s：%d", fallback, statusCode)}
	}
	return safeMessageError{message: fallback}
}

func HTTPClientForChannel(channel model.ModelChannel) *http.Client {
	timeout := channel.Timeout
	if timeout <= 0 {
		timeout = 600
	}
	return &http.Client{Timeout: time.Duration(timeout) * time.Second}
}

type safeMessageError struct {
	message string
}

func (err safeMessageError) Error() string {
	return err.message
}

func (err safeMessageError) SafeMessage() string {
	return err.message
}

func modelChannelsForModel(channels []model.ModelChannel, modelName string) []model.ModelChannel {
	result := []model.ModelChannel{}
	for _, channel := range channels {
		if !channel.Enabled || channel.BaseURL == "" || channel.APIKey == "" {
			continue
		}
		for _, item := range channel.Models {
			if strings.TrimSpace(item) == modelName {
				result = append(result, channel)
				break
			}
		}
	}
	return result
}

func publicChannelInfos(channels []model.ModelChannel) []model.PublicModelChannelInfo {
	result := []model.PublicModelChannelInfo{}
	for _, channel := range channels {
		if !channel.Enabled || channel.BaseURL == "" || len(channel.Models) == 0 {
			continue
		}
		result = append(result, model.PublicModelChannelInfo{
			ID:      channel.ID,
			Name:    channel.Name,
			BaseURL: channel.BaseURL,
			Models:  append([]string{}, channel.Models...),
			Weight:  channel.Weight,
			Timeout: channel.Timeout,
			Enabled: channel.Enabled,
			Remark:  channel.Remark,
		})
	}
	return result
}

func collectChannelModels(channels []model.ModelChannel) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, channel := range channels {
		if !channel.Enabled {
			continue
		}
		for _, item := range channel.Models {
			modelName := strings.TrimSpace(item)
			if modelName == "" || seen[modelName] {
				continue
			}
			seen[modelName] = true
			result = append(result, modelName)
		}
	}
	return result
}

func uniqueStrings(values []string) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, item := range values {
		value := strings.TrimSpace(item)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result
}

func repairDefaultModels(setting model.PublicModelChannelSetting) model.PublicModelChannelSetting {
	models := setting.AvailableModels
	if len(models) == 0 {
		return setting
	}
	setting.DefaultTextModel = validOrFallback(setting.DefaultTextModel, models, firstModelByCapability(models, "text"))
	setting.DefaultImageModel = validOrFallback(setting.DefaultImageModel, models, firstModelByCapability(models, "image"))
	setting.DefaultModel = validOrFallback(setting.DefaultModel, models, setting.DefaultTextModel)
	return setting
}

func validOrFallback(value string, models []string, fallback string) string {
	value = strings.TrimSpace(value)
	for _, modelName := range models {
		if modelName == value {
			return value
		}
	}
	if strings.TrimSpace(fallback) != "" {
		return fallback
	}
	return models[0]
}

func firstModelByCapability(models []string, capability string) string {
	for _, modelName := range models {
		if modelMatchesCapability(modelName, capability) {
			return modelName
		}
	}
	return models[0]
}

func modelMatchesCapability(modelName string, capability string) bool {
	value := strings.ToLower(modelName)
	switch capability {
	case "image":
		return strings.Contains(value, "image") || strings.Contains(value, "seedream") || strings.Contains(value, "flux") || strings.Contains(value, "dall")
	default:
		return !modelMatchesCapability(modelName, "image")
	}
}

func isArkPlanBaseURL(baseURL string) bool {
	return strings.Contains(strings.ToLower(baseURL), "/api/plan/v3")
}
