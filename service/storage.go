package service

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/google/uuid"
	"github.com/robfig/cron/v3"
	"gorm.io/gorm"
)

type UploadedStorageObject struct {
	ID         string `json:"id"`
	URL        string `json:"url"`
	StorageKey string `json:"storageKey"`
	Bytes      int64  `json:"bytes"`
	MimeType   string `json:"mimeType"`
}

type DownloadedStorageObject struct {
	Object      model.StorageObject
	Data        []byte
	RedirectURL string
}

type StorageObjectProviderInput struct {
	Name            string `json:"name"`
	Type            string `json:"type"`
	Endpoint        string `json:"endpoint"`
	Region          string `json:"region"`
	Bucket          string `json:"bucket"`
	AccessKeyID     string `json:"accessKeyId"`
	SecretAccessKey string `json:"secretAccessKey"`
	PublicBaseURL   string `json:"publicBaseUrl"`
	PathPrefix      string `json:"pathPrefix"`
}

type UserConfigPayload struct {
	ModelConfig      json.RawMessage             `json:"modelConfig,omitempty"`
	StorageProvider  *StorageObjectProviderInput `json:"storageProvider,omitempty"`
	CanvasData       json.RawMessage             `json:"canvasData,omitempty"`
	ImageHistory     json.RawMessage             `json:"imageHistory,omitempty"`
	AssetData        json.RawMessage             `json:"assetData,omitempty"`
	SyncCapabilities map[string]bool             `json:"syncCapabilities,omitempty"`
}

type UserDataPayload struct {
	Data json.RawMessage `json:"data"`
}

type CreativeWorkflowPayload struct {
	ID          string          `json:"id"`
	OwnerUserID string          `json:"ownerUserId,omitempty"`
	Scope       string          `json:"scope"`
	Name        string          `json:"name"`
	Category    string          `json:"category"`
	Description string          `json:"description"`
	Data        json.RawMessage `json:"data"`
	CreatedAt   string          `json:"createdAt"`
	UpdatedAt   string          `json:"updatedAt"`
	LastRunAt   string          `json:"lastRunAt,omitempty"`
	Editable    bool            `json:"editable"`
}

type WorkflowAgentDraftRequest struct {
	Prompt      string   `json:"prompt"`
	Scope       string   `json:"scope"`
	Model       string   `json:"model"`
	ChannelID   string   `json:"channelId"`
	ChannelMode string   `json:"channelMode"`
	BaseURL     string   `json:"baseUrl"`
	APIKey      string   `json:"apiKey"`
	References  []string `json:"references"`
}

type WorkflowAgentDraftResponse struct {
	Draft    json.RawMessage `json:"draft"`
	Warnings []string        `json:"warnings"`
	Model    string          `json:"model"`
}

type StorageCapacityResult struct {
	Bytes        int64  `json:"bytes"`
	LimitBytes   int64  `json:"limitBytes"`
	OverLimit    bool   `json:"overLimit"`
	CheckedAt    string `json:"checkedAt"`
	ProviderName string `json:"providerName"`
}

const defaultStorageCapacityLimitBytes int64 = 9 * 1024 * 1024 * 1024

var (
	storageCapacityCron *cron.Cron
	storageCapacityOnce sync.Once
	storageCapacityMu   sync.Mutex
)

func PublicStorageConfig() (model.PublicStorageSetting, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return model.PublicStorageSetting{}, err
	}
	settings = normalizeSettings(settings)
	return model.PublicStorageSetting{Mode: settings.Private.Storage.Mode, AllowUserProvider: settings.Private.Storage.AllowUserProvider}, nil
}

func StorageObjectInfo(id string) (model.StorageObject, error) {
	return repository.GetStorageObject(id)
}

func CurrentUserConfig(ctx context.Context) (UserConfigPayload, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return UserConfigPayload{}, errors.New("请先登录")
	}
	config, ok, err := repository.GetUserConfig(user.ID)
	if err != nil {
		return UserConfigPayload{}, err
	}
	result := UserConfigPayload{}
	result.SyncCapabilities = map[string]bool{"userData": true, "workflows": true, "assets": true}
	if !ok {
		return result, nil
	}
	if strings.TrimSpace(config.ModelConfig) != "" {
		result.ModelConfig = json.RawMessage(config.ModelConfig)
	}
	if strings.TrimSpace(config.StorageProvider) != "" {
		var provider StorageObjectProviderInput
		if err := json.Unmarshal([]byte(config.StorageProvider), &provider); err == nil {
			result.StorageProvider = &provider
		}
	}
	if strings.TrimSpace(config.CanvasData) != "" {
		result.CanvasData = json.RawMessage(config.CanvasData)
	}
	if strings.TrimSpace(config.ImageHistory) != "" {
		result.ImageHistory = json.RawMessage(config.ImageHistory)
	}
	if strings.TrimSpace(config.AssetData) != "" {
		result.AssetData = json.RawMessage(config.AssetData)
	}
	return result, nil
}

func SaveCurrentUserModelConfig(ctx context.Context, raw json.RawMessage) (UserConfigPayload, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return UserConfigPayload{}, errors.New("请先登录")
	}
	config, _, err := repository.GetUserConfig(user.ID)
	if err != nil {
		return UserConfigPayload{}, err
	}
	current := now()
	if config.UserID == "" {
		config.UserID = user.ID
		config.CreatedAt = current
	}
	config.ModelConfig = string(raw)
	config.UpdatedAt = current
	if _, err := repository.SaveUserConfig(config); err != nil {
		return UserConfigPayload{}, err
	}
	return CurrentUserConfig(ctx)
}

func CurrentUserCanvasData(ctx context.Context) (json.RawMessage, error) {
	config, err := currentUserConfig(ctx)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(config.CanvasData) == "" {
		return json.RawMessage(`{"projects":[]}`), nil
	}
	return json.RawMessage(config.CanvasData), nil
}

func SaveCurrentUserCanvasData(ctx context.Context, raw json.RawMessage) (json.RawMessage, error) {
	config, err := saveCurrentUserConfigField(ctx, func(config *model.UserConfig) {
		config.CanvasData = string(raw)
	})
	if err != nil {
		return nil, err
	}
	return json.RawMessage(config.CanvasData), nil
}

func CurrentUserImageHistory(ctx context.Context) (json.RawMessage, error) {
	config, err := currentUserConfig(ctx)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(config.ImageHistory) == "" {
		return json.RawMessage(`{"logs":[],"categories":[]}`), nil
	}
	return json.RawMessage(config.ImageHistory), nil
}

func SaveCurrentUserImageHistory(ctx context.Context, raw json.RawMessage) (json.RawMessage, error) {
	config, err := saveCurrentUserConfigField(ctx, func(config *model.UserConfig) {
		config.ImageHistory = string(raw)
	})
	if err != nil {
		return nil, err
	}
	return json.RawMessage(config.ImageHistory), nil
}

func CurrentUserAssetData(ctx context.Context) (json.RawMessage, error) {
	config, err := currentUserConfig(ctx)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(config.AssetData) == "" {
		return json.RawMessage(`{"assets":[]}`), nil
	}
	return json.RawMessage(config.AssetData), nil
}

func SaveCurrentUserAssetData(ctx context.Context, raw json.RawMessage) (json.RawMessage, error) {
	config, err := saveCurrentUserConfigField(ctx, func(config *model.UserConfig) {
		config.AssetData = string(raw)
	})
	if err != nil {
		return nil, err
	}
	return json.RawMessage(config.AssetData), nil
}

func currentUserConfig(ctx context.Context) (model.UserConfig, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return model.UserConfig{}, errors.New("请先登录")
	}
	config, _, err := repository.GetUserConfig(user.ID)
	if err != nil {
		return model.UserConfig{}, err
	}
	if config.UserID == "" {
		config.UserID = user.ID
	}
	return config, nil
}

func saveCurrentUserConfigField(ctx context.Context, patch func(config *model.UserConfig)) (model.UserConfig, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return model.UserConfig{}, errors.New("请先登录")
	}
	config, _, err := repository.GetUserConfig(user.ID)
	if err != nil {
		return model.UserConfig{}, err
	}
	current := now()
	if config.UserID == "" {
		config.UserID = user.ID
		config.CreatedAt = current
	}
	patch(&config)
	config.UpdatedAt = current
	return repository.SaveUserConfig(config)
}

func ListCreativeWorkflows(ctx context.Context) ([]CreativeWorkflowPayload, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return nil, errors.New("请先登录")
	}
	records, err := repository.ListCreativeWorkflows(user.ID)
	if err != nil {
		return nil, err
	}
	result := make([]CreativeWorkflowPayload, 0, len(records))
	for _, record := range records {
		result = append(result, creativeWorkflowPayload(record, user.ID))
	}
	return result, nil
}

func SaveCreativeWorkflow(ctx context.Context, payload CreativeWorkflowPayload) (CreativeWorkflowPayload, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return CreativeWorkflowPayload{}, errors.New("请先登录")
	}
	scope := strings.ToLower(strings.TrimSpace(payload.Scope))
	if scope != "public" {
		scope = "private"
	}
	current := now()
	id := strings.TrimSpace(payload.ID)
	var existing model.CreativeWorkflow
	if id != "" {
		record, found, err := repository.GetCreativeWorkflow(id)
		if err != nil {
			return CreativeWorkflowPayload{}, err
		}
		if found {
			if record.OwnerUserID != user.ID {
				return CreativeWorkflowPayload{}, errors.New("只能编辑自己的工作流")
			}
			existing = record
		}
	}
	if id == "" {
		id = uuid.NewString()
	}
	createdAt := existing.CreatedAt
	if createdAt == "" {
		createdAt = current
	}
	record := model.CreativeWorkflow{
		ID:          id,
		OwnerUserID: user.ID,
		Scope:       scope,
		Name:        strings.TrimSpace(payload.Name),
		Category:    strings.TrimSpace(payload.Category),
		Description: strings.TrimSpace(payload.Description),
		Data:        string(payload.Data),
		CreatedAt:   createdAt,
		UpdatedAt:   current,
		LastRunAt:   payload.LastRunAt,
	}
	if record.Name == "" {
		return CreativeWorkflowPayload{}, errors.New("请输入工作流名称")
	}
	if strings.TrimSpace(record.Data) == "" {
		record.Data = "{}"
	}
	saved, err := repository.SaveCreativeWorkflow(record)
	if err != nil {
		return CreativeWorkflowPayload{}, err
	}
	return creativeWorkflowPayload(saved, user.ID), nil
}

func DeleteCreativeWorkflow(ctx context.Context, id string) error {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return errors.New("请先登录")
	}
	record, found, err := repository.GetCreativeWorkflow(id)
	if err != nil {
		return err
	}
	if !found {
		return nil
	}
	if record.OwnerUserID != user.ID {
		return errors.New("只能删除自己的工作流")
	}
	return repository.DeleteCreativeWorkflow(id)
}

func DraftCreativeWorkflow(ctx context.Context, request WorkflowAgentDraftRequest) (WorkflowAgentDraftResponse, error) {
	startedAt := time.Now()
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return WorkflowAgentDraftResponse{}, errors.New("请先登录")
	}
	prompt := strings.TrimSpace(request.Prompt)
	if prompt == "" {
		return WorkflowAgentDraftResponse{}, safeMessageError{message: "请输入工作流需求"}
	}
	modelName, err := workflowDraftModel(request.Model)
	if err != nil {
		return WorkflowAgentDraftResponse{}, err
	}
	channel, err := workflowDraftChannel(request, modelName)
	if err != nil {
		return WorkflowAgentDraftResponse{}, err
	}
	credits, _ := ModelCost(modelName)
	chargedCredits := request.ChannelMode != "local"
	if chargedCredits {
		if err := ConsumeUserCredits(user.ID, modelName, credits, "/workflows/agent-draft"); err != nil {
			return WorkflowAgentDraftResponse{}, err
		}
	}
	refundCredits := func() {
		if chargedCredits {
			_ = RefundUserCredits(user.ID, modelName, credits, "/workflows/agent-draft")
		}
	}
	body, _ := json.Marshal(map[string]any{
		"model":       modelName,
		"messages":    workflowAgentMessages(prompt, request.References),
		"temperature": 0.2,
	})
	httpRequest, err := http.NewRequest(http.MethodPost, BuildModelChannelURL(channel, "/chat/completions"), bytes.NewReader(body))
	if err != nil {
		refundCredits()
		return WorkflowAgentDraftResponse{}, err
	}
	httpRequest.Header.Set("Authorization", "Bearer "+channel.APIKey)
	httpRequest.Header.Set("Content-Type", "application/json")
	response, err := HTTPClientForChannel(channel).Do(httpRequest)
	if err != nil {
		refundCredits()
		SaveAICallLog(AICallLogInput{UserID: user.ID, UserDisplayName: firstNonEmpty(user.DisplayName, user.Username), Endpoint: "/workflows/agent-draft", Method: http.MethodPost, Model: modelName, ChannelID: channel.ID, ChannelName: channel.Name, Status: 0, DurationMs: time.Since(startedAt).Milliseconds(), Credits: credits, RequestBody: string(body), Error: err.Error()})
		return WorkflowAgentDraftResponse{}, err
	}
	defer response.Body.Close()
	responseBody, _ := io.ReadAll(response.Body)
	if response.StatusCode >= http.StatusBadRequest {
		refundCredits()
		SaveAICallLog(AICallLogInput{UserID: user.ID, UserDisplayName: firstNonEmpty(user.DisplayName, user.Username), Endpoint: "/workflows/agent-draft", Method: http.MethodPost, Model: modelName, ChannelID: channel.ID, ChannelName: channel.Name, Status: response.StatusCode, DurationMs: time.Since(startedAt).Milliseconds(), Credits: credits, RequestBody: string(body), ResponseBody: string(responseBody), Error: string(responseBody)})
		return WorkflowAgentDraftResponse{}, readAdminChannelError(responseBody, response.StatusCode, "工作流 Agent 请求失败")
	}
	content := extractChatCompletionContent(responseBody)
	draft, warnings, err := normalizeWorkflowDraft(content, request.Scope)
	if err != nil {
		refundCredits()
		SaveAICallLog(AICallLogInput{UserID: user.ID, UserDisplayName: firstNonEmpty(user.DisplayName, user.Username), Endpoint: "/workflows/agent-draft", Method: http.MethodPost, Model: modelName, ChannelID: channel.ID, ChannelName: channel.Name, Status: response.StatusCode, DurationMs: time.Since(startedAt).Milliseconds(), Credits: credits, RequestBody: string(body), ResponseBody: string(responseBody), Error: err.Error()})
		return WorkflowAgentDraftResponse{}, err
	}
	SaveAICallLog(AICallLogInput{UserID: user.ID, UserDisplayName: firstNonEmpty(user.DisplayName, user.Username), Endpoint: "/workflows/agent-draft", Method: http.MethodPost, Model: modelName, ChannelID: channel.ID, ChannelName: channel.Name, Status: response.StatusCode, DurationMs: time.Since(startedAt).Milliseconds(), Credits: credits, RequestBody: string(body), ResponseBody: string(responseBody)})
	return WorkflowAgentDraftResponse{Draft: draft, Warnings: warnings, Model: modelName}, nil
}

func creativeWorkflowPayload(record model.CreativeWorkflow, currentUserID string) CreativeWorkflowPayload {
	data := json.RawMessage(record.Data)
	if len(data) == 0 {
		data = json.RawMessage(`{}`)
	}
	return CreativeWorkflowPayload{
		ID:          record.ID,
		OwnerUserID: record.OwnerUserID,
		Scope:       record.Scope,
		Name:        record.Name,
		Category:    record.Category,
		Description: record.Description,
		Data:        data,
		CreatedAt:   record.CreatedAt,
		UpdatedAt:   record.UpdatedAt,
		LastRunAt:   record.LastRunAt,
		Editable:    record.OwnerUserID == currentUserID,
	}
}

func workflowDraftModel(modelName string) (string, error) {
	modelName = strings.TrimSpace(modelName)
	if modelName != "" {
		return modelName, nil
	}
	settings, err := repository.GetSettings()
	if err != nil {
		return "", err
	}
	normalized := normalizeSettings(settings)
	if strings.TrimSpace(normalized.Public.ModelChannel.DefaultTextModel) != "" {
		return strings.TrimSpace(normalized.Public.ModelChannel.DefaultTextModel), nil
	}
	if strings.TrimSpace(normalized.Public.ModelChannel.DefaultModel) != "" {
		return strings.TrimSpace(normalized.Public.ModelChannel.DefaultModel), nil
	}
	for _, channel := range normalized.Private.Channels {
		for _, model := range channel.Models {
			if strings.TrimSpace(model) != "" {
				return strings.TrimSpace(model), nil
			}
		}
	}
	return "", safeMessageError{message: "请先配置文本模型"}
}

func workflowDraftChannel(request WorkflowAgentDraftRequest, modelName string) (model.ModelChannel, error) {
	if request.ChannelMode == "local" {
		channel := normalizeModelChannel(model.ModelChannel{
			ID:      strings.TrimSpace(request.ChannelID),
			Name:    "用户本地直连",
			BaseURL: strings.TrimSpace(request.BaseURL),
			APIKey:  strings.TrimSpace(request.APIKey),
			Models:  []string{modelName},
			Weight:  1,
		})
		if channel.BaseURL == "" || channel.APIKey == "" {
			return model.ModelChannel{}, errors.New("文本模型本地直连渠道配置不完整")
		}
		return channel, nil
	}
	return SelectModelChannelForModel(modelName, request.ChannelID)
}

func workflowAgentMessages(prompt string, references []string) []map[string]any {
	messages := []map[string]any{{"role": "system", "content": workflowAgentSystemPrompt()}}
	var content []map[string]any
	content = append(content, map[string]any{"type": "text", "text": prompt})
	for _, dataURL := range references {
		dataURL = strings.TrimSpace(dataURL)
		if strings.HasPrefix(dataURL, "data:image/") {
			content = append(content, map[string]any{"type": "image_url", "image_url": map[string]string{"url": dataURL}})
		}
	}
	if len(content) == 1 {
		messages = append(messages, map[string]any{"role": "user", "content": prompt})
	} else {
		messages = append(messages, map[string]any{"role": "user", "content": content})
	}
	return messages
}

func workflowAgentSystemPrompt() string {
	systemPrompt := ""
	if settings, err := repository.GetSettings(); err == nil {
		systemPrompt = strings.TrimSpace(normalizeSettings(settings).Public.ModelChannel.SystemPrompts.WorkflowAgent)
	}
	if systemPrompt != "" {
		return systemPrompt
	}
	return DefaultSystemPrompts().WorkflowAgent
}

func extractChatCompletionContent(body []byte) string {
	var payload struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	_ = json.Unmarshal(body, &payload)
	if len(payload.Choices) > 0 {
		return strings.TrimSpace(payload.Choices[0].Message.Content)
	}
	return strings.TrimSpace(string(body))
}

func normalizeWorkflowDraft(content string, scope string) (json.RawMessage, []string, error) {
	content = extractJSONObject(content)
	if content == "" {
		return nil, nil, safeMessageError{message: "工作流 Agent 没有返回有效 JSON"}
	}
	var draft map[string]any
	if err := json.Unmarshal([]byte(content), &draft); err != nil {
		return nil, nil, safeMessageError{message: "工作流 Agent 返回 JSON 解析失败"}
	}
	warnings := []string{}
	name := stringMapField(draft, "name")
	if name == "" {
		name = "AI 创建工作流"
		warnings = append(warnings, "已补全工作流名称")
	}
	selectedScope := strings.ToLower(strings.TrimSpace(fmt.Sprint(draft["scope"])))
	if strings.TrimSpace(scope) != "" {
		selectedScope = strings.ToLower(strings.TrimSpace(scope))
	}
	if selectedScope != "public" {
		selectedScope = "private"
	}
	draft["name"] = name
	draft["scope"] = selectedScope
	draft["category"] = stringMapField(draft, "category")
	draft["description"] = stringMapField(draft, "description")
	draft["variables"] = normalizeDraftVariables(draft["variables"])
	draft["config"] = normalizeDraftConfig(draft["config"])
	raw, _ := json.Marshal(draft)
	return raw, warnings, nil
}

func extractJSONObject(content string) string {
	content = strings.TrimSpace(strings.Trim(content, "`"))
	if strings.HasPrefix(content, "json") {
		content = strings.TrimSpace(strings.TrimPrefix(content, "json"))
	}
	start := strings.Index(content, "{")
	end := strings.LastIndex(content, "}")
	if start < 0 || end <= start {
		return ""
	}
	return content[start : end+1]
}

func normalizeDraftVariables(value any) []map[string]any {
	items, _ := value.([]any)
	result := []map[string]any{}
	seen := map[string]int{}
	for _, item := range items {
		record, ok := item.(map[string]any)
		if !ok {
			continue
		}
		key := sanitizeWorkflowVariableKey(stringMapField(record, "key"))
		if key == "" {
			key = fmt.Sprintf("variable_%d", len(result)+1)
		}
		if seen[key] > 0 {
			seen[key]++
			key = fmt.Sprintf("%s_%d", key, seen[key])
		} else {
			seen[key] = 1
		}
		typ := strings.ToLower(stringMapField(record, "type"))
		if typ != "textarea" && typ != "number" && typ != "select" && typ != "boolean" {
			typ = "text"
		}
		options := []string{}
		if optionItems, ok := record["options"].([]any); ok {
			for _, option := range optionItems {
				if text := strings.TrimSpace(fmt.Sprint(option)); text != "" && len([]rune(text)) <= 80 {
					options = append(options, text)
				}
				if len(options) >= 50 {
					break
				}
			}
		}
		result = append(result, map[string]any{
			"id":           stringMapField(record, "id"),
			"key":          key,
			"label":        stringMapField(record, "label"),
			"type":         typ,
			"required":     record["required"] != false,
			"defaultValue": stringMapField(record, "defaultValue"),
			"options":      options,
		})
	}
	return result
}

func stringMapField(record map[string]any, key string) string {
	value, ok := record[key]
	if !ok || value == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(value))
}

func sanitizeWorkflowVariableKey(value string) string {
	value = strings.TrimSpace(value)
	var builder strings.Builder
	for _, char := range value {
		if char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char == '_' || char == '-' || char == '.' {
			builder.WriteRune(char)
		} else if char == ' ' {
			builder.WriteRune('_')
		}
	}
	return builder.String()
}

func normalizeDraftConfig(value any) map[string]any {
	config, _ := value.(map[string]any)
	if config == nil {
		config = map[string]any{}
	}
	defaults := map[string]any{
		"systemPrompt":          "",
		"promptTemplate":        "",
		"negativePrompt":        "",
		"apiMode":               "responses",
		"size":                  "auto",
		"quality":               "high",
		"count":                 "1",
		"outputFormat":          "png",
		"outputCompression":     "100",
		"moderation":            "auto",
		"timeout":               "600",
		"streamImages":          true,
		"streamPartialImages":   "1",
		"responseFormatB64Json": true,
		"codexCli":              false,
	}
	for key, fallback := range defaults {
		if _, ok := config[key]; !ok {
			config[key] = fallback
		}
	}
	return config
}

func SaveCurrentUserStorageProvider(ctx context.Context, provider StorageObjectProviderInput) (UserConfigPayload, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return UserConfigPayload{}, errors.New("请先登录")
	}
	normalized := normalizeUserStorageProvider(provider, ctx)
	raw, _ := json.Marshal(StorageObjectProviderInput{
		Name: normalized.Name, Type: normalized.Type, Endpoint: normalized.Endpoint, Region: normalized.Region,
		Bucket: normalized.Bucket, AccessKeyID: normalized.AccessKeyID, SecretAccessKey: normalized.SecretAccessKey,
		PublicBaseURL: normalized.PublicBaseURL, PathPrefix: normalized.PathPrefix,
	})
	config, _, err := repository.GetUserConfig(user.ID)
	if err != nil {
		return UserConfigPayload{}, err
	}
	current := now()
	if config.UserID == "" {
		config.UserID = user.ID
		config.CreatedAt = current
	}
	config.StorageProvider = string(raw)
	config.UpdatedAt = current
	if _, err := repository.SaveUserConfig(config); err != nil {
		return UserConfigPayload{}, err
	}
	return CurrentUserConfig(ctx)
}

func UploadStorageObject(ctx context.Context, filename string, contentType string, data []byte) (UploadedStorageObject, error) {
	return UploadStorageObjectWithProvider(ctx, filename, contentType, data, nil)
}

func UploadStorageObjectWithProvider(ctx context.Context, filename string, contentType string, data []byte, providerInput *StorageObjectProviderInput) (UploadedStorageObject, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return UploadedStorageObject{}, err
	}
	storage := normalizePrivateStorageSetting(settings.Private.Storage)
	usingUserProvider := providerInput != nil && storage.AllowUserProvider
	if !usingUserProvider && storage.Mode != "server_sqlite_s3" && storage.Mode != "hybrid" {
		return UploadedStorageObject{}, errors.New("服务端对象存储未启用")
	}
	var provider model.StorageProvider
	if usingUserProvider {
		provider = normalizeUserStorageProvider(*providerInput, ctx)
		if provider.Endpoint == "" || provider.Bucket == "" || provider.AccessKeyID == "" || provider.SecretAccessKey == "" {
			return UploadedStorageObject{}, errors.New("用户对象存储配置不完整")
		}
	} else {
		provider, err = selectStorageProvider(storage)
		if err != nil {
			return UploadedStorageObject{}, err
		}
	}
	objectID := uuid.NewString()
	ext := path.Ext(filename)
	if ext == "" {
		ext = extensionForContentType(contentType)
	}
	userID := "anonymous"
	if user, ok := UserFromContext(ctx); ok && user.ID != "" {
		userID = user.ID
	}
	nowTime := time.Now()
	objectKey := strings.Trim(strings.Trim(provider.PathPrefix, "/")+"/"+userID+"/"+nowTime.Format("2006/01/02")+"/"+objectID+ext, "/")
	sum := sha256.Sum256(data)
	if err := putS3Object(provider, objectKey, contentType, data); err != nil {
		return UploadedStorageObject{}, err
	}
	publicURL := objectURL(provider, objectKey)
	object := model.StorageObject{
		ID: objectID, ProviderID: provider.ID, Bucket: provider.Bucket, ObjectKey: objectKey, PublicURL: publicURL,
		MimeType: contentType, Bytes: int64(len(data)), SHA256: hex.EncodeToString(sum[:]), CreatedBy: userID, CreatedAt: now(),
	}
	if _, err := repository.SaveStorageObject(object); err != nil {
		return UploadedStorageObject{}, err
	}
	url := "/api/files/" + objectID + "/content"
	if publicURL != "" {
		url = publicURL
	}
	return UploadedStorageObject{ID: objectID, URL: url, StorageKey: "server:" + objectID, Bytes: int64(len(data)), MimeType: contentType}, nil
}

func DeleteStorageObject(ctx context.Context, id string, providerInput *StorageObjectProviderInput) error {
	object, err := repository.GetStorageObject(id)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		return err
	}
	if user, ok := UserFromContext(ctx); ok && object.CreatedBy != "" && object.CreatedBy != user.ID {
		return errors.New("无权删除该对象")
	}
	settings, err := repository.GetSettings()
	if err != nil {
		return err
	}
	providers := normalizePrivateStorageSetting(settings.Private.Storage).Providers
	if providerInput != nil && settings.Private.Storage.AllowUserProvider {
		providers = append([]model.StorageProvider{normalizeUserStorageProvider(*providerInput, ctx)}, providers...)
	}
	provider, ok := findStorageProviderForObject(object, providers)
	if !ok {
		return errors.New("对象存储配置不存在")
	}
	if err := deleteS3Object(provider, object.ObjectKey); err != nil {
		return err
	}
	return repository.DeleteStorageObjectRecord(id)
}

func MeasureUserStorageProvider(ctx context.Context, providerInput StorageObjectProviderInput) (StorageCapacityResult, error) {
	provider := normalizeUserStorageProvider(providerInput, ctx)
	bytes, err := measureS3Provider(provider)
	if err != nil {
		return StorageCapacityResult{}, err
	}
	checkedAt := now()
	return StorageCapacityResult{Bytes: bytes, LimitBytes: defaultStorageCapacityLimitBytes, OverLimit: bytes >= defaultStorageCapacityLimitBytes, CheckedAt: checkedAt, ProviderName: provider.Name}, nil
}

func MeasureAdminStorageProvider(index int, providerInput *model.StorageProvider) (StorageCapacityResult, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return StorageCapacityResult{}, err
	}
	settings = normalizeSettings(settings)
	storage := settings.Private.Storage
	if index < 0 || index >= len(storage.Providers) {
		return StorageCapacityResult{}, errors.New("对象存储配置不存在")
	}
	provider := storage.Providers[index]
	if providerInput != nil {
		provider = normalizeStorageProvider(*providerInput)
		provider.SecretAccessKey = storage.Providers[index].SecretAccessKey
		if strings.TrimSpace(providerInput.SecretAccessKey) != "" {
			provider.SecretAccessKey = providerInput.SecretAccessKey
		}
	}
	bytes, err := measureS3Provider(provider)
	if err != nil {
		return StorageCapacityResult{}, err
	}
	checkedAt := now()
	limit := storage.CapacityLimitBytes
	if limit <= 0 {
		limit = defaultStorageCapacityLimitBytes
	}
	provider.CapacityBytes = bytes
	provider.CapacityCheckedAt = checkedAt
	provider.CapacityExceeded = bytes >= limit
	if provider.CapacityExceeded {
		provider.Enabled = false
	}
	storage.Providers[index] = provider
	settings.Private.Storage = storage
	if _, err := repository.SaveSettings(settings, now()); err != nil {
		return StorageCapacityResult{}, err
	}
	return StorageCapacityResult{Bytes: bytes, LimitBytes: limit, OverLimit: provider.CapacityExceeded, CheckedAt: checkedAt, ProviderName: provider.Name}, nil
}

func MeasureAllEnabledStorageProviders() {
	settings, err := repository.GetSettings()
	if err != nil {
		log.Printf("storage capacity settings load failed err=%v", err)
		return
	}
	settings = normalizeSettings(settings)
	storage := settings.Private.Storage
	changed := false
	for i, provider := range storage.Providers {
		if !provider.Enabled {
			continue
		}
		bytes, err := measureS3Provider(provider)
		if err != nil {
			log.Printf("storage capacity measure failed provider=%s err=%v", provider.Name, err)
			continue
		}
		provider.CapacityBytes = bytes
		provider.CapacityCheckedAt = now()
		provider.CapacityExceeded = bytes >= storage.CapacityLimitBytes
		if provider.CapacityExceeded {
			provider.Enabled = false
		}
		storage.Providers[i] = provider
		changed = true
	}
	if changed {
		settings.Private.Storage = storage
		if _, err := repository.SaveSettings(settings, now()); err != nil {
			log.Printf("storage capacity settings save failed err=%v", err)
		}
	}
}

func StartStorageCapacityScheduler() {
	storageCapacityOnce.Do(func() {
		storageCapacityCron = cron.New()
		storageCapacityCron.Start()
	})
	RefreshStorageCapacityScheduler()
}

func RefreshStorageCapacityScheduler() {
	storageCapacityMu.Lock()
	defer storageCapacityMu.Unlock()
	if storageCapacityCron == nil {
		return
	}
	for _, entry := range storageCapacityCron.Entries() {
		storageCapacityCron.Remove(entry.ID)
	}
	settings, err := repository.GetSettings()
	if err != nil {
		log.Printf("load storage capacity setting failed err=%v", err)
		return
	}
	setting := normalizePrivateStorageSetting(settings.Private.Storage).CapacityCheck
	if setting.Enabled == nil || !*setting.Enabled {
		return
	}
	if _, err := storageCapacityCron.AddFunc(setting.Cron, MeasureAllEnabledStorageProviders); err != nil {
		log.Printf("add storage capacity cron failed cron=%s err=%v", setting.Cron, err)
	}
}

func DownloadStorageObject(id string) (DownloadedStorageObject, error) {
	object, err := repository.GetStorageObject(id)
	if err != nil {
		return DownloadedStorageObject{}, err
	}
	if object.PublicURL != "" {
		response, err := http.DefaultClient.Get(object.PublicURL)
		if err != nil {
			return DownloadedStorageObject{}, err
		}
		defer response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
			return DownloadedStorageObject{}, fmt.Errorf("对象存储读取失败: %s %s", response.Status, string(body))
		}
		data, err := io.ReadAll(response.Body)
		if err != nil {
			return DownloadedStorageObject{}, err
		}
		return DownloadedStorageObject{Object: object, Data: data}, nil
	}
	settings, err := repository.GetSettings()
	if err != nil {
		return DownloadedStorageObject{}, err
	}
	provider, ok := findSavedStorageProvider(model.StorageProvider{ID: object.ProviderID}, normalizePrivateStorageSetting(settings.Private.Storage).Providers, -1)
	if !ok {
		return DownloadedStorageObject{}, errors.New("对象存储配置不存在")
	}
	data, err := getS3Object(provider, object.ObjectKey)
	if err != nil {
		return DownloadedStorageObject{}, err
	}
	return DownloadedStorageObject{Object: object, Data: data}, nil
}

func selectStorageProvider(storage model.PrivateStorageSetting) (model.StorageProvider, error) {
	var candidates []model.StorageProvider
	for _, provider := range storage.Providers {
		if provider.Enabled && provider.Endpoint != "" && provider.Bucket != "" && provider.AccessKeyID != "" && provider.SecretAccessKey != "" {
			for i := 0; i < provider.Weight; i++ {
				candidates = append(candidates, provider)
			}
		}
	}
	if len(candidates) == 0 {
		return model.StorageProvider{}, errors.New("没有可用对象存储配置")
	}
	return candidates[int(time.Now().UnixNano())%len(candidates)], nil
}

func putS3Object(provider model.StorageProvider, objectKey string, contentType string, data []byte) error {
	request, err := newS3Request(http.MethodPut, provider, objectKey, bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", contentType)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return fmt.Errorf("对象存储上传失败: %s %s", response.Status, string(body))
	}
	return nil
}

func getS3Object(provider model.StorageProvider, objectKey string) ([]byte, error) {
	request, err := newS3Request(http.MethodGet, provider, objectKey, nil, 0)
	if err != nil {
		return nil, err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("对象读取失败: %s", response.Status)
	}
	return io.ReadAll(response.Body)
}

func deleteS3Object(provider model.StorageProvider, objectKey string) error {
	request, err := newS3Request(http.MethodDelete, provider, objectKey, nil, 0)
	if err != nil {
		return err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return fmt.Errorf("对象存储删除失败: %s %s", response.Status, string(body))
	}
	return nil
}

func measureS3Provider(provider model.StorageProvider) (int64, error) {
	if provider.Endpoint == "" || provider.Bucket == "" || provider.AccessKeyID == "" || provider.SecretAccessKey == "" {
		return 0, errors.New("对象存储配置不完整")
	}
	var total int64
	var token string
	for {
		query := url.Values{}
		query.Set("list-type", "2")
		if token != "" {
			query.Set("continuation-token", token)
		}
		request, err := newS3RequestWithQuery(http.MethodGet, provider, "", query, nil, 0)
		if err != nil {
			return 0, err
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			return 0, err
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, 32*1024*1024))
		_ = response.Body.Close()
		if readErr != nil {
			return 0, readErr
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return 0, fmt.Errorf("对象存储容量统计失败: %s %s", response.Status, string(body))
		}
		var result listBucketResult
		if err := xml.Unmarshal(body, &result); err != nil {
			return 0, err
		}
		for _, item := range result.Contents {
			total += item.Size
		}
		if !result.IsTruncated || strings.TrimSpace(result.NextContinuationToken) == "" {
			return total, nil
		}
		token = result.NextContinuationToken
	}
}

func newS3Request(method string, provider model.StorageProvider, objectKey string, body io.Reader, contentLength int64) (*http.Request, error) {
	return newS3RequestWithQuery(method, provider, objectKey, nil, body, contentLength)
}

func newS3RequestWithQuery(method string, provider model.StorageProvider, objectKey string, query url.Values, body io.Reader, contentLength int64) (*http.Request, error) {
	endpoint, err := url.Parse(strings.TrimRight(provider.Endpoint, "/"))
	if err != nil {
		return nil, err
	}
	escapedKey := strings.TrimLeft(objectKey, "/")
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + "/" + provider.Bucket + "/" + escapedKey
	if query != nil {
		endpoint.RawQuery = query.Encode()
	}
	request, err := http.NewRequest(method, endpoint.String(), body)
	if err != nil {
		return nil, err
	}
	if contentLength > 0 {
		request.ContentLength = contentLength
	}
	signS3Request(request, provider, escapedKey)
	return request, nil
}

func signS3Request(request *http.Request, provider model.StorageProvider, objectKey string) {
	nowTime := time.Now().UTC()
	amzDate := nowTime.Format("20060102T150405Z")
	dateStamp := nowTime.Format("20060102")
	payloadHash := "UNSIGNED-PAYLOAD"
	region := provider.Region
	if region == "" {
		region = "auto"
	}
	request.Header.Set("Host", request.URL.Host)
	request.Header.Set("X-Amz-Date", amzDate)
	request.Header.Set("X-Amz-Content-Sha256", payloadHash)
	canonicalURI := "/" + provider.Bucket + "/" + strings.ReplaceAll(url.PathEscape(objectKey), "%2F", "/")
	canonicalHeaders := "host:" + request.URL.Host + "\n" + "x-amz-content-sha256:" + payloadHash + "\n" + "x-amz-date:" + amzDate + "\n"
	signedHeaders := "host;x-amz-content-sha256;x-amz-date"
	canonicalRequest := request.Method + "\n" + canonicalURI + "\n" + request.URL.RawQuery + "\n" + canonicalHeaders + "\n" + signedHeaders + "\n" + payloadHash
	scope := dateStamp + "/" + region + "/s3/aws4_request"
	stringToSign := "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + sha256Hex([]byte(canonicalRequest))
	signature := hex.EncodeToString(hmacSHA256(signingKey(provider.SecretAccessKey, dateStamp, region), []byte(stringToSign)))
	request.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+provider.AccessKeyID+"/"+scope+", SignedHeaders="+signedHeaders+", Signature="+signature)
}

func signingKey(secret string, dateStamp string, region string) []byte {
	kDate := hmacSHA256([]byte("AWS4"+secret), []byte(dateStamp))
	kRegion := hmacSHA256(kDate, []byte(region))
	kService := hmacSHA256(kRegion, []byte("s3"))
	return hmacSHA256(kService, []byte("aws4_request"))
}

func hmacSHA256(key []byte, data []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write(data)
	return mac.Sum(nil)
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func objectURL(provider model.StorageProvider, objectKey string) string {
	if provider.PublicBaseURL == "" {
		return ""
	}
	return strings.TrimRight(provider.PublicBaseURL, "/") + "/" + strings.TrimLeft(objectKey, "/")
}

func normalizeUserStorageProvider(input StorageObjectProviderInput, ctx context.Context) model.StorageProvider {
	owner := "anonymous"
	if user, ok := UserFromContext(ctx); ok && user.ID != "" {
		owner = user.ID
	}
	return normalizeStorageProvider(model.StorageProvider{
		Name:            input.Name,
		Type:            input.Type,
		Endpoint:        input.Endpoint,
		Region:          input.Region,
		Bucket:          input.Bucket,
		AccessKeyID:     input.AccessKeyID,
		SecretAccessKey: input.SecretAccessKey,
		PublicBaseURL:   input.PublicBaseURL,
		PathPrefix:      input.PathPrefix,
		Weight:          1,
		Enabled:         true,
		OwnerUserID:     owner,
	})
}

func findStorageProviderForObject(object model.StorageObject, providers []model.StorageProvider) (model.StorageProvider, bool) {
	for _, provider := range providers {
		if object.ProviderID != "" && provider.ID == object.ProviderID {
			return provider, true
		}
		if object.Bucket != "" && provider.Bucket == object.Bucket {
			if object.PublicURL == "" || provider.PublicBaseURL == "" || strings.HasPrefix(object.PublicURL, strings.TrimRight(provider.PublicBaseURL, "/")+"/") {
				return provider, true
			}
		}
	}
	return model.StorageProvider{}, false
}

type listBucketResult struct {
	XMLName               xml.Name `xml:"ListBucketResult"`
	IsTruncated           bool     `xml:"IsTruncated"`
	NextContinuationToken string   `xml:"NextContinuationToken"`
	Contents              []struct {
		Size int64 `xml:"Size"`
	} `xml:"Contents"`
}

func extensionForContentType(contentType string) string {
	switch strings.ToLower(strings.Split(contentType, ";")[0]) {
	case "image/jpeg":
		return ".jpg"
	case "image/webp":
		return ".webp"
	case "image/png":
		return ".png"
	default:
		return ".bin"
	}
}
