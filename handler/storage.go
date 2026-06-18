package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/service"
)

func StorageConfig(w http.ResponseWriter, r *http.Request) {
	config, err := service.PublicStorageConfig()
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, config)
}

func UserConfig(w http.ResponseWriter, r *http.Request) {
	config, err := service.CurrentUserConfig(r.Context())
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, config)
}

func SaveUserModelConfig(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Config json.RawMessage `json:"config"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil || len(request.Config) == 0 {
		Fail(w, "配置内容不能为空")
		return
	}
	config, err := service.SaveCurrentUserModelConfig(r.Context(), request.Config)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, config)
}

func SaveUserStorageProvider(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Provider service.StorageObjectProviderInput `json:"provider"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "配置内容格式错误")
		return
	}
	config, err := service.SaveCurrentUserStorageProvider(r.Context(), request.Provider)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, config)
}

func MeasureUserStorageProvider(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Provider service.StorageObjectProviderInput `json:"provider"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "配置内容格式错误")
		return
	}
	result, err := service.MeasureUserStorageProvider(r.Context(), request.Provider)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func UserCanvasData(w http.ResponseWriter, r *http.Request) {
	data, err := service.CurrentUserCanvasData(r.Context())
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, json.RawMessage(data))
}

func SaveUserCanvasData(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil || len(request.Data) == 0 {
		Fail(w, "数据内容不能为空")
		return
	}
	data, err := service.SaveCurrentUserCanvasData(r.Context(), request.Data)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, json.RawMessage(data))
}

func UserImageHistory(w http.ResponseWriter, r *http.Request) {
	data, err := service.CurrentUserImageHistory(r.Context())
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, json.RawMessage(data))
}

func SaveUserImageHistory(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil || len(request.Data) == 0 {
		Fail(w, "数据内容不能为空")
		return
	}
	data, err := service.SaveCurrentUserImageHistory(r.Context(), request.Data)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, json.RawMessage(data))
}

func UserAssetData(w http.ResponseWriter, r *http.Request) {
	data, err := service.CurrentUserAssetData(r.Context())
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, json.RawMessage(data))
}

func SaveUserAssetData(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil || len(request.Data) == 0 {
		Fail(w, "数据内容不能为空")
		return
	}
	data, err := service.SaveCurrentUserAssetData(r.Context(), request.Data)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, json.RawMessage(data))
}

func UserWorkflows(w http.ResponseWriter, r *http.Request) {
	workflows, err := service.ListCreativeWorkflows(r.Context())
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, workflows)
}

func SaveUserWorkflow(w http.ResponseWriter, r *http.Request) {
	var request service.CreativeWorkflowPayload
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "工作流数据格式错误")
		return
	}
	workflow, err := service.SaveCreativeWorkflow(r.Context(), request)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, workflow)
}

func DeleteUserWorkflow(w http.ResponseWriter, r *http.Request, id string) {
	if err := service.DeleteCreativeWorkflow(r.Context(), id); err != nil {
		FailError(w, err)
		return
	}
	OK(w, true)
}

func DraftUserWorkflow(w http.ResponseWriter, r *http.Request) {
	var request service.WorkflowAgentDraftRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "工作流需求格式错误")
		return
	}
	result, err := service.DraftCreativeWorkflow(r.Context(), request)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

const maxUploadBytes = 50 << 20

func UploadFile(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes+1)
	file, header, err := r.FormFile("file")
	if err != nil {
		Fail(w, "文件过大或上传格式不正确")
		return
	}
	defer file.Close()
	data, err := io.ReadAll(file)
	if err != nil {
		FailError(w, err)
		return
	}
	contentType := header.Header.Get("Content-Type")
	if strings.TrimSpace(contentType) == "" {
		contentType = http.DetectContentType(data)
	}
	var provider *service.StorageObjectProviderInput
	if raw := strings.TrimSpace(r.FormValue("provider")); raw != "" {
		var parsed service.StorageObjectProviderInput
		if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
			Fail(w, "用户对象存储配置格式错误")
			return
		}
		provider = &parsed
	}
	object, err := service.UploadStorageObjectWithProvider(r.Context(), header.Filename, contentType, data, provider)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, object)
}

func DeleteFile(w http.ResponseWriter, r *http.Request, id string) {
	var request struct {
		Provider *service.StorageObjectProviderInput `json:"provider"`
	}
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&request)
	}
	if err := service.DeleteStorageObject(r.Context(), id, request.Provider); err != nil {
		FailError(w, err)
		return
	}
	OK(w, true)
}

// safeDownloadContentType 限制 /api/files/:id/content 回显的 Content-Type，
// 防止用户上传声称 text/html 等可执行类型的文件造成同源存储型 XSS。
// 仅图片/音视频按原类型内联返回；其余（含可内嵌脚本的 SVG）一律按附件下载。
func safeDownloadContentType(mimeType string) (string, bool) {
	normalized := strings.ToLower(strings.TrimSpace(strings.Split(mimeType, ";")[0]))
	if normalized == "image/svg+xml" {
		return "application/octet-stream", false
	}
	if strings.HasPrefix(normalized, "image/") ||
		strings.HasPrefix(normalized, "video/") ||
		strings.HasPrefix(normalized, "audio/") {
		return normalized, true
	}
	return "application/octet-stream", false
}

func FileContent(w http.ResponseWriter, r *http.Request, id string) {
	download, err := service.DownloadStorageObject(id)
	if err != nil {
		FailError(w, err)
		return
	}
	if download.RedirectURL != "" {
		http.Redirect(w, r, download.RedirectURL, http.StatusTemporaryRedirect)
		return
	}
	contentType, inline := safeDownloadContentType(download.Object.MimeType)
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if !inline {
		w.Header().Set("Content-Disposition", "attachment")
	}
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	_, _ = w.Write(download.Data)
}

func FileInfo(w http.ResponseWriter, r *http.Request, id string) {
	object, err := service.StorageObjectInfo(id)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, object)
}

func AdminMeasureStorageProvider(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Index    int                    `json:"index"`
		Provider *model.StorageProvider `json:"provider"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "配置内容格式错误")
		return
	}
	result, err := service.MeasureAdminStorageProvider(request.Index, request.Provider)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

const proxyImageMaxBytes = 30 << 20

func ProxyImage(w http.ResponseWriter, r *http.Request) {
	targetURL := r.URL.Query().Get("url")
	if targetURL == "" {
		Fail(w, "url 参数不能为空")
		return
	}
	if !strings.HasPrefix(targetURL, "http://") && !strings.HasPrefix(targetURL, "https://") {
		Fail(w, "无效的 url")
		return
	}
	req, err := http.NewRequest(http.MethodGet, targetURL, nil)
	if err != nil {
		FailError(w, err)
		return
	}
	// 增加伪装请求头以避免被 OpenAI/Google Cloud/Azure 等 CDN/WAF 识别并阻断为机器人流量
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
	req.Header.Set("Cache-Control", "no-cache")
	req.Header.Set("Pragma", "no-cache")

	// 经 SSRF 安全客户端发起：拒绝内网/环回/元数据地址，限制重定向与跳数。
	resp, err := newSSRFSafeClient(30 * time.Second).Do(req)
	if err != nil {
		// 不回传底层错误，避免暴露内网探测结果（连接被拒 / 超时等差异）。
		FailWithStatus(w, http.StatusBadGateway, "代理图片请求失败")
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		FailWithStatus(w, http.StatusBadGateway, "代理图片请求失败: "+resp.Status)
		return
	}
	contentType := resp.Header.Get("Content-Type")
	// 仅允许图片，避免被当作开放代理转发任意内容
	if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(contentType)), "image/") {
		FailWithStatus(w, http.StatusBadGateway, "代理目标不是图片")
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, io.LimitReader(resp.Body, proxyImageMaxBytes))
}
