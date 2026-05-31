package handler

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/service"
)

type adminSyncRequest struct {
	Category string `json:"category"`
}

type adminBatchDeleteRequest struct {
	IDs []string `json:"ids"`
}

func AdminPromptCategories(w http.ResponseWriter, r *http.Request) {
	OK(w, service.ListPromptCategories())
}

func AdminPrompts(w http.ResponseWriter, r *http.Request) {
	result, err := service.ListPrompts(parseQuery(r))
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func AdminSavePrompt(w http.ResponseWriter, r *http.Request) {
	var item model.Prompt
	_ = json.NewDecoder(r.Body).Decode(&item)
	result, err := service.SavePrompt(item)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func AdminDeletePrompt(w http.ResponseWriter, r *http.Request, id string) {
	if err := service.DeletePrompt(id); err != nil {
		FailError(w, err)
		return
	}
	OK(w, true)
}

func AdminDeletePrompts(w http.ResponseWriter, r *http.Request) {
	var request adminBatchDeleteRequest
	_ = json.NewDecoder(r.Body).Decode(&request)
	if err := service.DeletePrompts(request.IDs); err != nil {
		FailError(w, err)
		return
	}
	OK(w, true)
}

func AdminAICallLogs(w http.ResponseWriter, r *http.Request) {
	result, err := service.ListAICallLogs(parseQuery(r))
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func AdminDeleteAICallLogs(w http.ResponseWriter, r *http.Request) {
	days, _ := strconv.Atoi(r.URL.Query().Get("olderThanDays"))
	if days <= 0 {
		days = 7
	}
	removed, err := service.DeleteAICallLogsOlderThan(days)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]int{"removedFiles": removed})
}

func ClientAICallLog(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok || user.ID == "" {
		Fail(w, "请先登录")
		return
	}
	var request service.AICallLogInput
	_ = json.NewDecoder(r.Body).Decode(&request)
	request.UserID = user.ID
	request.UserDisplayName = firstNonEmpty(user.DisplayName, user.Username)
	service.SaveAICallLog(request)
	OK(w, true)
}

func AdminSyncPromptCategories(w http.ResponseWriter, r *http.Request) {
	var request adminSyncRequest
	_ = json.NewDecoder(r.Body).Decode(&request)
	log.Printf("sync prompt category start category=%s", request.Category)
	categories, err := service.SyncPromptCategory(request.Category)
	if err != nil {
		log.Printf("sync prompt category failed category=%s err=%v", request.Category, err)
		FailError(w, err)
		return
	}
	log.Printf("sync prompt category done category=%s", request.Category)
	OK(w, categories)
}
