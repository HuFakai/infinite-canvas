package handler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"net/http"
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
	channel, err := service.SelectModelChannelForModel(modelName, r.Header.Get("X-Model-Channel-ID"))
	if err != nil {
		log.Printf("AI proxy select channel failed: model=%s err=%v", modelName, err)
		Fail(w, "AI 接口请求失败")
		return
	}
	request, err := http.NewRequest(http.MethodPost, service.BuildModelChannelURL(channel, path), bytes.NewReader(body))
	if err != nil {
		log.Printf("AI proxy build request failed: url=%s err=%v", service.BuildModelChannelURL(channel, path), err)
		Fail(w, "AI 接口请求失败")
		return
	}
	request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	copyAIResponse(w, request, channel, aiLogContext{
		StartedAt:       startedAt,
		Endpoint:        path,
		Method:          http.MethodPost,
		Model:           modelName,
		Channel:         channel,
		UserID:          user.ID,
		UserDisplayName: firstNonEmpty(user.DisplayName, user.Username),
		ExpectImage:     isImageAIRequest(path, body),
		RequestBody:     summarizeAIRequest(body, contentType),
	}, nil)
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
	if logContext.ExpectImage {
		if result.HasError || result.ImageCount <= 0 {
			status = http.StatusBadGateway
			errorMessage = firstNonEmpty(result.ErrorMessage, "AI 接口未返回有效图片")
			if onFailure != nil {
				onFailure()
			}
		}
	}
	saveAIProxyLog(logContext, status, result.Body, errorMessage, 0)
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
