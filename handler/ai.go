package handler

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/service"
)

func AIImagesGenerations(w http.ResponseWriter, r *http.Request) {
	proxyAIRequest(w, r, "/images/generations")
}

func AIImagesEdits(w http.ResponseWriter, r *http.Request) {
	proxyAIRequest(w, r, "/images/edits")
}

func AIChatCompletions(w http.ResponseWriter, r *http.Request) {
	proxyAIRequest(w, r, "/chat/completions")
}

func AIResponses(w http.ResponseWriter, r *http.Request) {
	proxyAIRequest(w, r, "/responses")
}

func proxyAIRequest(w http.ResponseWriter, r *http.Request, path string) {
	startedAt := time.Now()
	body, contentType, modelName, err := readAIRequest(r)
	if err != nil {
		log.Printf("AI proxy request read failed: %v", err)
		Fail(w, "AI 接口请求失败")
		return
	}
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	unitCredits, err := service.ModelCost(modelName)
	if err != nil {
		log.Printf("AI proxy read model cost failed: model=%s err=%v", modelName, err)
		Fail(w, "AI 接口请求失败")
		return
	}
	requestCount := readAIRequestCount(body, contentType)
	credits := unitCredits * requestCount
	channel, err := service.SelectModelChannelForModel(modelName, r.Header.Get("X-Model-Channel-ID"))
	if err != nil {
		log.Printf("AI proxy select channel failed: model=%s err=%v", modelName, err)
		Fail(w, "AI 接口请求失败")
		return
	}
	logContext := aiLogContext{
		StartedAt:       startedAt,
		Endpoint:        path,
		Method:          http.MethodPost,
		Model:           modelName,
		Channel:         channel,
		UserID:          user.ID,
		UserDisplayName: firstNonEmpty(user.DisplayName, user.Username),
		Credits:         credits,
		UnitCredits:     unitCredits,
		ExpectImage:     isImageAIRequest(path, body),
		RequestBody:     summarizeAIRequest(body, contentType),
	}
	refund := func() {
		if err := service.RefundUserCredits(user.ID, modelName, credits, path, channel); err != nil {
			log.Printf("AI proxy refund credits failed: user=%s model=%s credits=%d err=%v", user.ID, modelName, credits, err)
		}
	}
	if err := service.ConsumeUserCredits(user.ID, modelName, credits, path, channel); err != nil {
		FailError(w, err)
		return
	}
	if service.IsGeminiChannel(channel) {
		proxyGeminiAIRequest(w, r, path, body, contentType, channel, logContext, refund)
		return
	}
	requestPath := path
	useImageAdapter := strings.HasPrefix(path, "/images/") && channel.ImageAdapter != nil && channel.ImageAdapter.Enabled
	if useImageAdapter && strings.TrimSpace(channel.ImageAdapter.CreatePath) != "" {
		requestPath = channel.ImageAdapter.CreatePath
	}
	request, err := http.NewRequestWithContext(r.Context(), http.MethodPost, service.BuildModelChannelURL(channel, requestPath), bytes.NewReader(body))
	if err != nil {
		log.Printf("AI proxy build request failed: url=%s err=%v", service.BuildModelChannelURL(channel, path), err)
		refund()
		Fail(w, "AI 接口请求失败")
		return
	}
	request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	if useImageAdapter {
		copyDeclarativeImageResponse(w, r, request, channel, logContext, refund)
		return
	}
	copyAIResponse(w, request, channel, logContext, refund)
}

type aiLogContext struct {
	StartedAt       time.Time
	Endpoint        string
	Method          string
	Model           string
	Channel         model.ModelChannel
	UserID          string
	UserDisplayName string
	Credits         int
	UnitCredits     int
	ExpectImage     bool
	RequestBody     string
}

type aiResponseCopyResult struct {
	Body         string
	ImageCount   int
	HasError     bool
	ErrorMessage string
}

type aiClientKeepalive struct {
	stop chan struct{}
	done chan struct{}
}

func copyAIResponse(w http.ResponseWriter, request *http.Request, channel model.ModelChannel, logContext aiLogContext, onFailure func()) {
	keepalive := startAIClientKeepalive(w, logContext.ExpectImage)
	response, err := service.HTTPClientForChannel(channel).Do(request)
	if err != nil {
		log.Printf("AI proxy request failed: url=%s err=%v", request.URL.String(), err)
		if onFailure != nil {
			onFailure()
		}
		saveAIProxyLog(logContext, 0, "", err.Error(), 0)
		writeAIProxyError(w, keepalive, http.StatusBadGateway, readUpstreamAIErrorMessage([]byte(err.Error()), http.StatusBadGateway))
		return
	}
	defer response.Body.Close()

	if response.StatusCode >= http.StatusBadRequest {
		payload, _ := io.ReadAll(io.LimitReader(response.Body, 256*1024))
		log.Printf("AI upstream error: url=%s status=%d body=%s", request.URL.String(), response.StatusCode, strings.TrimSpace(string(payload)))
		if onFailure != nil {
			onFailure()
		}
		saveAIProxyLog(logContext, response.StatusCode, string(payload), strings.TrimSpace(string(payload)), 0)
		writeAIProxyError(w, keepalive, response.StatusCode, readUpstreamAIErrorMessage(payload, response.StatusCode))
		return
	}

	if !keepalive.Enabled() {
		for key, values := range response.Header {
			if strings.EqualFold(key, "Content-Length") {
				continue
			}
			for _, value := range values {
				w.Header().Add(key, value)
			}
		}
		w.WriteHeader(response.StatusCode)
	}
	result := copyAIResponseBody(w, response.Body, logContext.ExpectImage, keepalive)
	status := response.StatusCode
	errorMessage := ""
	chargedCredits := logContext.Credits
	if logContext.ExpectImage {
		if result.HasError || result.ImageCount <= 0 {
			status = http.StatusBadGateway
			errorMessage = firstNonEmpty(result.ErrorMessage, "AI 接口未返回有效图片")
			chargedCredits = 0
			if onFailure != nil {
				onFailure()
			}
		} else if logContext.UnitCredits > 0 && result.ImageCount*logContext.UnitCredits < chargedCredits {
			refundCredits := chargedCredits - result.ImageCount*logContext.UnitCredits
			chargedCredits -= refundCredits
			_ = service.RefundUserCredits(logContext.UserID, logContext.Model, refundCredits, logContext.Endpoint, logContext.Channel)
		}
	}
	saveAIProxyLog(logContext, status, result.Body, errorMessage, chargedCredits)
}

func copyDeclarativeImageResponse(w http.ResponseWriter, sourceRequest *http.Request, request *http.Request, channel model.ModelChannel, logContext aiLogContext, onFailure func()) {
	keepalive := startAIClientKeepalive(w, true)
	payload, status, err := requestImageAdapterJSON(request, channel)
	if err == nil {
		payload, err = pollImageAdapterResult(sourceRequest, channel, payload)
	}
	if err != nil {
		if onFailure != nil {
			onFailure()
		}
		message := err.Error()
		saveAIProxyLog(logContext, status, marshalLogJSON(payload), message, 0)
		writeAIProxyError(w, keepalive, firstPositive(status, http.StatusBadGateway), message)
		return
	}
	images := imageAdapterResults(payload, channel.ImageAdapter.ResultPaths)
	if len(images) == 0 {
		if onFailure != nil {
			onFailure()
		}
		message := firstNonEmpty(imageAdapterError(payload, channel.ImageAdapter.ErrorPaths), "AI 接口未返回有效图片")
		saveAIProxyLog(logContext, http.StatusBadGateway, marshalLogJSON(payload), message, 0)
		writeAIProxyError(w, keepalive, http.StatusBadGateway, message)
		return
	}
	data := make([]map[string]string, 0, len(images))
	for _, image := range images {
		if strings.HasPrefix(image, "http://") || strings.HasPrefix(image, "https://") || strings.HasPrefix(image, "data:") {
			data = append(data, map[string]string{"url": image})
		} else {
			data = append(data, map[string]string{"b64_json": image})
		}
	}
	encoded, _ := json.Marshal(map[string]any{"data": data})
	keepalive.Stop()
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_, _ = w.Write(encoded)
	chargedCredits := min(logContext.Credits, len(images)*logContext.UnitCredits)
	if refundCredits := logContext.Credits - chargedCredits; refundCredits > 0 {
		_ = service.RefundUserCredits(logContext.UserID, logContext.Model, refundCredits, logContext.Endpoint, logContext.Channel)
	}
	saveAIProxyLog(logContext, http.StatusOK, string(encoded), "", chargedCredits)
}

func requestImageAdapterJSON(request *http.Request, channel model.ModelChannel) (map[string]any, int, error) {
	response, err := service.HTTPClientForChannel(channel).Do(request)
	if err != nil {
		return nil, http.StatusBadGateway, err
	}
	defer response.Body.Close()
	body, readErr := io.ReadAll(response.Body)
	if readErr != nil {
		return nil, response.StatusCode, readErr
	}
	var payload map[string]any
	if json.Unmarshal(body, &payload) != nil {
		return nil, response.StatusCode, fmt.Errorf("异步渠道返回了无效 JSON")
	}
	if response.StatusCode >= http.StatusBadRequest {
		return payload, response.StatusCode, fmt.Errorf("%s", readUpstreamAIErrorMessage(body, response.StatusCode))
	}
	return payload, response.StatusCode, nil
}

func pollImageAdapterResult(sourceRequest *http.Request, channel model.ModelChannel, payload map[string]any) (map[string]any, error) {
	adapter := channel.ImageAdapter
	if len(imageAdapterResults(payload, adapter.ResultPaths)) > 0 {
		return payload, nil
	}
	taskID := adapterStringAt(payload, adapter.TaskIDPath)
	if taskID == "" || adapter.StatusPath == "" {
		return payload, nil
	}
	for attempt := 0; attempt < adapter.MaxAttempts; attempt++ {
		select {
		case <-sourceRequest.Context().Done():
			return payload, sourceRequest.Context().Err()
		case <-time.After(time.Duration(adapter.PollInterval) * time.Millisecond):
		}
		path := strings.ReplaceAll(adapter.StatusPath, "{task_id}", url.PathEscape(taskID))
		request, err := http.NewRequestWithContext(sourceRequest.Context(), http.MethodGet, service.BuildModelChannelURL(channel, path), nil)
		if err != nil {
			return payload, err
		}
		request.Header.Set("Authorization", "Bearer "+channel.APIKey)
		next, _, err := requestImageAdapterJSON(request, channel)
		if err != nil {
			return next, err
		}
		payload = next
		status := strings.ToLower(adapterStringAt(payload, adapter.StatusField))
		if containsFold(adapter.FailureValues, status) {
			return payload, fmt.Errorf("%s", firstNonEmpty(imageAdapterError(payload, adapter.ErrorPaths), "异步生图任务失败"))
		}
		if containsFold(adapter.SuccessValues, status) || len(imageAdapterResults(payload, adapter.ResultPaths)) > 0 {
			return payload, nil
		}
	}
	return payload, fmt.Errorf("异步生图任务轮询超时")
}

func imageAdapterResults(payload map[string]any, paths []string) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, path := range paths {
		for _, value := range collectAdapterImages(valueAtJSONPath(payload, path), true) {
			value = strings.TrimSpace(value)
			if value != "" && !seen[value] {
				seen[value] = true
				result = append(result, value)
			}
		}
	}
	return result
}

func collectAdapterImages(value any, direct bool) []string {
	switch typed := value.(type) {
	case string:
		if direct && isAdapterImageString(typed) {
			return []string{typed}
		}
	case []any:
		result := []string{}
		for _, item := range typed {
			result = append(result, collectAdapterImages(item, true)...)
		}
		return result
	case map[string]any:
		result := []string{}
		for _, key := range []string{"url", "image_url", "b64_json", "base64", "image", "images", "result", "results", "output"} {
			if item, ok := typed[key]; ok {
				result = append(result, collectAdapterImages(item, true)...)
			}
		}
		return result
	}
	return nil
}

func isAdapterImageString(value string) bool {
	value = strings.TrimSpace(value)
	return strings.HasPrefix(value, "http://") ||
		strings.HasPrefix(value, "https://") ||
		strings.HasPrefix(value, "data:image/") ||
		len(value) >= 64 && looksLikeBase64(value)
}

func imageAdapterError(payload map[string]any, paths []string) string {
	for _, path := range paths {
		if value := adapterStringAt(payload, path); value != "" {
			return value
		}
	}
	return ""
}

func adapterStringAt(payload map[string]any, path string) string {
	value := valueAtJSONPath(payload, path)
	if text, ok := value.(string); ok {
		return strings.TrimSpace(text)
	}
	return ""
}

func valueAtJSONPath(value any, path string) any {
	current := value
	for _, part := range strings.Split(strings.TrimSpace(path), ".") {
		record, ok := current.(map[string]any)
		if !ok {
			return nil
		}
		current = record[part]
	}
	return current
}

func containsFold(values []string, target string) bool {
	for _, value := range values {
		if strings.EqualFold(strings.TrimSpace(value), target) {
			return true
		}
	}
	return false
}

func firstPositive(values ...int) int {
	for _, value := range values {
		if value > 0 {
			return value
		}
	}
	return http.StatusBadGateway
}

func marshalLogJSON(value any) string {
	encoded, _ := json.Marshal(value)
	if len(encoded) <= 64*1024 {
		return string(encoded)
	}
	var cloned any
	if json.Unmarshal(encoded, &cloned) == nil {
		redactLargeImages(&cloned)
		encoded, _ = json.Marshal(cloned)
	}
	if len(encoded) > 64*1024 {
		encoded = encoded[:64*1024]
	}
	return string(encoded)
}

func proxyGeminiAIRequest(w http.ResponseWriter, r *http.Request, path string, body []byte, contentType string, channel model.ModelChannel, logContext aiLogContext, onFailure func()) {
	responseBody, responseContentType, imageCount, err := callGeminiProxy(r, path, body, contentType, channel, logContext.Model)
	if err != nil {
		if onFailure != nil {
			onFailure()
		}
		saveAIProxyLog(logContext, http.StatusBadGateway, "", err.Error(), 0)
		FailWithStatus(w, http.StatusBadGateway, err.Error())
		return
	}
	if responseContentType == "" {
		responseContentType = "application/json; charset=utf-8"
	}
	if logContext.ExpectImage && imageCount <= 0 {
		if onFailure != nil {
			onFailure()
		}
		saveAIProxyLog(logContext, http.StatusBadGateway, string(responseBody), "Gemini 接口未返回有效图片", 0)
		FailWithStatus(w, http.StatusBadGateway, "Gemini 接口未返回有效图片")
		return
	}
	w.Header().Set("Content-Type", responseContentType)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(responseBody)
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
	chargedCredits := logContext.Credits
	errorMessage := ""
	status := http.StatusOK
	if logContext.ExpectImage {
		if logContext.UnitCredits > 0 && imageCount*logContext.UnitCredits < chargedCredits {
			refundCredits := chargedCredits - imageCount*logContext.UnitCredits
			chargedCredits -= refundCredits
			_ = service.RefundUserCredits(logContext.UserID, logContext.Model, refundCredits, logContext.Endpoint, logContext.Channel)
		}
	}
	saveAIProxyLog(logContext, status, string(responseBody), errorMessage, chargedCredits)
}

func callGeminiProxy(r *http.Request, path string, body []byte, contentType string, channel model.ModelChannel, modelName string) ([]byte, string, int, error) {
	switch path {
	case "/images/generations":
		return callGeminiImageGeneration(r, body, channel, modelName)
	case "/images/edits":
		return callGeminiImageEdit(r, body, contentType, channel, modelName)
	case "/chat/completions":
		return callGeminiChatCompletions(r, body, channel, modelName)
	case "/responses":
		return callGeminiResponses(r, body, channel, modelName)
	default:
		return nil, "", 0, fmt.Errorf("Gemini 暂不支持该接口：%s", path)
	}
}

func callGeminiImageGeneration(r *http.Request, body []byte, channel model.ModelChannel, modelName string) ([]byte, string, int, error) {
	var payload struct {
		Prompt string `json:"prompt"`
		N      int    `json:"n"`
	}
	_ = json.Unmarshal(body, &payload)
	count := payload.N
	if count <= 0 {
		count = 1
	}
	items := []map[string]string{}
	for i := 0; i < count; i++ {
		images, err := requestGeminiImages(r, channel, modelName, []map[string]any{{"text": payload.Prompt}})
		if err != nil {
			return nil, "", 0, err
		}
		items = append(items, images...)
	}
	encoded, _ := json.Marshal(map[string]any{"data": items})
	return encoded, "application/json; charset=utf-8", len(items), nil
}

func callGeminiImageEdit(r *http.Request, body []byte, contentType string, channel model.ModelChannel, modelName string) ([]byte, string, int, error) {
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return nil, "", 0, err
	}
	form, err := multipart.NewReader(bytes.NewReader(body), params["boundary"]).ReadForm(64 << 20)
	if err != nil {
		return nil, "", 0, err
	}
	defer form.RemoveAll()
	if len(form.File["mask"]) > 0 {
		return nil, "", 0, fmt.Errorf("Gemini 调用格式暂不支持蒙版编辑")
	}
	prompt := firstFormValue(form.Value, "prompt")
	count := intFromString(firstFormValue(form.Value, "n"), 1)
	parts := []map[string]any{{"text": prompt}}
	for _, header := range form.File["image"] {
		file, err := header.Open()
		if err != nil {
			return nil, "", 0, err
		}
		fileBody, readErr := io.ReadAll(file)
		_ = file.Close()
		if readErr != nil {
			return nil, "", 0, readErr
		}
		mimeType := header.Header.Get("Content-Type")
		if mimeType == "" {
			mimeType = "image/png"
		}
		parts = append(parts, map[string]any{"inlineData": map[string]any{"mimeType": mimeType, "data": base64.StdEncoding.EncodeToString(fileBody)}})
	}
	items := []map[string]string{}
	for i := 0; i < count; i++ {
		images, err := requestGeminiImages(r, channel, modelName, parts)
		if err != nil {
			return nil, "", 0, err
		}
		items = append(items, images...)
	}
	encoded, _ := json.Marshal(map[string]any{"data": items})
	return encoded, "application/json; charset=utf-8", len(items), nil
}

func callGeminiChatCompletions(r *http.Request, body []byte, channel model.ModelChannel, modelName string) ([]byte, string, int, error) {
	geminiBody := geminiBodyFromOpenAIChat(body, nil)
	payload, err := requestGeminiJSON(r, channel, modelName, geminiBody, false)
	if err != nil {
		return nil, "", 0, err
	}
	text := geminiText(payload)
	chunk, _ := json.Marshal(map[string]any{"choices": []map[string]any{{"delta": map[string]string{"content": text}}}})
	return []byte("data: " + string(chunk) + "\n\ndata: [DONE]\n\n"), "text/event-stream; charset=utf-8", 0, nil
}

func callGeminiResponses(r *http.Request, body []byte, channel model.ModelChannel, modelName string) ([]byte, string, int, error) {
	var payload map[string]any
	_ = json.Unmarshal(body, &payload)
	if strings.Contains(string(body), "image_generation") {
		parts := geminiPartsFromResponsesInput(payload["input"])
		if len(parts) == 0 {
			parts = []map[string]any{{"text": ""}}
		}
		images, err := requestGeminiImages(r, channel, modelName, parts)
		if err != nil {
			return nil, "", 0, err
		}
		output := []map[string]any{}
		for _, image := range images {
			output = append(output, map[string]any{"type": "image_generation_call", "result": image["b64_json"], "url": image["url"]})
		}
		encoded, _ := json.Marshal(map[string]any{"output": output})
		return encoded, "application/json; charset=utf-8", len(images), nil
	}
	geminiBody := geminiBodyFromResponses(payload)
	result, err := requestGeminiJSON(r, channel, modelName, geminiBody, false)
	if err != nil {
		return nil, "", 0, err
	}
	encoded, _ := json.Marshal(openAIResponsesFromGemini(result))
	return encoded, "application/json; charset=utf-8", 0, nil
}

func requestGeminiImages(r *http.Request, channel model.ModelChannel, modelName string, parts []map[string]any) ([]map[string]string, error) {
	payload, err := requestGeminiJSON(r, channel, modelName, map[string]any{
		"contents": []map[string]any{{"role": "user", "parts": parts}},
		"generationConfig": map[string]any{
			"responseModalities": []string{"TEXT", "IMAGE"},
		},
	}, false)
	if err != nil {
		return nil, err
	}
	return geminiImages(payload), nil
}

func requestGeminiJSON(r *http.Request, channel model.ModelChannel, modelName string, body map[string]any, stream bool) (map[string]any, error) {
	encoded, _ := json.Marshal(body)
	request, err := http.NewRequestWithContext(r.Context(), http.MethodPost, service.BuildGeminiGenerateURL(channel, modelName, stream), bytes.NewReader(encoded))
	if err != nil {
		return nil, err
	}
	request.Header.Set("x-goog-api-key", channel.APIKey)
	request.Header.Set("Content-Type", "application/json")
	response, err := service.HTTPClientForChannel(channel).Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	responseBody, _ := io.ReadAll(response.Body)
	if response.StatusCode >= http.StatusBadRequest {
		return nil, fmt.Errorf("%s", readUpstreamAIErrorMessage(responseBody, response.StatusCode))
	}
	var payload map[string]any
	if err := json.Unmarshal(responseBody, &payload); err != nil {
		return nil, err
	}
	if msg := geminiErrorMessage(payload); msg != "" {
		return nil, fmt.Errorf("%s", msg)
	}
	return payload, nil
}

func geminiBodyFromOpenAIChat(body []byte, extra map[string]any) map[string]any {
	var payload struct {
		Messages []map[string]any `json:"messages"`
	}
	_ = json.Unmarshal(body, &payload)
	contents := []map[string]any{}
	systemParts := []map[string]string{}
	for _, message := range payload.Messages {
		role := fmt.Sprint(message["role"])
		text := chatContentText(message["content"])
		if strings.TrimSpace(text) == "" {
			continue
		}
		if role == "system" {
			systemParts = append(systemParts, map[string]string{"text": text})
			continue
		}
		geminiRole := "user"
		if role == "assistant" {
			geminiRole = "model"
		}
		contents = append(contents, map[string]any{"role": geminiRole, "parts": []map[string]string{{"text": text}}})
	}
	result := map[string]any{"contents": contents}
	if len(systemParts) > 0 {
		result["systemInstruction"] = map[string]any{"parts": systemParts}
	}
	for key, value := range extra {
		result[key] = value
	}
	return result
}

func geminiBodyFromResponses(payload map[string]any) map[string]any {
	body := map[string]any{"contents": []map[string]any{{"role": "user", "parts": geminiPartsFromResponsesInput(payload["input"])}}}
	if tools, ok := geminiToolsFromResponses(payload["tools"]); ok {
		body["tools"] = tools
	}
	return body
}

func geminiToolsFromResponses(value any) ([]map[string]any, bool) {
	items, ok := value.([]any)
	if !ok || len(items) == 0 {
		return nil, false
	}
	declarations := []map[string]any{}
	for _, item := range items {
		record, ok := item.(map[string]any)
		if !ok || fmt.Sprint(record["type"]) != "function" {
			continue
		}
		declarations = append(declarations, map[string]any{
			"name":        record["name"],
			"description": record["description"],
			"parameters":  record["parameters"],
		})
	}
	if len(declarations) == 0 {
		return nil, false
	}
	return []map[string]any{{"functionDeclarations": declarations}}, true
}

func geminiPartsFromResponsesInput(value any) []map[string]any {
	switch typed := value.(type) {
	case string:
		return []map[string]any{{"text": typed}}
	case []any:
		parts := []map[string]any{}
		for _, item := range typed {
			record, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if content, ok := record["content"].([]any); ok {
				for _, part := range content {
					if converted := geminiPartFromResponseContent(part); converted != nil {
						parts = append(parts, converted)
					}
				}
			}
		}
		return parts
	default:
		return nil
	}
}

func geminiPartFromResponseContent(value any) map[string]any {
	record, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	if text := strings.TrimSpace(fmt.Sprint(record["text"])); text != "" {
		return map[string]any{"text": text}
	}
	imageURL := ""
	if raw := record["image_url"]; raw != nil {
		if image, ok := raw.(map[string]any); ok {
			imageURL = fmt.Sprint(image["url"])
		} else {
			imageURL = fmt.Sprint(raw)
		}
	}
	if imageURL == "" {
		return nil
	}
	if mimeType, data, ok := splitDataURL(imageURL); ok {
		return map[string]any{"inlineData": map[string]any{"mimeType": mimeType, "data": data}}
	}
	return map[string]any{"fileData": map[string]any{"fileUri": imageURL, "mimeType": "image/png"}}
}

func openAIResponsesFromGemini(payload map[string]any) map[string]any {
	output := []map[string]any{}
	text := geminiText(payload)
	if strings.TrimSpace(text) != "" {
		output = append(output, map[string]any{"type": "message", "content": []map[string]any{{"type": "output_text", "text": text}}})
	}
	for _, call := range geminiFunctionCalls(payload) {
		output = append(output, map[string]any{"type": "function_call", "id": firstNonEmpty(call.ID, "call_"+time.Now().Format("150405000")), "call_id": firstNonEmpty(call.ID, "call_"+time.Now().Format("150405000")), "name": call.Name, "arguments": call.Arguments})
	}
	return map[string]any{"output": output, "output_text": text}
}

type geminiFunctionCall struct {
	ID        string
	Name      string
	Arguments string
}

func geminiFunctionCalls(payload map[string]any) []geminiFunctionCall {
	result := []geminiFunctionCall{}
	for _, part := range geminiParts(payload) {
		call, ok := part["functionCall"].(map[string]any)
		if !ok {
			call, ok = part["function_call"].(map[string]any)
			if !ok {
				continue
			}
		}
		args, _ := json.Marshal(call["args"])
		result = append(result, geminiFunctionCall{ID: fmt.Sprint(call["id"]), Name: fmt.Sprint(call["name"]), Arguments: string(args)})
	}
	return result
}

func geminiImages(payload map[string]any) []map[string]string {
	result := []map[string]string{}
	for _, part := range geminiParts(payload) {
		if inline, ok := part["inlineData"].(map[string]any); ok {
			if data := fmt.Sprint(inline["data"]); data != "" {
				result = append(result, map[string]string{"b64_json": data})
			}
		}
		if inline, ok := part["inline_data"].(map[string]any); ok {
			if data := fmt.Sprint(inline["data"]); data != "" {
				result = append(result, map[string]string{"b64_json": data})
			}
		}
		if fileData, ok := part["fileData"].(map[string]any); ok {
			if uri := fmt.Sprint(fileData["fileUri"]); uri != "" {
				result = append(result, map[string]string{"url": uri})
			}
		}
		if fileData, ok := part["file_data"].(map[string]any); ok {
			uri := strings.TrimSpace(fmt.Sprint(fileData["fileUri"]))
			if uri == "" || uri == "<nil>" {
				uri = strings.TrimSpace(fmt.Sprint(fileData["file_uri"]))
			}
			if uri != "" && uri != "<nil>" {
				result = append(result, map[string]string{"url": uri})
			}
		}
	}
	return result
}

func geminiText(payload map[string]any) string {
	parts := []string{}
	for _, part := range geminiParts(payload) {
		if text := fmt.Sprint(part["text"]); strings.TrimSpace(text) != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, "")
}

func geminiParts(payload map[string]any) []map[string]any {
	candidates, _ := payload["candidates"].([]any)
	parts := []map[string]any{}
	for _, candidate := range candidates {
		candidateMap, _ := candidate.(map[string]any)
		content, _ := candidateMap["content"].(map[string]any)
		rawParts, _ := content["parts"].([]any)
		for _, raw := range rawParts {
			if part, ok := raw.(map[string]any); ok {
				parts = append(parts, part)
			}
		}
	}
	return parts
}

func geminiErrorMessage(payload map[string]any) string {
	if errorValue, ok := payload["error"].(map[string]any); ok {
		return fmt.Sprint(errorValue["message"])
	}
	if feedback, ok := payload["promptFeedback"].(map[string]any); ok {
		if reason := strings.TrimSpace(fmt.Sprint(feedback["blockReason"])); reason != "" {
			return "Gemini 拒绝了本次请求：" + reason
		}
	}
	return ""
}

func chatContentText(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case []any:
		parts := []string{}
		for _, item := range typed {
			record, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if text := strings.TrimSpace(fmt.Sprint(record["text"])); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "\n")
	default:
		return ""
	}
}

func splitDataURL(value string) (string, string, bool) {
	if !strings.HasPrefix(value, "data:") {
		return "", "", false
	}
	header, data, ok := strings.Cut(value, ",")
	if !ok {
		return "", "", false
	}
	mimeType := strings.TrimPrefix(strings.Split(header, ";")[0], "data:")
	if mimeType == "" {
		mimeType = "image/png"
	}
	return mimeType, data, true
}

func firstFormValue(values map[string][]string, key string) string {
	if list := values[key]; len(list) > 0 {
		return list[0]
	}
	return ""
}

func intFromString(value string, fallback int) int {
	var result int
	if _, err := fmt.Sscanf(value, "%d", &result); err != nil || result <= 0 {
		return fallback
	}
	return result
}

func startAIClientKeepalive(w http.ResponseWriter, enabled bool) *aiClientKeepalive {
	keepalive := &aiClientKeepalive{}
	flusher, ok := w.(http.Flusher)
	if !enabled || !ok {
		return keepalive
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	_, _ = w.Write([]byte(" "))
	flusher.Flush()
	keepalive.stop = make(chan struct{})
	keepalive.done = make(chan struct{})
	go func() {
		defer close(keepalive.done)
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				_, _ = w.Write([]byte(" "))
				flusher.Flush()
			case <-keepalive.stop:
				return
			}
		}
	}()
	return keepalive
}

func (keepalive *aiClientKeepalive) Enabled() bool {
	return keepalive != nil && keepalive.stop != nil
}

func (keepalive *aiClientKeepalive) Stop() {
	if !keepalive.Enabled() {
		return
	}
	close(keepalive.stop)
	<-keepalive.done
	keepalive.stop = nil
}

func writeAIProxyError(w http.ResponseWriter, keepalive *aiClientKeepalive, status int, message string) {
	if keepalive.Enabled() {
		keepalive.Stop()
		encoded, _ := json.Marshal(map[string]any{"error": map[string]any{"message": message, "code": fmt.Sprintf("%d", status)}})
		_, _ = w.Write(encoded)
		return
	}
	FailWithStatus(w, status, message)
}

func copyAIResponseBody(w http.ResponseWriter, body io.Reader, scanImageResult bool, keepalive *aiClientKeepalive) aiResponseCopyResult {
	flusher, canFlush := w.(http.Flusher)
	buffer := make([]byte, 32*1024)
	var logBuffer strings.Builder
	result := aiResponseCopyResult{}
	tail := ""
	for {
		n, err := body.Read(buffer)
		if n > 0 {
			keepalive.Stop()
			if _, writeErr := w.Write(buffer[:n]); writeErr != nil {
				result.Body = logBuffer.String()
				return result
			}
			chunk := string(buffer[:n])
			if logBuffer.Len() < 64*1024 {
				_, _ = logBuffer.Write(buffer[:min(n, 64*1024-logBuffer.Len())])
			}
			if scanImageResult {
				scanAIImageResponseChunk(&result, tail+chunk, len(tail))
				tail = trailingText(tail+chunk, 256)
			}
			if canFlush {
				flusher.Flush()
			}
		}
		if err != nil {
			keepalive.Stop()
			result.Body = logBuffer.String()
			return result
		}
	}
}

func saveAIProxyLog(context aiLogContext, status int, responseBody string, errorMessage string, credits int) {
	if context.StartedAt.IsZero() {
		context.StartedAt = time.Now()
	}
	service.SaveAICallLog(service.AICallLogInput{
		UserID:          context.UserID,
		UserDisplayName: context.UserDisplayName,
		Endpoint:        context.Endpoint,
		Method:          context.Method,
		Model:           context.Model,
		ChannelID:       context.Channel.ID,
		ChannelName:     context.Channel.Name,
		Status:          status,
		DurationMs:      time.Since(context.StartedAt).Milliseconds(),
		Credits:         credits,
		RequestBody:     context.RequestBody,
		ResponseBody:    responseBody,
		Error:           errorMessage,
	})
}

func isImageAIRequest(path string, body []byte) bool {
	if strings.HasPrefix(path, "/images/") {
		return true
	}
	return path == "/responses" && bytes.Contains(body, []byte("image_generation"))
}

func scanAIImageResponseChunk(result *aiResponseCopyResult, text string, previousTailLength int) {
	for _, marker := range []string{
		"response.image_generation_call.completed",
		"image_generation.completed",
		"image_edit.completed",
		"image.generation.result",
		"image.edit.result",
		"\"b64_json\"",
		"\"partial_image_b64\"",
		"\"url\"",
		"\"image_url\"",
	} {
		result.ImageCount += countNewMarkerOccurrences(text, marker, previousTailLength)
	}
	for _, marker := range []string{
		"event: error",
		"response.failed",
		"\"status\":\"failed\"",
		"\"status\": \"failed\"",
		"stream_read_error",
		"upstream_error",
		"\"type\":\"api_error\"",
		"\"type\": \"api_error\"",
	} {
		if strings.Contains(text, marker) {
			result.HasError = true
			result.ErrorMessage = "AI 返回流包含失败事件"
			return
		}
	}
}

func countNewMarkerOccurrences(text string, marker string, previousTailLength int) int {
	count := 0
	minIndex := max(0, previousTailLength-len(marker)+1)
	offset := 0
	for {
		index := strings.Index(text[offset:], marker)
		if index < 0 {
			return count
		}
		absolute := offset + index
		if absolute >= minIndex {
			count++
		}
		offset = absolute + len(marker)
	}
}

func trailingText(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	return text[len(text)-limit:]
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func summarizeAIRequest(body []byte, contentType string) string {
	if strings.HasPrefix(contentType, "multipart/form-data") {
		return summarizeMultipartAIRequest(body, contentType)
	}
	var payload any
	if err := json.Unmarshal(body, &payload); err == nil {
		redactLargeImages(&payload)
		if encoded, err := json.MarshalIndent(payload, "", "  "); err == nil {
			return string(encoded)
		}
	}
	return string(body)
}

func summarizeQueryParams(values map[string][]string) string {
	if len(values) == 0 {
		return ""
	}
	encoded, _ := json.MarshalIndent(values, "", "  ")
	return string(encoded)
}

func summarizeMultipartAIRequest(body []byte, contentType string) string {
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return "multipart/form-data"
	}
	form, err := multipart.NewReader(bytes.NewReader(body), params["boundary"]).ReadForm(32 << 20)
	if err != nil {
		return "multipart/form-data"
	}
	defer form.RemoveAll()
	summary := map[string]any{"fields": form.Value}
	files := []map[string]any{}
	for field, headers := range form.File {
		for _, header := range headers {
			files = append(files, map[string]any{"field": field, "filename": header.Filename, "size": header.Size, "contentType": header.Header.Get("Content-Type")})
		}
	}
	summary["files"] = files
	encoded, _ := json.MarshalIndent(summary, "", "  ")
	return string(encoded)
}

func readUpstreamAIErrorMessage(body []byte, statusCode int) string {
	if detail := aiUpstreamErrorDetail(body); detail != "" {
		return detail
	}
	var payload struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
		Msg     string `json:"msg"`
		Message string `json:"message"`
	}
	if len(body) > 0 && json.Unmarshal(body, &payload) == nil {
		if payload.Error != nil && strings.TrimSpace(payload.Error.Message) != "" {
			return payload.Error.Message
		}
		if strings.TrimSpace(payload.Msg) != "" {
			return payload.Msg
		}
		if strings.TrimSpace(payload.Message) != "" {
			return payload.Message
		}
	}
	if statusCode > 0 {
		return fmt.Sprintf("AI 接口请求失败：%d", statusCode)
	}
	return "AI 接口请求失败"
}

func aiUpstreamErrorDetail(body []byte) string {
	var payload struct {
		Error *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
		Msg     string `json:"msg"`
		Message string `json:"message"`
	}
	if len(body) == 0 || json.Unmarshal(body, &payload) != nil {
		return safeUpstreamText(string(body))
	}
	code := strings.TrimSpace("")
	message := strings.TrimSpace("")
	if payload.Error != nil {
		code = strings.TrimSpace(payload.Error.Code)
		message = strings.TrimSpace(payload.Error.Message)
	}
	if message == "" {
		message = strings.TrimSpace(firstNonEmpty(payload.Msg, payload.Message))
	}
	detail := strings.TrimSpace(strings.Join([]string{code, message}, " "))
	return safeUpstreamText(detail)
}

func safeUpstreamText(text string) string {
	runes := []rune(strings.TrimSpace(text))
	if len(runes) <= 300 {
		return string(runes)
	}
	return string(runes[:300]) + "..."
}

func redactLargeImages(value *any) {
	switch typed := (*value).(type) {
	case map[string]any:
		for key, item := range typed {
			if text, ok := item.(string); ok && (strings.HasPrefix(text, "data:image/") || len(text) > 2048 && looksLikeBase64(text)) {
				typed[key] = fmt.Sprintf("[redacted image/string len=%d]", len(text))
				continue
			}
			redactLargeImages(&item)
			typed[key] = item
		}
	case []any:
		for index, item := range typed {
			redactLargeImages(&item)
			typed[index] = item
		}
	}
}

func looksLikeBase64(value string) bool {
	for _, char := range value[:min(len(value), 200)] {
		if !(char >= 'A' && char <= 'Z' || char >= 'a' && char <= 'z' || char >= '0' && char <= '9' || char == '+' || char == '/' || char == '=') {
			return false
		}
	}
	return true
}

func readAIRequest(r *http.Request) ([]byte, string, string, error) {
	contentType := r.Header.Get("Content-Type")
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, "", "", err
	}
	modelName := ""
	if strings.HasPrefix(contentType, "multipart/form-data") {
		modelName = readMultipartModel(body, contentType)
	} else {
		var payload struct {
			Model string `json:"model"`
		}
		_ = json.Unmarshal(body, &payload)
		modelName = payload.Model
	}
	if strings.TrimSpace(modelName) == "" {
		return nil, "", "", errMissingModel
	}
	return body, contentType, modelName, nil
}

func readMultipartModel(body []byte, contentType string) string {
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return ""
	}
	reader := multipart.NewReader(bytes.NewReader(body), params["boundary"])
	form, err := reader.ReadForm(32 << 20)
	if err != nil {
		return ""
	}
	defer form.RemoveAll()
	if values := form.Value["model"]; len(values) > 0 {
		return values[0]
	}
	return ""
}

func readAIRequestCount(body []byte, contentType string) int {
	count := 1
	if strings.HasPrefix(contentType, "multipart/form-data") {
		_, params, err := mime.ParseMediaType(contentType)
		if err != nil {
			return count
		}
		form, err := multipart.NewReader(bytes.NewReader(body), params["boundary"]).ReadForm(32 << 20)
		if err != nil {
			return count
		}
		defer form.RemoveAll()
		if values := form.Value["n"]; len(values) > 0 {
			_, _ = fmt.Sscan(values[0], &count)
		}
	} else {
		var payload struct {
			N int `json:"n"`
		}
		_ = json.Unmarshal(body, &payload)
		count = payload.N
	}
	if count < 1 {
		return 1
	}
	return count
}

var errMissingModel = &aiError{"缺少模型名称"}

type aiError struct {
	message string
}

func (err *aiError) Error() string {
	return err.message
}
