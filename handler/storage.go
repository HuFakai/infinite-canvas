package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

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

func UploadFile(w http.ResponseWriter, r *http.Request) {
	file, header, err := r.FormFile("file")
	if err != nil {
		Fail(w, "请选择要上传的文件")
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
	w.Header().Set("Content-Type", download.Object.MimeType)
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
